import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate, openDb, type Db } from "../src/db.js";

// Issue 499c148: migration v116 adds the two nullable sessions.identity_mismatch_*
// columns. The head of the migration list is v117 (issue be2ab49's residual
// local_default sweep), so a rewind to 115 replays v116 and then v117 and leaves
// the database at "117".
describe("migration v116: session identity mismatch flag", () => {
  let tempDir: string;
  let db: Db;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-db-v116-"));
    db = openDb(path.join(tempDir, "mandible.db"));
    db.exec(`
      INSERT INTO sessions (id, app, status, created_at, updated_at)
        VALUES ('legacy-session', 'claude-channel', 'active', datetime('now'), datetime('now'));
      ALTER TABLE sessions DROP COLUMN identity_mismatch_at;
      ALTER TABLE sessions DROP COLUMN identity_mismatch_json;
      UPDATE meta SET value = '115' WHERE key = 'schema_version';
    `);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("adds the nullable flag columns and leaves legacy rows unflagged", () => {
    migrate(db);

    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
      value: "117",
    });
    const columns = (db.prepare("PRAGMA table_info(sessions)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>).filter((column) => column.name.startsWith("identity_mismatch"));
    expect(columns).toEqual([
      { name: "identity_mismatch_at", type: "INTEGER", notnull: 0, dflt_value: null, cid: expect.any(Number), pk: 0 },
      { name: "identity_mismatch_json", type: "TEXT", notnull: 0, dflt_value: null, cid: expect.any(Number), pk: 0 },
    ]);
    expect(
      db.prepare(
        "SELECT identity_mismatch_at, identity_mismatch_json FROM sessions WHERE id = ?",
      ).get("legacy-session"),
    ).toEqual({ identity_mismatch_at: null, identity_mismatch_json: null });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("is idempotent when replayed over a database that already has the columns", () => {
    migrate(db);
    db.prepare(
      "UPDATE sessions SET identity_mismatch_at = ?, identity_mismatch_json = ? WHERE id = ?",
    ).run(1234, '{"detected_at":1234}', "legacy-session");
    db.exec("UPDATE meta SET value = '115' WHERE key = 'schema_version'");

    expect(() => migrate(db)).not.toThrow();

    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
      value: "117",
    });
    // A replay must not clear a recorded flag.
    expect(
      db.prepare("SELECT identity_mismatch_at FROM sessions WHERE id = ?").get("legacy-session"),
    ).toEqual({ identity_mismatch_at: 1234 });
  });
});
