import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { migrate, type Db } from "../src/db.js";
import { createUser } from "../src/users/store.js";

function downgradeToV135(db: Db): void {
  db.pragma("foreign_keys = OFF");
  db.exec(`
    DROP TABLE operational_incident_workflow_events;
    CREATE TABLE agent_dispatch_events_v135 (
      id             TEXT PRIMARY KEY,
      subject_kind   TEXT NOT NULL CHECK(subject_kind IN ('finding','issue')),
      candidate_id   TEXT REFERENCES feedback_items(id) ON DELETE RESTRICT,
      revision_id    TEXT REFERENCES feedback_item_revisions(id) ON DELETE RESTRICT,
      comment_id     TEXT REFERENCES feedback_comments(id) ON DELETE RESTRICT,
      issue_id       TEXT,
      actor_user_id  TEXT REFERENCES users(id) ON DELETE RESTRICT,
      provider       TEXT NOT NULL DEFAULT 'claude',
      instruction    TEXT NOT NULL,
      cwd            TEXT NOT NULL,
      prompt_path    TEXT,
      prompt_sha256  TEXT,
      status         TEXT NOT NULL CHECK(status IN ('dispatching','dispatched','failed')),
      session_handle TEXT,
      session_id     TEXT,
      attach_command TEXT,
      error          TEXT,
      created_at     INTEGER NOT NULL,
      settled_at     INTEGER
    );
    INSERT INTO agent_dispatch_events_v135 (
      id, subject_kind, candidate_id, revision_id, comment_id, issue_id,
      actor_user_id, provider, instruction, cwd, prompt_path, prompt_sha256,
      status, session_handle, session_id, attach_command, error, created_at, settled_at
    ) SELECT
      id, subject_kind, candidate_id, revision_id, comment_id, issue_id,
      actor_user_id, provider, instruction, cwd, prompt_path, prompt_sha256,
      status, session_handle, session_id, attach_command, error, created_at, settled_at
    FROM agent_dispatch_events;
    DROP TABLE agent_dispatch_events;
    ALTER TABLE agent_dispatch_events_v135 RENAME TO agent_dispatch_events;
    CREATE INDEX idx_agent_dispatch_events_candidate
      ON agent_dispatch_events(candidate_id, created_at DESC);
    CREATE INDEX idx_agent_dispatch_events_issue
      ON agent_dispatch_events(issue_id, created_at DESC);
    CREATE INDEX idx_agent_dispatch_events_comment
      ON agent_dispatch_events(comment_id);
    DROP TABLE operational_incident_observation_events;
    DROP TABLE operational_incidents;
    UPDATE meta SET value = '135' WHERE key = 'schema_version';
  `);
  db.pragma("foreign_keys = ON");
}

describe("migration v136: durable operational incidents", () => {
  it("migration_v136_preserves_existing_dispatch_events", () => {
    const db = new Database(":memory:");
    migrate(db);
    const actor = createUser(db, {
      slug: "dispatch-actor",
      kind: "human",
      display_name: "Dispatch Actor",
    }).id;
    db.prepare(
      `INSERT INTO agent_dispatch_events (
         id, subject_kind, issue_id, actor_user_id, instruction, cwd,
         prompt_sha256, status, created_at
       ) VALUES ('dispatch-1', 'issue', 'issue-1', ?, 'Investigate', '/tmp', ?, 'failed', 10)`,
    ).run(actor, "a".repeat(64));
    downgradeToV135(db);
    const before = db.prepare("SELECT * FROM agent_dispatch_events").get();

    migrate(db);

    expect(db.prepare(
      `SELECT id, subject_kind, candidate_id, revision_id, comment_id, issue_id,
              actor_user_id, provider, instruction, cwd, prompt_path, prompt_sha256,
              status, session_handle, session_id, attach_command, error, created_at, settled_at
         FROM agent_dispatch_events`,
    ).get()).toEqual(before);
    expect(db.prepare(
      "SELECT incident_id, incident_telemetry_sha256 FROM agent_dispatch_events",
    ).get()).toEqual({ incident_id: null, incident_telemetry_sha256: null });
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get())
      .toEqual({ value: "141" });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    db.close();
  });

  it("migration_v136_enforces_incident_subject_cardinality", () => {
    const db = new Database(":memory:");
    migrate(db);
    const actor = createUser(db, {
      slug: "dispatch-actor",
      kind: "human",
      display_name: "Dispatch Actor",
    }).id;
    db.prepare(
      `INSERT INTO operational_incidents (
         id, executor, task, condition, first_seen, observation_state,
         attention_state, remediation_state, latest_event_seq, latest_observed_at,
         latest_event_id, latest_telemetry_json, latest_telemetry_sha256,
         posted_by_user_id, created_at, updated_at
       ) VALUES (
         'incident-1', 'agent-schedule', 'daily-digest', 'failed_permanent', 1,
         'active', 'unacknowledged', 'none', 1, 1, 'event-1', '{}', ?, ?, 1, 1
       )`,
    ).run("b".repeat(64), actor);
    const insert = db.prepare(
      `INSERT INTO agent_dispatch_events (
         id, subject_kind, candidate_id, revision_id, issue_id, incident_id,
         incident_telemetry_sha256, actor_user_id, instruction, cwd, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Investigate', '/tmp', 'dispatching', 1)`,
    );
    expect(() => insert.run(
      "valid", "incident", null, null, null, "incident-1", "c".repeat(64), actor,
    )).not.toThrow();
    expect(() => insert.run(
      "mixed", "incident", null, null, "issue-1", "incident-1", "c".repeat(64), actor,
    )).toThrow();
    expect(() => insert.run(
      "missing-hash", "incident", null, null, null, "incident-1", null, actor,
    )).toThrow();
    expect(() => insert.run(
      "finding-mixed", "finding", "candidate", "revision", null, "incident-1", null, actor,
    )).toThrow();
    db.close();
  });
});
