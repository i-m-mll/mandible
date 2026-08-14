import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildMetadataBackupSql } from "../src/ledger/backup.js";
import { listBriefingSourceHealth, summarizeBatch } from "../src/briefing.js";
import { migrate, type Db } from "../src/db.js";
import { addGrant } from "../src/permissions/store.js";
import { resolveFindingReference } from "../src/routes/spaces.js";
import { createUser } from "../src/users/store.js";

const LEGACY_TABLES = [
  "review_candidates", "candidate_revisions", "candidate_occurrences",
  "decision_events", "candidate_comments", "briefing_batches",
] as const;

const LEGACY_INDEXES = [
  "idx_review_candidates_source", "idx_candidate_revisions_candidate",
  "idx_candidate_revisions_batch", "idx_candidate_occurrences_revision",
  "idx_candidate_occurrences_batch", "idx_decision_events_revision",
  "idx_decision_events_candidate", "idx_candidate_comments_candidate",
  "idx_briefing_batches_task",
] as const;

const FEEDBACK_TABLES = [
  "feedback_collections", "feedback_recurring_profiles", "feedback_ask_sessions",
  "feedback_publications", "feedback_items", "feedback_item_revisions",
  "feedback_item_options", "feedback_publication_items", "feedback_collection_events",
  "feedback_item_events", "feedback_response_events", "feedback_submissions",
  "feedback_submission_answers", "feedback_comments",
] as const;

const V126_FK_CHECK_TABLES = [
  ...LEGACY_TABLES, "agent_dispatch_events", ...FEEDBACK_TABLES,
] as const;

const FEEDBACK_INDEXES = [
  "uq_feedback_collections_recurring_source", "idx_feedback_collections_kind_created",
  "idx_feedback_ask_sessions_requester", "idx_feedback_ask_sessions_expiry",
  "idx_feedback_publications_collection", "idx_feedback_publications_task_digest",
  "uq_feedback_items_publisher_identity", "uq_feedback_items_client_key",
  "idx_feedback_items_collection", "idx_feedback_items_parent",
  "uq_feedback_item_revisions_evidence", "idx_feedback_item_revisions_item",
  "idx_feedback_item_revisions_publication", "idx_feedback_publication_items_revision",
  "uq_feedback_collection_event_successor", "idx_feedback_collection_events_head",
  "idx_feedback_item_events_revision", "uq_feedback_response_retraction",
  "idx_feedback_response_events_revision", "idx_feedback_response_events_collection_actor",
  "uq_feedback_submission_superseded_once", "idx_feedback_comments_item",
] as const;

const DISPATCH_INDEXES = [
  "idx_agent_dispatch_events_candidate", "idx_agent_dispatch_events_issue",
  "idx_agent_dispatch_events_comment",
] as const;

function normalizeSql(sql: string | null): string | null {
  return sql?.replace(/\s+/g, " ").trim() ?? null;
}

function definitions(target: Db, names: readonly string[]) {
  const placeholders = names.map(() => "?").join(",");
  return (target.prepare(
    `SELECT type, name, sql FROM sqlite_master WHERE name IN (${placeholders})
      ORDER BY type, name`,
  ).all(...names) as Array<{ type: string; name: string; sql: string | null }>).map((row) => ({
    ...row,
    sql: normalizeSql(row.sql),
  }));
}

function rows(target: Db, table: string): unknown[] {
  return target.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
}

function tableExists(target: Db, table: string): boolean {
  return target.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table) !== undefined;
}

function foreignKeyViolations(target: Db, table: string): unknown[] {
  return target.prepare(`PRAGMA foreign_key_check("${table}")`).all();
}

function withForeignKeysDisabled(target: Db, mutate: () => void): void {
  target.pragma("foreign_keys = OFF");
  try {
    mutate();
  } finally {
    target.pragma("foreign_keys = ON");
  }
}

