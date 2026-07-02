#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";

const DEFAULT_DB = path.join(os.homedir(), ".cache", "mandible", "mandible.db");
const DEFAULT_REPORT_NAME = "artifact-ref-repair-report.json";
const HASH_RE = "[a-f0-9]{7,64}";
const OLD_REF_PATTERN = new RegExp(
  [
    `artifact:sha256:(${HASH_RE})`,
    `sha256:(${HASH_RE})`,
    `artifact:(${HASH_RE})`,
    "artifact-series:[A-Za-z0-9][A-Za-z0-9_.:-]*(?:[@#][A-Za-z0-9_.:-]+)?",
  ].join("|"),
  "gi",
);
const ENCODED_OLD_REF_PATTERN = new RegExp(
  [
    `artifact%3Asha256%3A(${HASH_RE})`,
    `sha256%3A(${HASH_RE})`,
    `artifact%3A(${HASH_RE})`,
  ].join("|"),
  "gi",
);
const INVALID_ISSUE_TAGS = new Set([
  "reference",
  "references",
  "refs",
  "close",
  "closes",
  "closed",
  "closing",
  "resolve",
  "resolves",
  "resolved",
  "fix",
  "fixes",
  "fixed",
  "fixed_by",
  "block",
  "blocks",
  "blocked",
  "implements",
  "tests",
  "related",
  "duplicate_of",
  "caused_by",
  "parent_child",
]);

const CURRENT_LEDGER_TARGETS = [
  { table: "ledger_issues", key: "id", columns: [
    { name: "title", kind: "text" },
    { name: "body", kind: "text" },
    { name: "metadata_json", kind: "json" },
  ] },
  { table: "ledger_comments", key: "id", columns: [
    { name: "body", kind: "text" },
    { name: "metadata_json", kind: "json" },
  ] },
  { table: "ledger_body_revisions", key: "id", columns: [
    { name: "snapshot_body", kind: "text" },
    { name: "patch_text", kind: "text" },
    { name: "metadata_json", kind: "json" },
  ] },
  { table: "ledger_events", key: "id", columns: [
    { name: "payload_json", kind: "json" },
  ] },
  { table: "ledger_issue_relationships", key: "id", columns: [
    { name: "note", kind: "text" },
    { name: "metadata_json", kind: "json" },
  ] },
  { table: "ledger_issue_relationship_sources", key: "id", columns: [
    { name: "note", kind: "text" },
    { name: "metadata_json", kind: "json" },
  ] },
  { table: "auth_requests", key: "id", columns: [
    { name: "title", kind: "text" },
    { name: "diff_summary", kind: "text" },
    { name: "commit_message", kind: "text" },
    { name: "spec_content", kind: "text" },
    { name: "output", kind: "text" },
    { name: "error", kind: "text" },
    { name: "post_merge_handoff", kind: "text" },
  ] },
  { table: "auth_request_actions", key: "id", columns: [
    { name: "payload", kind: "json" },
    { name: "payload_json", kind: "json" },
  ] },
  { table: "work_units", key: "id", columns: [
    { name: "metadata_json", kind: "json" },
  ] },
  { table: "graph_entities", key: "id", columns: [
    { name: "id", kind: "text" },
    { name: "title", kind: "text" },
    { name: "detail_ref_json", kind: "json" },
    { name: "action_context_json", kind: "json" },
    { name: "summary_json", kind: "json" },
    { name: "metadata_json", kind: "json" },
  ] },
  { table: "graph_edges", key: "id", columns: [
    { name: "id", kind: "text" },
    { name: "source_id", kind: "text" },
    { name: "target_id", kind: "text" },
    { name: "metadata_json", kind: "json" },
  ] },
  { table: "knowledge_backrefs", key: "id", columns: [
    { name: "source_id", kind: "text" },
    { name: "external_ref", kind: "text" },
    { name: "metadata_json", kind: "json" },
  ] },
  { table: "provider_manifests", key: "id", columns: [
    { name: "content_json", kind: "json" },
  ] },
  { table: "space_items", key: "id", columns: [
    { name: "ref_id", kind: "text" },
    { name: "ref_uri", kind: "text" },
    { name: "metadata_json", kind: "json" },
  ] },
  { table: "space_blocks", key: "id", columns: [
    { name: "markdown", kind: "text" },
    { name: "item_snapshot_json", kind: "json" },
    { name: "metadata_json", kind: "json" },
  ] },
  { table: "space_occurrences", key: "id", columns: [
    { name: "item_snapshot_json", kind: "json" },
    { name: "metadata_json", kind: "json" },
  ] },
  { table: "space_edges", key: "id", columns: [
    { name: "source", kind: "text" },
    { name: "target", kind: "text" },
    { name: "metadata_json", kind: "json" },
  ] },
  { table: "artifact_blob", key: "id", columns: [
    { name: "storage_uri", kind: "text" },
    { name: "metadata_json", kind: "json" },
    { name: "reference_json", kind: "json" },
  ] },
  { table: "artifact_version", key: "id", columns: [
    { name: "note", kind: "text" },
    { name: "metadata_json", kind: "json" },
  ] },
  { table: "project_artifact_associations", key: "id", columns: [
    { name: "title", kind: "text" },
    { name: "description", kind: "text" },
    { name: "metadata_json", kind: "json" },
  ] },
  { table: "artifact_links", key: "id", columns: [
    { name: "metadata_json", kind: "json" },
  ] },
];

