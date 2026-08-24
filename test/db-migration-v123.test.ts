import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate, openDb, type Db } from "../src/db.js";

// Issue 7d64d8f: migration v123 adds the nullable
// auth_requests.commit_message_digest column that binds an auth request to the
// exact canonical change message bytes the merge must commit.
describe("migration v123: canonical change message digest", () => {
  let tempDir: string;
  let db: Db;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-db-v123-"));
    db = openDb(path.join(tempDir, "mandible.db"));
    db.exec(`
      INSERT INTO auth_requests (
        id, command, title, commit_message, status,
        created_at, updated_at, expires_at, output
      ) VALUES (
        'legacy-request', 'echo legacy', 'Legacy request', '- a bullet dump',
        'pending', 0, 0, 0, ''
      );
      ALTER TABLE auth_requests DROP COLUMN commit_message_digest;
      UPDATE meta SET value = '122' WHERE key = 'schema_version';
    `);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("adds the nullable digest column and leaves legacy messages undigested", () => {
    migrate(db);

    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
value: "156",
    });
    const column = (db.prepare("PRAGMA table_info(auth_requests)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>).find((entry) => entry.name === "commit_message_digest");
    expect(column).toMatchObject({ type: "TEXT", notnull: 0, dflt_value: null });

    expect(
      db.prepare(
        "SELECT commit_message, commit_message_digest FROM auth_requests WHERE id = 'legacy-request'",
      ).get(),
    ).toEqual({ commit_message: "- a bullet dump", commit_message_digest: null });
  });

  it("replays over a database that already has the column", () => {
    // The suite's version-rewind fixtures replay migrations over databases that
    // already carry later columns, so v123 must be idempotent.
    migrate(db);
    db.exec("UPDATE meta SET value = '122' WHERE key = 'schema_version'");

    expect(() => migrate(db)).not.toThrow();
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
value: "156",
    });
  });

  it("refuses to advance over a divergent column definition", () => {
    db.exec("ALTER TABLE auth_requests ADD COLUMN commit_message_digest INTEGER");

    expect(() => migrate(db)).toThrow(/divergent definition/);
  });
});