function restoreV125BriefingSchema(target: Db): void {
  target.pragma("foreign_keys = OFF");
  try {
    target.exec(`
      DROP TABLE agent_dispatch_events;
      CREATE TABLE review_candidates (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, candidate_key TEXT NOT NULL,
        current_revision_id TEXT, created_at INTEGER NOT NULL, UNIQUE(source, candidate_key)
      );
      CREATE TABLE candidate_revisions (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL REFERENCES review_candidates(id) ON DELETE CASCADE,
        title TEXT NOT NULL, why_notable TEXT,
        refs_json TEXT NOT NULL DEFAULT '[]'
          CHECK(json_valid(refs_json) AND json_type(refs_json)='array'),
        source_ref TEXT, evidence_hash TEXT NOT NULL,
        evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('snapshot-item','finding-only')),
        captured_at TEXT, run_id TEXT, digest_series_ref TEXT, digest_version INTEGER,
        rank INTEGER, batch_key TEXT NOT NULL, ingested_at INTEGER NOT NULL,
        UNIQUE(candidate_id, evidence_hash)
      );
      CREATE TABLE candidate_occurrences (
        id TEXT PRIMARY KEY,
        revision_id TEXT NOT NULL REFERENCES candidate_revisions(id) ON DELETE CASCADE,
        digest_version INTEGER, batch_key TEXT NOT NULL, seen_at INTEGER NOT NULL,
        UNIQUE(revision_id, batch_key)
      );
      CREATE TABLE decision_events (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL REFERENCES review_candidates(id) ON DELETE CASCADE,
        revision_id TEXT NOT NULL REFERENCES candidate_revisions(id) ON DELETE CASCADE,
        action TEXT NOT NULL CHECK(action IN ('keep','dismiss','undo','expire')),
        actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
        comment_id TEXT, created_at INTEGER NOT NULL
      );
      CREATE TABLE candidate_comments (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL REFERENCES review_candidates(id) ON DELETE CASCADE,
        revision_id TEXT NOT NULL REFERENCES candidate_revisions(id) ON DELETE CASCADE,
        body TEXT NOT NULL, actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE briefing_batches (
        batch_key TEXT PRIMARY KEY, task_identity TEXT NOT NULL, run_id TEXT,
        digest_series_ref TEXT, digest_version INTEGER,
        item_count INTEGER NOT NULL DEFAULT 0, received_at INTEGER NOT NULL
      );
      CREATE INDEX idx_review_candidates_source ON review_candidates(source, created_at DESC);
      CREATE INDEX idx_candidate_revisions_candidate ON candidate_revisions(candidate_id, ingested_at DESC);
      CREATE INDEX idx_candidate_revisions_batch ON candidate_revisions(batch_key);
      CREATE INDEX idx_candidate_occurrences_revision ON candidate_occurrences(revision_id, seen_at DESC);
      CREATE INDEX idx_candidate_occurrences_batch ON candidate_occurrences(batch_key);
      CREATE INDEX idx_decision_events_revision ON decision_events(revision_id, created_at);
      CREATE INDEX idx_decision_events_candidate ON decision_events(candidate_id, created_at);
      CREATE INDEX idx_candidate_comments_candidate ON candidate_comments(candidate_id, created_at);
      CREATE INDEX idx_briefing_batches_task ON briefing_batches(task_identity, digest_version);
      CREATE TABLE agent_dispatch_events (
        id TEXT PRIMARY KEY,
        subject_kind TEXT NOT NULL CHECK(subject_kind IN ('finding','issue')),
        candidate_id TEXT REFERENCES review_candidates(id) ON DELETE CASCADE,
        revision_id TEXT REFERENCES candidate_revisions(id) ON DELETE CASCADE,
        comment_id TEXT REFERENCES candidate_comments(id) ON DELETE SET NULL,
        issue_id TEXT, actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
        provider TEXT NOT NULL DEFAULT 'claude', instruction TEXT NOT NULL, cwd TEXT NOT NULL,
        prompt_path TEXT, prompt_sha256 TEXT,
        status TEXT NOT NULL CHECK(status IN ('dispatching','dispatched','failed')),
        session_handle TEXT, session_id TEXT, attach_command TEXT, error TEXT,
        created_at INTEGER NOT NULL, settled_at INTEGER
      );
      CREATE INDEX idx_agent_dispatch_events_candidate ON agent_dispatch_events(candidate_id, created_at DESC);
      CREATE INDEX idx_agent_dispatch_events_issue ON agent_dispatch_events(issue_id, created_at DESC);
      CREATE INDEX idx_agent_dispatch_events_comment ON agent_dispatch_events(comment_id);
      UPDATE meta SET value = '125' WHERE key = 'schema_version';
    `);
  } finally {
    target.pragma("foreign_keys = ON");
  }
}

