import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate, openDb, type Db } from "../src/db.js";
import { MIGRATIONS } from "../src/db-migrations.js";
import { addGrant } from "../src/permissions/store.js";
import { createUser } from "../src/users/store.js";

const FEEDBACK_TABLES = [
  "feedback_collections",
  "feedback_recurring_profiles",
  "feedback_ask_sessions",
  "feedback_publications",
  "feedback_items",
  "feedback_item_revisions",
  "feedback_item_options",
  "feedback_publication_items",
  "feedback_collection_events",
  "feedback_item_events",
  "feedback_response_events",
  "feedback_submissions",
  "feedback_submission_answers",
  "feedback_comments",
] as const;

const FEEDBACK_INDEXES = [
  "uq_feedback_collections_recurring_source",
  "idx_feedback_collections_kind_created",
  "idx_feedback_ask_sessions_requester",
  "idx_feedback_ask_sessions_expiry",
  "idx_feedback_publications_collection",
  "idx_feedback_publications_task_digest",
  "uq_feedback_items_publisher_identity",
  "uq_feedback_items_client_key",
  "idx_feedback_items_collection",
  "idx_feedback_items_parent",
  "uq_feedback_item_revisions_evidence",
  "idx_feedback_item_revisions_item",
  "idx_feedback_item_revisions_publication",
  "idx_feedback_publication_items_revision",
  "uq_feedback_collection_event_successor",
  "idx_feedback_collection_events_head",
  "idx_feedback_item_events_revision",
  "uq_feedback_response_retraction",
  "idx_feedback_response_events_revision",
  "idx_feedback_response_events_collection_actor",
  "uq_feedback_submission_superseded_once",
  "idx_feedback_comments_item",
] as const;

const PERMISSION_INDEXES = [
  "uq_permission_grants_project",
  "uq_permission_grants_global",
  "idx_permission_grants_subject",
  "idx_permission_grants_resource",
] as const;

const BRIEFING_TABLES = [
  "review_candidates",
  "candidate_revisions",
  "candidate_occurrences",
  "decision_events",
  "candidate_comments",
  "briefing_batches",
] as const;

function normalizeSql(sql: string | null): string | null {
  return sql?.replace(/\s+/g, " ").trim() ?? null;
}

function objectDefinitions(target: Db, names: readonly string[]): Array<{
  type: string;
  name: string;
  sql: string | null;
}> {
  const placeholders = names.map(() => "?").join(", ");
  return (target.prepare(
    `SELECT type, name, sql FROM sqlite_master
      WHERE name IN (${placeholders}) ORDER BY type, name`,
  ).all(...names) as Array<{ type: string; name: string; sql: string | null }>).map((row) => ({
    ...row,
    sql: normalizeSql(row.sql),
  }));
}

function rows(target: Db, table: string): unknown[] {
  return target.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
}

