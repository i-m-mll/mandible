#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

const MIN_ARTIFACT_PREFIX_LENGTH = 7;
const SAMPLE_LIMIT = 40;
const DEFAULT_DB = path.join(os.homedir(), ".cache", "mandible", "mandible.db");
const DEFAULT_OUTPUT_ROOT = path.join(os.homedir(), ".cache", "mandible", "db-ref-cleanup");

const TEXT_TARGETS = [
  { table: "ledger_issues", key: "id", columns: [{ name: "body", kind: "markdown" }] },
  { table: "ledger_comments", key: "id", columns: [{ name: "body", kind: "markdown" }] },
  { table: "ledger_body_revisions", key: "id", columns: [{ name: "snapshot_body", kind: "markdown" }] },
  { table: "artifact_aliases", key: "id", columns: [
    { name: "alias", kind: "artifact_ref" },
    { name: "normalized_ref", kind: "artifact_ref" },
    { name: "locator_json", kind: "json" },
  ] },
  { table: "artifacts", key: "id", columns: [
    { name: "uri", kind: "artifact_ref" },
    { name: "metadata_json", kind: "json" },
    { name: "reference_json", kind: "json" },
  ] },
  { table: "ledger_events", key: "id", columns: [{ name: "payload_json", kind: "json" }] },
];

const AUTH_TEXT_COLUMNS = new Set([
  "spec_content",
  "output",
  "error",
  "post_merge_handoff",
]);