function seedPopulatedV125(target: Db): { actorId: string } {
  const actorId = createUser(
    target,
    { slug: "v126-reviewer", kind: "human", display_name: "V126 Reviewer" },
    10,
  ).id;
  addGrant(target, {
    subject_type: "user", subject: actorId, resource_type: "global", permission: "backup",
  }, 11);
  addGrant(target, {
    subject_type: "user", subject: actorId, resource_type: "global", permission: "ask.create",
  }, 12);
  target.exec(`
    INSERT INTO briefing_batches VALUES
      ('batch-multi', 'agent-schedule/daily', 'run-1', 'series-1', 1, 2, 100),
      ('batch-current', 'agent-schedule/daily', 'run-3', 'series-1', 3, 1, 300),
      ('batch-stale', 'agent-schedule/daily', 'run-2', 'series-1', 2, 1, 400),
      ('batch-repeat', 'agent-schedule/daily', 'run-4', 'series-1', 4, 1, 500);
    INSERT INTO review_candidates VALUES
      ('candidate-a', 'source-a', 'key-a', NULL, 90),
      ('candidate-b', 'source-b', 'key-b', NULL, 91);
    INSERT INTO candidate_revisions VALUES
      ('revision-a1', 'candidate-a', 'A v1', 'why a1', '["ref-a1"]', 'source-a1',
       'hash-a1', 'snapshot-item', '2026-08-14T00:00:00Z', 'run-1', 'series-1', 1, 1,
       'batch-multi', 101),
      ('revision-a2', 'candidate-a', 'A v3', 'why a2', '["ref-a2"]', 'source-a2',
       'hash-a2', 'finding-only', '2026-08-14T00:03:00Z', 'run-3', 'series-1', 3, 2,
       'batch-current', 301),
      ('revision-a-stale', 'candidate-a', 'A stale', 'why stale', '["ref-stale"]', 'source-stale',
       'hash-stale', 'snapshot-item', '2026-08-14T00:02:00Z', 'run-2', 'series-1', 2, 3,
       'batch-stale', 401),
      ('revision-b1', 'candidate-b', 'B v1', 'why b1', '["ref-b1"]', 'source-b1',
       'hash-b1', 'snapshot-item', NULL, 'run-1', 'series-1', 1, 1,
       'batch-multi', 102);
    UPDATE review_candidates SET current_revision_id = 'revision-a2' WHERE id = 'candidate-a';
    UPDATE review_candidates SET current_revision_id = 'revision-b1' WHERE id = 'candidate-b';
    INSERT INTO candidate_occurrences VALUES
      ('occurrence-a1', 'revision-a1', 1, 'batch-multi', 110),
      ('occurrence-b1', 'revision-b1', 1, 'batch-multi', 111),
      ('occurrence-a2', 'revision-a2', 3, 'batch-current', 310),
      ('occurrence-stale', 'revision-a-stale', 2, 'batch-stale', 410),
      ('occurrence-repeat', 'revision-a1', 4, 'batch-repeat', 510);
    INSERT INTO decision_events VALUES
      ('decision-keep', 'candidate-a', 'revision-a1', 'keep', '${actorId}', NULL, 120),
      ('decision-undo', 'candidate-a', 'revision-a1', 'undo', '${actorId}', NULL, 121),
      ('decision-dismiss', 'candidate-a', 'revision-a2', 'dismiss', '${actorId}', NULL, 320),
      ('decision-expire', 'candidate-b', 'revision-b1', 'expire', NULL, NULL, 600);
    INSERT INTO candidate_comments VALUES
      ('comment-a1', 'candidate-a', 'revision-a1', 'Pinned to first revision', '${actorId}', 122),
      ('comment-a2', 'candidate-a', 'revision-a2', 'Dispatch instruction', '${actorId}', 321);
    INSERT INTO spaces (id, title, created_at, updated_at) VALUES
      ('space-v126', 'Migration refs', 1, 1),
      ('space-v126-pinned', 'Migration pinned ref', 1, 1);
    INSERT INTO space_items
      (id, space_id, ref_type, ref_id, metadata_json, created_at, updated_at)
      VALUES
      ('space-latest', 'space-v126', 'finding', 'candidate-a',
       '{"revision_mode":"latest"}', 2, 2),
      ('space-pinned', 'space-v126-pinned', 'finding', 'candidate-a',
       '{"revision_mode":"pinned","pinned_revision_id":"revision-a1"}', 3, 3);
    INSERT INTO agent_dispatch_events (
      id, subject_kind, candidate_id, revision_id, comment_id, actor_user_id,
      instruction, cwd, status, created_at
    ) VALUES (
      'dispatch-a2', 'finding', 'candidate-a', 'revision-a2', 'comment-a2', '${actorId}',
      'Investigate', '/tmp', 'dispatched', 330
    );
  `);
  return { actorId };
}

