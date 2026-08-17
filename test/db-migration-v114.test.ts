import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate, openDb, type Db } from "../src/db.js";

// Integration reconciliation (umbrella c16807e): the auth-request finalizer
// state migration (issue 75f52ac) was renumbered to v114 atop main's
// user-system migrations v107-v111 and our v112/v113 additive columns.
// Migration head has since advanced to v123 (through issue be2ab49's v117
// residual sweep, issue 13b071e's v118 project-identity pass, issue 8d12c96's
// v119 merge-candidate tree, and umbrella 99b74d6's v120/v121 briefing store
// and space_items finding refs).
describe("migration v114: auth-request finalizer state", () => {
  let tempDir: string;
  let db: Db;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-db-v114-"));
    db = openDb(path.join(tempDir, "mandible.db"));
    // Reverse the v114 change so the migration can be re-applied against a
    // simulated v113 database.
    db.exec(`
      ALTER TABLE auth_requests DROP COLUMN merge_finalizer_state;
      UPDATE meta SET value = '113' WHERE key = 'schema_version';
    `);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("adds the nullable merge_finalizer_state column", () => {
    const before = db.prepare("PRAGMA table_info(auth_requests)").all() as Array<{ name: string }>;
    expect(before.map((column) => column.name)).not.toContain("merge_finalizer_state");

    migrate(db);

    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
      value: "139",
    });
    const columns = db.prepare("PRAGMA table_info(auth_requests)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
    }>;
    const column = columns.find((entry) => entry.name === "merge_finalizer_state");
    expect(column).toBeDefined();
    expect(column?.type).toBe("TEXT");
    // Nullable with no default: absent until the finalizer queue records state.
    expect(column?.notnull).toBe(0);
    expect(column?.dflt_value).toBeNull();
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("is idempotent when re-migrating over a database that already has the column", () => {
    migrate(db);
    // A second migrate over the already-current database must not throw.
    expect(() => migrate(db)).not.toThrow();
    const columns = db.prepare("PRAGMA table_info(auth_requests)").all() as Array<{ name: string }>;
    expect(columns.filter((entry) => entry.name === "merge_finalizer_state")).toHaveLength(1);
  });

  it("leaves a freshly migrated database at head (v127) with the column present", () => {
    const fresh = openDb(path.join(tempDir, "fresh.db"));
    try {
      const columns = fresh.prepare("PRAGMA table_info(auth_requests)").all() as Array<{ name: string }>;
      expect(columns.map((entry) => entry.name)).toContain("merge_finalizer_state");
      expect(fresh.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
        value: "139",
      });
    } finally {
      fresh.close();
    }
  });
});
