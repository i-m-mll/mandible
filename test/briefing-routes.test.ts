import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Issue ce22a3a (umbrella 99b74d6): briefing HTTP surface — publisher-only
// ingestion inside a mapped source namespace, human-only decisions and
// comments, file-RPC policy, and the read-only instance gate.

import { countPendingBriefingCandidates, ingestBriefingBatch } from "../src/briefing.js";
import { setSetting } from "../src/client-auth/settings-kv.js";
import { BRIEFING_INGEST_SCHEMA, type BriefingIngestRequest } from "../src/contracts.js";
import { migrate, setDb, type Db } from "../src/db.js";
import { resolveInstanceInfo } from "../src/instance-policy.js";
import { registerBriefingRoutes } from "../src/routes/briefing.js";
import { Router, type ClientAuthGate, type ResolvedClientIdentity } from "../src/server.js";
import { createUser, OPERATOR_SETTING_KEY } from "../src/users/store.js";

let db: Db;
let router: Router;
let operatorId: string;
let publisherId: string;

/** Minimal gate: a credential string is a slug that resolves to a live user. */
class SlugGate implements ClientAuthGate {
  constructor(private readonly lookup: () => Db) {}

  authenticate(credential: string | null | undefined): ResolvedClientIdentity | null {
    if (!credential) return null;
    const row = this.lookup()
      .prepare("SELECT id, slug FROM users WHERE slug = ? AND status = 'active'")
      .get(credential) as { id: string; slug: string } | undefined;
    if (!row) return null;
    return {
      user_id: row.id,
      slug: row.slug,
      method: "api_token",
      credential_id: null,
      source: "in_process",
    };
  }

  mode(): "compat" | "strict" {
    return "compat";
  }

  recordUnattributedWrite(): void {
    // No telemetry assertions in this suite.
  }
}

function candidateKey(source: string, ref: string): string {
  return createHash("sha256").update(`${source} ${ref}`).digest("hex");
}

function batch(overrides: Partial<BriefingIngestRequest> = {}): BriefingIngestRequest {
  return {
    schema: BRIEFING_INGEST_SCHEMA,
    task_identity: overrides.task_identity ?? "agent-schedule/daily-digest",
    run_id: overrides.run_id ?? "run-1",
    digest: overrides.digest ?? { series_ref: "artifact-series:abc123", version: 1 },
    batch_key: overrides.batch_key ?? "batch-1",
    items: overrides.items ?? [
      {
        candidate_key: candidateKey("arxiv-scan", "paper-1"),
        source: "arxiv-scan",
        ref: "paper-1",
        title: "A notable finding",
        why_notable: "It moves the pilot forward",
        refs: [],
        evidence_hash: "evidence-a",
        evidence_kind: "snapshot-item",
        captured_at: "2026-08-11T09:00:00Z",
        rank: 1,
      },
    ],
  };
}

function makeRouter(options: { readOnly?: boolean } = {}): Router {
  return new Router({
    clientAuth: new SlugGate(() => db),
    instance: resolveInstanceInfo({
      env: {
        MANDIBLE_OPERATIONAL_MUTATIONS: options.readOnly ? "reject" : "allow",
      } as NodeJS.ProcessEnv,
    }),
  });
}

function onlyCandidateId(): string {
  return (db.prepare("SELECT id FROM review_candidates LIMIT 1").get() as { id: string }).id;
}

function currentRevisionId(candidateId: string): string {
  return (db
    .prepare("SELECT current_revision_id AS id FROM review_candidates WHERE id = ?")
    .get(candidateId) as { id: string }).id;
}

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  setDb(db);
  operatorId = createUser(db, { slug: "operator", kind: "human", display_name: "Operator" }).id;
  setSetting(db, OPERATOR_SETTING_KEY, operatorId);
  publisherId = createUser(db, {
    slug: "agent-schedule",
    kind: "agent",
    display_name: "Agent Schedule",
  }).id;
  router = makeRouter();
  registerBriefingRoutes(router, db);
});