export async function runCopiedDbRefCleanup(options = {}) {
  const timestamp = options.timestamp ?? formatTimestamp(new Date());
  const sourceDb = path.resolve(expandHome(options.sourceDb ?? process.env.MANDIBLE_DB ?? DEFAULT_DB));
  const outputDir = path.resolve(expandHome(options.outputDir ?? path.join(DEFAULT_OUTPUT_ROOT, timestamp)));
  const backupDb = path.resolve(expandHome(options.backupDb ?? path.join(outputDir, "mandible.backup.db")));
  const candidateDb = path.resolve(expandHome(options.candidateDb ?? path.join(outputDir, "mandible.candidate.db")));
  const reportPath = path.resolve(expandHome(options.reportPath ?? path.join(outputDir, "rewrite-report.json")));
  const apply = Boolean(options.apply);

  if (options.inPlace) {
    throw new Error("Ref cleanup refuses in-place DB mutation; provide a source DB and use a copied candidate.");
  }
  if (!fs.existsSync(sourceDb)) {
    throw new Error(`Source DB does not exist: ${sourceDb}`);
  }

  await fsp.mkdir(outputDir, { recursive: true });
  await copySqliteDb(sourceDb, backupDb);
  await copySqliteDb(sourceDb, candidateDb);

  const backupSha256 = await fileSha256(backupDb);
  const candidateBeforeSha256 = await fileSha256(candidateDb);
  const db = new Database(candidateDb, { fileMustExist: true });
  db.pragma("busy_timeout = 5000");

  const context = buildContext(db);
  const report = {
    ok: true,
    mode: apply ? "apply_candidate" : "dry_run",
    created_at: new Date().toISOString(),
    source_db: sourceDb,
    output_dir: outputDir,
    backup_db: backupDb,
    candidate_db: candidateDb,
    report_path: reportPath,
    checksums: {
      backup_sha256: backupSha256,
      candidate_before_sha256: candidateBeforeSha256,
      candidate_after_sha256: null,
    },
    summary: {
      tables_scanned: 0,
      columns_scanned: 0,
      rows_scanned: 0,
      rows_updated: 0,
      cells_updated: 0,
      issue_refs_rewritten: 0,
      artifact_refs_rewritten: 0,
      naked_typed_refs_bracketed: 0,
      malformed_artifact_aliases_removed: 0,
      refused: 0,
    },
    mutations: [],
    samples: [],
    refused: [],
    removed_aliases: [],
    skipped_targets: [],
    integrity_check: null,
  };

  try {
    const targets = existingTargets(db);
    const plannedUpdates = [];
    for (const target of targets) {
      report.summary.tables_scanned += 1;
      report.summary.columns_scanned += target.columns.length;
      const selectColumns = [
        target.key,
        ...target.columns.map((column) => column.name),
        ...target.contextColumns,
      ];
      const rows = db.prepare(
        `SELECT ${uniqueList(selectColumns).map((column) => quoteIdent(column)).join(", ")}
         FROM ${quoteIdent(target.table)}
         ORDER BY ${quoteIdent(target.key)}`,
      ).all();
      report.summary.rows_scanned += rows.length;
      for (const row of rows) {
        const updates = {};
        const cellMutations = [];
        for (const column of target.columns) {
          const before = row[column.name];
          if (typeof before !== "string" || before.length === 0) continue;
          const rewritten = rewriteCell(before, column.kind, context, {
            table: target.table,
            column: column.name,
            rowId: String(row[target.key]),
            issueId: sourceIssueId(target, row),
          });
          appendRefusals(report, rewritten.refused);
          if (!rewritten.changed) continue;
          updates[column.name] = rewritten.text;
          report.summary.issue_refs_rewritten += rewritten.counts.issue;
          report.summary.artifact_refs_rewritten += rewritten.counts.artifact;
          report.summary.naked_typed_refs_bracketed += rewritten.counts.typed;
          cellMutations.push({
            column: column.name,
            replacements: rewritten.replacements,
            before_sample: sampleText(before),
            after_sample: sampleText(rewritten.text),
          });
          pushLimited(report.samples, {
            table: target.table,
            row_id: String(row[target.key]),
            column: column.name,
            before: sampleText(before, 500),
            after: sampleText(rewritten.text, 500),
          });
        }
        if (cellMutations.length === 0) continue;
        plannedUpdates.push({ table: target.table, key: target.key, rowId: row[target.key], updates });
        report.mutations.push({
          table: target.table,
          row_id: String(row[target.key]),
          cells: cellMutations,
        });
      }
    }

    const aliasDeletes = planMalformedAliasDeletes(db, report);
    if (apply) {
      const applyChanges = db.transaction(() => {
        for (const update of plannedUpdates) {
          const columns = Object.keys(update.updates);
          const assignments = columns.map((column) => `${quoteIdent(column)} = ?`).join(", ");
          db.prepare(
            `UPDATE ${quoteIdent(update.table)}
             SET ${assignments}
             WHERE ${quoteIdent(update.key)} = ?`,
          ).run(...columns.map((column) => update.updates[column]), update.rowId);
        }
        for (const aliasId of aliasDeletes) {
          db.prepare("DELETE FROM artifact_aliases WHERE id = ?").run(aliasId);
        }
      });
      applyChanges();
    }

    report.summary.rows_updated = plannedUpdates.length;
    report.summary.cells_updated = plannedUpdates.reduce(
      (count, update) => count + Object.keys(update.updates).length,
      0,
    );
    report.summary.malformed_artifact_aliases_removed = aliasDeletes.length;
    report.summary.refused = report.refused.length;
    report.integrity_check = db.pragma("integrity_check", { simple: true });
  } finally {
    db.close();
  }

  report.checksums.candidate_after_sha256 = await fileSha256(candidateDb);
  await fsp.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function existingTargets(db) {
  const targets = [];
  for (const target of TEXT_TARGETS) {
    if (!tableExists(db, target.table)) {
      targets.push({ ...target, missing: true });
      continue;
    }
    const columns = tableColumns(db, target.table);
    const existingColumns = target.columns.filter((column) => columns.has(column.name));
    if (existingColumns.length > 0) {
      targets.push({
        table: target.table,
        key: target.key,
        columns: existingColumns,
        contextColumns: contextColumnsFor(columns, target),
      });
    }
  }
  if (tableExists(db, "auth_requests")) {
    const columns = tableColumns(db, "auth_requests");
    const authColumns = Array.from(AUTH_TEXT_COLUMNS)
      .filter((name) => columns.has(name))
      .map((name) => ({ name, kind: "markdown" }));
    if (authColumns.length > 0) {
      targets.push({ table: "auth_requests", key: "id", columns: authColumns, contextColumns: [] });
    }
  }
  return targets.filter((target) => !target.missing);
}

function contextColumnsFor(columns, target) {
  if (target.table === "ledger_issues") return [];
  return columns.has("issue_id") ? ["issue_id"] : [];
}

function sourceIssueId(target, row) {
  if (target.table === "ledger_issues") return String(row[target.key]);
  return row.issue_id == null ? null : String(row.issue_id);
}

function buildContext(db) {
  const issues = loadIssues(db);
  const issueAliases = loadIssueAliases(db);
  const issueResolver = buildIssueResolver(issues, issueAliases);
  const artifactHashes = loadArtifactHashes(db);
  const comments = loadComments(db, issueResolver);
  return {
    issues,
    issueResolver,
    artifactHashes,
    artifactHashSet: new Set(artifactHashes),
    commentResolver: buildCommentResolver(comments, issueResolver),
    typedResolvers: {
      auth: buildIdResolver(loadIds(db, "auth_requests"), 8),
      session: buildIdResolver(loadIds(db, "sessions"), 8),
      work_unit: buildIdResolver(loadIds(db, "work_units"), 8),
    },
  };
}

function loadComments(db, issueResolver) {
  if (!tableExists(db, "ledger_comments")) return [];
  const columns = tableColumns(db, "ledger_comments");
  const selected = [
    "id",
    columns.has("issue_id") ? "issue_id" : "'' AS issue_id",
    columns.has("ordinal") ? "ordinal" : "0 AS ordinal",
  ];
  return db.prepare(`SELECT ${selected.join(", ")} FROM ledger_comments`).all()
    .map((row) => {
      const issue = issueResolver.resolve(String(row.issue_id));
      const issueRef = issue.ok ? issueResolver.display(issue.issue) : String(row.issue_id);
      const ordinal = Number(row.ordinal ?? 0);
      return {
        id: String(row.id),
        issue_id: String(row.issue_id ?? ""),
        issue_ref: issueRef,
        ordinal,
        display: ordinal > 0 ? `${issueRef}#com_${ordinal}` : shortestGenericPrefix(String(row.id), []),
      };
    });
}

function buildCommentResolver(comments, issueResolver) {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  return {
    resolve(ref, sourceIssueId = null) {
      const trimmed = ref.replace(/^comment:/, "");
      const scoped = /^(?:(?<project>[^/#]+)\/)?(?<issue>[^/#]+)#(?<comment>[^#]+)$/.exec(trimmed);
      if (scoped?.groups) {
        const issue = issueResolver.resolve(scoped.groups.issue);
        if (!issue.ok) return { ok: false, reason: `issue_${issue.reason}` };
        const commentRef = scoped.groups.comment;
        const matches = comments.filter((comment) => (
          comment.issue_id === issue.issue.id && commentMatchesRef(comment, commentRef)
        ));
        return resolvedComment(matches);
      }
      if (/^#/.test(trimmed) && sourceIssueId) {
        const commentRef = trimmed.slice(1);
        const matches = comments.filter((comment) => (
          comment.issue_id === sourceIssueId && commentMatchesRef(comment, commentRef)
        ));
        return resolvedComment(matches);
      }
      const matches = comments.filter((comment) => comment.id.toLowerCase().startsWith(trimmed.toLowerCase()));
      return resolvedComment(matches);
    },
    display(comment) {
      return comment.display;
    },
  };
}

function commentMatchesRef(comment, ref) {
  const normalized = ref.toLowerCase().replace(/^#/, "");
  if (comment.id.toLowerCase().startsWith(normalized)) return true;
  const ordinal = /^com_(\d+)$/.exec(normalized)?.[1] ?? /^(\d+)$/.exec(normalized)?.[1];
  return ordinal != null && Number(ordinal) === comment.ordinal;
}

function resolvedComment(matches) {
  const unique = uniqueBy(matches, (comment) => comment.id);
  if (unique.length === 1) return { ok: true, comment: unique[0] };
  if (unique.length > 1) return { ok: false, reason: "ambiguous", count: unique.length };
  return { ok: false, reason: "unresolved", count: 0 };
}

function loadIds(db, table) {
  if (!tableExists(db, table) || !tableColumns(db, table).has("id")) return [];
  return db.prepare(`SELECT id FROM ${quoteIdent(table)} ORDER BY id`).all().map((row) => String(row.id));
}

function buildIdResolver(ids, minPrefixLength) {
  return {
    resolve(ref) {
      const normalized = ref.trim();
      const matches = ids.filter((id) => id.toLowerCase().startsWith(normalized.toLowerCase()));
      if (matches.length === 1) return { ok: true, id: matches[0] };
      if (matches.length > 1) return { ok: false, reason: "ambiguous", count: matches.length };
      return { ok: false, reason: "unresolved", count: 0 };
    },
    display(id) {
      return shortestGenericPrefix(id, ids, minPrefixLength);
    },
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
  return db.prepare(`SELECT ${selected.join(", ")} FROM ledger_issues`).all()
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
    "alias",
    columns.has("external_id") ? "external_id" : "'' AS external_id",
  ];
  return db.prepare(`SELECT ${selected.join(", ")} FROM ledger_issue_aliases`).all()
    .flatMap((row) => [
      { issue_id: String(row.issue_id), project_id: String(row.project_id ?? ""), ref: String(row.alias ?? "") },
      { issue_id: String(row.issue_id), project_id: String(row.project_id ?? ""), ref: String(row.external_id ?? "") },
    ])
    .filter((row) => row.ref.length > 0);
}

function buildIssueResolver(issues, aliases) {
  const byExact = new Map();
  const issueById = new Map(issues.map((issue) => [issue.id, issue]));
  for (const issue of issues) {
    addIssueRef(byExact, issue.id, issue);
    if (issue.short_id) addIssueRef(byExact, issue.short_id, issue);
  }
  for (const alias of aliases) {
    const issue = issueById.get(alias.issue_id);
    if (issue) addIssueRef(byExact, alias.ref, issue);
  }
  return {
    resolve(ref) {
      const cleaned = ref.replace(/^#/, "");
      const exact = uniqueIssues(byExact.get(cleaned.toLowerCase()) ?? []);
      if (exact.length === 1) return { ok: true, issue: exact[0] };
      if (exact.length > 1) return { ok: false, reason: "ambiguous", count: exact.length };
      const prefixMatches = issues.filter((issue) => {
        const lower = cleaned.toLowerCase();
        return issue.id.toLowerCase().startsWith(lower)
          || (issue.short_id && issue.short_id.toLowerCase().startsWith(lower));
      });
      const unique = uniqueIssues(prefixMatches);
      if (unique.length === 1) return { ok: true, issue: unique[0] };
      if (unique.length > 1) return { ok: false, reason: "ambiguous", count: unique.length };
      return { ok: false, reason: "unresolved", count: 0 };
    },
    display(issue) {
      return issue.short_id || shortestUniqueIssuePrefix(issue.id, issues);
    },
  };
}

function addIssueRef(map, ref, issue) {
  if (!ref) return;
  const key = String(ref).toLowerCase();
  const list = map.get(key) ?? [];
  list.push(issue);
  map.set(key, list);
}

function uniqueIssues(issues) {
  const byId = new Map();
  for (const issue of issues) byId.set(issue.id, issue);
  return Array.from(byId.values());
}

function loadArtifactHashes(db) {
  const hashes = new Set();
  if (tableExists(db, "artifacts")) {
    const columns = tableColumns(db, "artifacts");
    const scanColumns = ["content_hash", "id", "uri", "metadata_json", "reference_json"].filter((name) => columns.has(name));
    const rows = db.prepare(`SELECT ${scanColumns.map(quoteIdent).join(", ")} FROM artifacts`).all();
    for (const row of rows) {
      for (const column of scanColumns) collectHashesFromValue(row[column], hashes);
    }
  }
  if (tableExists(db, "artifact_aliases")) {
    const columns = tableColumns(db, "artifact_aliases");
    const scanColumns = ["artifact_id", "alias", "normalized_ref", "locator_json"].filter((name) => columns.has(name));
    const rows = db.prepare(`SELECT ${scanColumns.map(quoteIdent).join(", ")} FROM artifact_aliases`).all();
    for (const row of rows) {
      for (const column of scanColumns) collectHashesFromValue(row[column], hashes);
    }
  }
  return Array.from(hashes).sort();
}

function collectHashesFromValue(value, hashes) {
  if (typeof value !== "string") return;
  for (const match of value.matchAll(/[a-f0-9]{64}/gi)) {
    hashes.add(match[0].toLowerCase());
  }
}

function rewriteCell(value, kind, context, source) {
  if (kind === "json") return rewriteJsonCell(value, context, source);
  const includeIssueRefs = kind !== "artifact_ref";
  return rewriteText(value, context, source, { includeIssueRefs });
}

function rewriteJsonCell(value, context, source) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return {
      changed: false,
      text: value,
      counts: zeroCounts(),
      replacements: [],
      refused: [refusal(source, "invalid_json", "JSON column could not be parsed; left unchanged", value)],
    };
  }
  const aggregate = { counts: zeroCounts(), replacements: [], refused: [], changed: false };
  const rewritten = rewriteJsonValue(parsed, context, source, aggregate, null);
  if (!aggregate.changed) {
    return { changed: false, text: value, counts: aggregate.counts, replacements: [], refused: aggregate.refused };
  }
  return {
    changed: true,
    text: JSON.stringify(rewritten),
    counts: aggregate.counts,
    replacements: aggregate.replacements,
    refused: aggregate.refused,
  };
}

function rewriteJsonValue(value, context, source, aggregate, key) {
  if (typeof value === "string") {
    const rewritten = rewriteText(value, context, source, { includeIssueRefs: isTextLikeJsonKey(key) });
    appendCounts(aggregate.counts, rewritten.counts);
    aggregate.replacements.push(...rewritten.replacements);
    aggregate.refused.push(...rewritten.refused);
    if (rewritten.changed) {
      aggregate.changed = true;
      return rewritten.text;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewriteJsonValue(item, context, source, aggregate, key));
  }
  if (value && typeof value === "object") {
    const next = {};
    for (const [key, child] of Object.entries(value)) {
      next[key] = rewriteJsonValue(child, context, source, aggregate, key);
    }
    return next;
  }
  return value;
}

function isTextLikeJsonKey(key) {
  if (!key) return false;
  return /(^|_)(body|text|markdown|message|description|summary|title|notes?|spec_content|output|error|post_merge_handoff)$/i.test(key);
}

function rewriteText(value, context, source, options) {
  let text = value;
  const replacements = [];
  const refused = [];
  const counts = zeroCounts();

  const artifactPass = rewriteArtifacts(text, context, source);
  text = artifactPass.text;
  counts.artifact += artifactPass.counts.artifact;
  counts.typed += artifactPass.counts.typed;
  replacements.push(...artifactPass.replacements);
  refused.push(...artifactPass.refused);

  if (options.includeIssueRefs) {
    const issuePass = rewriteIssues(text, context, source);
    text = issuePass.text;
    counts.issue += issuePass.counts.issue;
    replacements.push(...issuePass.replacements);
    refused.push(...issuePass.refused);
  }

  return {
    changed: text !== value,
    text,
    counts,
    replacements,
    refused,
  };
}

function rewriteArtifacts(value, context, source) {
  let text = value;
  const replacements = [];
  const refused = [];
  const counts = zeroCounts();

  text = text.replace(/`((?:artifact:\/\/sha256\/|artifact:sha256:|sha256:)[a-f0-9]{7,64})`/gi, (match, ref) => {
    const resolved = resolveArtifactRef(ref, context);
    if (!resolved.ok) {
      refused.push(refusal(source, `artifact_${resolved.reason}`, `Inline artifact ref '${ref}' was not rewritten`, ref));
      return match;
    }
    counts.artifact += 1;
    const next = `[artifact:${resolved.prefix}]`;
    replacements.push({ kind: "artifact", before: match, after: next });
    return next;
  });

  text = replaceOutsideProtected(text, artifactHashRefPattern(), (match, index, fullText) => {
    if (isFileStorageLocator(fullText, index)) return match;
    const resolved = resolveArtifactRef(match, context);
    if (!resolved.ok) {
      refused.push(refusal(source, `artifact_${resolved.reason}`, `Artifact ref '${match}' was not rewritten`, match));
      return match;
    }
    counts.artifact += 1;
    const next = `[artifact:${resolved.prefix}]`;
    replacements.push({ kind: "artifact", before: match, after: next });
    return next;
  });

  text = replaceOutsideProtected(text, nakedTypedRefPattern(), (match, _index) => {
    const [type, ref] = splitTypedRef(match);
    if (!type || !ref) return match;
    if (type === "artifact") {
      const resolved = resolveArtifactRef(match, context);
      if (!resolved.ok) {
        refused.push(refusal(source, `artifact_${resolved.reason}`, `Naked artifact ref '${match}' was not bracketed`, match));
        return match;
      }
      counts.artifact += 1;
      counts.typed += 1;
      const next = `[artifact:${resolved.prefix}]`;
      replacements.push({ kind: "typed", before: match, after: next });
      return next;
    }
    if (type === "issue") {
      const resolved = context.issueResolver.resolve(ref);
      if (!resolved.ok) {
        refused.push(refusal(source, `issue_${resolved.reason}`, `Naked issue ref '${match}' was not bracketed`, match));
        return match;
      }
      counts.typed += 1;
      const next = `[issue:${context.issueResolver.display(resolved.issue)}]`;
      replacements.push({ kind: "typed", before: match, after: next });
      return next;
    }
    if (type === "comment") {
      const resolved = context.commentResolver.resolve(ref, source.issueId);
      if (!resolved.ok) {
        if (looksLikeInternalRef(ref)) {
          refused.push(refusal(source, `comment_${resolved.reason}`, `Naked comment ref '${match}' was not bracketed`, match));
        }
        return match;
      }
      counts.typed += 1;
      const next = `[comment:${context.commentResolver.display(resolved.comment)}]`;
      replacements.push({ kind: "typed", before: match, after: next });
      return next;
    }
    if (Object.prototype.hasOwnProperty.call(context.typedResolvers, type)) {
      const resolved = context.typedResolvers[type].resolve(ref);
      if (!resolved.ok) {
        if (looksLikeInternalRef(ref)) {
          refused.push(refusal(source, `${type}_${resolved.reason}`, `Naked ${type} ref '${match}' was not bracketed`, match));
        }
        return match;
      }
      counts.typed += 1;
      const next = `[${type}:${context.typedResolvers[type].display(resolved.id)}]`;
      replacements.push({ kind: "typed", before: match, after: next });
      return next;
    }
    return match;
  });

  return { text, counts, replacements, refused };
}

function rewriteIssues(value, context, source) {
  const replacements = [];
  const refused = [];
  const counts = zeroCounts();
  const text = replaceOutsideProtected(value, issueRefPattern(), (match, index, fullText) => {
    const token = match.startsWith("#") ? match.slice(1) : match;
    if (isLikelyArtifactOrShaContext(fullText, index, match.length)) return match;
    const legacyKind = match.startsWith("#") ? "hash_tag" : match.startsWith("iss_") ? "legacy_id" : "bare_hash";
    const resolved = context.issueResolver.resolve(token);
    if (!resolved.ok) {
      refused.push(refusal(source, `issue_${resolved.reason}`, `Issue ref '${match}' was not rewritten`, match));
      return match;
    }
    counts.issue += 1;
    const next = `[issue:${context.issueResolver.display(resolved.issue)}]`;
    replacements.push({ kind: "issue", legacy_kind: legacyKind, before: match, after: next });
    return next;
  });
  return { text, counts, replacements, refused };
}

function replaceOutsideProtected(value, pattern, replace) {
  const protectedSpans = buildProtectedSpans(value);
  return value.replace(pattern, (...args) => {
    const match = args[0];
    const index = args[args.length - 2];
    const fullText = args[args.length - 1];
    if (isInsideSpan(index, protectedSpans)) return match;
    return replace(match, index, fullText);
  });
}

function buildProtectedSpans(text) {
  const spans = [];
  collectRegexSpans(spans, text, /```[\s\S]*?```|~~~[\s\S]*?~~~/g);
  collectRegexSpans(spans, text, /`[^`\n]*`/g);
  collectRegexSpans(spans, text, /\[[a-z][a-z0-9_-]*:[^\]\n]+\]/gi);
  collectRegexSpans(spans, text, /\[[^\]\n]+\]\([^)]+\)/g);
  collectRegexSpans(spans, text, /(?:https?|file):\/\/[^\s)\]]+/gi);
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

function artifactHashRefPattern() {
  return /\b(?:artifact:\/\/sha256\/|artifact:sha256:|sha256:)([a-f0-9]{7,64})\b/gi;
}

function nakedTypedRefPattern() {
  return /(?<![\[\w/.-])\b(issue|comment|auth|artifact|session|work_unit):([A-Za-z0-9][A-Za-z0-9._/@#-]{1,127})\b(?![\]\w/-])/gi;
}

function issueRefPattern() {
  return /#[a-f0-9]{7,64}\b|\biss_[A-Za-z0-9_-]{4,}\b|\b[a-f0-9]{7,64}\b/gi;
}

function resolveArtifactRef(ref, context) {
  const trimmed = ref.trim().replace(/^\[artifact:/, "artifact:").replace(/\]$/, "");
  const hashMatch = /^(?:artifact:\/\/sha256\/|artifact:sha256:|sha256:)([a-f0-9]{7,64})$/i.exec(trimmed);
  const nakedMatch = /^artifact:([a-f0-9]{7,64})$/i.exec(trimmed);
  const prefix = (hashMatch?.[1] ?? nakedMatch?.[1] ?? "").toLowerCase();
  if (!prefix) return { ok: false, reason: "unsupported" };
  const matches = context.artifactHashes.filter((hash) => hash.startsWith(prefix));
  if (matches.length === 0) return { ok: false, reason: "unresolved" };
  if (matches.length > 1) return { ok: false, reason: "ambiguous" };
  return { ok: true, hash: matches[0], prefix: shortestUniqueArtifactPrefix(matches[0], context.artifactHashes) };
}

function shortestUniqueArtifactPrefix(hash, hashes) {
  for (let length = MIN_ARTIFACT_PREFIX_LENGTH; length <= hash.length; length += 1) {
    const prefix = hash.slice(0, length);
    if (hashes.filter((candidate) => candidate.startsWith(prefix)).length === 1) return prefix;
  }
  return hash.slice(0, Math.max(MIN_ARTIFACT_PREFIX_LENGTH, 12));
}

function shortestUniqueIssuePrefix(issueId, issues) {
  for (let length = 7; length <= issueId.length; length += 1) {
    const prefix = issueId.slice(0, length);
    if (issues.filter((issue) => issue.id.startsWith(prefix)).length === 1) return prefix;
  }
  return issueId.slice(0, 12);
}

function shortestGenericPrefix(id, ids, minPrefixLength = 7) {
  if (ids.length === 0) return id.slice(0, Math.max(minPrefixLength, 12));
  for (let length = minPrefixLength; length <= id.length; length += 1) {
    const prefix = id.slice(0, length);
    if (ids.filter((candidate) => candidate.startsWith(prefix)).length === 1) return prefix;
  }
  return id.slice(0, Math.max(minPrefixLength, 12));
}

function splitTypedRef(value) {
  const match = /^([a-z][a-z0-9_-]*):(.+)$/i.exec(value.trim());
  return match ? [match[1].toLowerCase(), match[2]] : [null, null];
}

function looksLikeInternalRef(ref) {
  return /[a-f0-9]{7,64}/i.test(ref)
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)
    || /\b(?:com|sess|wu|auth|req)_[A-Za-z0-9_-]{4,}\b/.test(ref);
}

function isFileStorageLocator(text, index) {
  const before = text.slice(Math.max(0, index - 80), index).toLowerCase();
  return /file:\/\/[^\s]*$/.test(before) || /\/artifacts\/sha256\/[a-f0-9]{2}\/?$/i.test(before);
}

function isLikelyArtifactOrShaContext(text, index, length) {
  const before = text.slice(Math.max(0, index - 32), index).toLowerCase();
  const after = text.slice(index + length, index + length + 32).toLowerCase();
  if (/(?:sha256[:/]|artifact(?::|:\/\/)sha256[:/]|artifact:)$/.test(before)) return true;
  if (/\b(commit|commits|sha|hash|tree|blob|object|merge|auth|request|branch)\b/.test(before)) return true;
  if (/^\.(?:patch|diff)\b/.test(after)) return true;
  return false;
}

function planMalformedAliasDeletes(db, report) {
  if (!tableExists(db, "artifact_aliases")) return [];
  const columns = tableColumns(db, "artifact_aliases");
  const selectColumns = ["id", "alias", "normalized_ref", "artifact_id", "resolution_status"].filter((name) => columns.has(name));
  const rows = db.prepare(`SELECT ${selectColumns.map(quoteIdent).join(", ")} FROM artifact_aliases`).all();
  const existingArtifactIds = tableExists(db, "artifacts")
    ? new Set(db.prepare("SELECT id FROM artifacts").all().map((row) => String(row.id)))
    : new Set();
  const deletes = [];
  for (const row of rows) {
    const alias = String(row.alias ?? "");
    const normalized = String(row.normalized_ref ?? "");
    const invalid = [alias, normalized].some(isMalformedArtifactHashRef);
    if (!invalid) continue;
    const artifactId = row.artifact_id == null ? "" : String(row.artifact_id);
    const hasLegitimateArtifact = artifactId && existingArtifactIds.has(artifactId);
    const unresolved = !artifactId || String(row.resolution_status ?? "") !== "resolved";
    if (unresolved && !hasLegitimateArtifact) {
      deletes.push(String(row.id));
      report.removed_aliases.push({
        id: String(row.id),
        alias,
        normalized_ref: normalized,
        reason: "malformed artifact hash ref without a legitimate artifact target",
      });
    } else {
      report.refused.push(refusal(
        { table: "artifact_aliases", column: "alias", rowId: String(row.id) },
        "malformed_alias_has_target",
        "Malformed artifact alias has a legitimate artifact target; left unchanged",
        `${alias} ${normalized}`.trim(),
      ));
    }
  }
  return deletes;
}

function isMalformedArtifactHashRef(value) {
  const trimmed = value.trim();
  if (!/^(?:artifact:\/\/sha256\/|artifact:sha256:|sha256:)/i.test(trimmed)) return false;
  return !/^(?:artifact:\/\/sha256\/|artifact:sha256:|sha256:)[a-f0-9]{7,64}$/i.test(trimmed);
}

async function copySqliteDb(sourceDb, targetDb) {
  await fsp.mkdir(path.dirname(targetDb), { recursive: true });
  const source = new Database(sourceDb, { readonly: true, fileMustExist: true });
  try {
    await source.backup(targetDb);
  } finally {
    source.close();
  }
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all().map((row) => String(row.name)));
}

function quoteIdent(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Invalid identifier: ${value}`);
  return `"${value}"`;
}

function zeroCounts() {
  return { issue: 0, artifact: 0, typed: 0 };
}

function appendCounts(target, source) {
  target.issue += source.issue;
  target.artifact += source.artifact;
  target.typed += source.typed;
}

function appendRefusals(report, refusals) {
  for (const item of refusals) pushLimited(report.refused, item, 500);
}

function refusal(source, reason, message, text) {
  return {
    table: source.table,
    column: source.column,
    row_id: source.rowId,
    reason,
    message,
    sample: sampleText(text, 240),
  };
}

function pushLimited(list, item, limit = SAMPLE_LIMIT) {
  if (list.length < limit) list.push(item);
}

function uniqueList(values) {
  return Array.from(new Set(values));
}

function uniqueBy(values, keyFn) {
  const map = new Map();
  for (const value of values) map.set(keyFn(value), value);
  return Array.from(map.values());
}

function sampleText(value, limit = 240) {
  const collapsed = String(value).replace(/\s+/g, " ").trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 3)}...`;
}

async function fileSha256(filePath) {
  const buffer = await fsp.readFile(filePath);
  return createHash("sha256").update(buffer).digest("hex");
}

function formatTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source-db" || arg === "--db") options.sourceDb = requireValue(argv, ++index, arg);
    else if (arg === "--output-dir") options.outputDir = requireValue(argv, ++index, arg);
    else if (arg === "--backup-db") options.backupDb = requireValue(argv, ++index, arg);
    else if (arg === "--candidate-db") options.candidateDb = requireValue(argv, ++index, arg);
    else if (arg === "--report") options.reportPath = requireValue(argv, ++index, arg);
    else if (arg === "--apply-candidate" || arg === "--apply") options.apply = true;
    else if (arg === "--dry-run") options.apply = false;
    else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function requireValue(argv, index, flag) {
  if (index >= argv.length || argv[index].startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return argv[index];
}

function printUsage() {
  console.log(`Usage: node scripts/rewrite-copied-db-refs.mjs [options]

Copies a Mandible SQLite DB to timestamped backup and candidate files, rewrites
legacy refs in the candidate only, and emits a JSON report.

Options:
  --source-db, --db <path>      Source DB to copy (default: MANDIBLE_DB or ${DEFAULT_DB})
  --output-dir <path>          Directory for backup, candidate, and report
  --backup-db <path>           Explicit backup copy path
  --candidate-db <path>        Explicit candidate copy path
  --report <path>              JSON report path
  --apply-candidate, --apply   Apply planned rewrites to the candidate copy
  --dry-run                    Copy and report only; do not mutate candidate
`);
}

const isCli = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCli) {
  try {
    const report = await runCopiedDbRefCleanup(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify({
      ok: true,
      mode: report.mode,
      backup_db: report.backup_db,
      candidate_db: report.candidate_db,
      report_path: report.report_path,
      checksums: report.checksums,
      summary: report.summary,
      integrity_check: report.integrity_check,
    }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
