import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { BASELINE_SCHEMA_VERSION } from "../src/db-baseline.js";
import { migrate, type Db } from "../src/db.js";

const TABLES = [
  "feedback_annotation_events",
  "feedback_collection_documents",
  "feedback_submission_annotations",
];
const V137_OBJECTS = [...TABLES,
  "idx_feedback_collection_documents_version",
  "idx_feedback_annotation_events_collection_actor",
  "uq_feedback_annotation_retraction",
  "uq_feedback_submission_superseded_once_actor",
];

function definitions(db: Db): unknown[] {
  return (db.prepare(
    `SELECT type, name, sql FROM sqlite_master
      WHERE name IN (${V137_OBJECTS.map(() => "?").join(",")}) ORDER BY type, name`,
  ).all(...V137_OBJECTS) as Array<{ type: string; name: string; sql: string }>).map((row) => ({
    ...row,
    sql: row.sql.replace(/ IF NOT EXISTS/gi, "").replace(/\s+/g, " ").trim(),
  }));
}

function installRows(db: Db): void {
  db.exec(`
    INSERT INTO users (id, slug, display_name, kind, status, created_at, updated_at)
      VALUES ('actor-1','actor-1','Actor 1','human','active',1,1),
             ('actor-2','actor-2','Actor 2','human','active',1,1);
    INSERT INTO feedback_collections (id, kind, interaction_mode, source, created_at)
      VALUES ('round-1','bounded_ask','explicit_submit',NULL,1),
             ('round-2','bounded_ask','explicit_submit',NULL,1),
             ('round-3','bounded_ask','explicit_submit',NULL,1);
  `);
}

describe("migration v137: annotatable ask documents", () => {
  it("builds the additive schema in the fresh baseline and enforces the closed annotation shape", () => {
    const db = new Database(":memory:");
    migrate(db);
    expect(BASELINE_SCHEMA_VERSION).toBe(140);
    expect(db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${TABLES.map(() => "?").join(",")}) ORDER BY name`,
    ).all(...TABLES)).toEqual(TABLES.map((name) => ({ name })).sort((a, b) => a.name.localeCompare(b.name)));
    installRows(db);
    const insert = (values: string) => db.exec(`INSERT INTO feedback_annotation_events
      (id, collection_id, operation, annotation_kind, start_offset, end_offset, quote,
       body, replacement_text, retracts_event_id, actor_user_id, created_at) VALUES (${values})`);
    expect(() => insert("'a','round-1','set','comment',0,1,NULL,'x',NULL,NULL,'actor-1',1")).toThrow();
    expect(() => insert("'b','round-1','set','comment',0,1,'x','x','bad',NULL,'actor-1',1")).toThrow();
    expect(() => insert("'c','round-1','set','suggest_replacement',0,1,'x',NULL,NULL,NULL,'actor-1',1")).toThrow();
    expect(() => insert("'d','round-1','retract',NULL,NULL,NULL,NULL,'payload',NULL,'missing','actor-1',1")).toThrow();
    expect(() => insert("'e','round-1','set','comment',1,1,'x','x',NULL,NULL,'actor-1',1")).toThrow();
    expect(() => insert("'f','round-1','set','comment',0,1,'','x',NULL,NULL,'actor-1',1")).toThrow();
    db.exec(`
      INSERT INTO artifact_blob (id, content_hash, created_at)
        VALUES ('artifact-blob:${"a".repeat(64)}','${"a".repeat(64)}',1);
      INSERT INTO artifact (id, identity_key, latest_version_id, version_count, created_at, updated_at)
        VALUES ('artifact:plan','plan','artifact-version:plan-v1',1,1,1);
      INSERT INTO artifact_version
        (id, artifact_id, version_no, blob_id, source_kind, content_hash, created_at)
        VALUES ('artifact-version:plan-v1','artifact:plan',1,'artifact-blob:${"a".repeat(64)}','managed','${"a".repeat(64)}',1);
      INSERT INTO feedback_collection_documents VALUES ('round-1','artifact-version:plan-v1',NULL,1);
      INSERT INTO feedback_collection_documents VALUES ('round-2','artifact-version:plan-v1','round-1',1);
      INSERT INTO feedback_collection_documents VALUES ('round-3','artifact-version:plan-v1','round-1',1);
    `);
    expect(() => db.exec(
      "UPDATE feedback_collection_documents SET previous_round_id = 'round-1' WHERE collection_id = 'round-1'",
    )).toThrow();
    db.close();
  });

  it("upgrades v136 without rebuilding tables and preserves legacy cross-actor supersession", () => {
    const db = new Database(":memory:");
    migrate(db);
    const freshDefinitions = definitions(db);
    installRows(db);
    db.exec(`
      DROP TABLE feedback_submission_annotations;
      DROP TABLE feedback_annotation_events;
      DROP TABLE feedback_collection_documents;
      DROP INDEX uq_feedback_submission_superseded_once_actor;
      CREATE UNIQUE INDEX uq_feedback_submission_superseded_once
        ON feedback_submissions(supersedes_submission_id) WHERE supersedes_submission_id IS NOT NULL;
      UPDATE meta SET value = '136' WHERE key = 'schema_version';
      INSERT INTO feedback_collection_events VALUES ('life-1','round-1','opened',NULL,'actor-1','{}',1);
      INSERT INTO feedback_collection_events VALUES ('life-2','round-1','submitted','life-1','actor-1','{}',2);
      INSERT INTO feedback_collection_events VALUES ('life-3','round-1','submitted','life-2','actor-2','{}',3);
      INSERT INTO feedback_submissions VALUES ('sub-1','round-1',1,NULL,'life-2','actor-1',2);
      INSERT INTO feedback_submissions VALUES ('sub-2','round-1',2,'sub-1','life-3','actor-2',3);
    `);
    migrate(db);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get())
      .toEqual({ value: "140" });
    db.exec(`
      INSERT INTO feedback_collection_events VALUES ('life-4','round-1','submitted','life-3','actor-1','{}',4);
      INSERT INTO feedback_submissions VALUES ('sub-3','round-1',3,'sub-1','life-4','actor-1',4);
    `);
    const index = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'uq_feedback_submission_superseded_once_actor'",
    ).get() as { sql: string };
    expect(index.sql).toContain("supersedes_submission_id, actor_user_id");
    expect(definitions(db)).toEqual(freshDefinitions);
    expect(TABLES.every((name) => db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(name))).toBe(true);
    db.close();
  });
});
