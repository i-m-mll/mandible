import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate, openDb, type Db } from "../src/db.js";

// Integration reconciliation (umbrella c16807e): the work-unit merge-scan
// retirement migration (issue 93d978e) was renumbered from v107 to v108 because
// 651e820's branch_upstream_cache migration took v107. Migration head is now
// v109 (75f52ac's auth finalizer state migration), so a re-migration from a
// simulated v106 database advances all the way to v109.
describe("migration v108: work-unit merge-scan retirement", () => {
  let tempDir: string;
  let db: Db;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-db-v107-"));
    db = openDb(path.join(tempDir, "mandible.db"));
    // Reverse the v108 change so the migration can be re-applied against a
    // simulated v106 database. The branch-upstream (v107) and finalizer-state
    // (v109) columns are left in place; their guarded hooks are idempotent.
    db.exec(`
      ALTER TABLE work_units DROP COLUMN merge_scan_retired_at;
      UPDATE meta SET value = '106' WHERE key = 'schema_version';
    `);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("adds the nullable merge_scan_retired_at tombstone column", () => {
    const before = db.prepare("PRAGMA table_info(work_units)").all() as Array<{ name: string }>;
    expect(before.map((column) => column.name)).not.toContain("merge_scan_retired_at");

    migrate(db);

    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
      value: "109",
    });
    const columns = db.prepare("PRAGMA table_info(work_units)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
    }>;
    const column = columns.find((entry) => entry.name === "merge_scan_retired_at");
    expect(column).toBeDefined();
    expect(column?.type).toBe("INTEGER");
    // Nullable with no default: a reversible tombstone, absent by default.
    expect(column?.notnull).toBe(0);
    expect(column?.dflt_value).toBeNull();
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("leaves a freshly migrated database at head (v109) with the column present", () => {
    // A fresh baseline (replayed to head) already carries the column.
    const fresh = openDb(path.join(tempDir, "fresh.db"));
    try {
      const columns = fresh.prepare("PRAGMA table_info(work_units)").all() as Array<{ name: string }>;
      expect(columns.map((entry) => entry.name)).toContain("merge_scan_retired_at");
      expect(fresh.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
        value: "109",
      });
    } finally {
      fresh.close();
    }
  });
});
