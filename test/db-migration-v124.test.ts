import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate, openDb, type Db } from "../src/db.js";
import { buildMetadataBackupSql, METADATA_BACKUP_TABLES } from "../src/ledger/backup.js";

// Issue 0bc2279: migration v124 adds the append-only
// `task_inventory_generations` receipts table. The table is additive (no column
// rewrite), so the two things worth proving are that it lands on a v123
// database and that the migration path and the fresh-schema baseline produce
// the SAME table — the baseline is a hand-maintained snapshot and drifts
// silently otherwise.
describe("migration v124: task inventory generations", () => {
  let tempDir: string;
  let db: Db;

  function objectSql(target: Db, name: string): string | null {
    const row = target
      .prepare("SELECT sql FROM sqlite_master WHERE name = ?")
      .get(name) as { sql: string | null } | undefined;
    return row?.sql?.replace(/\s+/g, " ").trim() ?? null;
  }

  /** Rewind a fully migrated database to the v123 shape. */
  function rewindToV123(target: Db): void {
    target.exec(`
      DROP TABLE IF EXISTS task_inventory_generations;
      UPDATE meta SET value = '123' WHERE key = 'schema_version';
    `);
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-db-v124-"));
    db = openDb(path.join(tempDir, "mandible.db"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates the receipts table with its digest uniqueness and principal column", () => {
    rewindToV123(db);
    expect(objectSql(db, "task_inventory_generations")).toBeNull();

    migrate(db);

    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
value: "157",
    });

    const columns = db.prepare("PRAGMA table_info(task_inventory_generations)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
    }>;
    const byName = new Map(columns.map((column) => [column.name, column]));
    expect([...byName.keys()].sort()).toEqual([
      "capabilities_json",
      "created_at",
      "digest",
      "executor_name",
      "executor_version",
      "id",
      "observed_at",
      "payload_json",
      "posted_by_user_id",
      "schema_id",
      "task_count",
    ]);
    // Every generation must name the principal that posted it.
    expect(byName.get("posted_by_user_id")).toMatchObject({ type: "TEXT", notnull: 1 });

    // The digest is the idempotency mechanism, scoped to one executor. A
    // synthetic cross-executor digest collision must not suppress a receipt.
    db.prepare(
      `INSERT INTO users (id, slug, kind, display_name, status, created_at, updated_at, metadata_json)
       VALUES ('u1', 'exec', 'agent', 'Exec', 'active', 0, 0, '{}')`,
    ).run();
    const insert = () =>
      db.prepare(
        `INSERT INTO task_inventory_generations (
           id, digest, schema_id, executor_name, executor_version, capabilities_json,
           observed_at, task_count, payload_json, posted_by_user_id, created_at
         ) VALUES (?, 'digest-a', 'executor-inventory@1', 'agent-schedule', '1', '[]', 1, 0, '{}', 'u1', 1)`,
      ).run(`gen-${Math.random()}`);
    insert();
    expect(() => insert()).toThrow(/UNIQUE/i);
    expect(() =>
      db.prepare(
        `INSERT INTO task_inventory_generations (
           id, digest, schema_id, executor_name, executor_version, capabilities_json,
           observed_at, task_count, payload_json, posted_by_user_id, created_at
         ) VALUES ('gen-other', 'digest-a', 'executor-inventory@1', 'other-executor', '1', '[]', 1, 0, '{}', 'u1', 1)`,
      ).run(),
    ).not.toThrow();

    // A generation may not name a principal that does not exist.
    expect(() =>
      db.prepare(
        `INSERT INTO task_inventory_generations (
           id, digest, schema_id, executor_name, executor_version, capabilities_json,
           observed_at, task_count, payload_json, posted_by_user_id, created_at
         ) VALUES ('gen-x', 'digest-b', 'executor-inventory@1', 'agent-schedule', '1', '[]', 1, 0, '{}', 'nobody', 1)`,
      ).run(),
    ).toThrow(/FOREIGN KEY/i);
  });

  it("produces a table identical to the fresh-schema baseline", () => {
    // `db` was opened fresh, so it carries the BASELINE definition.
    const baselineTable = objectSql(db, "task_inventory_generations");
    const baselineIndexes = db
      .prepare(
        `SELECT name, sql FROM sqlite_master
          WHERE type = 'index' AND tbl_name = 'task_inventory_generations' AND sql IS NOT NULL
          ORDER BY name`,
      )
      .all() as Array<{ name: string; sql: string }>;
    expect(baselineTable).toBeTruthy();

    rewindToV123(db);
    migrate(db);

    expect(objectSql(db, "task_inventory_generations")).toEqual(baselineTable);
    expect(
      (db.prepare(
        `SELECT name, sql FROM sqlite_master
          WHERE type = 'index' AND tbl_name = 'task_inventory_generations' AND sql IS NOT NULL
          ORDER BY name`,
      ).all() as Array<{ name: string; sql: string }>).map((row) => ({
        name: row.name,
        sql: row.sql.replace(/\s+/g, " ").trim(),
      })),
    ).toEqual(
      baselineIndexes.map((row) => ({ name: row.name, sql: row.sql.replace(/\s+/g, " ").trim() })),
    );
  });

  it("replays over a database that already has the table", () => {
    // The suite's version-rewind fixtures replay migrations over databases that
    // already carry later objects, so v124 must be idempotent.
    db.exec("UPDATE meta SET value = '123' WHERE key = 'schema_version'");
    expect(() => migrate(db)).not.toThrow();
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
value: "157",
    });
  });

  it("includes authenticated receipts in the durable metadata backup", () => {
    expect(METADATA_BACKUP_TABLES).toContain("task_inventory_generations");
    db.prepare(
      `INSERT INTO users (id, slug, kind, display_name, status, created_at, updated_at, metadata_json)
       VALUES ('u-backup', 'executor-backup', 'agent', 'Executor Backup', 'active', 0, 0, '{}')`,
    ).run();
    const payload = JSON.stringify({
      schema: "executor-inventory@1",
      executor: { name: "executor-backup", version: "1", capabilities: [] },
      observed_at: 1234,
      tasks: [],
    });
    db.prepare(
      `INSERT INTO task_inventory_generations (
         id, digest, schema_id, executor_name, executor_version, capabilities_json,
         observed_at, task_count, payload_json, posted_by_user_id, created_at
       ) VALUES ('generation-backup', 'digest-backup', 'executor-inventory@1',
         'executor-backup', '1', '[]', 1234, 0, ?, 'u-backup', 1235)`,
    ).run(payload);

    const dump = buildMetadataBackupSql(db);
    expect(dump).toContain("-- Table: task_inventory_generations");
    expect(dump).toContain("generation-backup");
    expect(dump).toContain("digest-backup");

    const restored = new Database(":memory:");
    try {
      restored.exec(dump);
      expect(
        restored.prepare(
          "SELECT executor_name, posted_by_user_id, payload_json FROM task_inventory_generations WHERE id = ?",
        ).get("generation-backup"),
      ).toEqual({
        executor_name: "executor-backup",
        posted_by_user_id: "u-backup",
        payload_json: payload,
      });
    } finally {
      restored.close();
    }
  });
});
