import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Issue ce22a3a (umbrella 99b74d6): briefing candidate store — schema,
// idempotent batch ingestion, derived review state, and the expiry sweep.

import {
  addBriefingComment,
  BriefingValidationError,
  countPendingBriefingCandidates,
  getBriefingCandidateHistory,
  ingestBriefingBatch,
  listBriefingQueue,
  parseBriefingIngestRequest,
  publisherMayIngest,
  recordBriefingDecision,
  sweepExpiredBriefingCandidates,
} from "../src/briefing.js";
import { BRIEFING_INGEST_SCHEMA, type BriefingIngestRequest } from "../src/contracts.js";
import { CURRENT_SCHEMA_VERSION, migrate, setDb, type Db } from "../src/db.js";
import { readDashboardBadgeCounts } from "../src/routes/dashboard.js";
import { createUser } from "../src/users/store.js";

let db: Db;
let reviewerId: string;

const EMPTY_AUTH_QUEUE = { listActive: () => [] } as never;

function candidateKey(source: string, ref: string): string {
  return createHash("sha256").update(`${source}\u0000${ref}`).digest("hex");
}

function batch(
  overrides: Partial<BriefingIngestRequest> & { items?: BriefingIngestRequest["items"] } = {},
): BriefingIngestRequest {
  const version = overrides.digest?.version ?? 1;
  return {
    schema: BRIEFING_INGEST_SCHEMA,
    task_identity: overrides.task_identity ?? "agent-schedule/daily-digest",
    run_id: overrides.run_id ?? `run-${version}`,
    digest: overrides.digest ?? { series_ref: "artifact-series:abc123", version },
    batch_key: overrides.batch_key ?? `batch-${version}`,
    items: overrides.items ?? [item()],
  };
}

function item(
  overrides: Partial<BriefingIngestRequest["items"][number]> = {},
): BriefingIngestRequest["items"][number] {
  const source = overrides.source ?? "arxiv-scan";
  const ref = overrides.ref ?? "paper-1";
  return {
    candidate_key: overrides.candidate_key ?? candidateKey(source, ref),
    source,
    ref,
    title: overrides.title ?? "A notable finding",
    why_notable: overrides.why_notable ?? "It moves the pilot forward",
    refs: overrides.refs ?? ["https://example.invalid/paper-1"],
    evidence_hash: overrides.evidence_hash ?? "evidence-a",
    evidence_kind: overrides.evidence_kind ?? "snapshot-item",
    captured_at: overrides.captured_at ?? "2026-08-11T09:00:00Z",
    rank: overrides.rank ?? 1,
  };
}

function candidateIdFor(source: string, ref: string): string {
  const row = db
    .prepare("SELECT id FROM review_candidates WHERE source = ? AND candidate_key = ?")
    .get(source, candidateKey(source, ref)) as { id: string };
  return row.id;
}

function currentRevisionId(candidateId: string): string | null {
  return (db
    .prepare("SELECT current_revision_id AS id FROM review_candidates WHERE id = ?")
    .get(candidateId) as { id: string | null }).id;
}

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  setDb(db);
  reviewerId = createUser(db, { slug: "operator", kind: "human", display_name: "Operator" }).id;
});

afterEach(() => {
  db.close();
});

