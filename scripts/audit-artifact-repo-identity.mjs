#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import Database from "better-sqlite3";

// Issue 07edc0d — this script opens the production DB directly (writably under
// --apply), bypassing openDb()'s guard. Share the same refusal so it cannot
// touch live data under the vitest test runner.
const { assertNotProductionDbUnderTest } = createRequire(import.meta.url)(
  "../cli/production-db-guard.cjs",
);
// Issue 24f0316 — the ledger database and the repair/audit evidence this
// script emits are both durable state, so both live under the durable root.
const { liveDbPath, mandibleHomePath } = createRequire(import.meta.url)(
  "../cli/mandible-paths.cjs",
);

const DEFAULT_DB = liveDbPath();
const DEFAULT_OUTPUT_ROOT = mandibleHomePath("repairs", "artifact-repo-identity-audit");
const GIT_BLOB_MAX_BUFFER = 64 * 1024 * 1024;
const REPO_URI_PATTERN = /^repo:\/\/([^/@]+)(?:@([^/]+))?(?:\/(.*))?$/;
const REPO_ID_KEYS = new Set(["repo_id", "home_repo_id"]);
const ROOT_KEYS = ["root", "repo_root", "checkout_root", "worktree_root"];
const PATH_KEYS = ["path", "repo_path", "observed_path", "relative_path"];
const REF_KEYS = ["ref", "commit", "commit_sha", "revision", "branch"];
const HASH_KEYS = ["content_hash", "sha256"];
const JSON_SCAN_TABLES = [
  {
    table: "artifacts",
    key: "id",
    columns: [
      "metadata_json",
      "repo_locator_json",
      "reference_json",
      "retention_json",
    ],
  },
  { table: "artifact_aliases", key: "id", columns: ["locator_json"] },
  { table: "artifact_series", key: "id", columns: ["metadata_json"] },
  { table: "artifact_versions", key: "id", columns: ["metadata_json"] },
  { table: "artifact_links", key: "id", columns: ["metadata_json"] },
  {
    table: "graph_entities",
    key: "id",
    columns: [
      "labels_json",
      "summary_json",
      "detail_ref_json",
      "action_context_json",
      "visual_json",
    ],
  },
  { table: "graph_edges", key: "id", columns: ["metadata_json"] },
];