function buildSequentialSchemaThroughV54(target: Db): void {
  for (const migration of MIGRATIONS.filter((entry) => entry.version <= 54)) {
    for (const statement of migration.statements) target.exec(statement);
  }
  target.prepare(
    `INSERT INTO meta (key, value) VALUES ('schema_version', '54')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run();
}

function rewindToV124(target: Db): void {
  target.pragma("foreign_keys = OFF");
  try {
    target.exec(`
      DROP TABLE IF EXISTS feedback_submission_answers;
      DROP TABLE IF EXISTS feedback_submissions;
      DROP TABLE IF EXISTS feedback_comments;
      DROP TABLE IF EXISTS feedback_response_events;
      DROP TABLE IF EXISTS feedback_item_events;
      DROP TABLE IF EXISTS feedback_collection_events;
      DROP TABLE IF EXISTS feedback_publication_items;
      DROP TABLE IF EXISTS feedback_item_options;
      DROP TABLE IF EXISTS feedback_item_revisions;
      DROP TABLE IF EXISTS feedback_items;
      DROP TABLE IF EXISTS feedback_publications;
      DROP TABLE IF EXISTS feedback_ask_sessions;
      DROP TABLE IF EXISTS feedback_recurring_profiles;
      DROP TABLE IF EXISTS feedback_collections;

      ALTER TABLE permission_grants RENAME TO permission_grants_v125;
      CREATE TABLE permission_grants (
        id            TEXT PRIMARY KEY,
        subject_type  TEXT NOT NULL CHECK(subject_type IN ('user','group')),
        subject_id    TEXT NOT NULL,
        resource_type TEXT NOT NULL CHECK(resource_type IN ('project','global')),
        resource_id   TEXT REFERENCES ledger_projects(id) ON DELETE CASCADE,
        permission    TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        CHECK (
          (resource_type = 'project' AND resource_id IS NOT NULL
            AND permission IN ('read','write','admin')) OR
          (resource_type = 'global' AND resource_id IS NULL
            AND permission IN ('approve_auth','spawn_console','change_settings','backup','open_path'))
        )
      );
      INSERT INTO permission_grants (
        id, subject_type, subject_id, resource_type, resource_id, permission, created_at
      )
      SELECT id, subject_type, subject_id, resource_type, resource_id, permission, created_at
        FROM permission_grants_v125;
      DROP TABLE permission_grants_v125;
      CREATE UNIQUE INDEX uq_permission_grants_project
        ON permission_grants(subject_type, subject_id, resource_id, permission)
        WHERE resource_type = 'project';
      CREATE UNIQUE INDEX uq_permission_grants_global
        ON permission_grants(subject_type, subject_id, permission)
        WHERE resource_type = 'global';
      CREATE INDEX idx_permission_grants_subject
        ON permission_grants(subject_type, subject_id);
      CREATE INDEX idx_permission_grants_resource
        ON permission_grants(resource_type, resource_id);
      UPDATE meta SET value = '124' WHERE key = 'schema_version';
    `);
  } finally {
    target.pragma("foreign_keys = ON");
  }
}

function seedV124Rows(target: Db): void {
  createUser(target, { slug: "v125-user", kind: "agent", display_name: "V125 User" }, 100);
  target.prepare(
    "INSERT INTO sessions (id, app, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("v125-session", "codex", "active", "100", "100");
  addGrant(target, {
    subject_type: "user",
    subject: "v125-user",
    resource_type: "global",
    permission: "backup",
  }, 101);

}

describe.sequential("migration v125: feedback schema foundation", () => {
  let tempDir: string;
  let db: Db;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-db-v125-"));
    db = openDb(path.join(tempDir, "mandible.db"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates the complete fresh schema and converges with the v124 upgrade path", () => {
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
      value: "127",
    });

    const requiredObjects = [...FEEDBACK_TABLES, ...FEEDBACK_INDEXES];
    const baselineDefinitions = objectDefinitions(db, [
      ...requiredObjects,
      "permission_grants",
      ...PERMISSION_INDEXES,
    ]);
    expect(baselineDefinitions.map((object) => object.name).sort()).toEqual(
      [...requiredObjects, "permission_grants", ...PERMISSION_INDEXES].sort(),
    );

    rewindToV124(db);
    migrate(db);

    expect(objectDefinitions(db, [
      ...requiredObjects,
      "permission_grants",
      ...PERMISSION_INDEXES,
    ])).toEqual(baselineDefinitions);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
  });

  it("preserves populated v124 grants while v125 creates an empty foundation", () => {
    rewindToV124(db);
    seedV124Rows(db);
    const grantsBefore = rows(db, "permission_grants");
    migrate(db);

    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
      value: "127",
    });
    expect(rows(db, "permission_grants")).toEqual(grantsBefore);
    for (const table of BRIEFING_TABLES) {
      expect(objectDefinitions(db, [table])).toHaveLength(0);
    }
    for (const table of FEEDBACK_TABLES) {
      expect(rows(db, table)).toEqual([]);
    }

    expect(() => addGrant(db, {
      subject_type: "user",
      subject: "v125-user",
      resource_type: "global",
      permission: "ask.create",
    }, 108)).not.toThrow();
    expect(() => addGrant(db, {
      subject_type: "user",
      subject: "v125-user",
      resource_type: "global",
      permission: "unknown.capability",
    }, 109)).toThrow(/Invalid global capability/);
    expect(() => db.prepare(
      `INSERT INTO permission_grants (
        id, subject_type, subject_id, resource_type, resource_id, permission, created_at
      ) VALUES ('unknown-grant', 'user',
        (SELECT id FROM users WHERE slug = 'v125-user'), 'global', NULL, 'unknown.capability', 109)`,
    ).run()).toThrow(/CHECK constraint failed/);

    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
  });

  it("replays safely when only the version marker is rewound", () => {
    const user = createUser(
      db,
      { slug: "replay-user", kind: "agent", display_name: "Replay User" },
      200,
    );
    addGrant(db, {
      subject_type: "user",
      subject: user.id,
      resource_type: "global",
      permission: "ask.create",
    }, 201);
    const definitionsBefore = objectDefinitions(db, [
      ...FEEDBACK_TABLES,
      ...FEEDBACK_INDEXES,
      "permission_grants",
      ...PERMISSION_INDEXES,
    ]);
    const grantsBefore = rows(db, "permission_grants");

    db.exec("UPDATE meta SET value = '124' WHERE key = 'schema_version'");
    expect(() => migrate(db)).not.toThrow();

    expect(rows(db, "permission_grants")).toEqual(grantsBefore);
    expect(objectDefinitions(db, [
      ...FEEDBACK_TABLES,
      ...FEEDBACK_INDEXES,
      "permission_grants",
      ...PERMISSION_INDEXES,
    ])).toEqual(definitionsBefore);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
      value: "127",
    });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
  });

  it("upgrades a genuine pre-ledger schema and preserves grants through v125 replay", () => {
    const legacyDb = new Database(":memory:");
    try {
      legacyDb.pragma("foreign_keys = ON");
      buildSequentialSchemaThroughV54(legacyDb);
      expect(objectDefinitions(legacyDb, ["ledger_projects", "permission_grants"])).toEqual([]);

      migrate(legacyDb);
      const permissionDefinition = objectDefinitions(legacyDb, ["permission_grants"])[0];
      expect(permissionDefinition.sql).toContain("'ask.create'");
      expect(objectDefinitions(legacyDb, PERMISSION_INDEXES).map((entry) => entry.name).sort())
        .toEqual([...PERMISSION_INDEXES].sort());

      createUser(legacyDb, { slug: "pre-ledger-user", kind: "agent", display_name: "Pre-ledger User" }, 300);
      addGrant(legacyDb, {
        subject_type: "user",
        subject: "pre-ledger-user",
        resource_type: "global",
        permission: "backup",
      }, 301);
      rewindToV124(legacyDb);
      const grantsBefore = rows(legacyDb, "permission_grants");
      migrate(legacyDb);

      expect(rows(legacyDb, "permission_grants")).toEqual(grantsBefore);
      expect(objectDefinitions(legacyDb, ["permission_grants"])[0].sql).toContain("'ask.create'");
      expect(objectDefinitions(legacyDb, PERMISSION_INDEXES).map((entry) => entry.name).sort())
        .toEqual([...PERMISSION_INDEXES].sort());
      expect(legacyDb.pragma("foreign_key_check")).toEqual([]);
      expect(legacyDb.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    } finally {
      legacyDb.close();
    }
  });
});
