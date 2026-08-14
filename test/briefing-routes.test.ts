import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Issue ce22a3a (umbrella 99b74d6): briefing HTTP surface — publisher-only
// ingestion inside a mapped source namespace, human-only decisions and
// comments, file-RPC policy, and the read-only instance gate.

import {
  countPendingBriefingCandidates,
  ingestBriefingBatch,
  listBriefingQueue,
} from "../src/briefing.js";
import { setSetting } from "../src/client-auth/settings-kv.js";
import {
  BRIEFING_INGEST_SCHEMA,
  BRIEFING_INGEST_SCHEMA_V2,
  type BriefingIngestRequest,
} from "../src/contracts.js";
import { migrate, setDb, type Db } from "../src/db.js";
import { FileRpcTransport } from "../src/file-rpc-transport.js";
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
    const ephemeral = credential.startsWith("session:");
    const slug = ephemeral ? credential.slice("session:".length) : credential;
    const row = this.lookup()
      .prepare("SELECT id, slug FROM users WHERE slug = ? AND status = 'active'")
      .get(slug) as { id: string; slug: string } | undefined;
    if (!row) return null;
    return {
      user_id: row.id,
      slug: row.slug,
      method: ephemeral ? "ephemeral" : "api_token",
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
    schema: overrides.schema ?? BRIEFING_INGEST_SCHEMA,
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
  return (db.prepare("SELECT id FROM feedback_items LIMIT 1").get() as { id: string }).id;
}

