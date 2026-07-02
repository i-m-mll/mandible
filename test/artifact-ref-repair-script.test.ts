import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runArtifactRefRepair } from "../scripts/repair-artifact-refs.mjs";

let tempDir = "";
let dbPath = "";
let artifactRoot = "";
let savedEnv: Record<string, string | undefined>;

const LEGACY_HASH = "a".repeat(64);
const MISSING_HASH = "b".repeat(64);

beforeEach(() => {
  savedEnv = {
    MANDIBLE_ARTIFACT_DIR: process.env.MANDIBLE_ARTIFACT_DIR,
    MANDIBLE_DB: process.env.MANDIBLE_DB,
  };
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-artifact-ref-repair-"));
  artifactRoot = path.join(tempDir, "artifacts");
  dbPath = path.join(tempDir, "mandible.db");
  process.env.MANDIBLE_ARTIFACT_DIR = artifactRoot;
  delete process.env.MANDIBLE_DB;
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("repair-artifact-refs script", () => {
  it("dry-runs current ledger fields, structured links, and latest text artifacts without mutating", async () => {
    const db = createFixtureDb({ latestHasRefs: true });
    const beforeIssue = getIssueBody(db);
    const beforeVersionCount = versionCount(db, "artifact:report");
    db.close();

    const report = await runArtifactRefRepair({ dbPath });

    expect(report.mode).toBe("dry_run");
    expect(report.summary.findings).toBeGreaterThanOrEqual(5);
    expect(report.summary.ledger_cells_to_update).toBeGreaterThanOrEqual(4);
    expect(report.summary.structured_links_to_update).toBe(2);
    expect(report.summary.latest_artifacts_to_version).toBe(1);
    expect(report.summary.invalid_issue_tags_rewritten).toBe(4);
    expect(report.summary.invalid_issue_tags_refused).toBe(1);
    expect(report.findings.some((finding: any) =>
      finding.ref === `artifact:sha256:${LEGACY_HASH}` &&
      finding.replacement === `artifact-blob:${LEGACY_HASH}`
    )).toBe(true);
    expect(report.findings.some((finding: any) =>
      finding.ref === "artifact-series:report" &&
      finding.replacement === "artifact:report"
    )).toBe(true);

    const after = new Database(dbPath);
    expect(getIssueBody(after)).toBe(beforeIssue);
    expect(versionCount(after, "artifact:report")).toBe(beforeVersionCount);
    after.close();
  });

  it("applies unambiguous rewrites, appends artifact versions, backs up, and is idempotent", async () => {
    const db = createFixtureDb({ latestHasRefs: true });
    const oldVersion = db
      .prepare("SELECT blob_id FROM artifact_version WHERE id = 'artifact-version:v1'")
      .get() as { blob_id: string };
    db.close();
    const backupPath = path.join(tempDir, "backup.db");

    const first = await runArtifactRefRepair({ dbPath, apply: true, backupPath, check: true });

    expect(first.mode).toBe("apply");
    expect(first.check_failed).toBe(false);
    expect(fs.existsSync(backupPath)).toBe(true);
    expect(first.artifact_version_appends).toHaveLength(1);
    expect(first.after_summary.unambiguous_replacements).toBe(0);
    expect(first.after_summary.invalid_issue_tags_refused).toBe(1);
    expect(first.after_verification.zero_legacy_actionable_refs).toBe(true);

    const applied = new Database(dbPath);
    expect(getIssueBody(applied)).toContain(`artifact-blob:${LEGACY_HASH}`);
    expect(getIssueBody(applied)).toContain(`artifact=artifact-blob%3A${LEGACY_HASH}`);
    expect(getIssueBody(applied)).toContain("artifact:report");
    expect(getIssueBody(applied)).toContain("[issue:abc1234]");
    expect(getIssueBody(applied)).toContain("`[closes:abc1234]`");
    expect(getIssueBody(applied)).toContain("```");
    expect(
      JSON.parse((applied.prepare("SELECT metadata_json FROM ledger_issues WHERE id = 'issue-1'").get() as any).metadata_json),
    ).toEqual({ ref: `artifact-blob:${LEGACY_HASH}` });
    expect(
      applied.prepare("SELECT target_type, target_id FROM artifact_links WHERE id = 'link-1'").get(),
    ).toEqual({ target_type: "artifact", target_id: "artifact:report" });
    expect(
      applied.prepare(
        "SELECT target_type, target_id, legacy_blob_id FROM artifact_links WHERE id = 'link-blob'",
      ).get(),
    ).toEqual({
      target_type: null,
      target_id: null,
      legacy_blob_id: `artifact-blob:${LEGACY_HASH}`,
    });
    expect(
      (applied.prepare("SELECT body FROM ledger_comments WHERE id = 'comment-1'").get() as any).body,
    ).toContain("[issue:abc1234]");
    expect(
      (applied.prepare("SELECT snapshot_body FROM ledger_body_revisions WHERE id = 'revision-1'").get() as any)
        .snapshot_body,
    ).toContain("[issue:abc1234]");

    const artifact = applied
      .prepare("SELECT latest_version_id, version_count FROM artifact WHERE id = 'artifact:report'")
      .get() as { latest_version_id: string; version_count: number };
    expect(artifact.latest_version_id).not.toBe("artifact-version:v1");
    expect(artifact.version_count).toBe(2);
    const latest = applied
      .prepare(
        `SELECT v.blob_id, b.content_hash
         FROM artifact_version v
         JOIN artifact_blob b ON b.id = v.blob_id
         WHERE v.id = ?`,
      )
      .get(artifact.latest_version_id) as { blob_id: string; content_hash: string };
    const latestText = fs.readFileSync(casPath(latest.content_hash), "utf8");
    expect(latestText).toContain(`artifact-blob:${LEGACY_HASH}`);
    expect(latestText).toContain("artifact:report");
    const oldBlob = applied
      .prepare("SELECT content_hash FROM artifact_blob WHERE id = ?")
      .get(oldVersion.blob_id) as { content_hash: string };
    expect(fs.readFileSync(casPath(oldBlob.content_hash), "utf8")).toContain(`artifact:${LEGACY_HASH}`);
    applied.close();

    const second = await runArtifactRefRepair({ dbPath, apply: true, backupPath: "auto", check: true });
    expect(second.check_failed).toBe(false);
    expect(second.summary.unambiguous_replacements).toBe(0);
    expect(second.summary.invalid_issue_tags_refused).toBe(1);
    expect(second.summary.latest_artifacts_to_version).toBe(0);
  });

  it("scans only latest text or markdown artifact content", async () => {
    const db = createFixtureDb({ latestHasRefs: false, previousHasRefs: true, jsonArtifactHasRefs: true });
    db.close();

    const report = await runArtifactRefRepair({ dbPath });

    expect(report.artifact_version_appends).toHaveLength(0);
    expect(report.skipped_artifacts.some((artifact: any) =>
      artifact.artifact_id === "artifact:manifest" &&
      artifact.reason === "not_text_or_markdown"
    )).toBe(true);
    expect(report.findings.every((finding: any) =>
      finding.context.surface !== "artifact_content" || finding.context.version_id !== "artifact-version:v0"
    )).toBe(true);
  });

  it("reports check failures until all current old refs are gone", async () => {
    const db = createFixtureDb({ latestHasRefs: false });
    db.prepare(
      "UPDATE ledger_issues SET body = ? WHERE id = 'issue-1'",
    ).run(`Unresolved ${`artifact:sha256:${MISSING_HASH}`}`);
    db.close();

    const failed = await runArtifactRefRepair({ dbPath, check: true });
    expect(failed.check_failed).toBe(true);
    expect(failed.summary.unresolved_refs).toBe(1);

    const fixedDb = new Database(dbPath);
    fixedDb.prepare("UPDATE ledger_issues SET body = 'No old refs' WHERE id = 'issue-1'").run();
    fixedDb.prepare("UPDATE ledger_issues SET metadata_json = '{}' WHERE id = 'issue-1'").run();
    fixedDb.prepare("UPDATE ledger_comments SET body = 'No old refs' WHERE id = 'comment-1'").run();
    fixedDb.prepare("UPDATE ledger_body_revisions SET snapshot_body = 'No old refs' WHERE id = 'revision-1'").run();
    fixedDb.prepare("UPDATE artifact_links SET series_id = NULL, series_ref = NULL WHERE id = 'link-1'").run();
    fixedDb.prepare(
      "UPDATE artifact_links SET legacy_blob_id = ? WHERE id = 'link-blob'",
    ).run(`artifact-blob:${LEGACY_HASH}`);
    fixedDb.close();

    const passed = await runArtifactRefRepair({ dbPath, check: true });
    expect(passed.check_failed).toBe(false);
    expect(passed.summary.findings).toBe(0);
  });
});

function createFixtureDb(options: {
  latestHasRefs: boolean;
  previousHasRefs?: boolean;
  jsonArtifactHasRefs?: boolean;
}): Database.Database {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE ledger_projects (
      id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL DEFAULT '',
      display_name TEXT NOT NULL DEFAULT '',
      repo_id TEXT NOT NULL DEFAULT '',
      work_repo_id TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE ledger_issues (
      id TEXT PRIMARY KEY,
      short_id TEXT NOT NULL DEFAULT '',
      project_id TEXT NOT NULL DEFAULT '',
      title TEXT,
      body TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE ledger_comments (
      id TEXT PRIMARY KEY,
      issue_id TEXT,
      body TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE ledger_body_revisions (
      id TEXT PRIMARY KEY,
      snapshot_body TEXT,
      patch_text TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE ledger_issue_aliases (
      issue_id TEXT NOT NULL,
      alias_kind TEXT NOT NULL,
      project_id TEXT NOT NULL DEFAULT '',
      alias TEXT NOT NULL,
      external_id TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'test'
    );
    CREATE TABLE ledger_events (
      id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE artifact_blob (
      id TEXT PRIMARY KEY,
      algorithm TEXT NOT NULL DEFAULT 'sha256',
      content_hash TEXT NOT NULL,
      storage_uri TEXT,
      media_type TEXT,
      role TEXT,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      provider_id TEXT,
      manifest_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      custody_mode TEXT NOT NULL DEFAULT 'managed',
      availability TEXT NOT NULL DEFAULT 'present',
      retention_json TEXT NOT NULL DEFAULT '{}',
      reference_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      UNIQUE(algorithm, content_hash)
    );
    CREATE TABLE artifact (
      id TEXT PRIMARY KEY,
      identity_key TEXT NOT NULL UNIQUE,
      source_kind TEXT NOT NULL DEFAULT 'managed',
      title TEXT,
      source_project_id TEXT,
      source_repo_id TEXT,
      logical_name TEXT,
      source_path TEXT,
      latest_version_id TEXT,
      version_count INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE artifact_version (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      version_no INTEGER NOT NULL,
      blob_id TEXT NOT NULL,
      source_kind TEXT NOT NULL DEFAULT 'managed',
      content_hash TEXT NOT NULL,
      source_project_id TEXT,
      source_repo_id TEXT,
      repo_path TEXT,
      commit_sha TEXT,
      observed_path TEXT,
      source_locator_json TEXT NOT NULL DEFAULT '{}',
      custody_mode TEXT,
      label TEXT,
      note TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      UNIQUE(artifact_id, version_no)
    );
    CREATE TABLE artifact_series (
      id TEXT PRIMARY KEY,
      series_key TEXT NOT NULL,
      latest_version_id TEXT,
      version_count INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE artifact_links (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      link_type TEXT NOT NULL DEFAULT 'references',
      link_kind TEXT NOT NULL DEFAULT 'living',
      series_id TEXT,
      series_ref TEXT,
      target_type TEXT,
      target_id TEXT,
      fallback_version_id TEXT,
      legacy_blob_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.prepare("INSERT INTO settings (key, value) VALUES ('artifact_root', ?)").run(artifactRoot);
  db.prepare(
    `INSERT INTO ledger_projects (id, project_key, display_name, repo_id, work_repo_id)
     VALUES ('prj_mandible', 'mandible', 'Mandible', 'mandible', 'mandible')`,
  ).run();
  db.prepare(
    `INSERT INTO ledger_issues (id, short_id, project_id, title, body, metadata_json)
     VALUES ('issue-1', 'abc1234', 'prj_mandible', 'Issue', ?, ?)`,
  ).run(
    [
      `See artifact:sha256:${LEGACY_HASH} and artifact-series:report`,
      `Short link [artifact:sha256:${LEGACY_HASH.slice(0, 7)}](http://localhost:19420/#/artifacts?artifact=artifact%3Asha256%3A${LEGACY_HASH}&sidebar=hidden)`,
      "Invalid [references:abc1234] and [parent_child:mandible/alias-issue] rewrite.",
      "Protected `[closes:abc1234]` and fenced stay:",
      "```",
      "[fixes:abc1234]",
      "```",
      "Unresolved [related:not-an-issue] is reported but not changed.",
    ].join("\n"),
    JSON.stringify({ ref: `sha256:${LEGACY_HASH}` }),
  );
  db.prepare(
    `INSERT INTO ledger_issue_aliases (issue_id, alias_kind, project_id, alias, source)
     VALUES ('issue-1', 'test', 'prj_mandible', 'alias-issue', 'test')`,
  ).run();
  db.prepare(
    "INSERT INTO ledger_comments (id, issue_id, body) VALUES ('comment-1', 'issue-1', ?)",
  ).run(`Old shorthand artifact:${LEGACY_HASH} and [closes:mandible/abc1234]`);
  db.prepare(
    "INSERT INTO ledger_body_revisions (id, snapshot_body, patch_text) VALUES ('revision-1', ?, '')",
  ).run("Historical [fixes:alias-issue] rewrites.");
  db.prepare("INSERT INTO ledger_events (id, payload_json) VALUES ('event-1', '{}')").run();
  insertBlob(db, LEGACY_HASH, "legacy target", "text/plain");
  db.prepare(
    `INSERT INTO artifact_series (id, series_key, latest_version_id, version_count, metadata_json)
     VALUES ('artifact-series:report', 'managed:report', 'artifact-version:v1', 1, '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO artifact (
      id, identity_key, source_kind, title, logical_name, source_path,
      latest_version_id, version_count, metadata_json, created_at, updated_at
    ) VALUES (
      'artifact:report', 'managed:report', 'managed', 'Report', 'report.md', 'report.md',
      'artifact-version:v1', 1, '{}', 1, 1
    )`,
  ).run();
  const previousText = options.previousHasRefs
    ? `Previous artifact-series:report and artifact:sha256:${LEGACY_HASH}\n`
    : "Previous clean\n";
  const latestText = options.latestHasRefs
    ? `Latest artifact:${LEGACY_HASH} and artifact-series:report\n`
    : "Latest clean\n";
  const previousHash = writeCas(previousText);
  const latestHash = writeCas(latestText);
  insertBlob(db, previousHash, previousText, "text/markdown");
  insertBlob(db, latestHash, latestText, "text/markdown");
  db.prepare(
    `INSERT INTO artifact_version (
      id, artifact_id, version_no, blob_id, source_kind, content_hash,
      source_locator_json, custody_mode, metadata_json, created_at
    ) VALUES (
      'artifact-version:v0', 'artifact:report', 0, ?, 'managed', ?, '{}', 'managed', '{}', 1
    )`,
  ).run(`artifact-blob:${previousHash}`, previousHash);
  db.prepare(
    `INSERT INTO artifact_version (
      id, artifact_id, version_no, blob_id, source_kind, content_hash,
      source_locator_json, custody_mode, metadata_json, created_at
    ) VALUES (
      'artifact-version:v1', 'artifact:report', 1, ?, 'managed', ?, ?, 'managed', '{}', 2
    )`,
  ).run(
    `artifact-blob:${latestHash}`,
    latestHash,
    JSON.stringify({ legacy_series_id: "artifact-series:report" }),
  );
  db.prepare(
    `INSERT INTO artifact_links (
      id, artifact_id, entity_type, entity_id, series_id, series_ref,
      metadata_json, created_at, updated_at
    ) VALUES (
      'link-1', 'legacy-artifact', 'issue', 'issue-1', 'artifact-series:report',
      'artifact-series:report', '{}', 1, 1
    )`,
  ).run();
  db.prepare(
    `INSERT INTO artifact_links (
      id, artifact_id, entity_type, entity_id,
      metadata_json, created_at, updated_at
    ) VALUES (
      'link-blob', ?, 'issue', 'issue-1',
      '{}', 1, 1
    )`,
  ).run(`artifact:sha256:${LEGACY_HASH}`);

  if (options.jsonArtifactHasRefs) {
    const manifest = JSON.stringify({ ref: `artifact:sha256:${LEGACY_HASH}` });
    const manifestHash = writeCas(manifest);
    insertBlob(db, manifestHash, manifest, "application/json");
    db.prepare(
      `INSERT INTO artifact (
        id, identity_key, source_kind, title, logical_name, latest_version_id,
        version_count, metadata_json, created_at, updated_at
      ) VALUES (
        'artifact:manifest', 'managed:manifest', 'managed', 'Manifest', 'manifest.json',
        'artifact-version:manifest-v1', 1, '{}', 1, 1
      )`,
    ).run();
    db.prepare(
      `INSERT INTO artifact_version (
        id, artifact_id, version_no, blob_id, source_kind, content_hash,
        source_locator_json, custody_mode, metadata_json, created_at
      ) VALUES (
        'artifact-version:manifest-v1', 'artifact:manifest', 1, ?, 'managed', ?,
        '{}', 'managed', '{}', 1
      )`,
    ).run(`artifact-blob:${manifestHash}`, manifestHash);
  }

  return db;
}

function insertBlob(db: Database.Database, hash: string, content: string, mediaType: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO artifact_blob (
      id, algorithm, content_hash, storage_uri, media_type, size_bytes,
      metadata_json, custody_mode, availability, retention_json, reference_json, created_at
    ) VALUES (?, 'sha256', ?, ?, ?, ?, '{}', 'managed', 'present', '{}', '{}', 1)`,
  ).run(
    `artifact-blob:${hash}`,
    hash,
    pathToFileURL(casPath(hash)).href,
    mediaType,
    Buffer.byteLength(content),
  );
}

function writeCas(content: string): string {
  const hash = sha256(content);
  const target = casPath(hash);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return hash;
}

function casPath(hash: string): string {
  return path.join(artifactRoot, "sha256", hash.slice(0, 2), hash);
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function getIssueBody(db: Database.Database): string {
  return (db.prepare("SELECT body FROM ledger_issues WHERE id = 'issue-1'").get() as { body: string }).body;
}

function versionCount(db: Database.Database, artifactId: string): number {
  return (db
    .prepare("SELECT COUNT(*) AS n FROM artifact_version WHERE artifact_id = ?")
    .get(artifactId) as { n: number }).n;
}
