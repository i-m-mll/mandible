#!/usr/bin/env node

import Database from "better-sqlite3";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const KINDS = new Set(["bug", "feature", "umbrella", "task", "question", "maintenance", "deferred", "unknown"]);
const PRIORITIES = new Set(["low", "normal", "high", "urgent", "unknown"]);
const KIND_PRECEDENCE = ["umbrella", "bug", "deferred", "question", "task", "maintenance", "feature"];
const HASH_REF_PATTERN = /`([0-9a-f]{7,16})`|(?<![\w/#:[-])([0-9a-f]{7,16})(?![\w-])/g;
const ISSUE_CONTEXT_PATTERN = /\b(issue|issues|bug|bugs|plan|umbrella|blocking|blocked|parent|child|children|partition|supersedes|related|references|refs|see|per|from|on|follow-up|followup)\b/i;
const NON_ISSUE_CONTEXT_PATTERN = /\b(commit|commits|sha|branch|branches|tag|version|diff|patch|tree|blob|object)\b/i;

const args = parseArgs(process.argv.slice(2));
const dbPath = args.db ?? process.env.MANDIBLE_DB ?? path.join(os.homedir(), ".cache", "mandible", "mandible.db");
const apply = Boolean(args.apply);
const reportPath = args.report ?? path.join(
  os.homedir(),
  ".cache",
  "mandible",
  `ledger-issue-audit-${timestamp()}.json`,
);

if (apply && args.dryRun) {
  die("Use either --apply or --dry-run, not both.");
}

const db = new Database(dbPath);
db.pragma("busy_timeout = 5000");

const backupPath = apply
  ? args.backup ?? path.join(path.dirname(dbPath), `mandible.db.pre-ledger-audit-${timestamp()}`)
  : null;

if (apply && backupPath) {
  await db.backup(backupPath);
}

const issues = loadIssues(db);
const aliasesByIssue = loadAliasesByIssue(db);
const labelsByIssue = loadLabelsByIssue(db);
const commentsByIssue = loadCommentsByIssue(db);
const projectById = loadProjects(db);
const resolver = buildAliasResolver(issues, aliasesByIssue, projectById);

const report = {
  mode: apply ? "apply" : "dry-run",
  db_path: dbPath,
  backup_path: backupPath,
  report_path: reportPath,
  created_at: new Date().toISOString(),
  summary: {
    issues_seen: issues.length,
    metadata_updates: 0,
    body_rewrites: 0,
    comment_rewrites: 0,
    refs_rewritten: 0,
    refs_skipped: 0,
    ambiguous_refs: 0,
  },
  metadata_updates: [],
  content_rewrites: [],
  skipped_refs: [],
};

for (const issue of issues) {
  const labels = labelsByIssue.get(issue.id) ?? [];
  const metadataPatch = deriveMetadataPatch(issue, labels);
  if (metadataPatch) {
    report.summary.metadata_updates += 1;
    report.metadata_updates.push({
      issue_id: issue.id,
      display_id: displayIssueId(issue, aliasesByIssue.get(issue.id) ?? []),
      repo: projectById.get(issue.project_id)?.repo_id ?? issue.project_id,
      title: issue.title,
      labels,
      before: { kind: issue.kind, priority: issue.priority },
      after: {
        kind: metadataPatch.kind ?? issue.kind,
        priority: metadataPatch.priority ?? issue.priority,
      },
    });
  }

  const rewrittenBody = rewriteContent(issue.body, issue, resolver, aliasesByIssue, projectById, report);
  if (rewrittenBody.changed) {
    report.summary.body_rewrites += 1;
    report.content_rewrites.push({
      entity_type: "issue",
      entity_id: issue.id,
      issue_id: issue.id,
      display_id: displayIssueId(issue, aliasesByIssue.get(issue.id) ?? []),
      repo: projectById.get(issue.project_id)?.repo_id ?? issue.project_id,
      title: issue.title,
      replacements: rewrittenBody.replacements,
    });
  }

  for (const comment of commentsByIssue.get(issue.id) ?? []) {
    const rewrittenComment = rewriteContent(comment.body, issue, resolver, aliasesByIssue, projectById, report);
    if (!rewrittenComment.changed) continue;
    report.summary.comment_rewrites += 1;
    report.content_rewrites.push({
      entity_type: "comment",
      entity_id: comment.id,
      issue_id: issue.id,
      display_id: displayIssueId(issue, aliasesByIssue.get(issue.id) ?? []),
      repo: projectById.get(issue.project_id)?.repo_id ?? issue.project_id,
      title: issue.title,
      replacements: rewrittenComment.replacements,
    });
  }
}

if (apply) {
  const updateIssueMetadata = db.prepare(
    "UPDATE ledger_issues SET kind = ?, priority = ?, updated_at = ? WHERE id = ?",
  );
  const updateIssueBody = db.prepare(
    "UPDATE ledger_issues SET body = ?, updated_at = ? WHERE id = ?",
  );
  const updateCommentBody = db.prepare(
    "UPDATE ledger_comments SET body = ?, updated_at = ? WHERE id = ?",
  );
  const now = Date.now();
  const applyChanges = db.transaction(() => {
    for (const item of report.metadata_updates) {
      updateIssueMetadata.run(item.after.kind, item.after.priority, now, item.issue_id);
    }
    for (const issue of issues) {
      const rewritten = rewriteContent(issue.body, issue, resolver, aliasesByIssue, projectById, null);
      if (rewritten.changed) updateIssueBody.run(rewritten.text, now, issue.id);
      for (const comment of commentsByIssue.get(issue.id) ?? []) {
        const rewrittenComment = rewriteContent(comment.body, issue, resolver, aliasesByIssue, projectById, null);
        if (rewrittenComment.changed) updateCommentBody.run(rewrittenComment.text, now, comment.id);
      }
    }
  });
  applyChanges();
}

await fs.mkdir(path.dirname(reportPath), { recursive: true });
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, mode: report.mode, backup_path: backupPath, report_path: reportPath, summary: report.summary }, null, 2));

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") parsed.apply = true;
    else if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--db") parsed.db = argv[++i];
    else if (arg === "--report") parsed.report = argv[++i];
    else if (arg === "--backup") parsed.backup = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/audit-ledger-issue-migration.mjs [--dry-run|--apply] [--db path] [--report path] [--backup path]");
      process.exit(0);
    } else {
      die(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function loadIssues(database) {
  return database.prepare(
    `SELECT id, project_id, title, body, kind, priority, created_at, updated_at
       FROM ledger_issues
      WHERE deleted_at IS NULL
      ORDER BY project_id, created_at, id`,
  ).all();
}

function loadAliasesByIssue(database) {
  const rows = database.prepare(
    `SELECT issue_id, alias_kind, alias, is_primary
       FROM ledger_issue_aliases
      ORDER BY is_primary DESC, alias_kind, alias`,
  ).all();
  const byIssue = new Map();
  for (const row of rows) {
    const list = byIssue.get(row.issue_id) ?? [];
    list.push(row);
    byIssue.set(row.issue_id, list);
  }
  return byIssue;
}

function loadLabelsByIssue(database) {
  const rows = database.prepare(
    "SELECT issue_id, label FROM ledger_labels WHERE deleted_at IS NULL ORDER BY label",
  ).all();
  const byIssue = new Map();
  for (const row of rows) {
    const list = byIssue.get(row.issue_id) ?? [];
    list.push(row.label);
    byIssue.set(row.issue_id, list);
  }
  return byIssue;
}

function loadCommentsByIssue(database) {
  const rows = database.prepare(
    "SELECT id, issue_id, body FROM ledger_comments WHERE deleted_at IS NULL ORDER BY issue_id, created_at, id",
  ).all();
  const byIssue = new Map();
  for (const row of rows) {
    const list = byIssue.get(row.issue_id) ?? [];
    list.push(row);
    byIssue.set(row.issue_id, list);
  }
  return byIssue;
}

function loadProjects(database) {
  const rows = database.prepare(
    `SELECT p.id AS project_id,
            p.display_name,
            COALESCE(c.work_repo_id, c.name, p.display_name, p.id) AS repo_id
       FROM ledger_projects p
       LEFT JOIN ledger_project_checkouts c ON c.project_id = p.id
      GROUP BY p.id`,
  ).all();
  return new Map(rows.map((row) => [row.project_id, row]));
}

function buildAliasResolver(issueRows, aliasesByIssue, projectById) {
  const entriesByAlias = new Map();
  const issueById = new Map(issueRows.map((issue) => [issue.id, issue]));
  for (const issue of issueRows) {
    for (const alias of aliasesByIssue.get(issue.id) ?? []) {
      const clean = String(alias.alias ?? "").trim();
      if (!clean) continue;
      const key = clean.toLowerCase();
      const list = entriesByAlias.get(key) ?? [];
      list.push({
        issue,
        alias: clean,
        repo: projectById.get(issue.project_id)?.repo_id ?? issue.project_id,
      });
      entriesByAlias.set(key, list);
    }
  }
  return {
    issueById,
    resolve(ref) {
      const list = entriesByAlias.get(String(ref).toLowerCase()) ?? [];
      if (list.length !== 1) return { ok: false, reason: list.length > 1 ? "ambiguous" : "unresolved", matches: list };
      return { ok: true, ...list[0] };
    },
  };
}

function deriveMetadataPatch(issue, labels) {
  const derivedKind = deriveKind(labels);
  const derivedPriority = derivePriority(labels);
  const patch = {};

  if (derivedKind && derivedKind !== issue.kind && shouldUpdateKind(issue.kind, derivedKind)) {
    patch.kind = derivedKind;
  }
  if (derivedPriority && derivedPriority !== issue.priority && shouldUpdatePriority(issue.priority, derivedPriority)) {
    patch.priority = derivedPriority;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

function deriveKind(labels) {
  for (const label of labels) {
    const parsed = label.match(/^mandible:kind:([^:]+)$/);
    if (parsed && KINDS.has(parsed[1])) return parsed[1];
  }
  const set = new Set(labels);
  for (const kind of KIND_PRECEDENCE) {
    if (kind === "bug" && set.has("error")) return "bug";
    if (set.has(kind)) return kind;
  }
  return null;
}

function derivePriority(labels) {
  for (const label of labels) {
    const parsed = label.match(/^mandible:priority:([^:]+)$/);
    if (parsed && PRIORITIES.has(parsed[1])) return parsed[1];
  }
  const set = new Set(labels);
  if (set.has("urgent")) return "urgent";
  if (set.has("important") || set.has("high")) return "high";
  if (set.has("normal")) return "normal";
  if (set.has("low")) return "low";
  return null;
}

function shouldUpdateKind(current, next) {
  if (!current || current === "unknown") return true;
  if (current === "feature" && next === "umbrella") return true;
  if (current === "feature" && next === "bug") return true;
  return false;
}

function shouldUpdatePriority(current, next) {
  return !current || current === "unknown" || current === next;
}

function rewriteContent(text, currentIssue, resolver, aliasesByIssue, projectById, reportSink) {
  if (!text) return { changed: false, text, replacements: [] };
  const replacements = [];
  const output = text.replace(HASH_REF_PATTERN, (full, codeRef, bareRef, offset, whole) => {
    const ref = codeRef || bareRef;
    const resolved = resolver.resolve(ref);
    if (!resolved.ok) {
      recordSkipped(reportSink, currentIssue, ref, resolved.reason, contextAround(whole, offset));
      return full;
    }
    if (!isSafeIssueReference(full, offset, whole, Boolean(codeRef))) {
      recordSkipped(reportSink, currentIssue, ref, "context_not_issue_like", contextAround(whole, offset));
      return full;
    }
    const currentRepo = projectById.get(currentIssue.project_id)?.repo_id ?? currentIssue.project_id;
    const targetRepo = resolved.repo;
    const display = displayIssueId(resolved.issue, aliasesByIssue.get(resolved.issue.id) ?? []);
    const scoped = targetRepo === currentRepo ? display : `${targetRepo}/${display}`;
    const next = `[issue:${scoped}]`;
    replacements.push({
      from: full,
      to: next,
      target_issue_id: resolved.issue.id,
      target_display_id: display,
      target_repo: targetRepo,
      context: contextAround(whole, offset),
    });
    if (reportSink) reportSink.summary.refs_rewritten += 1;
    return next;
  });
  return { changed: output !== text, text: output, replacements };
}

function isSafeIssueReference(full, offset, whole, codeSpan) {
  const context = contextAround(whole, offset);
  if (NON_ISSUE_CONTEXT_PATTERN.test(context) && !ISSUE_CONTEXT_PATTERN.test(context)) return false;
  if (codeSpan) return true;
  return ISSUE_CONTEXT_PATTERN.test(context);
}

function recordSkipped(reportSink, issue, ref, reason, context) {
  if (!reportSink) return;
  reportSink.summary.refs_skipped += 1;
  if (reason === "ambiguous") reportSink.summary.ambiguous_refs += 1;
  reportSink.skipped_refs.push({
    issue_id: issue.id,
    ref,
    reason,
    context,
  });
}

function displayIssueId(issue, aliases) {
  const preferred =
    aliases.find((alias) => alias.is_primary === 1 && alias.alias_kind !== "canonical") ??
    aliases.find((alias) => alias.alias_kind !== "canonical") ??
    aliases.find((alias) => alias.is_primary === 1) ??
    aliases[0];
  return preferred?.alias || issue.id;
}

function contextAround(value, offset) {
  return value.slice(Math.max(0, offset - 80), Math.min(value.length, offset + 80)).replace(/\s+/g, " ").trim();
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

function die(message) {
  console.error(message);
  process.exit(1);
}
