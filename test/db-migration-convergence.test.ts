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

  it("drops the retired tables and column without disturbing surviving rows", () => {
    const migratedPath = path.join(tempDir, "retired.db");
    createFloorDatabase(migratedPath);

    const RETIRED_TABLES = [
      "ledger_external_refs", "ledger_sync_jobs", "ledger_outbox", "ledger_conflicts",
      "starred_chats", "presets", "preset_nodes", "preset_diffs", "session_presets",
      "convention_setting_links", "session_instruction_artifacts",
    ];

    const seed = new Database(migratedPath);
    try {
      // The floor fixture really does carry these tables and the chain's own
      // completion markers, so the drop below is doing work rather than passing
      // over an already-absent shape.
      for (const table of RETIRED_TABLES) {
        expect(seed.prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        ).get(table)).toBeTruthy();
      }
      expect((seed.prepare(
        "SELECT count(*) AS n FROM meta WHERE key LIKE 'post_migration.%'",
      ).get() as { n: number }).n).toBeGreaterThan(0);

      seed.prepare(
        "INSERT INTO presets (id, name, created_at, updated_at) VALUES ('p1', 'Preset', 1, 1)",
      ).run();
      seed.prepare(
        `INSERT INTO preset_nodes (id, preset_id, created_at, updated_at)
         VALUES ('n1', 'p1', 1, 1)`,
      ).run();
      seed.prepare(
        `INSERT INTO message_params (session_id, message_index, model, preset_ids, created_at)
         VALUES ('s1', 0, 'opus', '["p1"]', 7)`,
      ).run();
    } finally {
      seed.close();
    }

    const migrated = openDb(migratedPath);
    try {
      for (const table of RETIRED_TABLES) {
        expect(migrated.prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        ).get(table)).toBeUndefined();
      }
      expect(migrated.prepare("PRAGMA table_info(message_params)").all())
        .not.toContainEqual(expect.objectContaining({ name: "preset_ids" }));
      // Dropping a column must not disturb the rest of the row.
      expect(migrated.prepare(
        "SELECT session_id, message_index, model, created_at FROM message_params",
      ).all()).toEqual([{ session_id: "s1", message_index: 0, model: "opus", created_at: 7 }]);
      expect(migrated.prepare(
        "SELECT count(*) AS n FROM meta WHERE key LIKE 'post_migration.%'",
      ).get()).toEqual({ n: 0 });
      expect(migrated.pragma("foreign_key_check")).toEqual([]);
    } finally {
      migrated.close();
    }
  });
});