afterEach(() => {
  db.close();
});

describe("briefing ingest route", () => {
  it("accepts a mapped publisher batch and replays it idempotently", async () => {
    const first = await router.invoke({
      method: "POST",
      url: "/api/briefing/ingest",
      body: batch(),
      credential: "agent-schedule",
    });
    expect(first).toEqual({
      status: 200,
      body: { accepted: 1, created: 1, revised: 0, unchanged: 0 },
    });

    const replay = await router.invoke({
      method: "POST",
      url: "/api/briefing/ingest",
      body: batch(),
      credential: "agent-schedule",
    });
    expect(replay).toEqual(first);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM candidate_revisions").get() as { n: number }).n,
    ).toBe(1);
    expect(publisherId).toBeTruthy();
  });

  it("rejects an unauthenticated caller and an unmapped source namespace", async () => {
    const anonymous = await router.invoke({
      method: "POST",
      url: "/api/briefing/ingest",
      body: batch(),
    });
    expect(anonymous.status).toBe(401);

    const foreignNamespace = await router.invoke({
      method: "POST",
      url: "/api/briefing/ingest",
      body: batch({ task_identity: "other-scheduler/daily-digest" }),
      credential: "agent-schedule",
    });
    expect(foreignNamespace.status).toBe(403);
    expect(foreignNamespace.body).toMatchObject({ code: "source_namespace_forbidden" });
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM briefing_batches").get() as { n: number }).n,
    ).toBe(0);
  });

  it("honors an operator-configured publisher mapping", async () => {
    setSetting(db, "briefing.ingest.publishers", JSON.stringify({ codex: ["research/"] }));
    createUser(db, { slug: "codex", kind: "agent", display_name: "Codex" });

    const denied = await router.invoke({
      method: "POST",
      url: "/api/briefing/ingest",
      body: batch(),
      credential: "agent-schedule",
    });
    expect(denied.status).toBe(403);

    const allowed = await router.invoke({
      method: "POST",
      url: "/api/briefing/ingest",
      body: batch({ task_identity: "research/paper-scan", batch_key: "batch-research" }),
      credential: "codex",
    });
    expect(allowed.status).toBe(200);
  });

  it("rejects a malformed batch with 400 and writes nothing", async () => {
    const response = await router.invoke({
      method: "POST",
      url: "/api/briefing/ingest",
      body: { ...batch(), schema: "briefing-ingest@2" },
      credential: "agent-schedule",
    });
    expect(response.status).toBe(400);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM briefing_batches").get() as { n: number }).n,
    ).toBe(0);
  });
});

