import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MIGRATIONS } from "../src/db-migrations.js";
import { migrate, type Db } from "../src/db.js";
import { createUser } from "../src/users/store.js";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
});

afterEach(() => db.close());

describe("migration 127 briefing ingest replay identity", () => {
  it("upgrades a v126 schema and enforces publisher-scoped request identity", () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 127);
    expect(migration?.name).toBe("briefing_ingest_v2_replay_identity");

    // Reconstruct the additive v126 boundary from the generated v127 baseline,
    // then exercise migrate() so the guarded column hook runs too.
    db.exec(`
      DROP INDEX idx_feedback_publications_ingest_request;
      ALTER TABLE feedback_publications DROP COLUMN ingest_request_id;
      DROP INDEX idx_feedback_ingest_requests_received;
      DROP TABLE feedback_ingest_requests;
      UPDATE meta SET value = '126' WHERE key = 'schema_version';
    `);
    migrate(db);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get())
      .toEqual({ value: "133" });
    expect((db.prepare("PRAGMA table_info(feedback_publications)").all() as Array<{ name: string }>)
      .map((column) => column.name)).toContain("ingest_request_id");

    const publisher = createUser(db, {
      slug: "publisher",
      kind: "agent",
      display_name: "Publisher",
    });
    const insert = db.prepare(`
      INSERT INTO feedback_ingest_requests (
        id, publisher_user_id, task_identity, batch_key, request_digest,
        schema_id, result_json, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      "request-1", publisher.id, "agent-schedule/daily-digest", "batch", "a".repeat(64),
      "briefing-ingest@2", '{"accepted":0,"created":0,"revised":0,"unchanged":0}', 2,
    );
    expect(() => insert.run(
      "request-2", publisher.id, "agent-schedule/daily-digest", "batch", "b".repeat(64),
      "briefing-ingest@2", "{}", 3,
    )).toThrow(/UNIQUE/);
    expect(() => insert.run(
      "bad-digest", publisher.id, "agent-schedule/task-health", "other", "not-a-digest",
      "briefing-ingest@2", "{}", 3,
    )).toThrow(/CHECK/);
  });
});
