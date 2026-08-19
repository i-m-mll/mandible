import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { BASELINE_SCHEMA_VERSION } from "../src/db-baseline.js";
import { migrate, type Db } from "../src/db.js";

const HASH = "a".repeat(64);

function installV1TaskCommandTables(db: Db): void {
  db.exec(`
    DROP TABLE task_command_events;
    DROP TABLE task_command_requests;
    CREATE TABLE task_command_requests (
      id                   TEXT PRIMARY KEY,
      schema_id            TEXT NOT NULL CHECK(schema_id = 'task-command@1'),
      request_key          TEXT NOT NULL CHECK(trim(request_key) != ''),
      request_digest       TEXT NOT NULL
                           CHECK(length(request_digest) = 64
                             AND request_digest NOT GLOB '*[^0-9a-f]*'),
      executor_name        TEXT NOT NULL CHECK(trim(executor_name) != ''),
      task_id              TEXT NOT NULL CHECK(trim(task_id) != ''),
      verb                 TEXT NOT NULL CHECK(verb = 'disable'),
      payload_json         TEXT NOT NULL DEFAULT '{}'
                           CHECK(json_valid(payload_json)
                             AND json_type(payload_json) = 'object'
                             AND payload_json = '{}'),
      requested_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      requested_at         INTEGER NOT NULL,
      UNIQUE(requested_by_user_id, request_key)
    );
    CREATE INDEX idx_task_command_requests_target
      ON task_command_requests(executor_name, task_id, requested_at DESC);
    CREATE TABLE task_command_events (
      id               TEXT PRIMARY KEY,
      command_id       TEXT NOT NULL
                       REFERENCES task_command_requests(id) ON DELETE RESTRICT,
      event_digest     TEXT NOT NULL
                       CHECK(length(event_digest) = 64
                         AND event_digest NOT GLOB '*[^0-9a-f]*'),
      event_type       TEXT NOT NULL
                       CHECK(event_type IN ('accepted','applied','rejected','cancelled')),
      payload_json     TEXT NOT NULL DEFAULT '{}'
                       CHECK(json_valid(payload_json) AND json_type(payload_json) = 'object'),
      no_op            INTEGER CHECK(no_op IS NULL OR no_op IN (0,1)),
      rejection_reason TEXT CHECK(rejection_reason IS NULL OR rejection_reason IN (
                         'unknown_task','unsupported_verb','invalid_payload',
                         'stale_target','policy_refused','unknown'
                       )),
      actor_user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      created_at       INTEGER NOT NULL,
      UNIQUE(command_id, event_digest),
      CHECK (
        (event_type IN ('accepted','cancelled')
          AND no_op IS NULL AND rejection_reason IS NULL)
        OR (event_type = 'applied' AND no_op IS NOT NULL AND rejection_reason IS NULL)
        OR (event_type = 'rejected' AND no_op IS NULL AND rejection_reason IS NOT NULL)
      )
    );
    CREATE UNIQUE INDEX uq_task_command_events_accepted
      ON task_command_events(command_id) WHERE event_type = 'accepted';
    CREATE UNIQUE INDEX uq_task_command_events_terminal
      ON task_command_events(command_id)
      WHERE event_type IN ('applied','rejected','cancelled');
    CREATE INDEX idx_task_command_events_command
      ON task_command_events(command_id, created_at, id);
    UPDATE meta SET value = '134' WHERE key = 'schema_version';
  `);
}

function upgradedDb(): Db {
  const db = new Database(":memory:");
  migrate(db);
  installV1TaskCommandTables(db);
  return db;
}

function insertUser(db: Db): void {
  db.prepare(
    `INSERT INTO users (id, slug, display_name, kind, status, created_at, updated_at)
     VALUES ('operator', 'operator-v135', 'Operator', 'human', 'active', 1, 1)`,
  ).run();
}

function schemaProjection(db: Db): unknown[] {
  return db.prepare(
    `SELECT type, name, tbl_name, sql
       FROM sqlite_master
      WHERE name LIKE 'task_command_%' OR name LIKE '%task_command_events%'
      ORDER BY type, name`,
  ).all();
}

