import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertMigrationSequence,
  migrate,
  openDb,
  resolvePrefix,
  type Migration,
} from "../src/db.js";

let tempDir = "";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-db-hardening-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("database hardening", () => {
  it("rejects duplicate migration versions before startup mutates the DB", () => {
    const migrations: Migration[] = [
      { version: 1, name: "first", statements: [] },
      { version: 1, name: "duplicate", statements: [] },
    ];

    expect(() => assertMigrationSequence(migrations)).toThrow(/Duplicate migration version 1/);
  });

  it("rejects non-contiguous migration versions", () => {
    const migrations: Migration[] = [
      { version: 1, name: "first", statements: [] },
      { version: 3, name: "gap", statements: [] },
    ];

    expect(() => assertMigrationSequence(migrations)).toThrow(/expected 2, got 3/);
  });

  it("sets a busy timeout on opened SQLite databases", () => {
    const db = openDb(path.join(tempDir, "busy.db"));
    try {
      expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
    } finally {
      db.close();
    }
  });

  it("rejects unsupported dynamic identifiers in prefix lookups", () => {
    const db = openDb(path.join(tempDir, "prefix.db"));
    try {
      expect(() => resolvePrefix(db, "auth_requests; DROP TABLE sessions", "id", "abcd")).toThrow(
        /Unsupported prefix lookup identifier/,
      );
      expect(() => resolvePrefix(db, "auth_requests", "title", "abcd")).toThrow(
        /Unsupported prefix lookup identifier/,
      );
    } finally {
      db.close();
    }
  });

  it("retries incomplete post-DDL backfills after schema_version is already current", () => {
    const db = openDb(path.join(tempDir, "resume.db"));
    try {
      const now = Date.now();
      db.prepare(
        `INSERT INTO conversations (
          id, source, source_path, source_hash, source_mtime, title, started_at,
          session_id, created_at, updated_at
        ) VALUES (
          'conv-1', 'codex', '/tmp/conv.jsonl', 'hash', 0, 'Conversation',
          ?, 'session-1', ?, ?
        )`,
      ).run(new Date(now).toISOString(), new Date(now).toISOString(), new Date(now).toISOString());
      db.prepare(
        `INSERT INTO conversation_blocks (
          id, conversation_id, type, role, content, position, timestamp, compressed
        ) VALUES (
          'block-1', 'conv-1', 'message', 'assistant', ?, 1, ?, 0
        )`,
      ).run("content that should be compressed on retry", new Date(now).toISOString());

      db.prepare("DELETE FROM meta WHERE key = 'post_migration.v19_compress_existing_blocks.complete'")
        .run();
      migrate(db);

      const row = db.prepare("SELECT compressed FROM conversation_blocks WHERE id = 'block-1'")
        .get() as { compressed: number };
      const marker = db.prepare(
        "SELECT value FROM meta WHERE key = 'post_migration.v19_compress_existing_blocks.complete'",
      ).get() as { value: string };
      expect(row.compressed).toBe(1);
      expect(marker.value).toBe("done");
    } finally {
      db.close();
    }
  });

  it("retries legacy session project backfills without primary-key collisions", () => {
    const db = openDb(path.join(tempDir, "session-projects.db"));
    try {
      const now = Date.now();
      db.prepare(
        `INSERT INTO sessions (id, cwd, worktree, status, app, created_at, updated_at)
         VALUES (?, ?, ?, 'active', 'codex', datetime('now'), datetime('now'))`,
      ).run(
        "session-collision",
        "/Users/mll/Main/10 Projects/10 PhD/20 Feedbax/feedbax",
        "/Users/mll/Main/10 Projects/10 PhD/20 Feedbax/feedbax/worktrees/develop",
      );
      db.prepare(
        `INSERT INTO sessions (id, cwd, worktree, status, app, created_at, updated_at)
         VALUES (?, ?, ?, 'active', 'codex', datetime('now'), datetime('now'))`,
      ).run(
        "session-update",
        "/Users/mll/Main/10 Projects/05 Utils/mandible",
        "/Users/mll/Main/10 Projects/05 Utils/mandible/worktrees/feature__daemon-fix",
      );
      db.prepare(
        `INSERT INTO session_projects (session_id, repo_id, repo_name, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run("session-collision", "feedbax", "feedbax", now);
      db.prepare(
        `INSERT INTO session_projects (session_id, repo_id, repo_name, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run(
        "session-collision",
        "feature__fix-param-schema-string-type",
        "feature__fix-param-schema-string-type",
        now,
      );
      db.prepare(
        `INSERT INTO session_projects (session_id, repo_id, repo_name, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run("session-update", "feature__daemon-fix", "feature__daemon-fix", now);

      db.prepare("DELETE FROM meta WHERE key = 'post_migration.v24_backfill_project_repo_names.complete'")
        .run();
      migrate(db);

      const collisionRows = db.prepare(
        "SELECT repo_id, repo_name FROM session_projects WHERE session_id = ? ORDER BY repo_id",
      ).all("session-collision");
      expect(collisionRows).toEqual([{ repo_id: "feedbax", repo_name: "feedbax" }]);

      const updatedRow = db.prepare(
        "SELECT repo_id, repo_name FROM session_projects WHERE session_id = ?",
      ).get("session-update") as { repo_id: string; repo_name: string };
      expect(updatedRow).toEqual({ repo_id: "mandible", repo_name: "mandible" });

      const marker = db.prepare(
        "SELECT value FROM meta WHERE key = 'post_migration.v24_backfill_project_repo_names.complete'",
      ).get() as { value: string };
      expect(marker.value).toBe("done");
    } finally {
      db.close();
    }
  });
});
