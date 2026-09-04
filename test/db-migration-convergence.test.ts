import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION, MINIMUM_SUPPORTED_SCHEMA_VERSION, openDb, type Db } from "../src/db.js";
import { MIGRATIONS } from "../src/db-migrations.js";
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

function migrateFixtureThrough(db: Database.Database, targetVersion: number): void {
  for (const migration of MIGRATIONS.filter((candidate) => candidate.version <= targetVersion)) {
    db.transaction(() => {
      for (const statement of migration.statements) db.exec(statement);
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(migration.version));
    }).immediate();
  }
}

function seedBriefingLineage(db: Database.Database, mixed: boolean): { rounds: unknown[] } {
  for (const [suffix, hash] of [["a", "a".repeat(64)], ["b", "b".repeat(64)]] as const) {
    db.prepare(`INSERT INTO artifact_blob
      (id, content_hash, size_bytes, metadata_json, custody_mode, availability,
       retention_json, reference_json, created_at)
      VALUES (?, ?, 1, '{}', 'managed', 'present', '{}', '{}', 1)`)
      .run(`artifact-blob:${suffix}`, hash);
    db.prepare(`INSERT INTO artifact
      (id, identity_key, source_kind, logical_name, latest_version_id, version_count,
       metadata_json, created_at, updated_at)
      VALUES (?, ?, 'managed', ?, ?, 1, '{}', 1, 1)`)
      .run(`artifact:${suffix}`, `lineage-${suffix}`, `${suffix}.md`, `artifact-version:${suffix}`);
    db.prepare(`INSERT INTO artifact_version
      (id, artifact_id, version_no, blob_id, source_kind, content_hash,
       source_locator_json, custody_mode, metadata_json, created_at)
      VALUES (?, ?, 1, ?, 'managed', ?, '{}', 'managed', '{}', 1)`)
      .run(`artifact-version:${suffix}`, `artifact:${suffix}`, `artifact-blob:${suffix}`, hash);
  }
  db.prepare(`INSERT INTO briefings
    (id, briefing_key, title, latest_round_id, round_count, created_at, updated_at)
    VALUES ('briefing-lineage', 'lineage', 'Lineage', 'round-2', 2, 1, 2)`).run();
  db.prepare(`INSERT INTO briefing_rounds
    (id, briefing_id, ordinal, artifact_version_id, comparison_base_artifact_version_id,
     previous_round_id, profile, binding_digest, created_at)
    VALUES ('round-1', 'briefing-lineage', 1, 'artifact-version:a', NULL, NULL,
      'mandible-briefing.v3', ?, 1)`).run("1".repeat(64));
  db.prepare(`INSERT INTO briefing_rounds
    (id, briefing_id, ordinal, artifact_version_id, comparison_base_artifact_version_id,
     previous_round_id, profile, binding_digest, created_at)
    VALUES ('round-2', 'briefing-lineage', 2, ?, NULL, 'round-1',
      'mandible-briefing.v3', ?, 2)`).run(mixed ? "artifact-version:b" : "artifact-version:a", "2".repeat(64));
  return { rounds: db.prepare("SELECT * FROM briefing_rounds ORDER BY ordinal").all() };
}

describe.sequential("schema convergence", () => {
  it("rolls v171 back completely when destination ownership is ambiguous", () => {
    const dbPath = path.join(tempDir, "ambiguous-destination.db");
    createFloorDatabase(dbPath);
    const db = new Database(dbPath);
    try {
      migrateFixtureThrough(db, 170);
      db.prepare(`INSERT INTO artifact (
        id, identity_key, source_kind, logical_name, latest_version_id, version_count,
        metadata_json, created_at, updated_at
      ) VALUES ('artifact:destination', 'destination', 'managed', 'Destination.md', NULL, 0, '{}', 1, 1)`).run();
      db.prepare(`INSERT INTO briefing_groups
        (id, name, current_bundle_id, created_at, updated_at, archived_at)
        VALUES (?, ?, NULL, 1, 1, NULL)`).run("group-one", "One");
      db.prepare(`INSERT INTO briefing_groups
        (id, name, current_bundle_id, created_at, updated_at, archived_at)
        VALUES (?, ?, NULL, 1, 1, NULL)`).run("group-two", "Two");
      const insertRoute = db.prepare(`INSERT INTO briefing_destination_routes (
        route_key, group_id, logical_artifact_id, heading, composer_kind, active_template_version,
        max_contributions, max_document_bytes, max_directives, created_at, updated_at
      ) VALUES (?, ?, 'artifact:destination', ?, 'deterministic', 1, 1, 1000, 0, 1, 1)`);
      insertRoute.run("destination.one", "group-one", "One");
      insertRoute.run("destination.two", "group-two", "Two");
      const migration = MIGRATIONS.find((candidate) => candidate.version === 171)!;
      expect(() => db.transaction(() => {
        for (const statement of migration.statements) db.exec(statement);
        db.prepare("UPDATE meta SET value = '171' WHERE key = 'schema_version'").run();
      }).immediate()).toThrow(/group_count/);
      expect(schemaVersion(db)).toBe("170");
      expect(db.prepare("SELECT COUNT(*) AS count FROM briefing_destination_routes").get()).toEqual({ count: 2 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('briefing_groups') WHERE name = 'key'").get())
        .toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'briefing_destination_owners'").get())
        .toEqual({ count: 0 });
      expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    } finally {
      db.close();
    }
  });

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

  it("preserves one-lineage Briefings and refuses mixed logical Artifact history at v161", () => {
    const validPath = path.join(tempDir, "briefing-valid.db");
    createFloorDatabase(validPath);
    const validSeed = new Database(validPath);
    migrateFixtureThrough(validSeed, 160);
    const before = seedBriefingLineage(validSeed, false);
    validSeed.close();

    const migrated = openDb(validPath);
    expect(migrated.prepare("SELECT logical_artifact_id FROM briefings WHERE id = 'briefing-lineage'").get())
      .toEqual({ logical_artifact_id: "artifact:a" });
    expect(migrated.prepare("SELECT * FROM briefing_rounds ORDER BY ordinal").all()).toEqual(before.rounds);
    expect(migrated.pragma("foreign_key_check")).toEqual([]);
    migrated.close();

    const mixedPath = path.join(tempDir, "briefing-mixed.db");
    createFloorDatabase(mixedPath);
    const mixedSeed = new Database(mixedPath);
    migrateFixtureThrough(mixedSeed, 160);
    seedBriefingLineage(mixedSeed, true);
    mixedSeed.close();
    expect(() => openDb(mixedPath)).toThrow(/briefing_lineage_guard|CHECK constraint failed/);
    const refused = new Database(mixedPath);
    expect(schemaVersion(refused)).toBe("160");
    expect(refused.prepare("PRAGMA table_info(briefings)").all())
      .not.toContainEqual(expect.objectContaining({ name: "logical_artifact_id" }));
    expect(refused.prepare("SELECT COUNT(*) AS n FROM briefing_rounds").get()).toEqual({ n: 2 });
    refused.close();
  });
});
