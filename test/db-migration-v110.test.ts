import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate, openDb, type Db } from "../src/db.js";

describe("migration v110: session and work-unit ownership", () => {
  let tempDir: string;
  let db: Db;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-db-v110-"));
    db = openDb(path.join(tempDir, "mandible.db"));
    db.exec(`
      INSERT INTO sessions (id, app, status, created_at, updated_at)
        VALUES ('legacy-session', 'codex', 'ended', datetime('now'), datetime('now'));
      INSERT INTO console_sessions (
        id, label, command, args_json, env_json, created_at, updated_at
      ) VALUES ('legacy-console', 'Legacy', 'codex', '[]', '{}', 1, 1);
      INSERT INTO work_units (id, issue_id, repo_id, created_at)
        VALUES ('legacy-work-unit', 'legacy-issue', 'mandible', 1);
      ALTER TABLE sessions DROP COLUMN owner_user_id;
      ALTER TABLE console_sessions DROP COLUMN owner_user_id;
      ALTER TABLE work_units DROP COLUMN owner_user_id;
      UPDATE meta SET value = '109' WHERE key = 'schema_version';
    `);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("adds nullable user foreign keys without rewriting legacy rows", () => {
    migrate(db);

    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
      value: "122",
    });
    for (const [table, id] of [
      ["sessions", "legacy-session"],
      ["console_sessions", "legacy-console"],
      ["work_units", "legacy-work-unit"],
    ] as const) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toContain("owner_user_id");
      expect(db.prepare(`SELECT owner_user_id FROM ${table} WHERE id = ?`).get(id)).toEqual({
        owner_user_id: null,
      });
      const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
        from: string;
        table: string;
      }>;
      expect(foreignKeys).toContainEqual(expect.objectContaining({
        from: "owner_user_id",
        table: "users",
      }));
    }
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});