export async function runArtifactRepoIdentityAudit(options = {}) {
  const createdAt = new Date();
  const dbPath = path.resolve(expandHome(options.dbPath ?? process.env.MANDIBLE_DB ?? DEFAULT_DB));
  assertNotProductionDbUnderTest(dbPath);
  const outputDir = path.resolve(
    expandHome(options.outputDir ?? path.join(DEFAULT_OUTPUT_ROOT, formatTimestamp(createdAt))),
  );
  const reportPath = path.resolve(
    expandHome(options.reportPath ?? path.join(outputDir, "artifact-repo-identity-audit.json")),
  );

  if (!fs.existsSync(dbPath)) {
    throw new Error(`Mandible DB does not exist: ${dbPath}`);
  }

  if (options.apply) {
    return runArtifactRepoIdentityApply({
      ...options,
      dbPath,
      outputDir,
      reportPath,
      createdAt,
    });
  }

  const db = new Database(dbPath, { fileMustExist: true, readonly: true });
  db.pragma("busy_timeout = 5000");
  const report = buildArtifactRepoIdentityAudit(db, {
    dbPath,
    reportPath,
    createdAt,
    git: options.git,
  });
  db.close();

  await fsp.mkdir(path.dirname(reportPath), { recursive: true });
  await fsp.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function runArtifactRepoIdentityApply(options) {
  const backupPath = resolveBackupPath(options.backupPath);
  if (fs.existsSync(backupPath)) {
    throw new Error(`Refusing to overwrite existing backup: ${backupPath}`);
  }
  if (path.resolve(backupPath) === path.resolve(options.dbPath)) {
    throw new Error("Backup path must be different from the Mandible DB path.");
  }

  await fsp.mkdir(path.dirname(backupPath), { recursive: true });

  const db = new Database(options.dbPath, { fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");

  try {
    await db.backup(backupPath);

    const beforeReport = buildArtifactRepoIdentityAudit(db, {
      dbPath: options.dbPath,
      reportPath: options.reportPath,
      createdAt: options.createdAt,
      git: options.git,
    });
    const safeUpdates = beforeReport.safe_updates;
    if (safeUpdates.length === 0) {
      throw new Error("Refusing to apply: the fresh plan contains no safe updates.");
    }
    const unsafeSelections = safeUpdates.filter((update) => update.status !== "safe");
    if (unsafeSelections.length > 0) {
      throw new Error(`Refusing to apply: plan selected ${unsafeSelections.length} non-safe updates.`);
    }

    const applySafeUpdates = db.transaction((updates) => {
      db.pragma("foreign_keys = ON");
      return updates.map((update) => applySafeUpdate(db, update));
    });
    const applied = applySafeUpdates(safeUpdates);

    const afterReport = buildArtifactRepoIdentityAudit(db, {
      dbPath: options.dbPath,
      reportPath: options.reportPath,
      createdAt: new Date(),
      git: options.git,
    });

    const report = {
      ok: true,
      mode: "apply",
      mutates_db: true,
      created_at: (options.createdAt ?? new Date()).toISOString(),
      db_path: options.dbPath,
      report_path: options.reportPath,
      backup_path: backupPath,
      backup_method: "better-sqlite3 sqlite backup",
      applied_update_count: applied.length,
      before_summary: beforeReport.summary,
      after_summary: afterReport.summary,
      applied_updates: applied,
      skipped_counts: {
        needs_review_updates: beforeReport.needs_review_updates.length,
        blocked_updates: beforeReport.blocked_updates.length,
        unresolved_occurrences: beforeReport.unresolved.length,
        ambiguous_occurrences: beforeReport.ambiguous.length,
      },
      after_audit: afterReport,
    };

    await fsp.mkdir(path.dirname(options.reportPath), { recursive: true });
    await fsp.writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    db.close();
  }
}

function resolveBackupPath(backupPath) {
  if (typeof backupPath !== "string" || !backupPath.trim()) {
    throw new Error("Apply mode requires --backup <path>.");
  }
  return path.resolve(expandHome(backupPath));
}

function applySafeUpdate(db, update) {
  if (update.status !== "safe") {
    throw new Error(`Refusing non-safe update ${describeUpdate(update)} with status ${update.status}.`);
  }
  if (update.before === update.after) {
    throw new Error(`Refusing no-op safe update ${describeUpdate(update)}.`);
  }
  if (update.json_path) {
    return applyJsonSafeUpdate(db, update);
  }
  return applyColumnSafeUpdate(db, update);
}

function applyColumnSafeUpdate(db, update) {
  const sql = [
    `UPDATE ${quoteIdent(update.table)}`,
    `SET ${quoteIdent(update.column)} = ?`,
    "WHERE id = ?",
    `AND ${quoteIdent(update.column)} = ?`,
  ].join(" ");
  const result = db.prepare(sql).run(update.after, update.row_id, update.before);
  if (result.changes !== 1) {
    throw new Error(`Refusing stale or missing row while applying ${describeUpdate(update)}.`);
  }
  return appliedUpdateRecord(update);
}

function applyJsonSafeUpdate(db, update) {
  const row = db.prepare(
    `SELECT ${quoteIdent(update.column)} AS value FROM ${quoteIdent(update.table)} WHERE id = ?`,
  ).get(update.row_id);
  if (!row || typeof row.value !== "string") {
    throw new Error(`Refusing missing JSON row while applying ${describeUpdate(update)}.`);
  }
  const json = parseJson(row.value);
  if (!json) {
    throw new Error(`Refusing unparsable JSON while applying ${describeUpdate(update)}.`);
  }
  const current = getJsonPath(json, update.json_path);
  if (current !== update.before) {
    throw new Error(`Refusing stale JSON value while applying ${describeUpdate(update)}.`);
  }
  setJsonPath(json, update.json_path, update.after);
  const nextValue = JSON.stringify(json);
  const result = db.prepare(
    [
      `UPDATE ${quoteIdent(update.table)}`,
      `SET ${quoteIdent(update.column)} = ?`,
      "WHERE id = ?",
      `AND ${quoteIdent(update.column)} = ?`,
    ].join(" "),
  ).run(nextValue, update.row_id, row.value);
  if (result.changes !== 1) {
    throw new Error(`Refusing stale JSON row while applying ${describeUpdate(update)}.`);
  }
  return {
    ...appliedUpdateRecord(update),
    column_before: row.value,
    column_after: nextValue,
  };
}

function appliedUpdateRecord(update) {
  return {
    table: update.table,
    row_id: update.row_id,
    column: update.column,
    json_path: update.json_path ?? null,
    kind: update.kind,
    before: update.before,
    after: update.after,
    status: update.status,
  };
}

function describeUpdate(update) {
  const jsonPath = update.json_path ? `:${update.json_path}` : "";
  return `${update.table}.${update.column}${jsonPath}#${update.row_id}`;
}

function getJsonPath(value, jsonPath) {
  let cursor = value;
  for (const part of String(jsonPath).split(".")) {
    if (cursor == null) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function setJsonPath(value, jsonPath, nextValue) {
  const parts = String(jsonPath).split(".");
  let cursor = value;
  for (const part of parts.slice(0, -1)) {
    cursor = cursor[part];
    if (cursor == null || typeof cursor !== "object") {
      throw new Error(`Cannot set missing JSON path: ${jsonPath}`);
    }
  }
  cursor[parts.at(-1)] = nextValue;
}

export function buildArtifactRepoIdentityAudit(db, options = {}) {
  const registry = loadProjectRegistry(db, options.git);
  const artifactContext = loadArtifactContext(db);
  const artifactVersionContext = loadArtifactVersionContext(db);
  const artifactSeriesContext = loadArtifactSeriesContext(db, artifactContext, artifactVersionContext);
  const artifactUsageContext = loadArtifactUsageContext(db);
  const aliasIndex = loadAliasIndex(db);
  const auditScope = buildAuditScope(db);
  const occurrences = scanRepoIdentityOccurrences(
    db,
    artifactContext,
    artifactVersionContext,
    artifactSeriesContext,
  );
  const updates = occurrences.map((occurrence) =>
    planOccurrence(occurrence, registry, aliasIndex, artifactUsageContext, options.git),
  );
  markPlannedAliasCollisions(updates);

  const changed = updates.filter((update) => update.before !== update.after);
  const safe = changed.filter((update) => update.status === "safe");
  const deterministicWarning = changed.filter((update) => update.status === "deterministic_warning");
  const review = changed.filter((update) => update.status === "needs_review");
  const blocked = changed.filter((update) => update.status === "blocked");
  const aliasCollapse = changed.filter((update) => update.status === "alias_collapse");
  const alreadyCanonical = updates.filter((update) => update.status === "already_canonical");
  const unresolved = updates.filter((update) => update.status === "unresolved");
  const ambiguous = updates.filter((update) => update.status === "ambiguous");
  const invalidReferences = updates.filter((update) => update.status === "invalid_reference");
  const orphanMalformedArtifacts = updates.filter((update) => update.status === "orphan_malformed_repo_artifact");
  const aliasCollapsePlans = buildAliasCollapsePlans(aliasCollapse);
  const orphanMalformedPlans = buildOrphanMalformedArtifactPlans(orphanMalformedArtifacts);

  return {
    ok: true,
    mode: "dry_run",
    mutates_db: false,
    created_at: (options.createdAt ?? new Date()).toISOString(),
    db_path: options.dbPath ?? null,
    report_path: options.reportPath ?? null,
    summary: {
      projects_seen: registry.projects.length,
      registered_checkouts_seen: registry.checkouts.length,
      tables_scanned: auditScope.filter((entry) => entry.exists).length,
      repo_identity_occurrences: occurrences.length,
      already_canonical: alreadyCanonical.length,
      safe_updates: safe.length,
      deterministic_warning_updates: deterministicWarning.length,
      needs_review_updates: review.length,
      blocked_updates: blocked.length,
      alias_collapse_updates: aliasCollapse.length,
      alias_collapse_plans: aliasCollapsePlans.length,
      unresolved_occurrences: unresolved.length,
      ambiguous_occurrences: ambiguous.length,
      invalid_reference_occurrences: invalidReferences.length,
      orphan_malformed_repo_artifact_occurrences: orphanMalformedArtifacts.length,
      orphan_malformed_repo_artifacts: orphanMalformedPlans.length,
      alias_collisions: changed.filter((update) =>
        update.blockers.some((blocker) => blocker.kind === "alias_collision"),
      ).length,
      hash_mismatches: changed.filter((update) =>
        update.blockers.some((blocker) => blocker.kind === "hash_mismatch"),
      ).length,
      missing_commit_or_path: changed.filter((update) =>
        update.warnings.some((warning) => warning.kind === "missing_commit_path" || warning.kind === "missing_path"),
      ).length,
    },
    audit_scope: auditScope,
    safe_updates: safe,
    deterministic_warning_updates: deterministicWarning,
    needs_review_updates: review,
    blocked_updates: blocked,
    alias_collapse_updates: aliasCollapse,
    alias_collapse_plans: aliasCollapsePlans,
    unresolved,
    ambiguous,
    invalid_references: invalidReferences,
    orphan_malformed_repo_artifact_updates: orphanMalformedArtifacts,
    orphan_malformed_repo_artifacts: orphanMalformedPlans,
    already_canonical: alreadyCanonical.slice(0, 80),
    registry_evidence: registry.projects.map((project) => ({
      project_id: project.project_id,
      project_key: project.project_key,
      display_name: project.display_name,
      remote_identity: project.remote_identity,
      checkout_roots: project.checkouts.map((checkout) => checkout.root).filter(Boolean),
      work_repo_ids: project.checkouts.map((checkout) => checkout.work_repo_id).filter(Boolean),
    })),
  };
}

function buildAuditScope(db) {
  const targets = [
    { table: "artifacts", columns: ["uri", "home_repo_id", "repo_locator_json", "metadata_json", "reference_json"] },
    { table: "artifact_aliases", columns: ["alias", "normalized_ref", "locator_json"] },
    { table: "artifact_series", columns: ["repo_id", "series_key", "metadata_json"] },
    { table: "artifact_versions", columns: ["commit_sha", "repo_path", "observed_path", "metadata_json"] },
    { table: "artifact_links", columns: ["repo_id", "series_ref", "metadata_json"] },
    { table: "graph_entities", columns: ["repo_id", "summary_json", "detail_ref_json", "action_context_json"] },
    { table: "graph_edges", columns: ["metadata_json"] },
  ];
  return targets.map((target) => {
    if (!tableExists(db, target.table)) {
      return { table: target.table, exists: false, rows_scanned: 0, columns_scanned: [] };
    }
    const columns = tableColumns(db, target.table);
    const scanned = target.columns.filter((column) => columns.has(column));
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdent(target.table)}`).get();
    return {
      table: target.table,
      exists: true,
      rows_scanned: row?.count ?? 0,
      columns_scanned: scanned,
    };
  });
}

function scanRepoIdentityOccurrences(db, artifactContext, artifactVersionContext, artifactSeriesContext) {
  const occurrences = [];
  scanArtifacts(db, artifactContext, artifactVersionContext, occurrences);
  scanArtifactAliases(db, artifactContext, artifactVersionContext, occurrences);
  scanArtifactSeries(db, artifactSeriesContext, occurrences);
  scanArtifactVersions(db, artifactContext, occurrences);
  scanArtifactLinks(db, artifactContext, artifactVersionContext, occurrences);
  scanGraphTables(db, artifactContext, artifactVersionContext, occurrences);
  scanJsonTables(db, artifactContext, artifactVersionContext, artifactSeriesContext, occurrences);
  return dedupeOccurrences(occurrences);
}

function scanArtifacts(db, artifactContext, artifactVersionContext, occurrences) {
  if (!tableExists(db, "artifacts")) return;
  const columns = tableColumns(db, "artifacts");
  const select = available(columns, [
    "id",
    "algorithm",
    "content_hash",
    "uri",
    "home_repo_id",
    "repo_locator_json",
    "metadata_json",
    "reference_json",
  ]);
  const rows = selectRows(db, "artifacts", select);
  for (const row of rows) {
    const context = {
      artifact_id: row.id,
      algorithm: row.algorithm,
      content_hash: row.content_hash,
      ...artifactContext.get(row.id),
      ...versionHints(artifactVersionContext.get(row.id)),
    };
    if (typeof row.uri === "string" && parseRepoUri(row.uri)) {
      occurrences.push(makeOccurrence(row, {
        table: "artifacts",
        row_id: row.id,
        column: "uri",
        kind: "repo_uri",
        value: parseRepoUri(row.uri).repo_id,
        before: row.uri,
        context: { ...context, ...repoUriContext(row.uri) },
      }));
    }
    if (typeof row.home_repo_id === "string" && row.home_repo_id.trim()) {
      occurrences.push(makeOccurrence(row, {
        table: "artifacts",
        row_id: row.id,
        column: "home_repo_id",
        kind: "repo_id",
        value: row.home_repo_id,
        before: row.home_repo_id,
        context,
      }));
    }
  }
}

function scanArtifactAliases(db, artifactContext, artifactVersionContext, occurrences) {
  if (!tableExists(db, "artifact_aliases")) return;
  const columns = tableColumns(db, "artifact_aliases");
  const select = available(columns, [
    "id",
    "artifact_id",
    "scheme",
    "alias",
    "normalized_ref",
    "locator_json",
    "resolution_status",
  ]);
  const rows = selectRows(db, "artifact_aliases", select);
  for (const row of rows) {
    const artifact = artifactContext.get(row.artifact_id) ?? {};
    const context = {
      artifact_id: row.artifact_id,
      alias_id: row.id,
      alias_scheme: row.scheme,
      ...artifact,
      ...versionHints(artifactVersionContext.get(row.artifact_id)),
    };
    for (const column of ["alias", "normalized_ref"]) {
      const value = row[column];
      if (typeof value !== "string" || !parseRepoUri(value)) continue;
      occurrences.push(makeOccurrence(row, {
        table: "artifact_aliases",
        row_id: row.id,
        column,
        kind: "repo_uri",
        value: parseRepoUri(value).repo_id,
        before: value,
        context: { ...context, ...repoUriContext(value) },
      }));
    }
  }
}

function scanArtifactSeries(db, artifactSeriesContext, occurrences) {
  if (!tableExists(db, "artifact_series")) return;
  const columns = tableColumns(db, "artifact_series");
  const rows = selectRows(db, "artifact_series", available(columns, [
    "id",
    "series_key",
    "repo_id",
    "logical_name",
    "metadata_json",
  ]));
  for (const row of rows) {
    const context = {
      series_id: row.id,
      path: row.logical_name,
      ...artifactSeriesContext.get(row.id),
    };
    if (typeof row.repo_id === "string" && row.repo_id.trim()) {
      occurrences.push(makeOccurrence(row, {
        table: "artifact_series",
        row_id: row.id,
        column: "repo_id",
        kind: "repo_id",
        value: row.repo_id,
        before: row.repo_id,
        context,
      }));
    }
    if (typeof row.series_key === "string" && parseRepoUri(row.series_key)) {
      occurrences.push(makeOccurrence(row, {
        table: "artifact_series",
        row_id: row.id,
        column: "series_key",
        kind: "repo_uri",
        value: parseRepoUri(row.series_key).repo_id,
        before: row.series_key,
        context: { ...context, ...repoUriContext(row.series_key) },
      }));
    }
  }
}

function scanArtifactVersions(db, artifactContext, occurrences) {
  if (!tableExists(db, "artifact_versions")) return;
  const columns = tableColumns(db, "artifact_versions");
  const rows = selectRows(db, "artifact_versions", available(columns, [
    "id",
    "series_id",
    "artifact_id",
    "commit_sha",
    "repo_path",
    "observed_path",
    "metadata_json",
  ]));
  for (const row of rows) {
    const artifact = artifactContext.get(row.artifact_id) ?? {};
    const observedPath = typeof row.observed_path === "string" ? row.observed_path : null;
    const inferredRoot = observedPath && row.repo_path
      ? observedPath.slice(0, Math.max(0, observedPath.length - String(row.repo_path).length)).replace(/\/$/, "")
      : null;
    const context = {
      artifact_id: row.artifact_id,
      series_id: row.series_id,
      commit: row.commit_sha,
      path: row.repo_path,
      root: artifact.root ?? inferredRoot,
      content_hash: artifact.content_hash,
      algorithm: artifact.algorithm,
    };
    const json = parseJson(row.metadata_json);
    if (json) collectJsonOccurrences(json, {
      table: "artifact_versions",
      row_id: row.id,
      column: "metadata_json",
      context,
      occurrences,
    });
  }
}

function scanArtifactLinks(db, artifactContext, artifactVersionContext, occurrences) {
  if (!tableExists(db, "artifact_links")) return;
  const columns = tableColumns(db, "artifact_links");
  const rows = selectRows(db, "artifact_links", available(columns, [
    "id",
    "artifact_id",
    "entity_type",
    "entity_id",
    "repo_id",
    "series_id",
    "series_ref",
    "metadata_json",
  ]));
  for (const row of rows) {
    const artifact = artifactContext.get(row.artifact_id) ?? {};
    const context = {
      artifact_id: row.artifact_id,
      series_id: row.series_id,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      ...artifact,
      ...versionHints(artifactVersionContext.get(row.artifact_id)),
    };
    if (typeof row.repo_id === "string" && row.repo_id.trim()) {
      occurrences.push(makeOccurrence(row, {
        table: "artifact_links",
        row_id: row.id,
        column: "repo_id",
        kind: "repo_id",
        value: row.repo_id,
        before: row.repo_id,
        context,
      }));
    }
    if (typeof row.series_ref === "string" && parseRepoUri(row.series_ref)) {
      occurrences.push(makeOccurrence(row, {
        table: "artifact_links",
        row_id: row.id,
        column: "series_ref",
        kind: "repo_uri",
        value: parseRepoUri(row.series_ref).repo_id,
        before: row.series_ref,
        context: { ...context, ...repoUriContext(row.series_ref) },
      }));
    }
  }
}

function scanGraphTables(db, artifactContext, artifactVersionContext, occurrences) {
  if (tableExists(db, "graph_entities")) {
    const columns = tableColumns(db, "graph_entities");
    const rows = selectRows(db, "graph_entities", available(columns, [
      "id",
      "entity_type",
      "repo_id",
      "external_id",
      "detail_ref_json",
      "action_context_json",
      "summary_json",
    ]));
    for (const row of rows) {
      const graphArtifactId = row.entity_type === "artifact" ? row.id : null;
      const artifact = artifactContext.get(row.external_id) ?? artifactContext.get(graphArtifactId) ?? {};
      const context = {
        graph_entity_id: row.id,
        entity_type: row.entity_type,
        external_id: row.external_id,
        ...artifact,
        ...versionHints(artifactVersionContext.get(row.external_id)),
      };
      if (typeof row.repo_id === "string" && row.repo_id.trim()) {
        occurrences.push(makeOccurrence(row, {
          table: "graph_entities",
          row_id: row.id,
          column: "repo_id",
          kind: "repo_id",
          value: row.repo_id,
          before: row.repo_id,
          context,
        }));
      }
    }
  }
}

function scanJsonTables(db, artifactContext, artifactVersionContext, artifactSeriesContext, occurrences) {
  for (const target of JSON_SCAN_TABLES) {
    if (!tableExists(db, target.table)) continue;
    const columns = tableColumns(db, target.table);
    const jsonColumns = target.columns.filter((column) => columns.has(column));
    if (jsonColumns.length === 0 || !columns.has(target.key)) continue;
    const contextColumns = available(columns, [
      "artifact_id",
      "content_hash",
      "algorithm",
      "commit_sha",
      "repo_path",
      "observed_path",
      "entity_type",
      "entity_id",
      "series_id",
      "external_id",
    ]);
    const rows = selectRows(db, target.table, [target.key, ...jsonColumns, ...contextColumns]);
    for (const row of rows) {
      const ownArtifactId = target.table === "artifacts" ? row[target.key] : null;
      const graphArtifactId = target.table === "graph_entities" && row.entity_type === "artifact"
        ? row[target.key]
        : null;
      const artifactId = row.artifact_id ?? ownArtifactId ?? graphArtifactId;
      const artifact = artifactContext.get(artifactId) ?? {};
      const externalArtifact = artifactContext.get(row.external_id) ?? {};
      const series = artifactSeriesContext.get(row.series_id) ?? {};
      const context = {
        artifact_id: artifactId,
        content_hash: row.content_hash ?? artifact.content_hash ?? externalArtifact.content_hash,
        algorithm: row.algorithm ?? artifact.algorithm ?? externalArtifact.algorithm,
        commit: row.commit_sha,
        path: row.repo_path,
        observed_path: row.observed_path,
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        series_id: row.series_id,
        ...artifact,
        ...externalArtifact,
        ...series,
        ...versionHints(artifactVersionContext.get(row.artifact_id)),
        ...versionHints(artifactVersionContext.get(row.external_id)),
      };
      for (const column of jsonColumns) {
        const json = parseJson(row[column]);
        if (!json) continue;
        collectJsonOccurrences(json, {
          table: target.table,
          row_id: row[target.key],
          column,
          context,
          occurrences,
        });
      }
    }
  }
}

function collectJsonOccurrences(value, state, pathParts = [], nearestContext = {}) {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectJsonOccurrences(item, state, [...pathParts, String(index)], nearestContext),
    );
    return;
  }
  if (value && typeof value === "object") {
    const localContext = { ...nearestContext, ...contextFromObject(value) };
    for (const [key, child] of Object.entries(value)) {
      const jsonPath = [...pathParts, key];
      if (REPO_ID_KEYS.has(key) && typeof child === "string" && child.trim()) {
        state.occurrences.push({
          table: state.table,
          row_id: String(state.row_id),
          column: state.column,
          json_path: jsonPath.join("."),
          kind: "repo_id",
          value: child,
          before: child,
          context: { ...state.context, ...localContext },
        });
      } else if (typeof child === "string" && parseRepoUri(child)) {
        state.occurrences.push({
          table: state.table,
          row_id: String(state.row_id),
          column: state.column,
          json_path: jsonPath.join("."),
          kind: "repo_uri",
          value: parseRepoUri(child).repo_id,
          before: child,
          context: { ...state.context, ...localContext, ...repoUriContext(child) },
        });
      }
      collectJsonOccurrences(child, state, jsonPath, localContext);
    }
  }
}

function planOccurrence(occurrence, registry, aliasIndex, artifactUsageContext, git) {
  if (isInvalidRepoReference(occurrence)) {
    const malformedArtifact = classifyOrphanMalformedRepoArtifact(occurrence, artifactUsageContext);
    return {
      table: occurrence.table,
      row_id: occurrence.row_id,
      column: occurrence.column,
      json_path: occurrence.json_path ?? null,
      kind: occurrence.kind,
      before: occurrence.before,
      after: occurrence.before,
      context: compactContext(occurrence.context),
      status: malformedArtifact ? "orphan_malformed_repo_artifact" : "invalid_reference",
      resolution: {
        status: malformedArtifact ? "orphan_malformed_repo_artifact" : "invalid_reference",
        reason: malformedArtifact ? "orphan_malformed_repo_artifact" : "malformed_repo_reference",
        repo_ref: String(occurrence.value ?? ""),
      },
      evidence: [],
      warnings: [{ kind: "invalid_reference", detail: "repo reference is syntactically garbage, not a project identity" }],
      blockers: [],
      validation: null,
      orphan_malformed_repo_artifact: malformedArtifact,
    };
  }

  const resolution = resolveCanonicalProject(occurrence, registry, git);
  const base = {
    table: occurrence.table,
    row_id: occurrence.row_id,
    column: occurrence.column,
    json_path: occurrence.json_path ?? null,
    kind: occurrence.kind,
    before: occurrence.before,
    after: occurrence.before,
    context: compactContext(occurrence.context),
    status: "unresolved",
    resolution: reportableResolution(resolution),
    evidence: resolution.evidence ?? [],
    warnings: [],
    blockers: [],
    validation: null,
  };

  if (resolution.status === "ambiguous") return { ...base, status: "ambiguous" };
  if (resolution.status !== "resolved") return base;

  const canonical = resolution.project.project_key;
  const after = occurrence.kind === "repo_uri"
    ? rewriteRepoUri(occurrence.before, canonical)
    : canonical;
  base.after = after;
  if (after === occurrence.before) {
    return { ...base, status: "already_canonical" };
  }

  const validation = validateRepoPath(occurrence, resolution.project, git);
  base.validation = validation;
  base.warnings.push(...validation.warnings);
  base.blockers.push(...validation.blockers);

  const aliasCollision = detectAliasCollision(occurrence, after, aliasIndex);
  if (aliasCollision) base.blockers.push(aliasCollision);

  if (base.blockers.length > 0) return { ...base, status: "blocked" };
  const deterministicWarning = classifyDeterministicWarningRepair(
    occurrence,
    resolution.project,
    canonical,
    validation,
    git,
  );
  if (deterministicWarning) {
    return {
      ...base,
      status: "deterministic_warning",
      repair_category: deterministicWarning.kind,
      repair_evidence: deterministicWarning,
    };
  }
  if (base.warnings.length > 0) return { ...base, status: "needs_review" };
  return { ...base, status: "safe" };
}

function classifyDeterministicWarningRepair(occurrence, project, canonical, validation, git) {
  if (validation.blockers.length > 0 || validation.warnings.length === 0) return null;
  if (!validation.warnings.every((warning) =>
    warning.kind === "missing_commit_path" || warning.kind === "missing_path"
  )) {
    return null;
  }

  if (
    occurrence.table === "artifact_links" &&
    occurrence.column === "repo_id" &&
    occurrence.context?.repo_id === canonical
  ) {
    return {
      kind: "link_repo_inferred_from_artifact_home_repo",
      detail: "linked artifact already has the canonical project; link owner repair does not require blob validation",
      artifact_id: occurrence.context?.artifact_id ?? null,
      artifact_home_repo_id: occurrence.context?.repo_id ?? null,
    };
  }

  const canonicalValidation = validateCanonicalCheckoutPath(occurrence, project, git);
  if (canonicalValidation?.checks?.content_hash_match === true || (
    canonicalValidation?.checks?.commit_path_reachable === true &&
    !occurrence.context?.content_hash
  )) {
    return {
      kind: "validated_via_canonical_checkout",
      detail: "canonical checkout validates the ref/path despite stale occurrence root warnings",
      validation: canonicalValidation,
    };
  }
  return null;
}

function validateCanonicalCheckoutPath(occurrence, project, git) {
  const canonicalRoots = canonicalCheckoutRoots(project);
  if (canonicalRoots.length === 0) return null;
  const locator = repoLocatorFromOccurrence(occurrence);
  const ref = locator.ref || occurrence.context?.commit || occurrence.context?.ref || null;
  const repoPath = locator.path || occurrence.context?.path || null;
  if (!ref || !repoPath) return null;
  const checks = {
    root: canonicalRoots[0],
    ref,
    path: repoPath,
    content_hash: occurrence.context?.content_hash ?? null,
    root_candidates: canonicalRoots,
    validated_root: null,
    commit_path_reachable: null,
    worktree_path_exists: null,
    content_hash_match: null,
  };
  const warnings = [];
  const blockers = [];
  validateCommitPath(
    canonicalRoots,
    ref,
    repoPath,
    occurrence.context?.content_hash ?? null,
    occurrence.context?.algorithm ?? "sha256",
    git,
    checks,
    warnings,
    blockers,
  );
  return { checks, warnings, blockers };
}

function canonicalCheckoutRoots(project) {
  const roots = [];
  const add = (root) => {
    if (typeof root !== "string" || !root.trim()) return;
    const resolved = path.resolve(root);
    if (!roots.includes(resolved)) roots.push(resolved);
  };
  for (const checkout of project.checkouts) {
    if (checkout.work_repo_id === project.project_key) add(checkout.root);
  }
  for (const checkout of project.checkouts) {
    if (checkout.root && !path.resolve(checkout.root).split(path.sep).includes("worktrees")) add(checkout.root);
  }
  return roots;
}

function classifyOrphanMalformedRepoArtifact(occurrence, artifactUsageContext) {
  const artifactId = occurrence.context?.artifact_id;
  if (!artifactId) return null;
  const usage = artifactUsageContext.get(artifactId);
  if (!usage || usage.artifact_links > 0 || usage.graph_edges > 0) return null;
  if (usage.algorithm !== "ref-sha256") return null;
  return {
    artifact_id: artifactId,
    action: "delete_or_quarantine_record_set",
    artifact_links: usage.artifact_links,
    graph_edges: usage.graph_edges,
    alias_count: usage.aliases,
    version_count: usage.versions,
    series_ids: Array.from(usage.series_ids).sort(),
  };
}

function reportableResolution(resolution) {
  if (resolution.status !== "resolved") return resolution;
  return {
    status: resolution.status,
    repo_ref: resolution.repo_ref,
    project: compactProject(resolution.project),
    evidence: resolution.evidence,
  };
}

function compactProject(project) {
  return {
    project_id: project.project_id,
    project_key: project.project_key,
    display_name: project.display_name,
    remote_identity: project.remote_identity,
    checkout_roots: project.checkouts.map((checkout) => checkout.root).filter(Boolean),
    work_repo_ids: project.checkouts.map((checkout) => checkout.work_repo_id).filter(Boolean),
  };
}

function resolveCanonicalProject(occurrence, registry, git) {
  const repoRef = String(occurrence.value ?? "").trim();
  const candidates = new Map();
  const add = (project, matchedBy, detail) => {
    if (!project) return;
    const existing = candidates.get(project.project_id);
    if (existing) {
      existing.evidence.push({ matched_by: matchedBy, detail });
      return;
    }
    candidates.set(project.project_id, {
      project,
      evidence: [{ matched_by: matchedBy, detail }],
    });
  };

  if (repoRef) {
    for (const row of registry.indexByRef.get(repoRef) ?? []) {
      add(row.project, row.matched_by, repoRef);
    }
    const normalized = normalizeRemoteIdentity(repoRef);
    if (normalized) {
      for (const project of registry.indexByRemote.get(normalized) ?? []) {
        add(project, "remote_identity", normalized);
      }
    }
  }

  const root = occurrence.context?.root;
  if (root) {
    const rootResolution = resolveProjectByRoot(registry, root, git);
    for (const candidate of rootResolution) add(candidate.project, candidate.matched_by, candidate.detail);
  }

  if (candidates.size === 0) {
    return {
      status: "unresolved",
      reason: "unknown_repo_identity",
      repo_ref: repoRef,
      evidence: [],
    };
  }
  if (candidates.size > 1) {
    return {
      status: "ambiguous",
      reason: "multiple_project_candidates",
      repo_ref: repoRef,
      candidates: Array.from(candidates.values())
        .map((candidate) => candidate.project.project_key)
        .sort(),
      evidence: Array.from(candidates.values()).flatMap((candidate) => candidate.evidence),
    };
  }

  const [candidate] = Array.from(candidates.values());
  return {
    status: "resolved",
    repo_ref: repoRef,
    project: candidate.project,
    evidence: candidate.evidence,
  };
}

function validateRepoPath(occurrence, project, git) {
  const context = occurrence.context ?? {};
  const locator = repoLocatorFromOccurrence(occurrence);
  const rootCandidates = candidateRoots(context.root, project);
  const root = rootCandidates[0] ?? null;
  const ref = locator.ref || context.commit || context.ref || null;
  const repoPath = locator.path || context.path || null;
  const contentHash = context.content_hash ?? null;
  const algorithm = context.algorithm ?? "sha256";
  const warnings = [];
  const blockers = [];
  const checks = {
    root,
    ref,
    path: repoPath,
    content_hash: contentHash,
    root_candidates: rootCandidates,
    validated_root: null,
    commit_path_reachable: null,
    worktree_path_exists: null,
    content_hash_match: null,
  };

  if (!repoPath) {
    if (occurrence.kind === "repo_uri" || occurrence.table === "artifacts") {
      warnings.push({ kind: "missing_path", detail: "no repository path was available for verification" });
    }
    return { checks, warnings, blockers };
  }
  if (!root) {
    warnings.push({ kind: "missing_root", detail: "no registered checkout root was available for verification" });
    return { checks, warnings, blockers };
  }

  if (ref) validateCommitPath(rootCandidates, ref, repoPath, contentHash, algorithm, git, checks, warnings, blockers);
  else validateWorktreePath(rootCandidates, repoPath, contentHash, algorithm, checks, warnings, blockers);

  return { checks, warnings, blockers };
}

function candidateRoots(contextRoot, project) {
  const roots = [];
  const add = (root) => {
    if (typeof root !== "string" || !root.trim()) return;
    const resolved = path.resolve(root);
    if (!roots.includes(resolved)) roots.push(resolved);
  };
  add(contextRoot);
  for (const checkout of project.checkouts) add(checkout.root);
  return roots;
}

function validateCommitPath(rootCandidates, ref, repoPath, contentHash, algorithm, git, checks, warnings, blockers) {
  const mismatches = [];
  for (const candidateRoot of rootCandidates) {
    const content = runGitBuffer(candidateRoot, ["show", `${ref}:${repoPath}`], git);
    if (!content.ok) continue;
    checks.root = candidateRoot;
    checks.validated_root = candidateRoot;
    checks.commit_path_reachable = true;
    if (contentHash && algorithm === "sha256") {
      const actual = createHash("sha256").update(content.stdout).digest("hex");
      checks.content_hash_match = actual === contentHash;
      if (actual === contentHash) return;
      mismatches.push({ root: candidateRoot, actual });
      continue;
    }
    return;
  }
  checks.commit_path_reachable = false;
  if (mismatches.length > 0) {
    const mismatch = mismatches[0];
    checks.validated_root = mismatch.root;
    checks.content_hash_match = false;
    blockers.push({
      kind: "hash_mismatch",
      detail: `sha256 mismatch for ${ref}:${repoPath}`,
      expected: contentHash,
      actual: mismatch.actual,
      root: mismatch.root,
    });
    return;
  }
  warnings.push({
    kind: "missing_commit_path",
    detail: `git show could not read ${ref}:${repoPath}`,
  });
}

function validateWorktreePath(rootCandidates, repoPath, contentHash, algorithm, checks, warnings, blockers) {
  const mismatches = [];
  for (const candidateRoot of rootCandidates) {
    const candidatePath = path.resolve(candidateRoot, repoPath);
    const inside = isPathInside(candidatePath, path.resolve(candidateRoot));
    const exists = inside && fs.existsSync(candidatePath);
    if (!exists) continue;
    checks.root = candidateRoot;
    checks.validated_root = candidateRoot;
    checks.worktree_path_exists = true;
    if (contentHash && algorithm === "sha256") {
      const actual = fileSha256(candidatePath);
      checks.content_hash_match = actual === contentHash;
      if (actual === contentHash) return;
      mismatches.push({ root: candidateRoot, actual });
      continue;
    }
    return;
  }
  checks.worktree_path_exists = false;
  if (mismatches.length > 0) {
    const mismatch = mismatches[0];
    checks.validated_root = mismatch.root;
    checks.content_hash_match = false;
    blockers.push({
      kind: "hash_mismatch",
      detail: `sha256 mismatch for ${repoPath}`,
      expected: contentHash,
      actual: mismatch.actual,
      root: mismatch.root,
    });
    return;
  }
  warnings.push({
    kind: "missing_path",
    detail: `worktree path was not found: ${repoPath}`,
  });
}

function detectAliasCollision(occurrence, after, aliasIndex) {
  if (occurrence.table !== "artifact_aliases") return null;
  if (!["alias", "normalized_ref"].includes(occurrence.column)) return null;
  const scheme = occurrence.context?.alias_scheme ?? "repo";
  const key = aliasKey(scheme, after);
  const existing = aliasIndex.get(key);
  const colliding = existing?.filter((row) => row.id !== occurrence.row_id) ?? [];
  if (colliding.length === 0) return null;
  return {
    kind: "alias_collision",
    detail: `proposed ${scheme} alias already exists`,
    aliases: colliding.map((row) => ({ id: row.id, artifact_id: row.artifact_id })),
  };
}

function markPlannedAliasCollisions(updates) {
  const byTarget = new Map();
  for (const update of updates) {
    if (update.table !== "artifact_aliases") continue;
    if (!["alias", "normalized_ref"].includes(update.column)) continue;
    if (update.before === update.after || update.status === "unresolved" || update.status === "ambiguous") continue;
    const scheme = update.context?.alias_scheme ?? "repo";
    const key = aliasKey(scheme, update.after);
    const bucket = byTarget.get(key) ?? [];
    bucket.push(update);
    byTarget.set(key, bucket);
  }
  for (const bucket of byTarget.values()) {
    const distinctRows = new Set(bucket.map((update) => update.row_id));
    if (distinctRows.size <= 1) continue;
    if (canCollapseAliasBucket(bucket)) {
      const plan = aliasCollapsePlanForBucket(bucket);
      for (const update of bucket) {
        update.status = "alias_collapse";
        update.alias_collapse = plan;
        update.warnings.push({
          kind: "alias_collapse_required",
          detail: "duplicate alias rows converge on one canonical alias for the same artifact/content",
        });
      }
      continue;
    }
    for (const update of bucket) {
      update.blockers.push({
        kind: "alias_collision",
        detail: "multiple planned alias rewrites converge on the same target",
        aliases: bucket.map((item) => ({ id: item.row_id, artifact_id: item.context?.artifact_id })),
      });
      update.status = "blocked";
    }
  }
}

function canCollapseAliasBucket(bucket) {
  const rowArtifacts = new Map();
  const rowHashes = new Map();
  for (const update of bucket) {
    if (update.blockers.length > 0) return false;
    rowArtifacts.set(update.row_id, update.context?.artifact_id ?? null);
    rowHashes.set(update.row_id, update.context?.content_hash ?? null);
  }
  const artifacts = new Set(rowArtifacts.values());
  const hashes = new Set(rowHashes.values());
  return artifacts.size === 1 && !artifacts.has(null) && hashes.size === 1 && !hashes.has(null);
}

function aliasCollapsePlanForBucket(bucket) {
  const rows = Array.from(new Set(bucket.map((update) => update.row_id))).sort();
  const keep = rows[0];
  return {
    scheme: bucket[0].context?.alias_scheme ?? "repo",
    canonical_ref: bucket[0].after,
    artifact_id: bucket[0].context?.artifact_id ?? null,
    content_hash: bucket[0].context?.content_hash ?? null,
    keep_alias_id: keep,
    delete_alias_ids: rows.filter((row) => row !== keep),
    update_alias_ids: rows,
    update_count: bucket.length,
  };
}

function buildAliasCollapsePlans(updates) {
  const byRef = new Map();
  for (const update of updates) {
    const plan = update.alias_collapse;
    if (!plan) continue;
    const key = aliasKey(plan.scheme, plan.canonical_ref);
    if (!byRef.has(key)) byRef.set(key, plan);
  }
  return Array.from(byRef.values());
}

function buildOrphanMalformedArtifactPlans(updates) {
  const byArtifact = new Map();
  for (const update of updates) {
    const artifact = update.orphan_malformed_repo_artifact;
    if (!artifact?.artifact_id) continue;
    const plan = byArtifact.get(artifact.artifact_id) ?? {
      artifact_id: artifact.artifact_id,
      action: artifact.action,
      series_ids: artifact.series_ids,
      alias_count: artifact.alias_count,
      version_count: artifact.version_count,
      occurrence_count: 0,
      malformed_refs: [],
    };
    plan.occurrence_count += 1;
    if (!plan.malformed_refs.includes(update.before)) plan.malformed_refs.push(update.before);
    byArtifact.set(artifact.artifact_id, plan);
  }
  return Array.from(byArtifact.values()).sort((a, b) => a.artifact_id.localeCompare(b.artifact_id));
}

function loadProjectRegistry(db, git) {
  if (!tableExists(db, "ledger_projects")) {
    return { projects: [], checkouts: [], indexByRef: new Map(), indexByRemote: new Map() };
  }
  const projectColumns = tableColumns(db, "ledger_projects");
  const projectSelect = available(projectColumns, [
    "id",
    "project_key",
    "display_name",
    "remote_identity",
    "upstream_identity",
  ]);
  const projects = selectRows(db, "ledger_projects", projectSelect)
    .map((row) => ({
      project_id: row.id,
      project_key: row.project_key || row.display_name || row.id,
      display_name: row.display_name ?? "",
      remote_identity: row.remote_identity ?? "",
      upstream_identity: row.upstream_identity ?? "",
      checkouts: [],
    }));
  const byId = new Map(projects.map((project) => [project.project_id, project]));
  const checkouts = [];
  if (tableExists(db, "ledger_project_checkouts")) {
    const checkoutColumns = tableColumns(db, "ledger_project_checkouts");
    const checkoutSelect = available(checkoutColumns, [
      "id",
      "project_id",
      "work_repo_id",
      "root",
      "name",
      "default_branch",
      "remote_url",
    ]);
    for (const row of selectRows(db, "ledger_project_checkouts", checkoutSelect)) {
      const project = byId.get(row.project_id);
      if (!project) continue;
      const checkout = {
        id: row.id,
        project,
        project_id: row.project_id,
        work_repo_id: row.work_repo_id ?? null,
        root: row.root ? path.resolve(row.root) : null,
        name: row.name ?? null,
        default_branch: row.default_branch ?? null,
        remote_url: row.remote_url ?? null,
        git_common_dir: row.root ? gitCommonDir(row.root, git) : null,
        git_remote_identity: row.root ? normalizeRemoteIdentity(gitRemote(row.root, git)) : "",
      };
      project.checkouts.push(checkout);
      checkouts.push(checkout);
    }
  }

  const indexByRef = new Map();
  const indexByRemote = new Map();
  const addRef = (ref, project, matchedBy) => {
    if (!ref || typeof ref !== "string") return;
    const trimmed = ref.trim();
    if (!trimmed) return;
    const bucket = indexByRef.get(trimmed) ?? [];
    bucket.push({ project, matched_by: matchedBy });
    indexByRef.set(trimmed, bucket);
  };
  const addRemote = (ref, project) => {
    const normalized = normalizeRemoteIdentity(ref);
    if (!normalized) return;
    const bucket = indexByRemote.get(normalized) ?? [];
    if (!bucket.some((item) => item.project_id === project.project_id)) bucket.push(project);
    indexByRemote.set(normalized, bucket);
  };

  for (const project of projects) {
    addRef(project.project_id, project, "project_id");
    addRef(project.project_key, project, "project_key");
    addRef(project.display_name, project, "display_name");
    addRemote(project.remote_identity, project);
    addRemote(project.upstream_identity, project);
    for (const checkout of project.checkouts) {
      addRef(checkout.work_repo_id, project, "work_repo_id");
      addRef(checkout.name, project, "checkout_name");
      addRef(checkout.root, project, "checkout_root");
      addRemote(checkout.remote_url, project);
      addRemote(checkout.git_remote_identity, project);
    }
  }

  return { projects, checkouts, indexByRef, indexByRemote };
}

function resolveProjectByRoot(registry, root, git) {
  const resolved = path.resolve(root);
  const real = safeRealpath(resolved);
  const matches = [];
  for (const checkout of registry.checkouts) {
    if (!checkout.root) continue;
    const checkoutRoot = path.resolve(checkout.root);
    const checkoutReal = safeRealpath(checkoutRoot);
    if (checkoutRoot === resolved || checkoutRoot === real || checkoutReal === real) {
      matches.push({ project: checkout.project, matched_by: "checkout_root", detail: checkout.root });
    }
  }
  if (matches.length > 0) return matches;

  const common = gitCommonDir(resolved, git);
  if (common) {
    for (const checkout of registry.checkouts) {
      if (checkout.git_common_dir && checkout.git_common_dir === common) {
        matches.push({ project: checkout.project, matched_by: "git_common_dir", detail: common });
      }
    }
  }
  if (matches.length > 0) return matches;

  const remote = normalizeRemoteIdentity(gitRemote(resolved, git));
  if (remote) {
    for (const project of registry.indexByRemote.get(remote) ?? []) {
      matches.push({ project, matched_by: "remote_identity", detail: remote });
    }
  }
  if (matches.length > 0) return matches;

  for (const checkout of registry.checkouts) {
    if (!checkout.root) continue;
    const checkoutRoot = path.resolve(checkout.root);
    const checkoutReal = safeRealpath(checkout.root);
    if (
      isPathInside(resolved, checkoutRoot) ||
      isPathInside(checkoutRoot, resolved) ||
      isPathInside(real, checkoutReal) ||
      isPathInside(checkoutReal, real)
    ) {
      matches.push({ project: checkout.project, matched_by: "checkout_ancestry", detail: checkout.root });
    }
  }
  if (matches.length > 0) return matches;

  const worktreesIndex = resolved.split(path.sep).lastIndexOf("worktrees");
  if (worktreesIndex > 0 && worktreesIndex < resolved.split(path.sep).length - 1) {
    const canonicalRoot = resolved.split(path.sep).slice(0, worktreesIndex).join(path.sep) || path.sep;
    for (const checkout of registry.checkouts) {
      if (!checkout.root) continue;
      const checkoutRoot = path.resolve(checkout.root);
      if (checkoutRoot === canonicalRoot || safeRealpath(checkoutRoot) === safeRealpath(canonicalRoot)) {
        matches.push({ project: checkout.project, matched_by: "stale_worktree_parent", detail: canonicalRoot });
      }
    }
  }
  return matches;
}

function loadArtifactContext(db) {
  const context = new Map();
  if (!tableExists(db, "artifacts")) return context;
  const columns = tableColumns(db, "artifacts");
  const rows = selectRows(db, "artifacts", available(columns, [
    "id",
    "algorithm",
    "content_hash",
    "uri",
    "home_repo_id",
    "repo_locator_json",
    "metadata_json",
    "reference_json",
  ]));
  for (const row of rows) {
    const repoLocator = parseJson(row.repo_locator_json) ?? {};
    const metadata = parseJson(row.metadata_json) ?? {};
    const reference = parseJson(row.reference_json) ?? {};
    context.set(row.id, {
      artifact_id: row.id,
      algorithm: row.algorithm,
      content_hash: row.content_hash,
      repo_id: row.home_repo_id ?? repoLocator.repo_id,
      root: firstString(repoLocator, ROOT_KEYS) ?? firstString(metadata, ROOT_KEYS) ?? firstString(reference, ROOT_KEYS),
      path: firstString(repoLocator, PATH_KEYS) ?? firstString(metadata, PATH_KEYS) ?? firstString(reference, PATH_KEYS),
      ref: firstString(repoLocator, REF_KEYS) ?? firstString(metadata, REF_KEYS) ?? firstString(reference, REF_KEYS),
      commit: repoLocator.commit ?? repoLocator.commit_sha ?? metadata.commit_sha ?? reference.commit_sha,
    });
  }
  return context;
}

function loadArtifactVersionContext(db) {
  const byArtifact = new Map();
  if (!tableExists(db, "artifact_versions")) return byArtifact;
  const columns = tableColumns(db, "artifact_versions");
  const rows = selectRows(db, "artifact_versions", available(columns, [
    "id",
    "artifact_id",
    "series_id",
    "commit_sha",
    "repo_path",
    "observed_path",
    "content_hash",
  ]));
  for (const row of rows) {
    if (!row.artifact_id) continue;
    const existing = byArtifact.get(row.artifact_id) ?? [];
    existing.push({
      version_id: row.id,
      series_id: row.series_id,
      commit: row.commit_sha,
      path: row.repo_path,
      observed_path: row.observed_path,
      content_hash: row.content_hash,
    });
    byArtifact.set(row.artifact_id, existing);
  }
  return byArtifact;
}

function loadArtifactUsageContext(db) {
  const byArtifact = new Map();
  const ensure = (artifactId) => {
    if (!artifactId) return null;
    const existing = byArtifact.get(artifactId);
    if (existing) return existing;
    const usage = {
      algorithm: null,
      artifact_links: 0,
      graph_edges: 0,
      aliases: 0,
      versions: 0,
      series_ids: new Set(),
    };
    byArtifact.set(artifactId, usage);
    return usage;
  };

  if (tableExists(db, "artifacts")) {
    const columns = tableColumns(db, "artifacts");
    for (const row of selectRows(db, "artifacts", available(columns, ["id", "algorithm"]))) {
      const usage = ensure(row.id);
      if (usage) usage.algorithm = row.algorithm ?? null;
    }
  }
  if (tableExists(db, "artifact_links")) {
    const columns = tableColumns(db, "artifact_links");
    for (const row of selectRows(db, "artifact_links", available(columns, ["artifact_id"]))) {
      const usage = ensure(row.artifact_id);
      if (usage) usage.artifact_links += 1;
    }
  }
  if (tableExists(db, "artifact_aliases")) {
    const columns = tableColumns(db, "artifact_aliases");
    for (const row of selectRows(db, "artifact_aliases", available(columns, ["artifact_id"]))) {
      const usage = ensure(row.artifact_id);
      if (usage) usage.aliases += 1;
    }
  }
  if (tableExists(db, "artifact_versions")) {
    const columns = tableColumns(db, "artifact_versions");
    for (const row of selectRows(db, "artifact_versions", available(columns, ["artifact_id", "series_id"]))) {
      const usage = ensure(row.artifact_id);
      if (!usage) continue;
      usage.versions += 1;
      if (row.series_id) usage.series_ids.add(row.series_id);
    }
  }
  if (tableExists(db, "graph_edges")) {
    const columns = tableColumns(db, "graph_edges");
    for (const row of selectRows(db, "graph_edges", available(columns, ["source_id", "target_id"]))) {
      const sourceUsage = ensure(row.source_id);
      if (sourceUsage) sourceUsage.graph_edges += 1;
      const targetUsage = ensure(row.target_id);
      if (targetUsage) targetUsage.graph_edges += 1;
    }
  }
  return byArtifact;
}

function loadArtifactSeriesContext(db, artifactContext, artifactVersionContext) {
  const bySeries = new Map();
  if (!tableExists(db, "artifact_versions")) return bySeries;
  const columns = tableColumns(db, "artifact_versions");
  const rows = selectRows(db, "artifact_versions", available(columns, [
    "id",
    "artifact_id",
    "series_id",
    "commit_sha",
    "repo_path",
    "observed_path",
    "content_hash",
  ]));
  for (const row of rows) {
    if (!row.series_id) continue;
    const artifact = artifactContext.get(row.artifact_id) ?? {};
    const hint = versionHints(artifactVersionContext.get(row.artifact_id));
    const context = {
      artifact_id: row.artifact_id,
      series_id: row.series_id,
      version_id: row.id,
      commit: row.commit_sha ?? hint.commit,
      path: row.repo_path ?? hint.path,
      observed_path: row.observed_path ?? hint.observed_path,
      content_hash: row.content_hash ?? artifact.content_hash,
      algorithm: artifact.algorithm,
      root: artifact.root,
      ref: artifact.ref,
      ...artifact,
      ...hint,
    };
    const existing = bySeries.get(row.series_id);
    if (!existing || scoreContext(context) > scoreContext(existing)) bySeries.set(row.series_id, context);
  }
  return bySeries;
}

function scoreContext(context) {
  let score = 0;
  for (const key of ["root", "commit", "ref", "path", "content_hash", "artifact_id"]) {
    if (context[key]) score += 1;
  }
  return score;
}

function loadAliasIndex(db) {
  const index = new Map();
  if (!tableExists(db, "artifact_aliases")) return index;
  const columns = tableColumns(db, "artifact_aliases");
  const rows = selectRows(db, "artifact_aliases", available(columns, [
    "id",
    "artifact_id",
    "scheme",
    "normalized_ref",
  ]));
  for (const row of rows) {
    if (!row.scheme || !row.normalized_ref) continue;
    const key = aliasKey(row.scheme, row.normalized_ref);
    const bucket = index.get(key) ?? [];
    bucket.push({ id: row.id, artifact_id: row.artifact_id });
    index.set(key, bucket);
  }
  return index;
}

function makeOccurrence(_row, occurrence) {
  return {
    ...occurrence,
    row_id: String(occurrence.row_id),
    value: String(occurrence.value),
    before: String(occurrence.before),
  };
}

function dedupeOccurrences(occurrences) {
  const seen = new Set();
  const out = [];
  for (const occurrence of occurrences) {
    const key = [
      occurrence.table,
      occurrence.row_id,
      occurrence.column,
      occurrence.json_path ?? "",
      occurrence.kind,
      occurrence.before,
    ].join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(occurrence);
  }
  return out;
}

function contextFromObject(obj) {
  return compactNullableContext({
    repo_id: firstString(obj, ["repo_id", "home_repo_id"]),
    root: firstString(obj, ROOT_KEYS),
    path: firstString(obj, PATH_KEYS),
    ref: firstString(obj, REF_KEYS),
    commit: firstString(obj, ["commit", "commit_sha"]),
    content_hash: firstString(obj, HASH_KEYS),
    algorithm: firstString(obj, ["algorithm"]),
  });
}

function compactNullableContext(context) {
  const out = {};
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined && value !== null && value !== "") out[key] = value;
  }
  return out;
}

function repoUriContext(value) {
  const parsed = parseRepoUri(value);
  if (!parsed) return {};
  return { repo_id: parsed.repo_id, ref: parsed.ref, path: parsed.path };
}

function repoLocatorFromOccurrence(occurrence) {
  if (occurrence.kind !== "repo_uri") {
    return {
      repo_id: occurrence.value,
      ref: occurrence.context?.ref ?? null,
      path: occurrence.context?.path ?? null,
    };
  }
  return parseRepoUri(occurrence.before) ?? {};
}

function versionHints(versions) {
  if (!versions || versions.length === 0) return {};
  const withPath = versions.find((version) => version.path || version.commit);
  if (!withPath) return {};
  return {
    version_id: withPath.version_id,
    series_id: withPath.series_id,
    commit: withPath.commit,
    path: withPath.path,
    observed_path: withPath.observed_path,
  };
}

function parseRepoUri(value) {
  if (typeof value !== "string") return null;
  const match = value.match(REPO_URI_PATTERN);
  if (!match) return null;
  return {
    repo_id: match[1],
    ref: match[2] ?? null,
    path: match[3] ?? null,
  };
}

function isInvalidRepoReference(occurrence) {
  if (occurrence.kind !== "repo_uri") return false;
  const parsed = parseRepoUri(occurrence.before);
  if (!parsed) return false;
  return isGarbageRepoRef(parsed.repo_id);
}

function isGarbageRepoRef(repoRef) {
  if (typeof repoRef !== "string") return false;
  const trimmed = repoRef.trim();
  return trimmed === "" ||
    trimmed.includes("`") ||
    trimmed.includes("…") ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed === "..." ||
    /^\.{2,}/.test(trimmed);
}

function rewriteRepoUri(value, repoId) {
  const parsed = parseRepoUri(value);
  if (!parsed) return value;
  const ref = parsed.ref ? `@${parsed.ref}` : "";
  const repoPath = parsed.path ? `/${parsed.path}` : "";
  return `repo://${repoId}${ref}${repoPath}`;
}

function normalizeRemoteIdentity(remoteUrl) {
  const trimmed = remoteUrl?.trim();
  if (!trimmed) return "";
  const scpMatch = trimmed.match(/^(?:([^@/:]+)@)?([^:/]+):(.+)$/);
  if (scpMatch && !trimmed.includes("://")) {
    return normalizeHostPath(scpMatch[2], scpMatch[3]);
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "file:") return `file:${path.resolve(parsed.pathname)}`;
    return normalizeHostPath(parsed.hostname, parsed.pathname);
  } catch {
    return trimmed.replace(/\/+$/, "").replace(/\.git$/, "").toLowerCase();
  }
}

function normalizeHostPath(host, repoPath) {
  return `${host.toLowerCase()}${repoPath.replace(/^\/+/, "/").replace(/\/+$/, "").replace(/\.git$/, "")}`;
}

function gitCommonDir(root, git = runGitText) {
  const common = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return common.ok ? safeRealpath(common.stdout.trim()) : null;
}

function gitRemote(root, git = runGitText) {
  const remote = git(root, ["remote", "get-url", "origin"]);
  return remote.ok ? remote.stdout.trim() : "";
}

function runGitText(cwd, args) {
  try {
    return {
      ok: true,
      stdout: execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        stdio: ["ignore", "pipe", "ignore"],
      }),
    };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function runGitBuffer(cwd, args, git) {
  if (git) return git(cwd, args, { encoding: "buffer" });
  try {
    return {
      ok: true,
      stdout: execFileSync("git", ["-C", cwd, ...args], {
        encoding: "buffer",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        maxBuffer: GIT_BLOB_MAX_BUFFER,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    };
  } catch {
    return { ok: false, stdout: Buffer.alloc(0) };
  }
}

function tableExists(db, table) {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return Boolean(row);
}

function tableColumns(db, table) {
  return new Set((db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all()).map((row) => row.name));
}

function available(columns, names) {
  return names.filter((name) => columns.has(name));
}

function selectRows(db, table, columns) {
  if (columns.length === 0) return [];
  return db.prepare(
    `SELECT ${columns.map(quoteIdent).join(", ")} FROM ${quoteIdent(table)}`,
  ).all();
}

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function parseJson(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function firstString(obj, keys) {
  if (!obj || typeof obj !== "object") return null;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function safeRealpath(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function isPathInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function fileSha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function aliasKey(scheme, normalizedRef) {
  return `${scheme}\0${normalizedRef}`;
}

function compactContext(context = {}) {
  const out = {};
  for (const key of [
    "artifact_id",
    "alias_id",
    "alias_scheme",
    "series_id",
    "version_id",
    "entity_type",
    "entity_id",
    "graph_entity_id",
    "external_id",
    "repo_id",
    "root",
    "ref",
    "commit",
    "path",
    "observed_path",
    "content_hash",
    "algorithm",
  ]) {
    if (context[key] !== undefined && context[key] !== null && context[key] !== "") out[key] = context[key];
  }
  return out;
}

function expandHome(value) {
  if (typeof value !== "string") return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function formatTimestamp(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--db") options.dbPath = argv[++i];
    else if (arg === "--report") options.reportPath = argv[++i];
    else if (arg === "--output-dir") options.outputDir = argv[++i];
    else if (arg === "--backup" || arg === "--backup-path") options.backupPath = argv[++i];
    else if (arg === "--json") options.json = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--write" || arg === "--in-place") {
      throw new Error("Use --apply --backup <path>; write aliases are intentionally unsupported.");
    } else if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage: node scripts/audit-artifact-repo-identity.mjs [--db path] [--report path] [--apply --backup path]",
        "",
        "Audits artifact repository identity rows and writes a JSON repair plan.",
        "Apply mode writes only updates classified safe by a fresh plan and requires a backup path.",
      ].join("\n"));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = await runArtifactRepoIdentityAudit(args);
    console.log(JSON.stringify({
      ok: true,
      mode: report.mode,
      mutates_db: report.mutates_db,
      backup_path: report.backup_path,
      report_path: report.report_path,
      summary: report.summary ?? report.after_summary,
      before_summary: report.before_summary,
      after_summary: report.after_summary,
      applied_update_count: report.applied_update_count,
    }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