export async function runArtifactRefRepair(options = {}) {
  const dbPath = path.resolve(expandHome(options.dbPath ?? process.env.MANDIBLE_DB ?? DEFAULT_DB));
  const apply = Boolean(options.apply);
  const check = Boolean(options.check ?? options.failOnFindings);
  const reportPath = options.reportPath
    ? path.resolve(expandHome(options.reportPath))
    : null;
  const backupPath = apply ? resolveBackupPath(options.backupPath, dbPath) : null;
  const startedAt = new Date().toISOString();

  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database does not exist: ${dbPath}`);
  }

  const db = new Database(dbPath, { fileMustExist: true });
  db.pragma("busy_timeout = 5000");

  const report = {
    ok: true,
    mode: apply ? "apply" : "dry_run",
    check,
    check_failed: false,
    created_at: startedAt,
    db_path: dbPath,
    report_path: reportPath,
    backup_path: backupPath,
    summary: emptySummary(),
    findings: [],
    ledger_updates: [],
    structured_link_updates: [],
    artifact_version_appends: [],
    skipped_artifacts: [],
    skipped_targets: [],
    after_summary: null,
    after_findings: null,
    verification: null,
    after_verification: null,
    alias_deletes: [],
    integrity_check: null,
  };

  try {
    const resolver = buildResolver(db);
    planLedgerUpdates(db, resolver, report);
    planAliasDeletes(db, resolver, report);
    planStructuredLinkUpdates(db, resolver, report);
    planLatestArtifactContentUpdates(db, resolver, report);
    finalizeSummary(report);
    report.verification = verificationForSummary(report.summary);

    if (apply) {
      await backupDatabase(db, backupPath);
      applyPlannedChanges(db, report);
      report.integrity_check = db.pragma("integrity_check", { simple: true });
      const after = buildScanOnlyReport(db, resolver);
      report.after_summary = after.summary;
      report.after_findings = after.findings;
      report.after_verification = verificationForSummary(after.summary);
      report.check_failed = check && actionableFindingCount(after.summary) > 0;
    } else {
      report.check_failed = check && actionableFindingCount(report.summary) > 0;
    }
  } finally {
    db.close();
  }

  if (reportPath) {
    await fsp.mkdir(path.dirname(reportPath), { recursive: true });
    await fsp.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  return report;
}

function buildScanOnlyReport(db, resolver) {
  const report = {
    summary: emptySummary(),
    findings: [],
    ledger_updates: [],
    structured_link_updates: [],
    artifact_version_appends: [],
    skipped_artifacts: [],
    skipped_targets: [],
    alias_deletes: [],
  };
  planLedgerUpdates(db, resolver, report);
  planStructuredLinkUpdates(db, resolver, report);
  planLatestArtifactContentUpdates(db, resolver, report);
  finalizeSummary(report);
  return report;
}

function emptySummary() {
  return {
    ledger_tables_scanned: 0,
    ledger_rows_scanned: 0,
    ledger_cells_scanned: 0,
    findings: 0,
    unambiguous_replacements: 0,
    unresolved_refs: 0,
    ambiguous_refs: 0,
    invalid_issue_tags_rewritten: 0,
    invalid_issue_tags_refused: 0,
    key_collisions_skipped: 0,
    ledger_cells_to_update: 0,
    structured_links_to_update: 0,
    aliases_to_delete: 0,
    latest_artifacts_scanned: 0,
    latest_artifacts_to_version: 0,
    skipped_artifacts: 0,
  };
}

function verificationForSummary(summary) {
  const actionable = actionableFindingCount(summary);
  return {
    remaining_actionable_refs: actionable,
    zero_legacy_actionable_refs: actionable === 0,
    unresolved_refs: summary.unresolved_refs,
    ambiguous_refs: summary.ambiguous_refs,
    invalid_issue_tags_refused: summary.invalid_issue_tags_refused,
  };
}

function finalizeSummary(report) {
  report.summary.findings = report.findings.length;
  report.summary.unambiguous_replacements = report.findings.filter((finding) => finding.status === "resolved").length;
  report.summary.unresolved_refs = report.findings.filter((finding) => finding.status === "unresolved").length;
  report.summary.ambiguous_refs = report.findings.filter((finding) => finding.status === "ambiguous").length;
  report.summary.invalid_issue_tags_rewritten = report.findings.filter(
    (finding) => finding.context?.invalid_issue_tag && finding.status === "resolved",
  ).length;
  report.summary.invalid_issue_tags_refused = report.findings.filter(
    (finding) => finding.context?.invalid_issue_tag && finding.status !== "resolved",
  ).length;
  report.summary.key_collisions_skipped = report.skipped_targets.filter(
    (target) => target.reason === "key_collision",
  ).length;
  report.summary.ledger_cells_to_update = report.ledger_updates.reduce(
    (count, update) => count + update.cells.length,
    0,
  );
  report.summary.structured_links_to_update = report.structured_link_updates.length;
  report.summary.aliases_to_delete = report.alias_deletes.length;
  report.summary.latest_artifacts_to_version = report.artifact_version_appends.length;
  report.summary.skipped_artifacts = report.skipped_artifacts.length;
}

function actionableFindingCount(summary) {
  return summary.unambiguous_replacements + summary.ambiguous_refs;
}

function planAliasDeletes(db, resolver, report) {
  if (!tableExists(db, "artifact_aliases")) return;
  const columns = tableColumns(db, "artifact_aliases");
  const scanColumns = ["artifact_id", "alias", "normalized_ref", "locator_json"].filter((column) => columns.has(column));
  if (!columns.has("id") || scanColumns.length === 0) return;
  const rows = db.prepare(
    `SELECT rowid AS __rowid, id, ${scanColumns.map(quoteIdent).join(", ")}
     FROM artifact_aliases
     ORDER BY id`,
  ).all();
  for (const row of rows) {
    const findings = [];
    for (const column of scanColumns) {
      const value = row[column];
      if (typeof value !== "string" || !OLD_REF_PATTERN.test(value)) {
        OLD_REF_PATTERN.lastIndex = 0;
        continue;
      }
      OLD_REF_PATTERN.lastIndex = 0;
      const rewritten = rewriteText(value, resolver, {
        surface: "artifact_alias",
        table: "artifact_aliases",
        row_id: String(row.id),
        column,
      }, { includeIssueTags: false });
      findings.push(...rewritten.findings);
    }
    if (findings.length === 0) continue;
    report.findings.push(...findings);
    report.alias_deletes.push({
      table: "artifact_aliases",
      rowid: row.__rowid,
      row_id: String(row.id),
      findings,
    });
  }
}

function planLedgerUpdates(db, resolver, report) {
  for (const target of existingLedgerTargets(db)) {
    report.summary.ledger_tables_scanned += 1;
    const rows = db.prepare(
      `SELECT rowid AS __rowid, ${[target.key, ...target.columns.map((column) => column.name)]
        .map(quoteIdent)
        .join(", ")}
       FROM ${quoteIdent(target.table)}
       ORDER BY ${quoteIdent(target.key)}`,
    ).all();
    report.summary.ledger_rows_scanned += rows.length;
    report.summary.ledger_cells_scanned += rows.length * target.columns.length;
    for (const row of rows) {
      const updates = {};
      const cells = [];
      for (const column of target.columns) {
        const before = row[column.name];
        if (typeof before !== "string" || before.length === 0) continue;
        const rewritten = column.kind === "json"
          ? rewriteJsonCell(before, resolver, contextFor(target.table, row[target.key], column.name), {
            includeIssueTags: true,
          })
          : rewriteText(before, resolver, contextFor(target.table, row[target.key], column.name), {
            includeIssueTags: true,
          });
        if (!rewritten.changed) {
          report.findings.push(...rewritten.findings);
          continue;
        }
        if (column.name === target.key && keyReplacementCollides(db, target, row.__rowid, rewritten.text)) {
          report.skipped_targets.push({
            reason: "key_collision",
            table: target.table,
            column: column.name,
            row_id: String(row[target.key]),
            old_value: before,
            replacement: rewritten.text,
            findings: rewritten.findings,
          });
          continue;
        }
        report.findings.push(...rewritten.findings);
        updates[column.name] = rewritten.text;
        cells.push({
          column: column.name,
          replacements: rewritten.replacements,
          before_sample: sampleText(before),
          after_sample: sampleText(rewritten.text),
        });
      }
      if (cells.length === 0) continue;
      report.ledger_updates.push({
        table: target.table,
        rowid: row.__rowid,
        row_id: String(row[target.key]),
        cells,
        updates,
      });
    }
  }
}

function planStructuredLinkUpdates(db, resolver, report) {
  if (!tableExists(db, "artifact_links")) return;
  const columns = tableColumns(db, "artifact_links");
  if (!columns.has("target_type") && !columns.has("legacy_blob_id")) return;

  const scanColumns = ["id", "artifact_id", "target_type", "target_id", "series_id", "series_ref", "legacy_blob_id"]
    .filter((column) => columns.has(column));
  const rows = db.prepare(
    `SELECT rowid AS __rowid, ${scanColumns.map(quoteIdent).join(", ")}
     FROM artifact_links
     ORDER BY id`,
  ).all();
  for (const row of rows) {
    const candidates = [];
    if (typeof row.artifact_id === "string" && row.artifact_id) {
      candidates.push({ column: "artifact_id", ref: row.artifact_id });
    }
    if (typeof row.target_id === "string" && row.target_id) {
      candidates.push({ column: "target_id", ref: row.target_id });
    }
    if (typeof row.series_id === "string" && row.series_id) {
      candidates.push({ column: "series_id", ref: row.series_id });
    }
    if (typeof row.series_ref === "string" && row.series_ref) {
      candidates.push({ column: "series_ref", ref: row.series_ref });
    }

    let plannedUpdate = false;
    for (const candidate of candidates) {
      const old = parseOldRef(candidate.ref);
      if (!old) continue;
      const resolution = resolver.resolve(candidate.ref);
      if (
        candidate.column === "artifact_id" &&
        resolution.status === "resolved" &&
        structuredLinkBlobAlreadyBackfilled(row, resolution)
      ) {
        continue;
      }
      const findingContext = {
        surface: "structured_link",
        table: "artifact_links",
        row_id: String(row.id),
        column: candidate.column,
      };
      report.findings.push(makeFinding(candidate.ref, resolution, findingContext));
      if (plannedUpdate) continue;
      if (resolution.status !== "resolved") continue;
      const targetType = targetTypeForCanonicalRef(resolution.replacement);
      const clearsLegacySeries =
        candidate.column === "series_id" || candidate.column === "series_ref";
      const after = {
        ...(columns.has("target_type") ? { target_type: row.target_type ?? null } : {}),
        ...(columns.has("target_id") ? { target_id: row.target_id ?? null } : {}),
        ...(columns.has("series_id") ? { series_id: clearsLegacySeries ? null : row.series_id ?? null } : {}),
        ...(columns.has("series_ref") ? { series_ref: clearsLegacySeries ? null : row.series_ref ?? null } : {}),
        ...(columns.has("legacy_blob_id") ? { legacy_blob_id: row.legacy_blob_id ?? null } : {}),
      };

      if (targetType === "artifact" || targetType === "artifact_version") {
        if (!columns.has("target_type") || !columns.has("target_id")) continue;
        after.target_type = targetType;
        after.target_id = resolution.replacement;
      } else if (targetType === "artifact_blob") {
        if (columns.has("legacy_blob_id")) after.legacy_blob_id = resolution.replacement;
      } else {
        continue;
      }

      if (!hasStructuredLinkChange(row, after)) {
        continue;
      }
      report.structured_link_updates.push({
        table: "artifact_links",
        rowid: row.__rowid,
        row_id: String(row.id),
        source_column: candidate.column,
        before: structuredLinkBefore(row, after),
        after,
        replacement: {
          old_ref: candidate.ref,
          new_ref: resolution.replacement,
          replacement_kind: resolution.replacement_kind,
        },
      });
      plannedUpdate = true;
    }
  }
}

function planLatestArtifactContentUpdates(db, resolver, report) {
  if (!tableExists(db, "artifact") || !tableExists(db, "artifact_version") || !tableExists(db, "artifact_blob")) {
    return;
  }
  const rows = db.prepare(
    `SELECT
       a.id AS artifact_id,
       a.title AS artifact_title,
       a.logical_name AS artifact_logical_name,
       a.source_path AS artifact_source_path,
       a.latest_version_id AS latest_version_id,
       a.version_count AS artifact_version_count,
       v.id AS version_id,
       v.version_no AS version_no,
       v.source_kind AS version_source_kind,
       v.source_project_id AS version_source_project_id,
       v.source_repo_id AS version_source_repo_id,
       v.repo_path AS version_repo_path,
       v.commit_sha AS version_commit_sha,
       v.observed_path AS version_observed_path,
       v.source_locator_json AS version_source_locator_json,
       v.custody_mode AS version_custody_mode,
       v.label AS version_label,
       v.note AS version_note,
       v.metadata_json AS version_metadata_json,
       b.id AS blob_id,
       b.algorithm AS blob_algorithm,
       b.content_hash AS blob_content_hash,
       b.storage_uri AS blob_storage_uri,
       b.media_type AS blob_media_type,
       b.role AS blob_role,
       b.provider_id AS blob_provider_id,
       b.manifest_id AS blob_manifest_id,
       b.metadata_json AS blob_metadata_json,
       b.retention_json AS blob_retention_json,
       b.reference_json AS blob_reference_json
     FROM artifact a
     JOIN artifact_version v ON v.id = a.latest_version_id
     JOIN artifact_blob b ON b.id = v.blob_id
     ORDER BY a.id`,
  ).all();

  for (const row of rows) {
    if (!isPlainTextOrMarkdownArtifact(row)) {
      report.skipped_artifacts.push({
        artifact_id: row.artifact_id,
        version_id: row.version_id,
        reason: "not_text_or_markdown",
        media_type: row.blob_media_type ?? null,
      });
      continue;
    }
    report.summary.latest_artifacts_scanned += 1;
    const materialized = materializeBlob(db, row);
    if (!materialized.ok) {
      report.skipped_artifacts.push({
        artifact_id: row.artifact_id,
        version_id: row.version_id,
        reason: materialized.reason,
      });
      continue;
    }
    const before = materialized.bytes.toString("utf8");
    const rewritten = rewriteText(before, resolver, {
      surface: "artifact_content",
      artifact_id: row.artifact_id,
      version_id: row.version_id,
      blob_id: row.blob_id,
    });
    report.findings.push(...rewritten.findings);
    if (!rewritten.changed) continue;
    const afterBuffer = Buffer.from(rewritten.text, "utf8");
    const newHash = sha256(afterBuffer);
    report.artifact_version_appends.push({
      artifact_id: row.artifact_id,
      previous_version_id: row.version_id,
      previous_blob_id: row.blob_id,
      new_version_id: repairVersionId(row.artifact_id, newHash),
      new_blob_id: `artifact-blob:${newHash}`,
      new_content_hash: newHash,
      new_size_bytes: afterBuffer.byteLength,
      media_type: row.blob_media_type ?? "text/plain",
      replacements: rewritten.replacements,
      before_sample: sampleText(before),
      after_sample: sampleText(rewritten.text),
      __row: row,
      __after_text: rewritten.text,
    });
  }
}

function applyPlannedChanges(db, report) {
  const applyTxn = db.transaction(() => {
    for (const update of report.ledger_updates) {
      const columns = Object.keys(update.updates);
      if (columns.length === 0) continue;
      db.prepare(
        `UPDATE ${quoteIdent(update.table)}
         SET ${columns.map((column) => `${quoteIdent(column)} = ?`).join(", ")}
         WHERE rowid = ?`,
      ).run(...columns.map((column) => update.updates[column]), update.rowid);
    }

    for (const update of report.structured_link_updates) {
      const columns = Object.keys(update.after);
      if (columns.length === 0) continue;
      db.prepare(
        `UPDATE artifact_links
         SET ${columns.map((column) => `${quoteIdent(column)} = ?`).join(", ")}, updated_at = ?
         WHERE rowid = ?`,
      ).run(
        ...columns.map((column) => update.after[column]),
        Date.now(),
        update.rowid,
      );
    }

    for (const deletion of report.alias_deletes) {
      db.prepare("DELETE FROM artifact_aliases WHERE rowid = ?").run(deletion.rowid);
    }

    for (const append of report.artifact_version_appends) {
      applyArtifactAppend(db, append);
    }
  });
  applyTxn();
  stripPrivatePlanningFields(report);
}

function applyArtifactAppend(db, append) {
  const row = append.__row;
  const now = Date.now();
  const bytes = Buffer.from(append.__after_text, "utf8");
  const root = getArtifactRoot(db);
  const casPath = artifactCasPath(root, append.new_content_hash);
  fs.mkdirSync(path.dirname(casPath), { recursive: true });
  fs.writeFileSync(casPath, bytes);

  db.prepare(
    `INSERT OR IGNORE INTO artifact_blob (
      id, algorithm, content_hash, storage_uri, media_type, role, size_bytes,
      provider_id, manifest_id, metadata_json, custody_mode, availability,
      retention_json, reference_json, created_at
    ) VALUES (
      @id, 'sha256', @content_hash, NULL, @media_type, @role, @size_bytes,
      @provider_id, @manifest_id, @metadata_json, 'managed', 'present',
      @retention_json, @reference_json, @created_at
    )`,
  ).run({
    id: append.new_blob_id,
    content_hash: append.new_content_hash,
    media_type: append.media_type,
    role: row.blob_role,
    size_bytes: append.new_size_bytes,
    provider_id: row.blob_provider_id,
    manifest_id: row.blob_manifest_id,
    metadata_json: JSON.stringify({
      repaired_by: "repair-artifact-refs",
      previous_version_id: append.previous_version_id,
      previous_blob_id: append.previous_blob_id,
      previous_content_hash: row.blob_content_hash,
    }),
    retention_json: "{}",
    reference_json: JSON.stringify({
      repaired_by: "repair-artifact-refs",
      previous_version_id: append.previous_version_id,
      previous_blob_id: append.previous_blob_id,
      previous_content_hash: row.blob_content_hash,
    }),
    created_at: now,
  });

  const blob = db.prepare(
    "SELECT id FROM artifact_blob WHERE algorithm = 'sha256' AND content_hash = ?",
  ).get(append.new_content_hash);
  const blobId = blob?.id ?? append.new_blob_id;
  const versionNo = nextVersionNo(db, append.artifact_id);
  const versionId = uniqueVersionId(db, append.new_version_id);

  db.prepare(
    `INSERT INTO artifact_version (
      id, artifact_id, version_no, blob_id, source_kind, content_hash,
      source_project_id, source_repo_id, repo_path, commit_sha, observed_path,
      source_locator_json, custody_mode, label, note, metadata_json, created_at
    ) VALUES (
      @id, @artifact_id, @version_no, @blob_id, @source_kind, @content_hash,
      @source_project_id, @source_repo_id, @repo_path, @commit_sha, @observed_path,
      @source_locator_json, 'managed', @label, @note, @metadata_json, @created_at
    )`,
  ).run({
    id: versionId,
    artifact_id: append.artifact_id,
    version_no: versionNo,
    blob_id: blobId,
    source_kind: normalizeSourceKind(row.version_source_kind),
    content_hash: append.new_content_hash,
    source_project_id: row.version_source_project_id,
    source_repo_id: row.version_source_repo_id,
    repo_path: row.version_repo_path,
    commit_sha: row.version_commit_sha,
    observed_path: row.version_observed_path,
    source_locator_json: JSON.stringify({
      repaired_by: "repair-artifact-refs",
      previous_version_id: append.previous_version_id,
      previous_blob_id: append.previous_blob_id,
      previous_content_hash: row.blob_content_hash,
    }),
    label: row.version_label ?? "artifact ref repair",
    note: "Rewrites legacy artifact references in latest text/markdown content.",
    metadata_json: JSON.stringify({
      repaired_by: "repair-artifact-refs",
      previous_version_id: append.previous_version_id,
      previous_blob_id: append.previous_blob_id,
      previous_content_hash: row.blob_content_hash,
    }),
    created_at: now,
  });

  db.prepare(
    `UPDATE artifact
     SET latest_version_id = ?,
         version_count = MAX(COALESCE(version_count, 0), ?),
         updated_at = ?
     WHERE id = ?`,
  ).run(versionId, versionNo, now, append.artifact_id);

  append.new_version_id = versionId;
  append.new_blob_id = blobId;
  append.version_no = versionNo;
  delete append.__row;
  delete append.__after_text;
}

function stripPrivatePlanningFields(report) {
  for (const append of report.artifact_version_appends) {
    delete append.__row;
    delete append.__after_text;
  }
}

function rewriteJsonCell(text, resolver, context, options = {}) {
  const parsed = parseJson(text);
  if (parsed === null) {
    const scanned = rewriteText(text, resolver, context, options);
    return {
      changed: false,
      text,
      findings: scanned.findings.map((finding) => ({ ...finding, status: "unresolved", reason: "invalid_json" })),
      replacements: [],
    };
  }
  const findings = [];
  const replacements = [];
  let changed = false;
  const rewritten = rewriteJsonValue(parsed, resolver, context, findings, replacements, () => {
    changed = true;
  }, options);
  return {
    changed,
    text: changed ? JSON.stringify(rewritten) : text,
    findings,
    replacements,
  };
}

function rewriteJsonValue(value, resolver, context, findings, replacements, markChanged, options = {}) {
  if (typeof value === "string") {
    const rewritten = rewriteText(value, resolver, context, options);
    findings.push(...rewritten.findings);
    replacements.push(...rewritten.replacements);
    if (rewritten.changed) {
      markChanged();
      return rewritten.text;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewriteJsonValue(item, resolver, context, findings, replacements, markChanged, options));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = rewriteJsonValue(nested, resolver, context, findings, replacements, markChanged, options);
    }
    return out;
  }
  return value;
}

function rewriteInvalidIssueTags(text, resolver, context, findings, replacements) {
  return replaceOutsideCodeSpans(text, /\[([a-z][a-z0-9_-]*):([^\]\n]+)\]/gi, (match, tag, ref) => {
    const normalizedTag = tag.toLowerCase();
    if (!INVALID_ISSUE_TAGS.has(normalizedTag)) return match;
    const target = normalizeInvalidIssueTagRef(ref.trim());
    const resolution = resolver.resolveIssue(target.ref);
    const findingContext = {
      ...context,
      invalid_issue_tag: normalizedTag,
      normalized_issue_ref: target.ref,
    };
    findings.push(makeFinding(match, issueFindingResolution(resolution), findingContext));
    if (resolution.status !== "resolved") return match;
    const next = `[issue:${target.display ?? resolution.display ?? resolver.displayIssue(resolution.issue)}]`;
    replacements.push({
      old_ref: match,
      new_ref: next,
      replacement_kind: "issue",
      invalid_issue_tag: normalizedTag,
    });
    return next;
  });
}

function normalizeInvalidIssueTagRef(ref) {
  const projectColon = /^([A-Za-z][A-Za-z0-9_.-]*)\s*:\s*([A-Za-z0-9][A-Za-z0-9._-]{1,127})$/.exec(ref);
  if (!projectColon) return { ref };
  const normalized = `${projectColon[1]}/${projectColon[2]}`;
  return { ref: normalized, display: normalized };
}

function rewriteText(text, resolver, context, options = {}) {
  const findings = [];
  const replacements = [];
  let rewritten = text;

  if (options.includeIssueTags) {
    rewritten = rewriteInvalidIssueTags(rewritten, resolver, context, findings, replacements);
  }

  rewritten = rewritten.replace(OLD_REF_PATTERN, (match) => {
    const resolution = resolver.resolve(match);
    findings.push(makeFinding(match, resolution, context));
    if (resolution.status !== "resolved") return match;
    replacements.push({
      old_ref: match,
      new_ref: resolution.replacement,
      replacement_kind: resolution.replacement_kind,
    });
    return resolution.replacement;
  });
  rewritten = rewritten.replace(ENCODED_OLD_REF_PATTERN, (match) => {
    const decodedRef = decodeLegacyArtifactRef(match);
    const resolution = resolver.resolve(decodedRef);
    findings.push(makeFinding(decodedRef, resolution, { ...context, encoded: true }));
    if (resolution.status !== "resolved") return match;
    const encodedReplacement = encodeURIComponent(resolution.replacement);
    replacements.push({
      old_ref: match,
      new_ref: encodedReplacement,
      replacement_kind: resolution.replacement_kind,
      encoded: true,
    });
    return encodedReplacement;
  });
  return {
    changed: rewritten !== text,
    text: rewritten,
    findings,
    replacements,
  };
}

function replaceOutsideCodeSpans(value, pattern, replace) {
  const protectedSpans = buildCodeSpans(value);
  return value.replace(pattern, (...args) => {
    const match = args[0];
    const index = args[args.length - 2];
    const fullText = args[args.length - 1];
    if (isInsideSpan(index, protectedSpans)) return match;
    return replace(match, ...args.slice(1, -2), index, fullText);
  });
}

function buildCodeSpans(text) {
  const spans = [];
  collectRegexSpans(spans, text, /```[\s\S]*?```|~~~[\s\S]*?~~~/g);
  collectRegexSpans(spans, text, /`[^`\n]*`/g);
  return mergeSpans(spans);
}

