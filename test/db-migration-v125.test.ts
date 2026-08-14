import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate, openDb, type Db } from "../src/db.js";
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

  target.exec(`
    INSERT INTO review_candidates (
      id, source, candidate_key, current_revision_id, created_at
    ) VALUES ('candidate-1', 'source-1', 'key-1', NULL, 102);
    INSERT INTO briefing_batches (
      batch_key, task_identity, run_id, digest_series_ref, digest_version, item_count, received_at
    ) VALUES ('batch-1', 'task-1', 'run-1', 'series-1', 7, 1, 103);
    INSERT INTO candidate_revisions (
      id, candidate_id, title, why_notable, refs_json, source_ref, evidence_hash,
      evidence_kind, captured_at, run_id, digest_series_ref, digest_version,
      rank, batch_key, ingested_at
    ) VALUES (
      'revision-1', 'candidate-1', 'Title', 'Why', '["ref-1"]', 'source-ref-1',
      'evidence-1', 'snapshot-item', '2026-08-14T00:00:00Z', 'run-1', 'series-1',
      7, 1, 'batch-1', 104
    );
    UPDATE review_candidates SET current_revision_id = 'revision-1' WHERE id = 'candidate-1';
    INSERT INTO candidate_occurrences (
      id, revision_id, digest_version, batch_key, seen_at
    ) VALUES ('occurrence-1', 'revision-1', 7, 'batch-1', 105);
    INSERT INTO decision_events (
      id, candidate_id, revision_id, action, actor_user_id, comment_id, created_at
    ) VALUES ('decision-1', 'candidate-1', 'revision-1', 'keep',
      (SELECT id FROM users WHERE slug = 'v125-user'), NULL, 106);
    INSERT INTO candidate_comments (
      id, candidate_id, revision_id, body, actor_user_id, created_at
    ) VALUES ('comment-1', 'candidate-1', 'revision-1', 'Legacy comment',
      (SELECT id FROM users WHERE slug = 'v125-user'), 107);
  `);
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
      value: "125",
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

  it("preserves populated v124 grants and Briefing rows without copying them", () => {
    rewindToV124(db);
    seedV124Rows(db);
    const grantsBefore = rows(db, "permission_grants");
    const briefingBefore = new Map(BRIEFING_TABLES.map((table) => [table, rows(db, table)]));

    migrate(db);

    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
      value: "125",
    });
    expect(rows(db, "permission_grants")).toEqual(grantsBefore);
    for (const table of BRIEFING_TABLES) {
      expect(objectDefinitions(db, [table])).toHaveLength(1);
      expect(rows(db, table)).toEqual(briefingBefore.get(table));
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
      value: "125",
    });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
  });
});
