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
      ALTER TABLE branches DROP COLUMN worktree_inventory_known;
      ALTER TABLE branches DROP COLUMN worktree_status_known;
      ALTER TABLE branches DROP COLUMN default_comparison_known;
      UPDATE meta SET value = '105' WHERE key = 'schema_version';
    `);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("adds the sequential record table with retention and lifecycle constraints", () => {
    migrate(db);
    // Re-migration from the rewound v105 fixture also applies main's user-system
    // migrations (v107-v111) and our additive v112, v113, and v114 columns,
    // advancing the schema version past 106.
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
value: "158",
    });
    const columns = db.prepare("PRAGMA table_info(trash_entries)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "project_id", "checkout_id", "snapshot_ref", "snapshot_oid", "expires_at", "state",
    ]));
    const branchColumns = db.prepare("PRAGMA table_info(branches)").all() as Array<{ name: string }>;
    expect(branchColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "worktree_inventory_known", "worktree_status_known", "default_comparison_known",
    ]));
    const createSql = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'trash_entries'",
    ).get() as { sql: string };
    expect(createSql.sql).toContain("gc_pending");
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});