describe("briefing decision and comment routes", () => {
  beforeEach(() => {
    ingestBriefingBatch(db, batch(), 1_000);
  });

  it("records a human decision and its undo", async () => {
    const candidateId = onlyCandidateId();
    const kept = await router.invoke({
      method: "POST",
      url: `/api/briefing/candidates/${candidateId}/decision`,
      body: { action: "keep" },
      credential: "operator",
    });
    expect(kept.status).toBe(200);
    expect(kept.body).toMatchObject({ candidate_id: candidateId, action: "keep", state: "kept" });
    expect(countPendingBriefingCandidates(db)).toBe(0);
    expect(
      (db.prepare("SELECT actor_user_id AS id FROM decision_events").get() as { id: string }).id,
    ).toBe(operatorId);

    const undone = await router.invoke({
      method: "POST",
      url: `/api/briefing/candidates/${candidateId}/decision`,
      body: { action: "undo" },
      credential: "operator",
    });
    expect(undone.body).toMatchObject({ state: "pending" });
    expect(countPendingBriefingCandidates(db)).toBe(1);
  });

  it("appends the decision to the revision the request names", async () => {
    const candidateId = onlyCandidateId();
    const revisionA = currentRevisionId(candidateId);

    const kept = await router.invoke({
      method: "POST",
      url: `/api/briefing/candidates/${candidateId}/decision`,
      body: { action: "keep", revision_id: revisionA },
      credential: "operator",
    });
    expect(kept.status).toBe(200);
    expect(kept.body).toMatchObject({ revision_id: revisionA, state: "kept" });

    // Re-ingest: the candidate moves to a new revision and is pending again.
    ingestBriefingBatch(db, batch({
      digest: { series_ref: "artifact-series:abc123", version: 2 },
      batch_key: "batch-2",
      items: [{
        candidate_key: candidateKey("arxiv-scan", "paper-1"),
        source: "arxiv-scan",
        ref: "paper-1",
        title: "The revised finding",
        why_notable: "It changed",
        refs: [],
        evidence_hash: "evidence-b",
        evidence_kind: "snapshot-item",
        captured_at: "2026-08-12T09:00:00Z",
        rank: 1,
      }],
    }), 2_000);
    const revisionB = currentRevisionId(candidateId);
    expect(revisionB).not.toBe(revisionA);

    await router.invoke({
      method: "POST",
      url: `/api/briefing/candidates/${candidateId}/decision`,
      body: { action: "dismiss", revision_id: revisionB },
      credential: "operator",
    });
    expect(countPendingBriefingCandidates(db)).toBe(0);

    // Undo of the OLDER row. Without revision addressing this cleared the
    // dismissal on revision B and put the candidate back in the queue.
    const undone = await router.invoke({
      method: "POST",
      url: `/api/briefing/candidates/${candidateId}/decision`,
      body: { action: "undo", revision_id: revisionA },
      credential: "operator",
    });
    expect(undone.status).toBe(200);
    expect(undone.body).toMatchObject({ revision_id: revisionA, state: "dismissed" });
    expect(countPendingBriefingCandidates(db)).toBe(0);

    // The same undo again is a conflict the client can see.
    const again = await router.invoke({
      method: "POST",
      url: `/api/briefing/candidates/${candidateId}/decision`,
      body: { action: "undo", revision_id: revisionA },
      credential: "operator",
    });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: "no decision to undo" });
  });

  it("rejects a malformed or foreign revision_id", async () => {
    const candidateId = onlyCandidateId();
    const blank = await router.invoke({
      method: "POST",
      url: `/api/briefing/candidates/${candidateId}/decision`,
      body: { action: "keep", revision_id: "  " },
      credential: "operator",
    });
    expect(blank.status).toBe(400);

    const wrongType = await router.invoke({
      method: "POST",
      url: `/api/briefing/candidates/${candidateId}/decision`,
      body: { action: "keep", revision_id: 7 },
      credential: "operator",
    });
    expect(wrongType.status).toBe(400);

    const unknown = await router.invoke({
      method: "POST",
      url: `/api/briefing/candidates/${candidateId}/decision`,
      body: { action: "keep", revision_id: "rev-does-not-exist" },
      credential: "operator",
    });
    expect(unknown.status).toBe(404);

    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM decision_events").get() as { n: number }).n,
    ).toBe(0);
  });

  it("rejects a malformed expected_event_id and a stale one", async () => {
    const candidateId = onlyCandidateId();
    const revisionId = currentRevisionId(candidateId);

    for (const expected_event_id of ["  ", 7]) {
      const bad = await router.invoke({
        method: "POST",
        url: `/api/briefing/candidates/${candidateId}/decision`,
        body: { action: "keep", revision_id: revisionId, expected_event_id },
        credential: "operator",
      });
      expect(bad.status).toBe(400);
    }
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM decision_events").get() as { n: number }).n,
    ).toBe(0);

    const kept = await router.invoke({
      method: "POST",
      url: `/api/briefing/candidates/${candidateId}/decision`,
      body: { action: "keep", revision_id: revisionId },
      credential: "operator",
    });
    const keptEventId = (kept.body as { event_id: string }).event_id;

    // Somebody else decides the SAME revision. The undo the first reviewer holds
    // now names a judgment that is no longer effective.
    await router.invoke({
      method: "POST",
      url: `/api/briefing/candidates/${candidateId}/decision`,
      body: { action: "dismiss", revision_id: revisionId },
      credential: "operator",
    });

    const stale = await router.invoke({
      method: "POST",
      url: `/api/briefing/candidates/${candidateId}/decision`,
      body: { action: "undo", revision_id: revisionId, expected_event_id: keptEventId },
      credential: "operator",
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: "decision changed since it was read" });
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM decision_events").get() as { n: number }).n,
    ).toBe(2);
    expect(countPendingBriefingCandidates(db)).toBe(0);
  });

  it("rejects publisher and agent credentials on decisions and comments", async () => {
    const candidateId = onlyCandidateId();
    for (const url of [
      `/api/briefing/candidates/${candidateId}/decision`,
      `/api/briefing/candidates/${candidateId}/comments`,
    ]) {
      const response = await router.invoke({
        method: "POST",
        url,
        body: { action: "keep", body: "agents may not review" },
        credential: "agent-schedule",
      });
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: "human_reviewer_required" });
    }
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM decision_events").get() as { n: number }).n,
    ).toBe(0);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM candidate_comments").get() as { n: number }).n,
    ).toBe(0);
    expect(countPendingBriefingCandidates(db)).toBe(1);
  });

  it("rejects an unauthenticated reviewer", async () => {
    const candidateId = onlyCandidateId();
    const response = await router.invoke({
      method: "POST",
      url: `/api/briefing/candidates/${candidateId}/decision`,
      body: { action: "keep" },
    });
    expect(response.status).toBe(401);
  });

  it("rejects an invalid action and an unknown candidate", async () => {
    const candidateId = onlyCandidateId();
    const badAction = await router.invoke({
      method: "POST",
      url: `/api/briefing/candidates/${candidateId}/decision`,
      body: { action: "expire" },
      credential: "operator",
    });
    expect(badAction.status).toBe(400);

    const missing = await router.invoke({
      method: "POST",
      url: "/api/briefing/candidates/does-not-exist/decision",
      body: { action: "keep" },
      credential: "operator",
    });
    expect(missing.status).toBe(404);
  });

  it("stores a human comment against the current revision", async () => {
    const candidateId = onlyCandidateId();
    const response = await router.invoke({
      method: "POST",
      url: `/api/briefing/candidates/${candidateId}/comments`,
      body: { body: "follow up next week" },
      credential: "operator",
    });
    expect(response.status).toBe(200);
    const comment = (response.body as { comment: Record<string, unknown> }).comment;
    expect(comment).toMatchObject({
      candidate_id: candidateId,
      body: "follow up next week",
      actor_user_id: operatorId,
    });
    expect(typeof comment.id).toBe("string");
  });

  // Issue f8f8d76: the route accepts the revision the client displayed and
  // validates it exactly like the decision route.
  it("pins a comment to a caller-supplied revision and validates it", async () => {
    const candidateId = onlyCandidateId();
    const displayedRevisionId = currentRevisionId(candidateId);
    // A second batch supersedes the displayed revision before the note lands.
    ingestBriefingBatch(db, batch({
      batch_key: "batch-2",
      digest: { series_ref: "artifact-series:abc123", version: 2 },
      items: [{
        candidate_key: candidateKey("arxiv-scan", "paper-1"),
        source: "arxiv-scan",
        ref: "paper-1",
        title: "Sharper finding",
        why_notable: null,
        refs: [],
        evidence_hash: "evidence-b",
        evidence_kind: "snapshot-item",
        captured_at: "2026-08-12T09:00:00Z",
        rank: 1,
      }],
    }));
    expect(currentRevisionId(candidateId)).not.toBe(displayedRevisionId);

    const pinned = await router.invoke({
      method: "POST",
      url: `/api/briefing/candidates/${candidateId}/comments`,
      body: { body: "about the old text", revision_id: displayedRevisionId },
      credential: "operator",
    });
    expect(pinned.status).toBe(200);
    expect((pinned.body as { comment: Record<string, unknown> }).comment).toMatchObject({
      revision_id: displayedRevisionId,
    });

    const malformed = await router.invoke({
      method: "POST",
      url: `/api/briefing/candidates/${candidateId}/comments`,
      body: { body: "bad pin", revision_id: "  " },
      credential: "operator",
    });
    expect(malformed.status).toBe(400);

    const unknown = await router.invoke({
      method: "POST",
      url: `/api/briefing/candidates/${candidateId}/comments`,
      body: { body: "foreign pin", revision_id: "not-a-revision-of-this-candidate" },
      credential: "operator",
    });
    expect(unknown.status).toBe(404);
  });

  it("refuses decisions and comments while the instance is read-only", async () => {
    const readOnlyRouter = makeRouter({ readOnly: true });
    registerBriefingRoutes(readOnlyRouter, db);
    const candidateId = onlyCandidateId();

    for (const [url, body] of [
      [`/api/briefing/candidates/${candidateId}/decision`, { action: "keep" }],
      [`/api/briefing/candidates/${candidateId}/comments`, { body: "nope" }],
      ["/api/briefing/ingest", batch({ batch_key: "batch-read-only" })],
    ] as const) {
      const response = await readOnlyRouter.invoke({
        method: "POST",
        url,
        body,
        credential: "operator",
      });
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({
        error: "instance_mutation_forbidden",
        category: "briefing",
      });
    }
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM decision_events").get() as { n: number }).n,
    ).toBe(0);

    // Reads stay available on a read-only instance.
    const queue = await readOnlyRouter.invoke({ method: "GET", url: "/api/briefing/queue" });
    expect(queue.status).toBe(200);
  });
});

