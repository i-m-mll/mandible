import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate, openDb, type Db } from "../src/db.js";

describe("migration v108: auth-request finalizer state", () => {
  let tempDir: string;
  let db: Db;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-db-v108-"));
    db = openDb(path.join(tempDir, "mandible.db"));
    // Reverse the v108 change so the migration can be re-applied against a
    // simulated v107 database.
    db.exec(`
      ALTER TABLE auth_requests DROP COLUMN merge_finalizer_state;
      UPDATE meta SET value = '107' WHERE key = 'schema_version';
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
      value: "108",
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

  it("leaves a freshly migrated database at v108 with the column present", () => {
    const fresh = openDb(path.join(tempDir, "fresh.db"));
    try {
      const columns = fresh.prepare("PRAGMA table_info(auth_requests)").all() as Array<{ name: string }>;
      expect(columns.map((entry) => entry.name)).toContain("merge_finalizer_state");
      expect(fresh.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
        value: "108",
      });
    } finally {
      fresh.close();
    }
  });
});
