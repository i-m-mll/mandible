import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.join(process.cwd(), "scripts", "project-db-snapshot.mjs");
const DAY_MS = 24 * 60 * 60 * 1000;
const CUTOFF_MS = 2_000_000_000_000;

let tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
  tempRoots = [];
});

function createFixture(): { root: string; source: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-projected-db-test-"));
  tempRoots.push(root);
  const source = path.join(root, "source.db");
  const db = new Database(source);
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE canonical_records (
      id TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      source_path TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      source_mtime INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      summary TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      block_count INTEGER NOT NULL DEFAULT 0,
      session_id TEXT NOT NULL,
      project_path TEXT,
      cwd TEXT,
      branch TEXT,
      model TEXT,
      cli_version TEXT,
      starred INTEGER NOT NULL DEFAULT 0,
      label TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      parent_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      is_sidechain INTEGER NOT NULL DEFAULT 0,
      agent_id TEXT,
      started_at_ms INTEGER,
      ended_at_ms INTEGER,
      created_at_ms INTEGER,
      updated_at_ms INTEGER
    );
    CREATE TABLE conversation_blocks (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL,
      timestamp TEXT,
      parent_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      dag_uuid TEXT,
      dag_parent_uuid TEXT,
      compressed INTEGER NOT NULL DEFAULT 0,
      timestamp_ms INTEGER,
      UNIQUE(conversation_id, position)
    );
    CREATE TABLE daemon_log (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      level TEXT NOT NULL,
      event TEXT NOT NULL,
      subsystem TEXT NOT NULL DEFAULT 'daemon',
      fields_json TEXT NOT NULL DEFAULT '{}',
      issue_id TEXT,
      auth_request_id TEXT,
      artifact_id TEXT,
      session_id TEXT,
      repo_id TEXT
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      conversation_id TEXT
    );
    CREATE TABLE workflow_runs (id TEXT PRIMARY KEY);
    CREATE TABLE workflow_workers (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES workflow_runs(id),
      conversation_id TEXT REFERENCES conversations(id)
    );
    CREATE INDEX idx_daemon_log_ts ON daemon_log(ts DESC);
    CREATE INDEX idx_blocks_conv ON conversation_blocks(conversation_id);
    CREATE INDEX idx_conv_source_path ON conversations(source_path);
  `);

  db.prepare("INSERT INTO canonical_records VALUES (?, ?)").run("canonical-1", "one");
  db.prepare("INSERT INTO canonical_records VALUES (?, ?)").run("canonical-2", "two");

  const insertConversation = db.prepare(`
    INSERT INTO conversations (
      id, source, source_path, source_hash, source_mtime, title, started_at,
      block_count, session_id, project_path, starred, created_at, updated_at,
      parent_conversation_id
    ) VALUES (
      @id, 'codex', @source_path, @id, @source_mtime, @id, '2026-01-01',
      1, @session_id, @project_path, @starred, '2026-01-01', '2026-01-01',
      @parent_conversation_id
    )
  `);
  const conversations = [
    { id: "old-parent", source_mtime: CUTOFF_MS - 30 * DAY_MS, project_path: "/a", starred: 0, parent_conversation_id: null },
    { id: "old-excluded-a", source_mtime: CUTOFF_MS - 40 * DAY_MS, project_path: "/a", starred: 0, parent_conversation_id: null },
    { id: "recent-child", source_mtime: CUTOFF_MS - DAY_MS, project_path: "/a", starred: 0, parent_conversation_id: "old-parent" },
    { id: "starred-old", source_mtime: CUTOFF_MS - 20 * DAY_MS, project_path: "/a", starred: 1, parent_conversation_id: null },
    { id: "session-old", source_mtime: CUTOFF_MS - 25 * DAY_MS, project_path: "/a", starred: 0, parent_conversation_id: null },
    { id: "workflow-old", source_mtime: CUTOFF_MS - 25 * DAY_MS, project_path: "/a", starred: 0, parent_conversation_id: null },
    { id: "newest-b", source_mtime: CUTOFF_MS - 15 * DAY_MS, project_path: "/b", starred: 0, parent_conversation_id: null },
    { id: "old-excluded-b", source_mtime: CUTOFF_MS - 35 * DAY_MS, project_path: "/b", starred: 0, parent_conversation_id: null },
  ];
  for (const conversation of conversations) {
    insertConversation.run({
      ...conversation,
      source_path: `/source/${conversation.id}.jsonl`,
      session_id: `session-${conversation.id}`,
    });
    db.prepare(`
      INSERT INTO conversation_blocks
        (id, conversation_id, type, role, content, position, metadata_json)
      VALUES (?, ?, 'message', 'user', ?, 0, '{}')
    `).run(`block-${conversation.id}`, conversation.id, conversation.id);
  }

  db.prepare("INSERT INTO sessions VALUES (?, 'active', 0, '2026-01-01', ?)")
    .run("session-1", "session-old");
  db.prepare("INSERT INTO workflow_runs VALUES ('workflow-1')").run();
  db.prepare("INSERT INTO workflow_workers VALUES ('worker-1', 'workflow-1', 'workflow-old')").run();

  const insertLog = db.prepare(
    "INSERT INTO daemon_log VALUES (?, ?, ?, ?, 'daemon', '{}', NULL, NULL, NULL, NULL, NULL)",
  );
  insertLog.run("recent-info", CUTOFF_MS - 2 * 60 * 60 * 1000, "info", "recent");
  insertLog.run("old-warn", CUTOFF_MS - 2 * DAY_MS, "warn", "warning");
  insertLog.run("old-info", CUTOFF_MS - 2 * DAY_MS, "info", "old-info");
  insertLog.run("expired-error", CUTOFF_MS - 8 * DAY_MS, "error", "expired");
  db.close();
  return { root, source };
}

function runSnapshot(source: string, output: string, extraArgs: string[] = []) {
  return spawnSync(process.execPath, [
    SCRIPT,
    "--source", source,
    "--output", output,
    "--cutoff-ms", String(CUTOFF_MS),
    "--json",
    ...extraArgs,
  ], { encoding: "utf8" });
}

describe("project-db-snapshot", () => {
  it("copies canonical data and applies the deterministic log/conversation projection", () => {
    const { root, source } = createFixture();
    const output = path.join(root, "preview.db");
    const sourceSizeBefore = fs.statSync(source).size;
    const result = runSnapshot(source, output);

    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(result.stdout);
    expect(manifest.projection.cutoff_ms).toBe(CUTOFF_MS);
    expect(manifest.tables.projected_counts).toEqual({
      daemon_log: 2,
      conversations: 6,
      conversation_blocks: 6,
    });
    expect(manifest.safety.integrity).toBe("ok");
    expect(manifest.safety.foreign_key_violations).toBe(0);
    expect(fs.existsSync(`${output}.manifest.json`)).toBe(true);
    expect(fs.statSync(source).size).toBe(sourceSizeBefore);

    const projected = new Database(output, { readonly: true });
    expect(projected.prepare("SELECT id FROM canonical_records ORDER BY id").pluck().all())
      .toEqual(["canonical-1", "canonical-2"]);
    expect(projected.prepare("SELECT id FROM daemon_log ORDER BY id").pluck().all())
      .toEqual(["old-warn", "recent-info"]);
    expect(projected.prepare("SELECT id FROM conversations ORDER BY id").pluck().all())
      .toEqual(["newest-b", "old-parent", "recent-child", "session-old", "starred-old", "workflow-old"]);
    expect(projected.prepare("PRAGMA quick_check").pluck().get()).toBe("ok");
    expect(projected.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    projected.close();
  });

  it("selects the same logical rows for the same source and cutoff", () => {
    const { root, source } = createFixture();
    const first = path.join(root, "first.db");
    const second = path.join(root, "second.db");
    const firstResult = runSnapshot(source, first);
    const secondResult = runSnapshot(source, second);
    expect(firstResult.status, firstResult.stderr).toBe(0);
    expect(secondResult.status, secondResult.stderr).toBe(0);

    const firstDb = new Database(first, { readonly: true });
    const secondDb = new Database(second, { readonly: true });
    for (const table of ["canonical_records", "daemon_log", "conversations", "conversation_blocks"]) {
      const sql = `SELECT * FROM ${table} ORDER BY 1`;
      expect(secondDb.prepare(sql).all()).toEqual(firstDb.prepare(sql).all());
    }
    firstDb.close();
    secondDb.close();
  });

  it("atomically replaces an explicitly replaceable output", () => {
    const { root, source } = createFixture();
    const output = path.join(root, "preview.db");
    expect(runSnapshot(source, output).status).toBe(0);

    const sourceDb = new Database(source);
    sourceDb.prepare("INSERT INTO canonical_records VALUES (?, ?)").run("canonical-3", "three");
    sourceDb.close();
    const replacement = runSnapshot(source, output, ["--replace"]);
    expect(replacement.status, replacement.stderr).toBe(0);

    const projected = new Database(output, { readonly: true });
    expect(projected.prepare("SELECT id FROM canonical_records ORDER BY id").pluck().all())
      .toEqual(["canonical-1", "canonical-2", "canonical-3"]);
    projected.close();
    expect(fs.readdirSync(root).some((name) => name.includes(".partial-"))).toBe(false);
  });

  it("removes partial output when projection fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-projected-db-test-"));
    tempRoots.push(root);
    const source = path.join(root, "invalid.db");
    const output = path.join(root, "preview.db");
    const db = new Database(source);
    db.exec("CREATE TABLE canonical_records (id TEXT PRIMARY KEY)");
    db.close();

    const result = runSnapshot(source, output);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing projected table");
    expect(fs.existsSync(output)).toBe(false);
    expect(fs.readdirSync(root).some((name) => name.includes(".partial-"))).toBe(false);
  });
});