describe("briefing schema", () => {
  it("applies the briefing migrations cleanly from the current head", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(121);
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table'
            AND name IN ('review_candidates','candidate_revisions','candidate_occurrences',
                         'decision_events','candidate_comments','briefing_batches')
          ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual([
      "briefing_batches",
      "candidate_comments",
      "candidate_occurrences",
      "candidate_revisions",
      "decision_events",
      "review_candidates",
    ]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
  });

  it("admits a finding ref in space_items after the v121 rebuild", () => {
    // Contract §6/§7 amendment: a Space may reference a briefing candidate, so
    // the ref_type CHECK must accept 'finding' while still rejecting an
    // unregistered type. The migrated-vs-fresh equality of this DDL is covered
    // by test/db-schema-baseline.test.ts.
    db.prepare(
      `INSERT INTO spaces (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    ).run("space-1", "Briefing", 1_000, 1_000);
    ingestBriefingBatch(db, batch(), 1_000);
    const candidateId = candidateIdFor("arxiv-scan", "paper-1");

    expect(() => db.prepare(
      `INSERT INTO space_items (id, space_id, ref_type, ref_id, created_at, updated_at)
       VALUES (?, 'space-1', 'finding', ?, 1000, 1000)`,
    ).run("item-1", candidateId)).not.toThrow();
    expect(() => db.prepare(
      `INSERT INTO space_items (id, space_id, ref_type, ref_id, created_at, updated_at)
       VALUES (?, 'space-1', 'not-a-ref-type', ?, 1000, 1000)`,
    ).run("item-2", candidateId)).toThrow(/CHECK constraint/);
  });

  it("rebuilds a live space_items table whose CHECK predates finding refs", () => {
    // A database that already reached head before this wave keeps the old
    // CHECK, so the v121 post-migration must rebuild it in place — preserving
    // existing rows — the next time the daemon opens the database.
    db.prepare(
      `INSERT INTO spaces (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    ).run("space-1", "Briefing", 1_000, 1_000);
    db.exec("DROP TABLE space_items");
    db.exec(
      `CREATE TABLE space_items (
        id            TEXT NOT NULL,
        space_id      TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
        ref_type      TEXT NOT NULL
                        CHECK(ref_type IN ('issue','comment','artifact','external_ref','space')),
        ref_id        TEXT NOT NULL CHECK(ref_id != ''),
        ref_uri       TEXT,
        title         TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
                        CHECK(json_valid(metadata_json) AND json_type(metadata_json)='object'),
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        PRIMARY KEY (id),
        UNIQUE (space_id, id),
        UNIQUE (space_id, ref_type, ref_id),
        CHECK (ref_type != 'external_ref' OR ref_uri IS NOT NULL)
      )`,
    );
    db.prepare(
      `INSERT INTO space_items (id, space_id, ref_type, ref_id, created_at, updated_at)
       VALUES ('legacy-item', 'space-1', 'issue', 'issue-1', 1000, 1000)`,
    ).run();
    db.prepare("DELETE FROM meta WHERE key = ?")
      .run("post_migration.v121_space_items_finding_refs.complete");

    migrate(db);

    expect(() => db.prepare(
      `INSERT INTO space_items (id, space_id, ref_type, ref_id, created_at, updated_at)
       VALUES ('finding-item', 'space-1', 'finding', 'candidate-1', 1000, 1000)`,
    ).run()).not.toThrow();
    expect(
      db.prepare("SELECT ref_type, ref_id FROM space_items WHERE id = 'legacy-item'").get(),
    ).toEqual({ ref_type: "issue", ref_id: "issue-1" });
    expect(
      db.prepare("SELECT value FROM meta WHERE key = ?")
        .get("post_migration.v121_space_items_finding_refs.complete"),
    ).toEqual({ value: "done" });
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
  });

  it("rejects an unsupported ingest schema and malformed items", () => {
    expect(() => parseBriefingIngestRequest({ ...batch(), schema: "briefing-ingest@2" }))
      .toThrow(BriefingValidationError);
    expect(() => parseBriefingIngestRequest({
      ...batch(),
      items: [{ ...item(), evidence_kind: "guessed" }],
    })).toThrow(/evidence_kind/);
    // A well-formed body round-trips through validation unchanged.
    expect(parseBriefingIngestRequest(JSON.parse(JSON.stringify(batch())))).toMatchObject({
      task_identity: "agent-schedule/daily-digest",
      batch_key: "batch-1",
    });
  });
});

describe("briefing ingestion", () => {
  it("creates a candidate, revision, and occurrence for an unknown finding", () => {
    const result = ingestBriefingBatch(db, batch(), 1_000);
    expect(result).toEqual({ accepted: 1, created: 1, revised: 0, unchanged: 0 });

    const candidateId = candidateIdFor("arxiv-scan", "paper-1");
    const revision = db
      .prepare("SELECT * FROM candidate_revisions WHERE candidate_id = ?")
      .get(candidateId) as Record<string, unknown>;
    expect(revision).toMatchObject({
      title: "A notable finding",
      source_ref: "paper-1",
      evidence_hash: "evidence-a",
      evidence_kind: "snapshot-item",
      digest_version: 1,
      rank: 1,
      batch_key: "batch-1",
    });
    expect(currentRevisionId(candidateId)).toBe(revision.id);
    expect(countPendingBriefingCandidates(db)).toBe(1);
  });

  it("replays a known batch_key without writing anything and returns the original result", () => {
    const first = ingestBriefingBatch(db, batch({ items: [item(), item({ ref: "paper-2" })] }), 1_000);
    expect(first).toEqual({ accepted: 2, created: 2, revised: 0, unchanged: 0 });

    const counts = () => ({
      candidates: (db.prepare("SELECT COUNT(*) AS n FROM review_candidates").get() as { n: number }).n,
      revisions: (db.prepare("SELECT COUNT(*) AS n FROM candidate_revisions").get() as { n: number }).n,
      occurrences: (db.prepare("SELECT COUNT(*) AS n FROM candidate_occurrences").get() as { n: number }).n,
      batches: (db.prepare("SELECT COUNT(*) AS n FROM briefing_batches").get() as { n: number }).n,
    });
    const before = counts();

    const replay = ingestBriefingBatch(
      db,
      batch({ items: [item(), item({ ref: "paper-2" })] }),
      9_000,
    );
    expect(replay).toEqual(first);
    expect(counts()).toEqual(before);
  });

  it("records only an occurrence for a re-ingested (candidate_key, evidence_hash) pair", () => {
    ingestBriefingBatch(db, batch(), 1_000);
    const candidateId = candidateIdFor("arxiv-scan", "paper-1");
    const revisionId = currentRevisionId(candidateId);

    recordBriefingDecision(db, {
      candidateId,
      action: "keep",
      actorUserId: reviewerId,
      now: 1_500,
    });
    expect(countPendingBriefingCandidates(db)).toBe(0);

    const second = ingestBriefingBatch(
      db,
      batch({ digest: { series_ref: "artifact-series:abc123", version: 2 }, batch_key: "batch-2" }),
      2_000,
    );
    expect(second).toEqual({ accepted: 1, created: 0, revised: 0, unchanged: 1 });

    // No new revision, no move, and — the point of the rule — no re-pend.
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM candidate_revisions").get() as { n: number }).n,
    ).toBe(1);
    expect(currentRevisionId(candidateId)).toBe(revisionId);
    expect(countPendingBriefingCandidates(db)).toBe(0);
    expect(
      (db
        .prepare("SELECT COUNT(*) AS n FROM candidate_occurrences WHERE revision_id = ?")
        .get(revisionId) as { n: number }).n,
    ).toBe(2);
  });

  it("re-pends exactly once when the evidence changes and moves current_revision_id", () => {
    ingestBriefingBatch(db, batch(), 1_000);
    const candidateId = candidateIdFor("arxiv-scan", "paper-1");
    const firstRevision = currentRevisionId(candidateId);
    recordBriefingDecision(db, {
      candidateId,
      action: "dismiss",
      actorUserId: reviewerId,
      now: 1_500,
    });
    expect(countPendingBriefingCandidates(db)).toBe(0);

    const revised = ingestBriefingBatch(
      db,
      batch({
        digest: { series_ref: "artifact-series:abc123", version: 2 },
        batch_key: "batch-2",
        items: [item({ evidence_hash: "evidence-b" })],
      }),
      2_000,
    );
    expect(revised).toEqual({ accepted: 1, created: 0, revised: 1, unchanged: 0 });

    const secondRevision = currentRevisionId(candidateId);
    expect(secondRevision).not.toBe(firstRevision);
    expect(countPendingBriefingCandidates(db)).toBe(1);

    // Seeing the SAME new evidence again is an occurrence only: the candidate
    // is already pending on that revision and must not re-pend a second time.
    const again = ingestBriefingBatch(
      db,
      batch({
        digest: { series_ref: "artifact-series:abc123", version: 3 },
        batch_key: "batch-3",
        items: [item({ evidence_hash: "evidence-b" })],
      }),
      3_000,
    );
    expect(again).toEqual({ accepted: 1, created: 0, revised: 0, unchanged: 1 });
    expect(currentRevisionId(candidateId)).toBe(secondRevision);
    expect(countPendingBriefingCandidates(db)).toBe(1);
    expect(
      (db
        .prepare("SELECT COUNT(*) AS n FROM candidate_revisions WHERE candidate_id = ?")
        .get(candidateId) as { n: number }).n,
    ).toBe(2);
  });

  it("accepts a stale digest version without moving current_revision_id backwards", () => {
    ingestBriefingBatch(db, batch(), 1_000);
    ingestBriefingBatch(
      db,
      batch({
        digest: { series_ref: "artifact-series:abc123", version: 5 },
        batch_key: "batch-5",
        items: [item({ evidence_hash: "evidence-b" })],
      }),
      2_000,
    );
    const candidateId = candidateIdFor("arxiv-scan", "paper-1");
    const currentAfterV5 = currentRevisionId(candidateId);

    const late = ingestBriefingBatch(
      db,
      batch({
        digest: { series_ref: "artifact-series:abc123", version: 4 },
        batch_key: "batch-4-late",
        items: [item({ evidence_hash: "evidence-c" })],
      }),
      3_000,
    );
    expect(late).toEqual({ accepted: 1, created: 0, revised: 1, unchanged: 0 });
    // The late revision is recorded as a fact, but the pointer stays put.
    expect(currentRevisionId(candidateId)).toBe(currentAfterV5);
    expect(
      (db
        .prepare("SELECT COUNT(*) AS n FROM candidate_revisions WHERE candidate_id = ?")
        .get(candidateId) as { n: number }).n,
    ).toBe(3);
  });

  it("maps publishers to their permitted source namespace", () => {
    expect(publisherMayIngest(db, "agent-schedule", "agent-schedule/daily-digest")).toBe(true);
    expect(publisherMayIngest(db, "agent-schedule", "other-scheduler/daily-digest")).toBe(false);
    expect(publisherMayIngest(db, "codex", "agent-schedule/daily-digest")).toBe(false);
  });
});