function collectRegexSpans(spans, text, pattern) {
  for (const match of text.matchAll(pattern)) {
    spans.push([match.index, match.index + match[0].length]);
  }
}

function mergeSpans(spans) {
  if (spans.length === 0) return spans;
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [spans[0]];
  for (const span of spans.slice(1)) {
    const last = merged[merged.length - 1];
    if (span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push(span);
  }
  return merged;
}

function isInsideSpan(index, spans) {
  return spans.some(([start, end]) => index >= start && index < end);
}

function makeFinding(ref, resolution, context) {
  return {
    ref,
    status: resolution.status,
    replacement: resolution.replacement ?? null,
    replacement_kind: resolution.replacement_kind ?? null,
    reason: resolution.reason ?? null,
    context,
  };
}

function buildResolver(db) {
  const hashTargets = new Map();
  const seriesTargets = new Map();
  const seriesVersionTargets = new Map();
  const issues = loadIssues(db);
  const issueAliases = loadIssueAliases(db);
  const projects = loadProjects(db);
  const issueResolver = buildIssueResolver(issues, issueAliases, projects);

  if (tableExists(db, "artifact_blob")) {
    for (const row of db.prepare("SELECT id, content_hash FROM artifact_blob ORDER BY id").all()) {
      if (typeof row.content_hash === "string" && /^[a-f0-9]{64}$/i.test(row.content_hash)) {
        addTarget(hashTargets, row.content_hash.toLowerCase(), {
          replacement: String(row.id),
          replacement_kind: "artifact_blob",
        });
      }
    }
  }

  if (tableExists(db, "artifacts")) {
    const columns = tableColumns(db, "artifacts");
    if (columns.has("content_hash")) {
      const rows = db.prepare(
        `SELECT id, content_hash FROM artifacts
         WHERE content_hash IS NOT NULL
         ORDER BY id`,
      ).all();
      for (const row of rows) {
        if (typeof row.content_hash === "string" && /^[a-f0-9]{64}$/i.test(row.content_hash)) {
          addTarget(hashTargets, row.content_hash.toLowerCase(), {
            replacement: `artifact-blob:${row.content_hash.toLowerCase()}`,
            replacement_kind: "artifact_blob",
          });
        }
      }
    }
  }

  if (tableExists(db, "artifact_series")) {
    for (const row of db.prepare("SELECT id, latest_version_id FROM artifact_series ORDER BY id").all()) {
      const canonical = logicalArtifactIdFromLegacySeries(String(row.id));
      if (canonicalArtifactExists(db, canonical)) {
        addTarget(seriesTargets, String(row.id).toLowerCase(), {
          replacement: canonical,
          replacement_kind: "artifact",
        });
      }
    }
  }

  if (tableExists(db, "artifact_versions") && tableExists(db, "artifact_version")) {
    for (const row of db.prepare("SELECT id, series_id, version_no FROM artifact_versions ORDER BY id").all()) {
      const canonical = artifactVersionIdFromLegacy(String(row.id));
      if (!canonicalVersionExists(db, canonical)) continue;
      addTarget(seriesVersionTargets, `${String(row.series_id).toLowerCase()}\u0000${Number(row.version_no)}`, {
        replacement: canonical,
        replacement_kind: "artifact_version",
      });
    }
  }

  if (tableExists(db, "artifact_version")) {
    const rows = db.prepare(
      `SELECT artifact_id, source_locator_json
       FROM artifact_version
       WHERE source_locator_json IS NOT NULL
       ORDER BY id`,
    ).all();
    for (const row of rows) {
      const locator = parseJson(row.source_locator_json);
      const legacySeries = locator?.legacy_series_id;
      if (typeof legacySeries === "string" && canonicalArtifactExists(db, row.artifact_id)) {
        addTarget(seriesTargets, legacySeries.toLowerCase(), {
          replacement: String(row.artifact_id),
          replacement_kind: "artifact",
        });
      }
    }
  }

  return {
    resolve(ref) {
      const parsed = parseOldRef(ref);
      if (!parsed) return { status: "unsupported", reason: "not_old_ref" };
      const targets = parsed.kind === "series"
        ? resolveSeriesTargets(seriesTargets, seriesVersionTargets, parsed)
        : resolveHashTargets(hashTargets, parsed.key);
      const unique = uniqueTargets(targets);
      if (unique.length === 1) return { status: "resolved", ...unique[0] };
      if (unique.length > 1) return { status: "ambiguous", reason: "multiple_replacements" };
      return { status: "unresolved", reason: "no_canonical_target" };
    },
    resolveIssue(ref) {
      return issueResolver.resolve(ref);
    },
    displayIssue(issue) {
      return issueResolver.display(issue);
    },
  };
}

function issueFindingResolution(resolution) {
  if (resolution.status === "resolved") {
    return {
      status: "resolved",
      replacement: resolution.display,
      replacement_kind: "issue",
    };
  }
  return {
    status: resolution.status,
    reason: resolution.reason,
  };
}

function loadIssues(db) {
  if (!tableExists(db, "ledger_issues")) return [];
  const columns = tableColumns(db, "ledger_issues");
  const selected = [
    "id",
    columns.has("short_id") ? "short_id" : "'' AS short_id",
    columns.has("project_id") ? "project_id" : "'' AS project_id",
  ];
  return db.prepare(`SELECT ${selected.join(", ")} FROM ledger_issues ORDER BY id`).all()
    .map((row) => ({
      id: String(row.id),
      short_id: String(row.short_id ?? ""),
      project_id: String(row.project_id ?? ""),
    }));
}

function loadIssueAliases(db) {
  if (!tableExists(db, "ledger_issue_aliases")) return [];
  const columns = tableColumns(db, "ledger_issue_aliases");
  const selected = [
    "issue_id",
    columns.has("project_id") ? "project_id" : "'' AS project_id",
    columns.has("alias") ? "alias" : "'' AS alias",
    columns.has("external_id") ? "external_id" : "'' AS external_id",
  ];
  return db.prepare(`SELECT ${selected.join(", ")} FROM ledger_issue_aliases ORDER BY issue_id`).all()
    .flatMap((row) => [
      { issue_id: String(row.issue_id), project_id: String(row.project_id ?? ""), ref: String(row.alias ?? "") },
      { issue_id: String(row.issue_id), project_id: String(row.project_id ?? ""), ref: String(row.external_id ?? "") },
    ])
    .filter((row) => row.ref.length > 0);
}

function loadProjects(db) {
  if (!tableExists(db, "ledger_projects")) return [];
  const columns = tableColumns(db, "ledger_projects");
  const selected = [
    "id",
    columns.has("project_key") ? "project_key" : "'' AS project_key",
    columns.has("display_name") ? "display_name" : "'' AS display_name",
    columns.has("repo_id") ? "repo_id" : "'' AS repo_id",
    columns.has("work_repo_id") ? "work_repo_id" : "'' AS work_repo_id",
  ];
  return db.prepare(`SELECT ${selected.join(", ")} FROM ledger_projects ORDER BY id`).all()
    .map((row) => ({
      id: String(row.id),
      aliases: [row.project_key, row.display_name, row.repo_id, row.work_repo_id, row.id]
        .map((value) => String(value ?? "").trim())
        .filter(Boolean),
    }));
}

function buildIssueResolver(issues, aliases, projects) {
  const issuesById = new Map(issues.map((issue) => [issue.id, issue]));
  const projectAliases = new Map();
  const projectDisplay = new Map();
  for (const project of projects) {
    const aliasesForProject = uniqueStrings(project.aliases);
    projectDisplay.set(project.id, aliasesForProject[0] ?? project.id);
    for (const alias of aliasesForProject) {
      const key = alias.toLowerCase();
      projectAliases.set(key, [...(projectAliases.get(key) ?? []), project.id]);
    }
  }

  const refsByProject = new Map();
  for (const issue of issues) {
    addIssueRef(refsByProject, issue.project_id, issue.id, issue);
    addIssueRef(refsByProject, issue.project_id, issue.short_id, issue);
  }
  for (const alias of aliases) {
    const issue = issuesById.get(alias.issue_id);
    if (issue) addIssueRef(refsByProject, alias.project_id || issue.project_id, alias.ref, issue);
  }

  return {
    resolve(ref) {
      const trimmed = String(ref).trim();
      const scoped = /^([^/\s]+)\/(.+)$/.exec(trimmed);
      if (scoped) {
        const matchingProjects = uniqueStrings(projectAliases.get(scoped[1].toLowerCase()) ?? []);
        if (matchingProjects.length > 1) return { status: "ambiguous", reason: "ambiguous_project" };
        if (matchingProjects.length === 1) {
          return resolveIssueCandidates(issueCandidatesForProject(refsByProject, matchingProjects[0], scoped[2]));
        }
      }
      const matches = [];
      for (const issue of issues) {
        if (issueMatchesRef(issue, trimmed)) matches.push(issue);
      }
      for (const projectId of refsByProject.keys()) {
        matches.push(...issueCandidatesForProject(refsByProject, projectId, trimmed));
      }
      return resolveIssueCandidates(matches);
    },
    display(issue) {
      const display = issue.short_id || shortestUniquePrefix(issue.id, issues.map((candidate) => candidate.id));
      const sameDisplay = issues.filter((candidate) => (
        candidate.id !== issue.id &&
        (candidate.short_id === display || candidate.id.startsWith(display))
      ));
      if (sameDisplay.length === 0) return display;
      const project = projectDisplay.get(issue.project_id);
      return project ? `${project}/${display}` : display;
    },
  };
}

function issueMatchesRef(issue, ref) {
  const lower = ref.toLowerCase();
  return issue.id.toLowerCase() === lower ||
    issue.short_id.toLowerCase() === lower ||
    issue.id.toLowerCase().startsWith(lower) ||
    (issue.short_id && issue.short_id.toLowerCase().startsWith(lower));
}

function addIssueRef(refsByProject, projectId, ref, issue) {
  if (!ref) return;
  const projectRefs = refsByProject.get(projectId) ?? new Map();
  const key = String(ref).toLowerCase();
  projectRefs.set(key, [...(projectRefs.get(key) ?? []), issue]);
  refsByProject.set(projectId, projectRefs);
}

function issueCandidatesForProject(refsByProject, projectId, ref) {
  const projectRefs = refsByProject.get(projectId);
  if (!projectRefs) return [];
  const lower = String(ref).toLowerCase();
  const exact = projectRefs.get(lower);
  if (exact) return exact;
  const matches = [];
  for (const [candidate, issuesForRef] of projectRefs.entries()) {
    if (candidate.startsWith(lower)) matches.push(...issuesForRef);
  }
  return matches;
}

function resolveIssueCandidates(matches) {
  const unique = uniqueBy(matches, (issue) => issue.id);
  if (unique.length === 1) {
    return { status: "resolved", issue: unique[0], display: unique[0].short_id || unique[0].id };
  }
  if (unique.length > 1) return { status: "ambiguous", reason: "multiple_issues" };
  return { status: "unresolved", reason: "no_matching_issue" };
}

function parseOldRef(ref) {
  const trimmed = String(ref).trim();
  const hashMatch =
    /^artifact:sha256:([a-f0-9]{7,64})$/i.exec(trimmed) ??
    /^sha256:([a-f0-9]{7,64})$/i.exec(trimmed) ??
    /^artifact:([a-f0-9]{7,64})$/i.exec(trimmed);
  if (hashMatch) return { kind: "hash", key: hashMatch[1].toLowerCase() };
  const seriesMatch = /^(artifact-series:[A-Za-z0-9][A-Za-z0-9_.:-]*)(?:([@#])([A-Za-z0-9_.:-]+))?$/i.exec(trimmed);
  if (seriesMatch) {
    return {
      kind: "series",
      key: seriesMatch[1],
      selector: seriesMatch[3]?.toLowerCase() ?? null,
    };
  }
  return null;
}

function decodeLegacyArtifactRef(value) {
  return String(value)
    .replace(/%3A/gi, ":")
    .replace(/%2F/gi, "/");
}

function resolveHashTargets(hashTargets, key) {
  const lower = key.toLowerCase();
  if (lower.length === 64) return hashTargets.get(lower) ?? [];
  const targets = [];
  for (const [hash, hashTarget] of hashTargets.entries()) {
    if (hash.startsWith(lower)) targets.push(...hashTarget);
  }
  return targets;
}

function resolveSeriesTargets(seriesTargets, seriesVersionTargets, parsed) {
  const key = parsed.key.toLowerCase();
  const seriesKeys = seriesTargetKeys(seriesTargets, key);
  if (seriesKeys.length !== 1) {
    return seriesKeys.flatMap((seriesKey) => seriesTargets.get(seriesKey) ?? []);
  }
  const seriesKey = seriesKeys[0];
  if (parsed.selector && parsed.selector !== "latest") {
    if (!/^[1-9][0-9]*$/.test(parsed.selector)) return [];
    return seriesVersionTargets.get(`${seriesKey}\u0000${Number(parsed.selector)}`) ?? [];
  }
  return seriesTargets.get(seriesKey) ?? [];
}

function seriesTargetKeys(seriesTargets, key) {
  if (seriesTargets.has(key)) return [key];
  const matches = [];
  for (const candidate of seriesTargets.keys()) {
    if (candidate.startsWith(key)) matches.push(candidate);
  }
  return matches;
}

function addTarget(map, key, target) {
  const list = map.get(key) ?? [];
  list.push(target);
  map.set(key, list);
}

function uniqueTargets(targets) {
  const seen = new Set();
  const unique = [];
  for (const target of targets) {
    const key = `${target.replacement_kind}:${target.replacement}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(target);
  }
  return unique;
}

function uniqueBy(values, keyFn) {
  const byKey = new Map();
  for (const value of values) {
    byKey.set(keyFn(value), value);
  }
  return Array.from(byKey.values());
}

function uniqueStrings(values) {
  return Array.from(new Set(values.filter((value) => value.length > 0)));
}

function shortestUniquePrefix(id, ids, minPrefixLength = 7) {
  for (let length = minPrefixLength; length <= id.length; length += 1) {
    const prefix = id.slice(0, length);
    if (ids.filter((candidate) => candidate.startsWith(prefix)).length === 1) return prefix;
  }
  return id.slice(0, Math.max(minPrefixLength, 12));
}

function canonicalArtifactExists(db, id) {
  if (!tableExists(db, "artifact")) return false;
  return Boolean(db.prepare("SELECT 1 FROM artifact WHERE id = ?").get(id));
}

function canonicalVersionExists(db, id) {
  if (!tableExists(db, "artifact_version")) return false;
  return Boolean(db.prepare("SELECT 1 FROM artifact_version WHERE id = ?").get(id));
}

function artifactVersionIdFromLegacy(versionId) {
  const trimmed = String(versionId).trim();
  return /^artifact-version:/i.test(trimmed) ? trimmed : `artifact-version:${trimmed}`;
}

function logicalArtifactIdFromLegacySeries(seriesId) {
  const trimmed = String(seriesId).trim();
  const match = /^artifact-series:(.+)$/i.exec(trimmed);
  return match ? `artifact:${match[1]}` : `artifact:${trimmed.replace(/^artifact:/i, "")}`;
}

function targetTypeForCanonicalRef(ref) {
  if (/^artifact-version:/i.test(ref)) return "artifact_version";
  if (/^artifact-blob:/i.test(ref)) return "artifact_blob";
  if (/^artifact:/i.test(ref)) return "artifact";
  return null;
}

function hasStructuredLinkChange(row, after) {
  return Object.entries(after).some(([column, value]) => (row[column] ?? null) !== value);
}

function structuredLinkBlobAlreadyBackfilled(row, resolution) {
  if (resolution.replacement_kind !== "artifact_blob") return false;
  return row.legacy_blob_id === resolution.replacement;
}

function structuredLinkBefore(row, after) {
  const before = {};
  for (const column of Object.keys(after)) {
    before[column] = row[column] ?? null;
  }
  return before;
}

function existingLedgerTargets(db) {
  const targets = [];
  for (const target of CURRENT_LEDGER_TARGETS) {
    if (!tableExists(db, target.table)) continue;
    const columns = tableColumns(db, target.table);
    if (!columns.has(target.key)) {
      reportSkippedTarget(target, "missing_key_column");
      continue;
    }
    const existingColumns = target.columns.filter((column) => columns.has(column.name));
    if (existingColumns.length === 0) continue;
    targets.push({ ...target, columns: existingColumns });
  }
  return targets;
}

function keyReplacementCollides(db, target, rowid, replacement) {
  if (!tableExists(db, target.table)) return false;
  const columns = tableColumns(db, target.table);
  if (!columns.has(target.key)) return false;
  return Boolean(db.prepare(
    `SELECT 1
     FROM ${quoteIdent(target.table)}
     WHERE ${quoteIdent(target.key)} = ?
       AND rowid != ?
     LIMIT 1`,
  ).get(replacement, rowid));
}

function reportSkippedTarget(_target, _reason) {
  // Kept as a hook for future target diagnostics without making reports noisy.
}

function isPlainTextOrMarkdownArtifact(row) {
  const media = typeof row.blob_media_type === "string" ? row.blob_media_type.toLowerCase() : "";
  if (media === "text/markdown" || media === "text/plain") return true;
  if (media && media !== "application/octet-stream") return false;
  const name = [
    row.artifact_logical_name,
    row.artifact_source_path,
    row.version_repo_path,
    row.version_observed_path,
    row.blob_storage_uri,
  ].find((value) => typeof value === "string" && value.length > 0);
  return /\.(md|markdown|txt|log)$/i.test(String(name ?? ""));
}

function materializeBlob(db, row) {
  const expected = /^[a-f0-9]{64}$/i.test(row.blob_content_hash ?? "")
    ? String(row.blob_content_hash).toLowerCase()
    : null;
  const candidates = [];
  if (typeof row.blob_storage_uri === "string" && row.blob_storage_uri) {
    candidates.push(row.blob_storage_uri);
  }
  if (expected) candidates.push(artifactCasPath(getArtifactRoot(db), expected));

  for (const candidate of candidates) {
    const filePath = pathFromStorageUri(candidate);
    if (!filePath || !fs.existsSync(filePath)) continue;
    const bytes = fs.readFileSync(filePath);
    if (expected) {
      const actual = sha256(bytes);
      if (actual !== expected) {
        return { ok: false, reason: `hash_mismatch:${actual}` };
      }
    }
    return { ok: true, bytes, path: filePath };
  }
  return { ok: false, reason: "materialization_unavailable" };
}

function pathFromStorageUri(uri) {
  if (/^file:\/\//i.test(uri)) return fileURLToPath(uri);
  if (path.isAbsolute(uri)) return uri;
  return null;
}

function getArtifactRoot(db) {
  if (process.env.MANDIBLE_ARTIFACT_DIR?.trim()) {
    return path.resolve(expandHome(process.env.MANDIBLE_ARTIFACT_DIR));
  }
  if (tableExists(db, "settings")) {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'artifact_root'").get();
    if (typeof row?.value === "string" && row.value.trim()) {
      return path.resolve(expandHome(row.value));
    }
  }
  if (process.env.MANDIBLE_HOME?.trim()) {
    return path.join(path.resolve(expandHome(process.env.MANDIBLE_HOME)), "artifacts");
  }
  return path.join(os.homedir(), ".mandible", "artifacts");
}

function artifactCasPath(root, hash) {
  return path.join(root, "sha256", hash.slice(0, 2), hash);
}

function repairVersionId(artifactId, hash) {
  return `artifact-version:${artifactId.replace(/^artifact:/i, "")}:repair:${hash.slice(0, 16)}`;
}

function uniqueVersionId(db, preferred) {
  if (!db.prepare("SELECT 1 FROM artifact_version WHERE id = ?").get(preferred)) return preferred;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${preferred}-${i}`;
    if (!db.prepare("SELECT 1 FROM artifact_version WHERE id = ?").get(candidate)) return candidate;
  }
  throw new Error(`Could not allocate artifact version id for ${preferred}`);
}

function nextVersionNo(db, artifactId) {
  const row = db.prepare(
    "SELECT COALESCE(MAX(version_no), 0) AS max_version FROM artifact_version WHERE artifact_id = ?",
  ).get(artifactId);
  return Number(row?.max_version ?? 0) + 1;
}

function normalizeSourceKind(value) {
  return ["tracked_repo", "local_only", "managed", "external"].includes(value) ? value : "managed";
}

function mergeJsonText(text, extra) {
  const parsed = parseJson(text);
  return JSON.stringify({ ...(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}), ...extra });
}

function parseJson(text) {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function tableExists(db, table) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table));
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all().map((row) => row.name));
}