describe("briefing read routes and file-RPC policy", () => {
  beforeEach(() => {
    ingestBriefingBatch(db, batch(), 1_000);
  });

  it("serves the pending queue and candidate history", async () => {
    const candidateId = onlyCandidateId();
    const queue = await router.invoke({ method: "GET", url: "/api/briefing/queue" });
    expect(queue.status).toBe(200);
    expect((queue.body as { candidates: unknown[] }).candidates).toHaveLength(1);
    expect((queue.body as { sources: Array<{ source: string }> }).sources[0].source)
      .toBe("arxiv-scan");

    const filtered = await router.invoke({
      method: "GET",
      url: "/api/briefing/queue?source=nothing-here",
    });
    expect((filtered.body as { candidates: unknown[] }).candidates).toEqual([]);

    const history = await router.invoke({
      method: "GET",
      url: `/api/briefing/candidates/${candidateId}/history`,
    });
    expect(history.status).toBe(200);
    expect(history.body).toMatchObject({ candidate: { id: candidateId, state: "pending" } });

    const missing = await router.invoke({
      method: "GET",
      url: "/api/briefing/candidates/does-not-exist/history",
    });
    expect(missing.status).toBe(404);
  });

  it("allows file-RPC for ingest and reads, and denies it for review mutations", () => {
    const candidateId = onlyCandidateId();
    expect(router.resolveFileRpcPolicy("POST", "/api/briefing/ingest")).toBe(true);
    expect(router.resolveFileRpcPolicy("GET", "/api/briefing/queue")).toBe(true);
    expect(
      router.resolveFileRpcPolicy("GET", `/api/briefing/candidates/${candidateId}/history`),
    ).toBe(true);
    expect(
      router.resolveFileRpcPolicy("POST", `/api/briefing/candidates/${candidateId}/decision`),
    ).toBe(false);
    expect(
      router.resolveFileRpcPolicy("POST", `/api/briefing/candidates/${candidateId}/comments`),
    ).toBe(false);
  });
});
