import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate, openDb, type Db } from "../src/db.js";

describe("migration v106: trash custody records", () => {
  let tempDir: string;
  let db: Db;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-db-v106-"));
    db = openDb(path.join(tempDir, "mandible.db"));
    db.exec(`
      DROP TABLE trash_entries;
      UPDATE meta SET value = '105' WHERE key = 'schema_version';
    `);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("adds the sequential record table with retention and lifecycle constraints", () => {
    migrate(db);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
      value: "106",
    });
    const columns = db.prepare("PRAGMA table_info(trash_entries)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "project_id", "checkout_id", "snapshot_ref", "snapshot_oid", "expires_at", "state",
    ]));
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});