describe("briefing review state", () => {
  it("tracks the badge across keep, undo, and expiry transitions", () => {
    ingestBriefingBatch(db, batch({ items: [item(), item({ ref: "paper-2" })] }), 1_000);
    expect(readDashboardBadgeCounts(EMPTY_AUTH_QUEUE, db).briefing).toBe(2);

    const first = candidateIdFor("arxiv-scan", "paper-1");
    recordBriefingDecision(db, { candidateId: first, action: "keep", actorUserId: reviewerId, now: 1_100 });
    expect(readDashboardBadgeCounts(EMPTY_AUTH_QUEUE, db).briefing).toBe(1);

    const undone = recordBriefingDecision(db, {
      candidateId: first,
      action: "undo",
      actorUserId: reviewerId,
      now: 1_200,
    });
    expect(undone.state).toBe("pending");
    expect(readDashboardBadgeCounts(EMPTY_AUTH_QUEUE, db).briefing).toBe(2);

    recordBriefingDecision(db, { candidateId: first, action: "dismiss", actorUserId: reviewerId, now: 1_300 });
    expect(readDashboardBadgeCounts(EMPTY_AUTH_QUEUE, db).briefing).toBe(1);

    // Expiry retires the remaining pending candidate the same way a human
    // decision would, and the badge follows.
    const swept = sweepExpiredBriefingCandidates(db, { now: 100_000, expiryMs: 10_000 });
    expect(swept.expired).toBe(1);
    expect(readDashboardBadgeCounts(EMPTY_AUTH_QUEUE, db).briefing).toBe(0);
  });

  it("marks an expiry with a NULL actor and presents it as expired_unreviewed", () => {
    ingestBriefingBatch(db, batch(), 1_000);
    const candidateId = candidateIdFor("arxiv-scan", "paper-1");

    const swept = sweepExpiredBriefingCandidates(db, { now: 100_000, expiryMs: 10_000 });
    expect(swept).toMatchObject({ expired: 1, candidate_ids: [candidateId] });

    const event = db
      .prepare("SELECT action, actor_user_id FROM decision_events WHERE candidate_id = ?")
      .get(candidateId) as { action: string; actor_user_id: string | null };
    expect(event).toEqual({ action: "expire", actor_user_id: null });

    const history = getBriefingCandidateHistory(db, candidateId);
    expect(history?.candidate.state).toBe("expired_unreviewed");
    expect(listBriefingQueue(db).candidates).toEqual([]);
    expect(countPendingBriefingCandidates(db)).toBe(0);
  });

  it("leaves decided and freshly-seen candidates untouched during a sweep", () => {
    ingestBriefingBatch(db, batch({ items: [item(), item({ ref: "paper-2" })] }), 1_000);
    const kept = candidateIdFor("arxiv-scan", "paper-1");
    recordBriefingDecision(db, { candidateId: kept, action: "keep", actorUserId: reviewerId, now: 1_100 });

    // A fresh occurrence on the still-pending candidate keeps it alive.
    ingestBriefingBatch(
      db,
      batch({
        digest: { series_ref: "artifact-series:abc123", version: 2 },
        batch_key: "batch-2",
        items: [item({ ref: "paper-2" })],
      }),
      99_000,
    );

    expect(sweepExpiredBriefingCandidates(db, { now: 100_000, expiryMs: 10_000 })).toMatchObject({
      expired: 0,
    });
    expect(countPendingBriefingCandidates(db)).toBe(1);
  });

  it("refuses to undo a candidate that has no effective decision", () => {
    ingestBriefingBatch(db, batch(), 1_000);
    const candidateId = candidateIdFor("arxiv-scan", "paper-1");
    expect(() => recordBriefingDecision(db, {
      candidateId,
      action: "undo",
      actorUserId: reviewerId,
    })).toThrow(/no decision to undo/);
  });

  it("serves the pending queue with provenance, occurrence stats, and source health", () => {
    ingestBriefingBatch(db, batch(), 1_000);
    ingestBriefingBatch(
      db,
      batch({
        digest: { series_ref: "artifact-series:abc123", version: 2 },
        batch_key: "batch-2",
        run_id: "run-2",
      }),
      5_000,
    );

    const queue = listBriefingQueue(db, { now: 6_000 });
    expect(queue.candidates).toHaveLength(1);
    expect(queue.candidates[0]).toMatchObject({
      source: "arxiv-scan",
      state: "pending",
      revision_count: 1,
      occurrences: { count: 2, first_seen_at: 1_000, last_seen_at: 5_000 },
    });
    expect(queue.candidates[0].revision).toMatchObject({
      title: "A notable finding",
      refs: ["https://example.invalid/paper-1"],
      run_id: "run-1",
      digest_series_ref: "artifact-series:abc123",
      digest_version: 1,
      evidence_kind: "snapshot-item",
    });
    expect(queue.sources).toEqual([
      {
        source: "arxiv-scan",
        pending_count: 1,
        candidate_count: 1,
        last_task_identity: "agent-schedule/daily-digest",
        last_run_id: "run-2",
        last_digest_version: 2,
        last_ingested_at: 5_000,
        last_ingest_age_ms: 1_000,
        last_batch_item_count: 1,
      },
    ]);
  });

  it("returns revisions, decisions, and comments in candidate history", () => {
    ingestBriefingBatch(db, batch(), 1_000);
    const candidateId = candidateIdFor("arxiv-scan", "paper-1");
    ingestBriefingBatch(
      db,
      batch({
        digest: { series_ref: "artifact-series:abc123", version: 2 },
        batch_key: "batch-2",
        items: [item({ evidence_hash: "evidence-b", title: "Sharper finding" })],
      }),
      2_000,
    );
    recordBriefingDecision(db, { candidateId, action: "keep", actorUserId: reviewerId, now: 2_500 });
    const comment = addBriefingComment(db, {
      candidateId,
      body: "  worth a follow-up  ",
      actorUserId: reviewerId,
      now: 2_600,
    });

    const history = getBriefingCandidateHistory(db, candidateId);
    expect(history?.candidate.state).toBe("kept");
    expect(history?.revisions.map((revision) => revision.evidence_hash)).toEqual([
      "evidence-a",
      "evidence-b",
    ]);
    expect(history?.decisions).toHaveLength(1);
    expect(history?.decisions[0]).toMatchObject({ action: "keep", actor_user_id: reviewerId });
    expect(history?.comments).toHaveLength(1);
    expect(history?.comments[0]).toMatchObject({
      id: comment.id,
      body: "worth a follow-up",
      actor_user_id: reviewerId,
      revision_id: currentRevisionId(candidateId),
    });
  });
});
