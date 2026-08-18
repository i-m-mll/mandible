import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setSetting } from "../src/client-auth/settings-kv.js";
import { migrate, type Db } from "../src/db.js";
import { registerBriefingRoutes } from "../src/routes/briefing.js";
import { Router, type ClientAuthGate, type ResolvedClientIdentity } from "../src/server.js";
import { createUser } from "../src/users/store.js";

class SlugGate implements ClientAuthGate {
  constructor(private readonly db: () => Db) {}
  authenticate(credential: string | null | undefined): ResolvedClientIdentity | null {
    if (!credential) return null;
    const ephemeral = credential.startsWith("session:");
    const slug = ephemeral ? credential.slice(8) : credential;
    const user = this.db().prepare("SELECT id, slug FROM users WHERE slug = ? AND status = 'active'")
      .get(slug) as { id: string; slug: string } | undefined;
    return user ? { user_id: user.id, slug: user.slug, method: ephemeral ? "ephemeral" : "api_token",
      credential_id: null, source: "in_process" } : null;
  }
  mode() { return "compat" as const; }
  recordUnattributedWrite() {}
}

let db: Db;
let router: Router;
let root: string;
let humanId: string;

function payload(overrides: Record<string, unknown> = {}) {
  return {
    schema: "mandible-briefing-run@1", briefing_key: "daily", title: "Daily",
    task_identity: "agent-schedule/daily-digest", run_id: "run-1", run_key: "key-1",
    responder_user_ids: [humanId],
    evidence: { series_ref: "artifact-series:digest", version: 1, digest: "a".repeat(64) },
    source_health: { source: "arxiv-scan", status: "healthy", detail: null, observed_at: 1 },
    document: { markdown: '# Daily\n\n:::spec-item{key="paper" required="true"}\nKeep it?\n:::\n' },
    quiet_reason: null,
    occurrences: [{ directive_key: "paper", evidence_digest: "b".repeat(64), occurred_at: 1, metadata: {} }],
    ...overrides,
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-briefing-routes-"));
  db = new Database(":memory:");
  migrate(db);
  setSetting(db, "artifact_root", root);
  createUser(db, { slug: "agent-schedule", kind: "agent", display_name: "Publisher" });
  humanId = createUser(db, { slug: "human", kind: "human", display_name: "Human" }).id;
  router = new Router({ clientAuth: new SlugGate(() => db) });
  registerBriefingRoutes(router, db);
});

afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("plural Briefing routes", () => {
  it("authenticates publishers, returns stable run identity, and rejects old compatibility routes", async () => {
    expect((await router.invoke({ method: "POST", url: "/api/briefings/runs", body: payload() })).status).toBe(401);
    expect((await router.invoke({ method: "POST", url: "/api/briefings/runs", body: payload(), credential: "session:agent-schedule" })).status).toBe(403);
    const first = await router.invoke({ method: "POST", url: "/api/briefings/runs", body: payload(), credential: "agent-schedule" });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ quiet: false, run_id: "run-1" });
    expect(await router.invoke({ method: "POST", url: "/api/briefings/runs", body: payload(), credential: "agent-schedule" }))
      .toEqual(first);
    expect((await router.invoke({ method: "POST", url: "/api/briefing/ingest", body: payload(), credential: "agent-schedule" })).status).toBe(404);
    expect((await router.invoke({ method: "GET", url: "/api/asks/anything", credential: "human" })).status).toBe(404);
  });

  it("lists logical identities, selects rounds, and executes the actor-scoped answer/submit family", async () => {
    const published = await router.invoke({ method: "POST", url: "/api/briefings/runs", body: payload(), credential: "agent-schedule" });
    const ids = published.body as { briefing_id: string; round_id: string };
    const list = await router.invoke({ method: "GET", url: "/api/briefings", credential: "human" });
    expect(list.body).toMatchObject({ briefings: [{ id: ids.briefing_id, latest_round_id: ids.round_id, round_count: 1 }] });
    const detail = await router.invoke({ method: "GET", url: `/api/briefings/${ids.briefing_id}?round=${ids.round_id}`, credential: "human" });
    expect(detail.body).toMatchObject({ selected_round: { id: ids.round_id, binding: { status: "valid" }, items: [{ directive_key: "paper" }] } });
    const answer = await router.invoke({ method: "POST", url: `/api/briefings/${ids.briefing_id}/rounds/${ids.round_id}/answers`,
      credential: "human", body: { answers: [{ directive_key: "paper", operation: "set",
        expected_response_event_id: null, value: { verdict: "keep" } }] } });
    expect(answer.status).toBe(200);
    const responseEventId = ((answer.body as { answers: Array<{ response_event_id: string }> }).answers[0]).response_event_id;
    const submitted = await router.invoke({ method: "POST", url: `/api/briefings/${ids.briefing_id}/rounds/${ids.round_id}/submit`,
      credential: "human", body: { answers: [{ directive_key: "paper", response_event_id: responseEventId }],
        annotation_event_ids: [], supersedes_submission_id: null } });
    expect(submitted).toMatchObject({ status: 200, body: { ordinal: 1, actor_user_id: humanId } });
  });

  it("records quiet source-health receipts without creating a round", async () => {
    const quiet = await router.invoke({ method: "POST", url: "/api/briefings/runs", credential: "agent-schedule", body: payload({
      document: null, quiet_reason: "no changes", occurrences: [], run_key: "quiet-1", run_id: "quiet-1",
    }) });
    expect(quiet).toMatchObject({ status: 200, body: { quiet: true, round_id: null, artifact_version_id: null } });
    expect(db.prepare("SELECT source_health_json FROM briefing_runs WHERE id = ?")
      .get((quiet.body as { receipt_id: string }).receipt_id)).toMatchObject({ source_health_json: expect.stringContaining("healthy") });
  });
});