describe.sequential("migration v126: recurring feedback cutover", () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db);
    restoreV125BriefingSchema(db);
  });

  afterEach(() => db.close());

  it("copies populated v125 data, rebuilds dependents, drops v120, and matches baseline", () => {
    const { actorId } = seedPopulatedV125(db);
    const grantsBefore = rows(db, "permission_grants");
    migrate(db);

    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get())
      .toEqual({ value: "128" });
    expect(definitions(db, [...LEGACY_TABLES, ...LEGACY_INDEXES])).toEqual([]);
    expect(definitions(db, [...FEEDBACK_TABLES, ...FEEDBACK_INDEXES]).map((row) => row.name).sort())
      .toEqual([...FEEDBACK_TABLES, ...FEEDBACK_INDEXES].sort());
    expect(rows(db, "permission_grants")).toEqual(grantsBefore);

    expect(db.prepare(
      "SELECT source, kind, interaction_mode FROM feedback_collections ORDER BY source",
    ).all()).toEqual([
      { source: "source-a", kind: "recurring_feed", interaction_mode: "immediate_per_item" },
      { source: "source-b", kind: "recurring_feed", interaction_mode: "immediate_per_item" },
    ]);
    expect(summarizeBatch(db, "batch-multi")).toEqual({
      accepted: 2, created: 2, revised: 0, unchanged: 0,
    });
    expect(listBriefingSourceHealth(db, 700).map((source) => ({
      source: source.source,
      last_batch_item_count: source.last_batch_item_count,
    }))).toEqual([
      { source: "source-a", last_batch_item_count: 1 },
      { source: "source-b", last_batch_item_count: 2 },
    ]);
    expect(db.prepare(
      "SELECT id, current_revision_id FROM feedback_items ORDER BY id",
    ).all()).toEqual([
      { id: "candidate-a", current_revision_id: "revision-a2" },
      { id: "candidate-b", current_revision_id: "revision-b1" },
    ]);
    expect(db.prepare(
      "SELECT id, item_id, ordinal FROM feedback_item_revisions ORDER BY item_id, ordinal",
    ).all()).toEqual([
      { id: "revision-a1", item_id: "candidate-a", ordinal: 1 },
      { id: "revision-a2", item_id: "candidate-a", ordinal: 2 },
      { id: "revision-a-stale", item_id: "candidate-a", ordinal: 3 },
      { id: "revision-b1", item_id: "candidate-b", ordinal: 1 },
    ]);
    expect(db.prepare(
      "SELECT id FROM feedback_publication_items ORDER BY id",
    ).all()).toEqual([
      { id: "occurrence-a1" }, { id: "occurrence-a2" }, { id: "occurrence-b1" },
      { id: "occurrence-repeat" }, { id: "occurrence-stale" },
    ]);
    expect(db.prepare(
      `SELECT id, operation, value_json, retracts_event_id, actor_user_id
         FROM feedback_response_events ORDER BY created_at`,
    ).all()).toEqual([
      { id: "decision-keep", operation: "set", value_json: '{"verdict":"keep"}',
        retracts_event_id: null, actor_user_id: actorId },
      { id: "decision-undo", operation: "retract", value_json: null,
        retracts_event_id: "decision-keep", actor_user_id: actorId },
      { id: "decision-dismiss", operation: "set", value_json: '{"verdict":"dismiss"}',
        retracts_event_id: null, actor_user_id: actorId },
    ]);
    expect(db.prepare(
      "SELECT id, item_revision_id, operation, actor_user_id FROM feedback_item_events",
    ).get()).toEqual({
      id: "decision-expire", item_revision_id: "revision-b1", operation: "expired",
      actor_user_id: null,
    });
    expect(db.prepare(
      "SELECT id, item_revision_id FROM feedback_comments ORDER BY id",
    ).all()).toEqual([
      { id: "comment-a1", item_revision_id: "revision-a1" },
      { id: "comment-a2", item_revision_id: "revision-a2" },
    ]);
    for (const table of [
      "feedback_ask_sessions", "feedback_item_options", "feedback_submissions",
      "feedback_submission_answers",
    ]) {
      expect(rows(db, table)).toEqual([]);
    }

    expect(resolveFindingReference(db, "candidate-a", { revision_mode: "latest" }))
      .toMatchObject({ effective_revision: { id: "revision-a2" }, review_state: "dismissed" });
    expect(resolveFindingReference(db, "candidate-a", {
      revision_mode: "pinned", pinned_revision_id: "revision-a1",
    })).toMatchObject({ effective_revision: { id: "revision-a1" }, revision_state: "pinned_superseded" });
    expect(db.prepare(
      "SELECT candidate_id, revision_id, comment_id FROM agent_dispatch_events",
    ).get()).toEqual({
      candidate_id: "candidate-a", revision_id: "revision-a2", comment_id: "comment-a2",
    });

    const fresh = new Database(":memory:");
    migrate(fresh);
    const compared = [...FEEDBACK_TABLES, ...FEEDBACK_INDEXES, "agent_dispatch_events", ...DISPATCH_INDEXES];
    expect(definitions(db, compared)).toEqual(definitions(fresh, compared));
    fresh.close();

    const restored = new Database(":memory:");
    restored.exec(buildMetadataBackupSql(db));
    expect(rows(restored, "feedback_items")).toEqual(rows(db, "feedback_items"));
    expect(rows(restored, "feedback_response_events")).toEqual(rows(db, "feedback_response_events"));
    expect(rows(restored, "agent_dispatch_events")).toEqual(rows(db, "agent_dispatch_events"));
    expect(definitions(restored, [...FEEDBACK_INDEXES, ...DISPATCH_INDEXES]))
      .toEqual(definitions(db, [...FEEDBACK_INDEXES, ...DISPATCH_INDEXES]));
    expect(restored.pragma("foreign_key_check")).toEqual([]);
    expect(restored.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    restored.close();

    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
  });

  it("is a row- and schema-no-op when only an already-v126 marker is rewound", () => {
    seedPopulatedV125(db);
    migrate(db);
    const tableSnapshots = new Map(FEEDBACK_TABLES.map((table) => [table, rows(db, table)]));
    const dispatchBefore = rows(db, "agent_dispatch_events");
    const definitionsBefore = definitions(db, [...FEEDBACK_TABLES, ...FEEDBACK_INDEXES, ...DISPATCH_INDEXES]);

    db.prepare("UPDATE meta SET value = '125' WHERE key = 'schema_version'").run();
    migrate(db);

    for (const table of FEEDBACK_TABLES) expect(rows(db, table)).toEqual(tableSnapshots.get(table));
    expect(rows(db, "agent_dispatch_events")).toEqual(dispatchBefore);
    expect(definitions(db, [...FEEDBACK_TABLES, ...FEEDBACK_INDEXES, ...DISPATCH_INDEXES]))
      .toEqual(definitionsBefore);
    expect(definitions(db, [...LEGACY_TABLES, ...LEGACY_INDEXES])).toEqual([]);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get())
      .toEqual({ value: "128" });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
  });

  it("tolerates an unrelated pre-existing foreign key violation", () => {
    seedPopulatedV125(db);
    withForeignKeysDisabled(db, () => {
      db.prepare(
        `INSERT INTO console_session_usage (id, console_session_id, recorded_at)
         VALUES ('orphan-usage', 'missing-console-session', 1)`,
      ).run();
    });
    const unrelatedViolation = foreignKeyViolations(db, "console_session_usage");
    expect(unrelatedViolation).toHaveLength(1);

    migrate(db);

    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get())
      .toEqual({ value: "128" });
    expect(definitions(db, [...LEGACY_TABLES, ...LEGACY_INDEXES])).toEqual([]);
    expect(db.prepare("SELECT id FROM feedback_items ORDER BY id").all()).toEqual([
      { id: "candidate-a" }, { id: "candidate-b" },
    ]);
    expect(db.prepare("SELECT id FROM agent_dispatch_events").all())
      .toEqual([{ id: "dispatch-a2" }]);
    for (const table of V126_FK_CHECK_TABLES) {
      if (tableExists(db, table)) expect(foreignKeyViolations(db, table)).toEqual([]);
    }
    expect(foreignKeyViolations(db, "console_session_usage")).toEqual(unrelatedViolation);
    expect(db.prepare(
      "SELECT id, console_session_id FROM console_session_usage WHERE id = 'orphan-usage'",
    ).get()).toEqual({ id: "orphan-usage", console_session_id: "missing-console-session" });
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
  });

  it("fails before cutover on a cutover-scoped foreign key violation", () => {
    seedPopulatedV125(db);
    withForeignKeysDisabled(db, () => {
      db.prepare(
        `INSERT INTO candidate_occurrences
           (id, revision_id, digest_version, batch_key, seen_at)
         VALUES ('orphan-occurrence', 'missing-revision', 1, 'batch-multi', 1)`,
      ).run();
    });
    expect(foreignKeyViolations(db, "candidate_occurrences")).toHaveLength(1);
    const dispatchBefore = rows(db, "agent_dispatch_events");
    const dispatchDefinitionBefore = definitions(db, ["agent_dispatch_events", ...DISPATCH_INDEXES]);

    expect(() => migrate(db)).toThrow(
      "migration 126 preflight: 1 cutover-scoped foreign key violation(s) in candidate_occurrences",
    );

    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get())
      .toEqual({ value: "125" });
    expect(definitions(db, [...LEGACY_TABLES, ...LEGACY_INDEXES]).map((entry) => entry.name).sort())
      .toEqual([...LEGACY_TABLES, ...LEGACY_INDEXES].sort());
    for (const table of FEEDBACK_TABLES) expect(rows(db, table)).toEqual([]);
    expect(rows(db, "agent_dispatch_events")).toEqual(dispatchBefore);
    expect(definitions(db, ["agent_dispatch_events", ...DISPATCH_INDEXES]))
      .toEqual(dispatchDefinitionBefore);
    expect(foreignKeyViolations(db, "candidate_occurrences")).toHaveLength(1);
  });

  it("fails before cutover when strict attribution cannot be preserved", () => {
    const actorId = createUser(
      db, { slug: "invalid-v126", kind: "human", display_name: "Invalid V126" }, 1,
    ).id;
    db.exec(`
      INSERT INTO briefing_batches VALUES ('batch-1', 'task', NULL, NULL, 1, 1, 1);
      INSERT INTO review_candidates VALUES ('candidate-1', 'source', 'key', NULL, 1);
      INSERT INTO candidate_revisions VALUES (
        'revision-1', 'candidate-1', 'Title', NULL, '[]', NULL, 'hash',
        'snapshot-item', NULL, NULL, NULL, 1, NULL, 'batch-1', 1
      );
      UPDATE review_candidates SET current_revision_id = 'revision-1' WHERE id = 'candidate-1';
      INSERT INTO candidate_occurrences VALUES ('occurrence-1', 'revision-1', 1, 'batch-1', 1);
      INSERT INTO decision_events VALUES (
        'decision-1', 'candidate-1', 'revision-1', 'keep', NULL, NULL, 2
      );
      INSERT INTO candidate_comments VALUES (
        'comment-1', 'candidate-1', 'revision-1', 'valid', '${actorId}', 3
      );
    `);
    expect(() => migrate(db)).toThrow(/human decision actor is missing/);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get())
      .toEqual({ value: "125" });
    expect(definitions(db, LEGACY_TABLES)).toHaveLength(LEGACY_TABLES.length);
    for (const table of FEEDBACK_TABLES) expect(rows(db, table)).toEqual([]);
  });
});