function currentRevisionId(candidateId: string): string {
  return (db
    .prepare("SELECT current_revision_id AS id FROM feedback_items WHERE id = ?")
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
      (db.prepare("SELECT COUNT(*) AS n FROM feedback_item_revisions").get() as { n: number }).n,
    ).toBe(1);
    expect(db.prepare(
      "SELECT publisher_user_id FROM feedback_publications",
    ).get()).toEqual({ publisher_user_id: publisherId });
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
      (db.prepare("SELECT COUNT(*) AS n FROM feedback_publications").get() as { n: number }).n,
    ).toBe(0);
  });

  it("honors an operator-configured publisher mapping", async () => {
    setSetting(db, "briefing.ingest.publishers", JSON.stringify({
      codex: [{
        task_identity: "agent-schedule/daily-digest",
        sources: ["research"],
      }],
    }));
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
      body: batch({
        batch_key: "batch-research",
        items: [{ ...batch().items[0], source: "research" }],
      }),
      credential: "codex",
    });
    expect(allowed.status).toBe(200);
  });

  it("rejects prefix bypasses, session credentials, non-agents, and malformed overrides", async () => {
    expect((await router.invoke({
      method: "POST",
      url: "/api/briefing/ingest",
      body: batch({ task_identity: "agent-schedule/daily-digest/extra" }),
      credential: "agent-schedule",
    })).status).toBe(403);

    const session = await router.invoke({
      method: "POST",
      url: "/api/briefing/ingest",
      body: batch(),
      credential: "session:agent-schedule",
    });
    expect(session).toMatchObject({
      status: 403,
      body: { code: "briefing_publisher_credential_required" },
    });

    createUser(db, { slug: "human-publisher", kind: "human", display_name: "Human" });
    setSetting(db, "briefing.ingest.publishers", JSON.stringify({
      "human-publisher": [{
        task_identity: "agent-schedule/daily-digest",
        sources: ["arxiv-scan"],
      }],
    }));
    const human = await router.invoke({
      method: "POST",
      url: "/api/briefing/ingest",
      body: batch(),
      credential: "human-publisher",
    });
    expect(human).toMatchObject({
      status: 403,
      body: { code: "briefing_publisher_agent_required" },
    });

    for (const override of [
      "",
      "not-json",
      JSON.stringify({ "agent-schedule": [{ task_identity: "", sources: ["arxiv-scan"] }] }),
      JSON.stringify({ "agent-schedule": [{ task_identity: "agent-schedule/daily-digest", sources: [""] }] }),
      JSON.stringify({ "agent-schedule": [{ task_identity: "agent-schedule/daily-digest", sources: ["arxiv-scan"], extra: true }] }),
    ]) {
      setSetting(db, "briefing.ingest.publishers", override);
      expect((await router.invoke({
        method: "POST",
        url: "/api/briefing/ingest",
        body: batch({ batch_key: `malformed-${override}` }),
        credential: "agent-schedule",
      })).status).toBe(403);
    }
    expect((db.prepare("SELECT COUNT(*) AS n FROM feedback_publications").get() as { n: number }).n)
      .toBe(0);
  });

  it("authorizes every source before writing a multi-source batch", async () => {
    const response = await router.invoke({
      method: "POST",
      url: "/api/briefing/ingest",
      credential: "agent-schedule",
      body: batch({
        items: [
          batch().items[0],
          { ...batch().items[0], candidate_key: "other", source: "not-allowed" },
        ],
      }),
    });
    expect(response.status).toBe(403);
    expect((db.prepare("SELECT COUNT(*) AS n FROM feedback_publications").get() as { n: number }).n)
      .toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM feedback_items").get() as { n: number }).n)
      .toBe(0);
  });

  it("enforces the same durable-agent boundary through file-RPC", async () => {
    const spool = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-briefing-file-rpc-"));
    try {
      const transport = new FileRpcTransport({ router, dir: spool, responseTtlMs: 60_000 });
      for (const [id, capability_token] of [
        ["session", "session:agent-schedule"],
        ["mapped", "agent-schedule"],
      ]) {
        fs.writeFileSync(path.join(spool, `${id}.request.json`), JSON.stringify({
          id,
          capability_token,
          method: "POST",
          path: "/api/briefing/ingest",
          body: batch({ batch_key: `file-${id}` }),
        }));
      }
      await transport.processOnce();
      const response = (id: string) => JSON.parse(
        fs.readFileSync(path.join(spool, `${id}.response.json`), "utf8"),
      ) as { status: number; body: Record<string, unknown> };
      expect(response("session")).toMatchObject({
        status: 403,
        body: { code: "briefing_publisher_credential_required" },
      });
      expect(response("mapped").status).toBe(200);
    } finally {
      fs.rmSync(spool, { recursive: true, force: true });
    }
  });

  it("rejects unknown keys exactly in both versions", async () => {
    for (const body of [
      { ...batch(), invented: true },
      { ...batch(), items: [{ ...batch().items[0], publisher_advisory: null }] },
      { ...batch({ schema: BRIEFING_INGEST_SCHEMA_V2 }), items: [{
        ...batch().items[0], item_kind: "item", parent: null, publisher_advisory: null, invented: true,
      }] },
    ]) {
      const response = await router.invoke({
        method: "POST",
        url: "/api/briefing/ingest",
        body,
        credential: "agent-schedule",
      });
      expect(response.status).toBe(400);
    }
    expect((db.prepare("SELECT COUNT(*) AS n FROM feedback_publications").get() as { n: number }).n)
      .toBe(0);
  });

  it("stores v2 groups and advisory metadata without creating response events", async () => {
    setSetting(db, "briefing.ingest.publishers", JSON.stringify({
      "agent-schedule": [{
        task_identity: "agent-schedule/task-health",
        sources: ["task-health"],
      }],
    }));
    const group = {
      ...batch().items[0],
      candidate_key: "quarantine",
      source: "task-health",
      title: "Quarantined by admission gate",
      evidence_hash: "group-evidence",
      item_kind: "group" as const,
      parent: null,
      publisher_advisory: null,
    };
    const leaf = {
      ...batch().items[0],
      candidate_key: "card-1",
      source: "task-health",
      evidence_hash: "leaf-evidence",
      item_kind: "item" as const,
      parent: "quarantine",
      publisher_advisory: {
        code: "admission_gate_rejected" as const,
        reason: "missing evidence",
      },
    };
    const body = batch({
      schema: BRIEFING_INGEST_SCHEMA_V2,
      task_identity: "agent-schedule/task-health",
      items: [leaf, group],
    });
    const first = await router.invoke({
      method: "POST", url: "/api/briefing/ingest", body, credential: "agent-schedule",
    });
    expect(first.status).toBe(200);
    const queue = listBriefingQueue(db);
    expect(queue.candidates).toHaveLength(1);
    expect(queue.candidates[0]).toMatchObject({
      state: "pending",
      group: { candidate_key: "quarantine", title: "Quarantined by admission gate" },
      revision: {
        publisher_advisory: { code: "admission_gate_rejected", reason: "missing evidence" },
      },
    });
    expect((db.prepare("SELECT COUNT(*) AS n FROM feedback_response_events").get() as { n: number }).n)
      .toBe(0);
    expect(db.prepare(
      "SELECT DISTINCT publisher_user_id FROM feedback_publications",
    ).all()).toEqual([{ publisher_user_id: publisherId }]);

    const replay = await router.invoke({
      method: "POST", url: "/api/briefing/ingest", body, credential: "agent-schedule",
    });
    expect(replay).toEqual(first);
    const conflict = await router.invoke({
      method: "POST",
      url: "/api/briefing/ingest",
      body: { ...body, run_id: "different-run" },
      credential: "agent-schedule",
    });
    expect(conflict.status).toBe(409);
    expect((db.prepare("SELECT COUNT(*) AS n FROM feedback_ingest_requests").get() as { n: number }).n)
      .toBe(1);
  });

  it("scopes the same task and batch key to the authenticated publisher", async () => {
    createUser(db, { slug: "codex", kind: "agent", display_name: "Codex" });
    setSetting(db, "briefing.ingest.publishers", JSON.stringify({
      "agent-schedule": [{
        task_identity: "agent-schedule/daily-digest",
        sources: ["arxiv-scan"],
      }],
      codex: [{
        task_identity: "agent-schedule/daily-digest",
        sources: ["arxiv-scan"],
      }],
    }));
    const body = batch();
    expect((await router.invoke({
      method: "POST", url: "/api/briefing/ingest", body, credential: "agent-schedule",
    })).status).toBe(200);
    expect((await router.invoke({
      method: "POST", url: "/api/briefing/ingest", body, credential: "codex",
    })).status).toBe(200);
    expect((db.prepare("SELECT COUNT(*) AS n FROM feedback_ingest_requests").get() as { n: number }).n)
      .toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS n FROM feedback_publications").get() as { n: number }).n)
      .toBe(2);
  });

  it("rejects group-under-group and leaf-as-parent without writes", async () => {
    const baseItem = batch().items[0];
    for (const items of [
      [
        { ...baseItem, candidate_key: "outer", item_kind: "group", parent: null },
        { ...baseItem, candidate_key: "inner", item_kind: "group", parent: "outer" },
      ],
      [
        { ...baseItem, candidate_key: "leaf", item_kind: "item", parent: null },
        { ...baseItem, candidate_key: "child", item_kind: "item", parent: "leaf" },
      ],
    ]) {
      const response = await router.invoke({
        method: "POST",
        url: "/api/briefing/ingest",
        body: batch({ schema: BRIEFING_INGEST_SCHEMA_V2, batch_key: `bad-${items[0].candidate_key}`, items }),
        credential: "agent-schedule",
      });
      expect(response.status).toBe(400);
    }
    expect((db.prepare("SELECT COUNT(*) AS n FROM feedback_items").get() as { n: number }).n)
      .toBe(0);
  });

  it("rejects a parent group from a different source collection", async () => {
    setSetting(db, "briefing.ingest.publishers", JSON.stringify({
      "agent-schedule": [{
        task_identity: "agent-schedule/daily-digest",
        sources: ["alpha", "beta"],
      }],
    }));
    const baseItem = batch().items[0];
    const response = await router.invoke({
      method: "POST",
      url: "/api/briefing/ingest",
      credential: "agent-schedule",
      body: batch({
        schema: BRIEFING_INGEST_SCHEMA_V2,
        items: [
          { ...baseItem, source: "alpha", candidate_key: "group", item_kind: "group", parent: null },
          { ...baseItem, source: "beta", candidate_key: "leaf", item_kind: "item", parent: "group" },
        ],
      }),
    });
    expect(response.status).toBe(400);
    expect((db.prepare("SELECT COUNT(*) AS n FROM feedback_items").get() as { n: number }).n)
      .toBe(0);
  });

  it("rejects a malformed batch with 400 and writes nothing", async () => {
    const response = await router.invoke({
      method: "POST",
      url: "/api/briefing/ingest",
      body: { ...batch(), schema: "briefing-ingest@3" },
      credential: "agent-schedule",
    });
    expect(response.status).toBe(400);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM feedback_publications").get() as { n: number }).n,
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
      (db.prepare("SELECT actor_user_id AS id FROM feedback_response_events").get() as { id: string }).id,
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
      (db.prepare("SELECT COUNT(*) AS n FROM feedback_response_events").get() as { n: number }).n,
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
      (db.prepare("SELECT COUNT(*) AS n FROM feedback_response_events").get() as { n: number }).n,
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
      (db.prepare("SELECT COUNT(*) AS n FROM feedback_response_events").get() as { n: number }).n,
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
      (db.prepare("SELECT COUNT(*) AS n FROM feedback_response_events").get() as { n: number }).n,
    ).toBe(0);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM feedback_comments").get() as { n: number }).n,
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
      (db.prepare("SELECT COUNT(*) AS n FROM feedback_response_events").get() as { n: number }).n,
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