function quoteIdent(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function contextFor(table, rowId, column) {
  return {
    surface: "ledger_cell",
    table,
    row_id: String(rowId),
    column,
  };
}

function sampleText(text, limit = 400) {
  const normalized = String(text).replace(/\s+/g, " ");
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function expandHome(value) {
  const text = String(value);
  if (text === "~") return os.homedir();
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2));
  return text;
}

function resolveBackupPath(backupPath, dbPath) {
  if (backupPath && backupPath !== "auto") return path.resolve(expandHome(backupPath));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(path.dirname(dbPath), `${path.basename(dbPath)}.${stamp}.artifact-ref-repair.bak`);
}

async function backupDatabase(db, backupPath) {
  await fsp.mkdir(path.dirname(backupPath), { recursive: true });
  await db.backup(backupPath);
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--db") options.dbPath = argv[++i];
    else if (arg === "--report") options.reportPath = argv[++i] ?? DEFAULT_REPORT_NAME;
    else if (arg === "--backup") options.backupPath = argv[++i] ?? "auto";
    else if (arg === "--dry-run") options.apply = false;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--check" || arg === "--fail-on-findings") options.check = true;
    else if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage: node scripts/repair-artifact-refs.mjs [--db path] [--dry-run|--apply] [--check]",
        "                                            [--report path] [--backup path|auto]",
        "",
        "Dry-run is the default. Apply mode backs up the SQLite database before mutation.",
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
    const report = await runArtifactRefRepair(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(report, null, 2));
    if (report.check_failed) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const isCli = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCli) {
  await main();
}