describe("migration v135: task-command v2", () => {
  it("migrates_despite_a_pre_existing_unrelated_foreign_key_violation", () => {
    // A real database had three `console_session_usage` rows whose parent
    // sessions were gone — orphaned before that foreign key was declared, and
    // untouched by this migration. A whole-database `foreign_key_check` saw
    // them, aborted, and left the daemon crash-looping on every restart with
    // no way forward. A migration verifies what it changed.
    const db = upgradedDb();
    insertUser(db);
    db.pragma("foreign_keys = OFF");
    db.exec(`
      INSERT INTO console_session_usage (id, console_session_id, recorded_at)
      VALUES ('usage-orphan','session-that-no-longer-exists',10);
    `);

    expect(() => migrate(db)).not.toThrow();

    expect(db.prepare(
      "SELECT value FROM meta WHERE key = 'schema_version'",
    ).get()).toEqual({ value: String(BASELINE_SCHEMA_VERSION) });
    // The unrelated violation is left exactly as found: not repaired, not
    // deleted, and not a reason to refuse to start.
    expect(db.prepare(
      "SELECT count(*) AS n FROM console_session_usage WHERE id = 'usage-orphan'",
    ).get()).toEqual({ n: 1 });
    db.close();
  });

  it("preserves_v1_command_rows_and_events_exactly", () => {
    const db = upgradedDb();
    insertUser(db);
    db.exec(`
      INSERT INTO task_command_requests VALUES (
        'command-1','task-command@1','disable-1','${"1".repeat(64)}',
        'agent-schedule','daily-digest','disable','{}','operator',10
      );
      INSERT INTO task_command_events VALUES (
        'event-accepted','command-1','${"2".repeat(64)}','accepted','{}',
        NULL,NULL,'operator',11
      );
      INSERT INTO task_command_events VALUES (
        'event-applied','command-1','${"3".repeat(64)}','applied','{"no_op":false}',
        0,NULL,'operator',12
      );
    `);
    const requestBefore = db.prepare("SELECT * FROM task_command_requests").get();
    const eventBefore = db.prepare(
      `SELECT id, command_id, event_digest, event_type, payload_json, no_op,
              rejection_reason, actor_user_id, created_at
         FROM task_command_events ORDER BY rowid`,
    ).all();

    migrate(db);

    expect(db.prepare("SELECT * FROM task_command_requests").get()).toEqual(requestBefore);
    expect(db.prepare(
      `SELECT id, command_id, event_digest, event_type, payload_json, no_op,
              rejection_reason, actor_user_id, created_at
         FROM task_command_events ORDER BY event_ordinal`,
    ).all()).toEqual(eventBefore);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    db.close();
  });

  it("admits_only_canonical_v2_schema_verb_payload_pairs", () => {
    const db = upgradedDb();
    insertUser(db);
    migrate(db);
    const insert = db.prepare(
      `INSERT INTO task_command_requests (
         id, schema_id, request_key, request_digest, executor_name, task_id,
         verb, payload_json, requested_by_user_id, requested_at
       ) VALUES (?, ?, ?, ?, 'agent-schedule', 'daily-digest', ?, ?, 'operator', 1)`,
    );
    let ordinal = 0;
    const admit = (schema: string, verb: string, payload: string) => {
      ordinal += 1;
      insert.run(`id-${ordinal}`, schema, `key-${ordinal}`, HASH, verb, payload);
    };
    expect(() => admit("task-command@1", "disable", "{}")).not.toThrow();
    expect(() => admit("task-command@2", "disable", "{}")).not.toThrow();
    expect(() => admit("task-command@2", "dry_run", `{"execution_hash":"${HASH}"}`))
      .not.toThrow();
    expect(() => admit("task-command@2", "enable", `{"execution_hash":"${HASH}"}`))
      .not.toThrow();
    for (const [schema, verb, payload] of [
      ["task-command@1", "enable", `{"execution_hash":"${HASH}"}`],
      ["task-command@2", "disable", `{"execution_hash":"${HASH}"}`],
      ["task-command@2", "dry_run", `{"execution_hash":"${HASH.toUpperCase()}"}`],
      ["task-command@2", "dry_run", `{"execution_hash":"${HASH}","extra":true}`],
      ["task-command@2", "enable", `{ "execution_hash": "${HASH}" }`],
    ] as const) {
      expect(() => admit(schema, verb, payload)).toThrow();
    }
    db.close();
  });

  it("assigns_deterministic_event_ordinals", () => {
    const db = upgradedDb();
    insertUser(db);
    db.exec(`
      INSERT INTO task_command_requests VALUES (
        'command-1','task-command@1','disable-1','${"1".repeat(64)}',
        'agent-schedule','daily-digest','disable','{}','operator',10
      );
      INSERT INTO task_command_events VALUES (
        'accepted','command-1','${"2".repeat(64)}','accepted','{}',NULL,NULL,'operator',11
      );
      INSERT INTO task_command_events VALUES (
        'terminal','command-1','${"3".repeat(64)}','applied','{"no_op":true}',1,NULL,'operator',12
      );
    `);
    migrate(db);
    expect(db.prepare(
      "SELECT event_type, event_ordinal, schema_id FROM task_command_events ORDER BY event_ordinal",
    ).all()).toEqual([
      { event_type: "accepted", event_ordinal: 0, schema_id: "task-command-event@1" },
      { event_type: "applied", event_ordinal: 8, schema_id: "task-command-event@1" },
    ]);
    expect(() => db.prepare(
      `INSERT INTO task_command_events (
         id, command_id, schema_id, event_ordinal, event_digest, event_type,
         payload_json, no_op, rejection_reason, actor_user_id, created_at
       ) VALUES ('bad','command-1','task-command-event@2',2,?,'started',
                 '{"execution_hash":"${HASH}","run_id":"run-1"}',NULL,NULL,'operator',13)`,
    ).run("4".repeat(64))).toThrow();
    db.close();
  });

  it("fresh_and_upgraded_schemas_converge_at_v135", () => {
    const fresh = new Database(":memory:");
    migrate(fresh);
    const upgraded = upgradedDb();
    migrate(upgraded);
    expect(BASELINE_SCHEMA_VERSION).toBe(143);
    expect(schemaProjection(upgraded)).toEqual(schemaProjection(fresh));
    expect(upgraded.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get())
      .toEqual({ value: "143" });
    fresh.close();
    upgraded.close();
  });
});
