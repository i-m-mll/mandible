import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate, openDb, type Db } from "../src/db.js";

// Integration reconciliation (umbrella c16807e): the additive-column hooks for
// v107 (branches.has_upstream/upstream), v108 (work_units.merge_scan_retired_at),
// and v109 (auth_requests.merge_finalizer_state) were renumbered during
// integration. A database that previously ran an intermediate feature-branch
// daemon may have recorded v107/v108 under DIFFERENT meanings, so those exact
// migrations are no longer pending and their per-version hooks never fire —
// leaving the renumbered columns absent. migrate() must converge the full column
// set for ANY database migrating from a recorded version below 109, not only at
// the exact version numbers.
describe("migration convergence: renumbered additive column hooks", () => {
  let tempDir: string;
  let db: Db;

  const columnNames = (table: string): string[] =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (column) => column.name,
    );

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-db-converge-"));
    db = openDb(path.join(tempDir, "mandible.db"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("converges every renumbered column for a DB recorded at v108 that is missing them", () => {
    // Simulate an intermediate-version DB: the version says 108, but the
    // renumbered v107/v108/v109 columns are absent because the intermediate
    // daemon's v107/v108 meant something else. Without convergence, migrate()
    // would only re-run the v109 hook (the sole pending migration) and leave the
    // v107 upstream columns and the v108 retirement column permanently absent.
    db.exec(`
      ALTER TABLE branches DROP COLUMN has_upstream;
      ALTER TABLE branches DROP COLUMN upstream;
      ALTER TABLE work_units DROP COLUMN merge_scan_retired_at;
      ALTER TABLE auth_requests DROP COLUMN merge_finalizer_state;
      UPDATE meta SET value = '108' WHERE key = 'schema_version';
    `);

    expect(columnNames("branches")).not.toContain("has_upstream");
    expect(columnNames("branches")).not.toContain("upstream");
    expect(columnNames("work_units")).not.toContain("merge_scan_retired_at");
    expect(columnNames("auth_requests")).not.toContain("merge_finalizer_state");

    migrate(db);

    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
      value: "109",
    });
    expect(columnNames("branches")).toContain("has_upstream");
    expect(columnNames("branches")).toContain("upstream");
    expect(columnNames("work_units")).toContain("merge_scan_retired_at");
    expect(columnNames("auth_requests")).toContain("merge_finalizer_state");

    // has_upstream is re-created with its intended definition, not a divergent one.
    const branchInfo = db.prepare("PRAGMA table_info(branches)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
    }>;
    const hasUpstream = branchInfo.find((column) => column.name === "has_upstream");
    expect(hasUpstream?.type).toBe("INTEGER");
    expect(hasUpstream?.notnull).toBe(1);
    expect(hasUpstream?.dflt_value).toBe("0");
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("is idempotent when the columns already exist at a below-head version", () => {
    // Only the version marker is rewound; all columns remain present. Convergence
    // hooks must be no-ops (guarded) rather than duplicate-column errors.
    db.exec("UPDATE meta SET value = '108' WHERE key = 'schema_version';");
    expect(() => migrate(db)).not.toThrow();
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
      value: "109",
    });
    expect(
      columnNames("branches").filter((name) => name === "has_upstream"),
    ).toHaveLength(1);
    expect(
      columnNames("work_units").filter((name) => name === "merge_scan_retired_at"),
    ).toHaveLength(1);
    expect(
      columnNames("auth_requests").filter((name) => name === "merge_finalizer_state"),
    ).toHaveLength(1);
  });

  it("re-fires convergence at head version when a renumbered column is missing (post-failure recovery)", () => {
    // Simulate the state a convergence-hook failure leaves behind: the version is
    // ALREADY recorded at head (109) — applySchemaMigrations committed it — but a
    // renumbered column is absent because its ALTER rolled back. A version-based
    // gate ("currentVersion < 109") would never fire again, so the columns would
    // stay missing forever. The live schema gate must detect and repair them on
    // this open even though the version does not change.
    db.exec(`
      ALTER TABLE work_units DROP COLUMN merge_scan_retired_at;
      ALTER TABLE branches DROP COLUMN upstream;
    `);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
      value: "109",
    });
    expect(columnNames("work_units")).not.toContain("merge_scan_retired_at");
    expect(columnNames("branches")).not.toContain("upstream");

    migrate(db);

    // Version is unchanged (already at head) but the missing columns are repaired.
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
      value: "109",
    });
    expect(columnNames("work_units")).toContain("merge_scan_retired_at");
    expect(columnNames("branches")).toContain("upstream");
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});
