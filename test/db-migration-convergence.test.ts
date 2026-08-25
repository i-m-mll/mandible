import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION, MINIMUM_SUPPORTED_SCHEMA_VERSION, openDb, type Db } from "../src/db.js";
import {
  builtinAuthHooks,
  metaRows,
  schemaVersion,
  seededUsers,
  settingsRows,
  sqliteMaster,
  tableInfo,
} from "./helpers/schema-snapshot.js";

// The schema has two representations: src/db-baseline.ts creates it outright for
// a fresh database, and src/db-migrations.ts moves a supported existing database
// to the same shape. Nothing derives one from the other, so this is the check
// that keeps them from drifting: take the frozen floor-version fixture, migrate
// it, and require the result to be indistinguishable from a fresh database.

const FLOOR_FIXTURE = fs.readFileSync(
  path.join(process.cwd(), "test", "fixtures", `schema-v${MINIMUM_SUPPORTED_SCHEMA_VERSION}.sql`),
  "utf8",
);

let tempDir = "";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-schema-converge-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function createFloorDatabase(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(FLOOR_FIXTURE);
  } finally {
    db.close();
  }
}

describe.sequential("schema convergence", () => {
  it("migrates the frozen floor fixture to the same schema a fresh database gets", () => {
    const freshPath = path.join(tempDir, "fresh.db");
    const migratedPath = path.join(tempDir, "migrated.db");
    createFloorDatabase(migratedPath);

    const fresh = openDb(freshPath);
    const migrated = openDb(migratedPath);
    try {
      for (const db of [fresh, migrated]) {
        expect(schemaVersion(db)).toBe(String(CURRENT_SCHEMA_VERSION));
        expect(db.pragma("foreign_key_check")).toEqual([]);
        expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      }

      expect(sqliteMaster(migrated)).toEqual(sqliteMaster(fresh));
      expect(tableInfo(migrated)).toEqual(tableInfo(fresh));
      expect(metaRows(migrated)).toEqual(metaRows(fresh));
      expect(settingsRows(migrated)).toEqual(settingsRows(fresh));
      expect(builtinAuthHooks(migrated)).toEqual(builtinAuthHooks(fresh));
      expect(seededUsers(migrated)).toEqual(seededUsers(fresh));
    } finally {
      migrated.close();
      fresh.close();
    }
  });
});
