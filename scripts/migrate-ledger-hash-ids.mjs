#!/usr/bin/env node
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_DB = path.join(os.homedir(), ".cache", "mandible", "mandible.db");
const dryRun = process.argv.includes("--dry-run");
const dbArg = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const dbPath = dbArg || process.env.MANDIBLE_DB || DEFAULT_DB;
const nowStamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
const backupPath = `${dbPath}.pre-hash-id-migration-${nowStamp}`;
const reportPath = path.join(path.dirname(dbPath), `ledger-hash-id-migration-${nowStamp}.json`);

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

function hasTable(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function columns(table) {
  if (!hasTable(table)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function ensureColumns() {
  const issueColumns = columns("ledger_issues");
  if (!issueColumns.has("short_id")) {
    db.exec("ALTER TABLE ledger_issues ADD COLUMN short_id TEXT NOT NULL DEFAULT ''");
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_issues_project_short_id
    ON ledger_issues(project_id, short_id)
    WHERE short_id != ''`);

  const commentColumns = columns("ledger_comments");
  if (!commentColumns.has("ordinal")) {
    db.exec("ALTER TABLE ledger_comments ADD COLUMN ordinal INTEGER NOT NULL DEFAULT 0");
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_comments_issue_ordinal
    ON ledger_comments(issue_id, ordinal)
    WHERE ordinal > 0`);
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function sha256(record) {
  return createHash("sha256").update(stableJson(record)).digest("hex");
}

function isSha256(value) {
  return /^[0-9a-f]{64}$/.test(value);
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function shortestUnique(id, peers) {
  for (let length = 7; length <= id.length; length++) {
    const prefix = id.slice(0, length);
    if (!peers.some((peer) => peer !== id && peer.startsWith(prefix))) return prefix;
  }
  return id;
}

function projectRef(project) {
  return project.repo_id || project.repo_name || project.display_name || project.id;
}

function replaceDeep(value, issueMap, commentMap) {
  if (typeof value === "string") {
    const issue = issueMap.byOldIssue.get(value);
    if (issue) return issue.newId;
    const comment = commentMap.get(value);
    if (comment) return comment.newId;
    return value;
  }
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => replaceDeep(item, issueMap, commentMap));
  const next = {};
  for (const [key, item] of Object.entries(value)) next[key] = replaceDeep(item, issueMap, commentMap);
  return next;
}

function rewriteText(text, issueMap, commentMap, contextProjectId = "") {
  let rewrites = 0;
  const mapIssueRef = (raw, explicitProject = contextProjectId) => {
    const scoped = explicitProject && issueMap.byProject.get(explicitProject)?.get(raw);
    if (scoped) return scoped.short;
    const global = issueMap.global.get(raw);
    return global && global.unique ? global.short : null;
  };
  const mapCommentRef = (raw) => commentMap.get(raw) ?? null;

  let next = text.replace(/\[comment:([^\]\s]+)\]/g, (full, ref) => {
    const scoped = ref.match(/^([^/#]+)\/([^/#]+)#([^#]+)$/);
    if (scoped) {
      const projectId = issueMap.projectRefToId.get(scoped[1]) ?? contextProjectId;
      const issue = mapIssueRef(scoped[2], projectId);
      const comment = mapCommentRef(scoped[3]);
      if (issue && comment) {
        rewrites++;
        return `[issue:${scoped[1]}/${issue}#${comment.ordinal}]`;
      }
      return full;
    }
    const local = ref.match(/^#([^#]+)$/);
    if (local) {
      const comment = mapCommentRef(local[1]);
      if (comment) {
        rewrites++;
        return `[#${comment.ordinal}]`;
      }
    }
    return full;
  });

  next = next.replace(/\[issue:([^\]\s]+)\]/g, (full, ref) => {
    const commentSplit = ref.match(/^(.+)#([^#]+)$/);
    const issuePart = commentSplit ? commentSplit[1] : ref;
    const commentPart = commentSplit ? commentSplit[2] : "";
    const scoped = issuePart.match(/^([^/#]+)\/([^/#]+)$/);
    const projectId = scoped ? issueMap.projectRefToId.get(scoped[1]) ?? contextProjectId : contextProjectId;
    const issueRef = scoped ? scoped[2] : issuePart;
    const issue = mapIssueRef(issueRef, projectId);
    if (!issue) return full;
    const prefix = scoped ? `${scoped[1]}/` : "";
    let suffix = "";
    if (commentPart) {
      const comment = mapCommentRef(commentPart);
      suffix = comment ? `#${comment.ordinal}` : `#${commentPart}`;
    }
    rewrites++;
    return `[issue:${prefix}${issue}${suffix}]`;
  });

  next = next.replace(/(?<![\w/])(?:iss_[A-Za-z0-9_]+|[0-9a-f]{7,64})\b/g, (raw) => {
    const issue = mapIssueRef(raw);
    if (!issue || issue === raw) return raw;
    rewrites++;
    return issue;
  });

  return { text: next, rewrites };
}

function buildMaps() {
  const projects = db.prepare(
    `SELECT p.id, p.display_name, c.work_repo_id AS repo_id, c.name AS repo_name
     FROM ledger_projects p
     LEFT JOIN ledger_project_checkouts c ON c.project_id = p.id`
  ).all();
  const projectRefToId = new Map();
  for (const project of projects) {
    for (const ref of [project.id, project.display_name, project.repo_id, project.repo_name].filter(Boolean)) {
      projectRefToId.set(ref, project.id);
    }
  }

  const issues = db.prepare("SELECT * FROM ledger_issues ORDER BY project_id, created_at, id").all();
  const aliases = hasTable("ledger_issue_aliases")
    ? db.prepare("SELECT * FROM ledger_issue_aliases").all()
    : [];
  const refs = hasTable("ledger_external_refs")
    ? db.prepare("SELECT * FROM ledger_external_refs").all()
    : [];

  const aliasesByIssue = new Map();
  for (const alias of aliases) {
    const bucket = aliasesByIssue.get(alias.issue_id) ?? [];
    bucket.push(alias);
    aliasesByIssue.set(alias.issue_id, bucket);
  }

  const refsByIssue = new Map();
  for (const ref of refs.filter((row) => row.entity_type === "issue")) {
    const bucket = refsByIssue.get(ref.entity_id) ?? [];
    bucket.push(ref);
    refsByIssue.set(ref.entity_id, bucket);
  }

  const issueEntries = issues.map((issue) => {
    const issueAliases = aliasesByIssue.get(issue.id) ?? [];
    const gitBugFull = issueAliases.find((alias) => alias.alias_kind === "git_bug_full" && isSha256(alias.alias))?.alias
      ?? issueAliases.find((alias) => alias.alias_kind === "git_bug_full" && isSha256(alias.external_id))?.external_id
      ?? parseJson((refsByIssue.get(issue.id) ?? []).find((ref) => ref.external_kind === "git_bug_issue")?.metadata_json ?? "{}", {}).full_id;
    const newId = issue.source === "git_bug" && isSha256(gitBugFull)
      ? gitBugFull
      : sha256({
        type: "mandible.issue.v1",
        project_id: issue.project_id,
        title: issue.title,
        body: issue.body ?? "",
        source: issue.source,
        created_at: issue.created_at,
        author_actor_id: issue.author_actor_id ?? null,
        author_actor_type: issue.author_actor_type,
        author_display: issue.author_display ?? "",
        migration_nonce: issue.id,
      });
    return { oldId: issue.id, newId, issue, aliases: issueAliases, refs: refsByIssue.get(issue.id) ?? [] };
  });

  const byProjectEntries = new Map();
  for (const entry of issueEntries) {
    const bucket = byProjectEntries.get(entry.issue.project_id) ?? [];
    bucket.push(entry);
    byProjectEntries.set(entry.issue.project_id, bucket);
  }
  for (const entries of byProjectEntries.values()) {
    const ids = entries.map((entry) => entry.newId);
    for (const entry of entries) entry.short = shortestUnique(entry.newId, ids);
  }

  const byOldIssue = new Map(issueEntries.map((entry) => [entry.oldId, entry]));
  const byNewIssue = new Map(issueEntries.map((entry) => [entry.newId, entry]));
  const byProject = new Map();
  const global = new Map();
  const addIssueRef = (projectId, ref, entry) => {
    if (!ref) return;
    const projectMap = byProject.get(projectId) ?? new Map();
    projectMap.set(ref, entry);
    byProject.set(projectId, projectMap);
    const existing = global.get(ref);
    if (!existing) global.set(ref, { ...entry, unique: true });
    else if (existing.newId !== entry.newId) global.set(ref, { ...existing, unique: false });
  };
  for (const entry of issueEntries) {
    addIssueRef(entry.issue.project_id, entry.oldId, entry);
    addIssueRef(entry.issue.project_id, entry.newId, entry);
    addIssueRef(entry.issue.project_id, entry.short, entry);
    for (const alias of entry.aliases) {
      addIssueRef(entry.issue.project_id, alias.alias, entry);
      addIssueRef(entry.issue.project_id, alias.external_id, entry);
    }
    for (const ref of entry.refs) addIssueRef(entry.issue.project_id, ref.external_id, entry);
  }

  const comments = db.prepare("SELECT * FROM ledger_comments ORDER BY issue_id, created_at, id").all();
  const commentsByIssue = new Map();
  for (const comment of comments) {
    const bucket = commentsByIssue.get(comment.issue_id) ?? [];
    bucket.push(comment);
    commentsByIssue.set(comment.issue_id, bucket);
  }
  const commentMap = new Map();
  for (const [oldIssueId, bucket] of commentsByIssue.entries()) {
    const issueEntry = byOldIssue.get(oldIssueId);
    if (!issueEntry) continue;
    bucket.forEach((comment, index) => {
      const ordinal = index + 1;
      const newId = isSha256(comment.id) ? comment.id : sha256({
        type: "mandible.comment.v1",
        issue_id: issueEntry.newId,
        ordinal,
        body: comment.body,
        source: comment.source,
        created_at: comment.created_at,
        author_actor_id: comment.author_actor_id ?? null,
        author_actor_type: comment.author_actor_type,
        author_display: comment.author_display ?? "",
        migration_nonce: comment.id,
      });
      commentMap.set(comment.id, { oldId: comment.id, newId, oldIssueId, issueId: issueEntry.newId, ordinal });
    });
  }
  for (const ref of refs.filter((row) => row.entity_type === "comment")) {
    const comment = commentMap.get(ref.entity_id);
    if (comment) commentMap.set(ref.external_id, comment);
  }

  return {
    issueEntries,
    byOldIssue,
    byNewIssue,
    byProject,
    global,
    projectRefToId,
    commentMap,
  };
}

function migrateData(maps) {
  const report = {
    dbPath,
    dryRun,
    backupPath: dryRun ? null : backupPath,
    reportPath,
    issues: maps.issueEntries.length,
    comments: Array.from(new Set([...maps.commentMap.values()].map((entry) => entry.oldId))).length,
    issueIdChanges: maps.issueEntries.filter((entry) => entry.oldId !== entry.newId).length,
    textRewrites: 0,
    tables: {},
  };
  const count = (name, n = 1) => { report.tables[name] = (report.tables[name] ?? 0) + n; };

  const run = db.transaction(() => {
    ensureColumns();
    for (const entry of maps.issueEntries) {
      db.prepare("UPDATE ledger_issues SET id = ?, short_id = ? WHERE id = ?").run(entry.newId, entry.short, entry.oldId);
      count("ledger_issues");
    }
    for (const entry of maps.commentMap.values()) {
      if (entry.oldId !== entry.newId || entry.oldIssueId !== entry.issueId) {
        db.prepare("UPDATE ledger_comments SET id = ?, issue_id = ?, ordinal = ? WHERE id = ?").run(entry.newId, entry.issueId, entry.ordinal, entry.oldId);
        count("ledger_comments");
      }
    }

    const issueTables = [
      ["ledger_labels", "issue_id"],
      ["ledger_work_unit_issue_links", "issue_id"],
      ["ledger_session_issue_links", "issue_id"],
      ["ledger_auth_issue_links", "issue_id"],
      ["ledger_commit_issue_links", "issue_id"],
    ];
    for (const [table, column] of issueTables) {
      if (!hasTable(table)) continue;
      for (const entry of maps.issueEntries) {
        const info = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(entry.newId, entry.oldId);
        if (info.changes) count(table, info.changes);
      }
    }

    if (hasTable("ledger_issue_relationships")) {
      for (const entry of maps.issueEntries) {
        count("ledger_issue_relationships", db.prepare("UPDATE ledger_issue_relationships SET source_issue_id = ? WHERE source_issue_id = ?").run(entry.newId, entry.oldId).changes);
        count("ledger_issue_relationships", db.prepare("UPDATE ledger_issue_relationships SET target_issue_id = ? WHERE target_issue_id = ?").run(entry.newId, entry.oldId).changes);
      }
    }

    if (hasTable("ledger_issue_aliases")) {
      for (const entry of maps.issueEntries) {
        db.prepare("UPDATE ledger_issue_aliases SET issue_id = ? WHERE issue_id = ?").run(entry.newId, entry.oldId);
      }
      count("ledger_issue_aliases", db.prepare("DELETE FROM ledger_issue_aliases WHERE alias_kind IN ('canonical','git_bug_human','git_bug_full','git_bug_legacy')").run().changes);
      const insert = db.prepare(
        `INSERT OR IGNORE INTO ledger_issue_aliases
         (issue_id, alias_kind, project_id, alias, external_id, source, is_primary, created_at)
         VALUES (?, 'legacy_mandible_id', ?, ?, ?, 'migration', 0, ?)`,
      );
      for (const entry of maps.issueEntries) {
        if (entry.oldId !== entry.newId && entry.oldId.startsWith("iss_")) {
          insert.run(entry.newId, entry.issue.project_id, entry.oldId, entry.oldId, Date.now());
          count("ledger_issue_aliases");
        }
      }
    }

    if (hasTable("ledger_external_refs")) {
      for (const entry of maps.issueEntries) {
        count("ledger_external_refs", db.prepare("UPDATE ledger_external_refs SET entity_id = ? WHERE entity_type = 'issue' AND entity_id = ?").run(entry.newId, entry.oldId).changes);
        count("ledger_external_refs", db.prepare("UPDATE ledger_external_refs SET external_id = ? WHERE entity_type = 'issue' AND adapter = 'git_bug' AND external_kind = 'git_bug_issue' AND entity_id = ?").run(entry.newId, entry.newId).changes);
      }
      for (const entry of maps.commentMap.values()) {
        count("ledger_external_refs", db.prepare("UPDATE ledger_external_refs SET entity_id = ? WHERE entity_type = 'comment' AND entity_id = ?").run(entry.newId, entry.oldId).changes);
      }
    }

    if (hasTable("ledger_events")) {
      const rows = db.prepare("SELECT id, entity_type, entity_id, payload_json FROM ledger_events").all();
      const update = db.prepare("UPDATE ledger_events SET entity_id = ?, payload_json = ? WHERE id = ?");
      for (const row of rows) {
        const issueEntry = row.entity_type === "issue" ? maps.byOldIssue.get(row.entity_id) : null;
        const commentEntry = row.entity_type === "comment" ? maps.commentMap.get(row.entity_id) : null;
        const newEntityId = issueEntry?.newId ?? commentEntry?.newId ?? row.entity_id;
        const payload = replaceDeep(parseJson(row.payload_json, {}), maps, maps.commentMap);
        update.run(newEntityId, JSON.stringify(payload), row.id);
      }
      count("ledger_events", rows.length);
    }

    for (const table of ["ledger_conflicts", "ledger_reconciliation_mismatches", "ledger_operational_link_mismatches"]) {
      if (!hasTable(table)) continue;
      const tableColumns = columns(table);
      for (const column of ["entity_id", "issue_ref"]) {
        if (!tableColumns.has(column)) continue;
        for (const entry of maps.issueEntries) {
          count(table, db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(entry.newId, entry.oldId).changes);
        }
      }
      for (const jsonColumn of ["local_value_json", "remote_value_json", "base_value_json", "metadata_json", "scanner_json", "ledger_json"]) {
        if (!tableColumns.has(jsonColumn)) continue;
        const rows = db.prepare(`SELECT rowid, ${jsonColumn} AS value FROM ${table}`).all();
        const update = db.prepare(`UPDATE ${table} SET ${jsonColumn} = ? WHERE rowid = ?`);
        for (const row of rows) update.run(JSON.stringify(replaceDeep(parseJson(row.value, row.value), maps, maps.commentMap)), row.rowid);
      }
    }

    for (const table of ["work_units", "session_issues", "issue_resolutions"]) {
      if (!hasTable(table) || !columns(table).has("issue_id")) continue;
      const rows = db.prepare(`SELECT rowid, issue_id FROM ${table}`).all();
      const update = db.prepare(`UPDATE ${table} SET issue_id = ? WHERE rowid = ?`);
      for (const row of rows) {
        const rewritten = rewriteText(row.issue_id, maps, maps.commentMap).text;
        if (rewritten !== row.issue_id) {
          update.run(rewritten, row.rowid);
          count(table);
        }
      }
    }
    if (hasTable("work_units") && columns("work_units").has("ledger_issue_id")) {
      for (const entry of maps.issueEntries) {
        count("work_units", db.prepare("UPDATE work_units SET ledger_issue_id = ? WHERE ledger_issue_id = ?").run(entry.newId, entry.oldId).changes);
      }
    }

    if (hasTable("auth_requests")) {
      const tableColumns = columns("auth_requests");
      const stringColumns = ["issue_references", "issue_closures", "issue_ids", "issues", "spec", "commit_message"].filter((column) => tableColumns.has(column));
      const rows = db.prepare(`SELECT id, ${stringColumns.join(", ")} FROM auth_requests`).all();
      for (const column of stringColumns) {
        const update = db.prepare(`UPDATE auth_requests SET ${column} = ? WHERE id = ?`);
        for (const row of rows) {
          if (typeof row[column] !== "string") continue;
          const { text, rewrites } = rewriteText(row[column], maps, maps.commentMap);
          if (rewrites > 0) {
            update.run(text, row.id);
            report.textRewrites += rewrites;
            count("auth_requests");
          }
        }
      }
    }

    for (const table of ["ledger_issues", "ledger_comments"]) {
      const bodyColumn = table === "ledger_issues" ? "body" : "body";
      const rows = db.prepare(`SELECT id, ${table === "ledger_issues" ? "project_id" : "issue_id"} AS scope_id, ${bodyColumn} AS body FROM ${table}`).all();
      const update = db.prepare(`UPDATE ${table} SET ${bodyColumn} = ? WHERE id = ?`);
      for (const row of rows) {
        const projectId = table === "ledger_issues"
          ? row.scope_id
          : maps.byOldIssue.get(row.scope_id)?.issue.project_id ?? maps.byNewIssue.get(row.scope_id)?.issue.project_id ?? "";
        const { text, rewrites } = rewriteText(row.body, maps, maps.commentMap, projectId);
        if (rewrites > 0) {
          update.run(text, row.id);
          report.textRewrites += rewrites;
          count(table);
        }
      }
    }

    const fk = db.pragma("foreign_key_check");
    if (fk.length > 0) {
      throw new Error(`foreign_key_check failed: ${JSON.stringify(fk.slice(0, 10))}`);
    }
  });

  if (!dryRun) {
    db.pragma("foreign_keys = OFF");
    try {
      run();
    } finally {
      db.pragma("foreign_keys = ON");
    }
  }
  return report;
}

try {
  ensureColumns();
  const maps = buildMaps();
  if (!dryRun) {
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    await db.backup(backupPath);
  }
  const report = migrateData(maps);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  db.close();
}
