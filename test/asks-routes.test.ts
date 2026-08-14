import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setSetting } from "../src/client-auth/settings-kv.js";
import { migrate, setDb, type Db } from "../src/db.js";
import { FileRpcTransport } from "../src/file-rpc-transport.js";
import { addGrant, addGroup, addGroupMember } from "../src/permissions/store.js";
import { registerAskRoutes } from "../src/routes/asks.js";
import { Router, type ClientAuthGate, type ResolvedClientIdentity } from "../src/server.js";
import { setSseManager } from "../src/sse.js";
import { createUser, OPERATOR_SETTING_KEY } from "../src/users/store.js";

let db: Db;
let router: Router;
let agentId: string;
let humanId: string;
let operatorId: string;
let events: Array<{ type: string; data: unknown }>;
let tempDirs: string[];

class SlugGate implements ClientAuthGate {
  authenticate(credential: string | null | undefined): ResolvedClientIdentity | null {
    if (!credential) return null;
    const row = db.prepare("SELECT id, slug FROM users WHERE slug = ? AND status = 'active'")
      .get(credential) as { id: string; slug: string } | undefined;
    return row ? {
      user_id: row.id, slug: row.slug, method: "api_token", credential_id: null, source: "in_process",
    } : null;
  }
  mode() { return "strict" as const; }
  recordUnattributedWrite() {}
}

function packet(expiresAt = 4_000_000_000_000, requestKey = "route-request") {
  return {
    request_key: requestKey,
    session_id: "route-session",
    responder_user_ids: [humanId],
    expires_at: expiresAt,
    items: [{
      client_item_key: "text", item_kind: "item", title: "Question", prompt: "Answer",
      response_type: "free_text", required: true,
    }],
  };
}

async function create(body = packet()) {
  return router.invoke({ method: "POST", url: "/api/asks", credential: "agent", body });
}

async function fileRpc(
  method: string,
  requestPath: string,
  credential: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-ask-rpc-"));
  tempDirs.push(dir);
  const transport = new FileRpcTransport({ router, dir, responseTtlMs: 60_000 });
  const id = `request-${tempDirs.length}`;
  fs.writeFileSync(path.join(dir, `${id}.request.json`), JSON.stringify({
    id, method, path: requestPath, capability_token: credential, body,
  }));
  await transport.processOnce();
  const response = JSON.parse(fs.readFileSync(path.join(dir, `${id}.response.json`), "utf8"));
  return { status: response.status, body: response.body };
}

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  setDb(db);
  operatorId = createUser(db, { slug: "operator", kind: "human", display_name: "Operator" }).id;
  setSetting(db, OPERATOR_SETTING_KEY, operatorId);
  agentId = createUser(db, { slug: "agent", kind: "agent", display_name: "Agent" }).id;
  humanId = createUser(db, { slug: "human", kind: "human", display_name: "Human" }).id;
  db.prepare("INSERT INTO sessions (id, app, status, owner_user_id) VALUES ('route-session','codex','active',?)")
    .run(agentId);
  router = new Router({ clientAuth: new SlugGate() });
  registerAskRoutes(router, db);
  events = [];
  tempDirs = [];
  setSseManager({
    broadcast: (event: { type: string; data: unknown }) => events.push(event),
  } as never);
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("ask routes", () => {
  it("registers the frozen route/file-RPC policy", () => {
    expect(router.listRoutePolicies().map(({ method, path, fileRpc }) => ({ method, path, fileRpc })))
      .toEqual([
        { method: "POST", path: "/api/asks", fileRpc: "allow" },
        { method: "GET", path: "/api/asks/:id", fileRpc: "allow" },
        { method: "GET", path: "/api/asks/:id/result", fileRpc: "allow" },
        { method: "GET", path: "/api/asks/:id/wait", fileRpc: "allow" },
        { method: "POST", path: "/api/asks/:id/answers", fileRpc: "deny" },
        { method: "POST", path: "/api/asks/:id/submit", fileRpc: "deny" },
        { method: "DELETE", path: "/api/asks/:id", fileRpc: "deny" },
      ]);
  });

  it("requires an active granted agent and makes create replay idempotent", async () => {
    expect((await create()).status).toBe(403);
    addGrant(db, { subject_type: "user", subject: agentId, resource_type: "global", permission: "ask.create" });
    const first = await create();
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ replay: false });
    const replay = await create();
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ ask_id: (first.body as { ask_id: string }).ask_id, replay: true });
    expect(events.filter((event) => event.type === "ask:created")).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("Question");
  });

  it("accepts ask.create through a group grant without assuming a seeded capability", async () => {
    const group = addGroup(db, { slug: "askers", display_name: "Ask creators" });
    addGroupMember(db, group.id, agentId);
    addGrant(db, { subject_type: "group", subject: group.id, resource_type: "global", permission: "ask.create" });
    expect((await create()).status).toBe(201);
  });

  it("scopes reads, hides drafts from results, and enforces human HTTP writes", async () => {
    addGrant(db, { subject_type: "user", subject: agentId, resource_type: "global", permission: "ask.create" });
    const created = await create();
    const askId = (created.body as { ask_id: string }).ask_id;
    const form = await router.invoke({ method: "GET", url: `/api/asks/${askId}`, credential: "human", transport: "http" });
    expect(form.status).toBe(200);
    const item = (form.body as any).items[0];
    const answer = await router.invoke({
      method: "POST", url: `/api/asks/${askId}/answers`, credential: "human", transport: "http",
      body: { answers: [{
        item_id: item.id, item_revision_id: item.revision.id, operation: "set",
        value: { text: "private draft" }, expected_response_event_id: null,
      }] },
    });
    expect(answer.status).toBe(200);
    const result = await router.invoke({ method: "GET", url: `/api/asks/${askId}/result`, credential: "agent" });
    expect(result.body).toMatchObject({ schema: "mandible-ask-result@1", state: "open", submission: null });
    expect(JSON.stringify(result.body)).not.toContain("private draft");
    const stranger = createUser(db, { slug: "stranger", kind: "agent", display_name: "Stranger" });
    addGrant(db, { subject_type: "user", subject: stranger.id, resource_type: "global", permission: "ask.create" });
    expect((await router.invoke({ method: "GET", url: `/api/asks/${askId}/result`, credential: "stranger" })).status)
      .toBe(404);
  });

  it("submits atomically, returns the canonical envelope, and emits no answer values", async () => {
    addGrant(db, { subject_type: "user", subject: agentId, resource_type: "global", permission: "ask.create" });
    const askId = ((await create()).body as { ask_id: string }).ask_id;
    const form = (await router.invoke({ method: "GET", url: `/api/asks/${askId}`, credential: "human" })).body as any;
    const item = form.items[0];
    const set = (await router.invoke({
      method: "POST", url: `/api/asks/${askId}/answers`, credential: "human", transport: "http",
      body: { answers: [{ item_id: item.id, item_revision_id: item.revision.id, operation: "set", value: { text: "answer" }, expected_response_event_id: null }] },
    })).body as { answer_event_ids: string[] };
    const submitted = await router.invoke({
      method: "POST", url: `/api/asks/${askId}/submit`, credential: "human", transport: "http",
      body: {
        expected_lifecycle_event_id: form.lifecycle_event_id,
        answers: [{ item_id: item.id, item_revision_id: item.revision.id, response_event_id: set.answer_event_ids[0] }],
      },
    });
    expect(submitted.body).toMatchObject({ schema: "mandible-ask-result@1", state: "submitted" });
    const submission = (submitted.body as any).submission;
    const refreshed = await router.invoke({
      method: "GET", url: `/api/asks/${askId}`, credential: "human", transport: "http",
    });
    expect(refreshed.status).toBe(200);
    expect((refreshed.body as any).latest_submission).toEqual({ id: submission.id, ordinal: 1 });
    expect((refreshed.body as any).lifecycle_event_id).not.toBe(submission.id);
    expect(JSON.stringify((refreshed.body as any).latest_submission)).not.toContain("answer");
    expect((await router.invoke({
      method: "GET", url: `/api/asks/${askId}/result`, credential: "human", transport: "http",
    })).status).toBe(404);
    const requesterRead = await router.invoke({
      method: "GET", url: `/api/asks/${askId}`, credential: "agent", transport: "http",
    });
    expect(requesterRead.status).toBe(200);
    expect((requesterRead.body as any).latest_submission).toEqual({ id: submission.id, ordinal: 1 });
    expect(JSON.stringify(requesterRead.body)).not.toContain("effective_response");
    const event = events.find((candidate) => candidate.type === "ask:submitted")!;
    expect(JSON.stringify(event)).not.toContain("answer");
  });

  it("validates wait bounds and does not mutate on a zero timeout", async () => {
    addGrant(db, { subject_type: "user", subject: agentId, resource_type: "global", permission: "ask.create" });
    const askId = ((await create()).body as { ask_id: string }).ask_id;
    const before = (db.prepare("SELECT COUNT(*) AS n FROM feedback_collection_events").get() as { n: number }).n;
    const zero = await router.invoke({ method: "GET", url: `/api/asks/${askId}/wait?timeout_ms=0`, credential: "agent" });
    expect(zero.body).toMatchObject({ state: "open", wait_timed_out: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM feedback_collection_events").get()).toEqual({ n: before });
    for (const query of ["55001", "-1", "1.5", "NaN", "1&timeout_ms=2"]) {
      expect((await router.invoke({ method: "GET", url: `/api/asks/${askId}/wait?timeout_ms=${query}`, credential: "agent" })).status)
        .toBe(400);
    }
  });

  it("allows operator inspection/cancellation but not responder authority", async () => {
    addGrant(db, { subject_type: "user", subject: agentId, resource_type: "global", permission: "ask.create" });
    const askId = ((await create()).body as { ask_id: string }).ask_id;
    expect((await router.invoke({ method: "GET", url: `/api/asks/${askId}`, credential: "operator" })).status).toBe(200);
    expect((await router.invoke({
      method: "POST", url: `/api/asks/${askId}/answers`, credential: "operator", transport: "http", body: { answers: [] },
    })).status).toBe(404);
    const cancelled = await router.invoke({ method: "DELETE", url: `/api/asks/${askId}`, credential: "operator", transport: "http" });
    expect(cancelled.body).toMatchObject({ state: "cancelled" });
    expect(events.some((event) => event.type === "ask:cancelled")).toBe(true);
  });

  it("enforces ownership, audience, human-only writes, and operator non-bypass on every route", async () => {
    addGrant(db, { subject_type: "user", subject: agentId, resource_type: "global", permission: "ask.create" });
    const askId = ((await create()).body as { ask_id: string }).ask_id;
    const outsiderAgent = createUser(db, { slug: "outsider-agent", kind: "agent", display_name: "Outsider agent" });
    addGrant(db, { subject_type: "user", subject: outsiderAgent.id, resource_type: "global", permission: "ask.create" });
    const outsiderHuman = createUser(db, { slug: "outsider-human", kind: "human", display_name: "Outsider human" });
    for (const suffix of ["", "/result", "/wait?timeout_ms=0"]) {
      expect((await router.invoke({ method: "GET", url: `/api/asks/${askId}${suffix}`, credential: "outsider-agent" })).status).toBe(404);
    }
    expect((await router.invoke({ method: "GET", url: `/api/asks/${askId}/result`, credential: "human" })).status).toBe(404);
    for (const credential of ["outsider-human", "operator"]) {
      expect((await router.invoke({ method: "POST", url: `/api/asks/${askId}/answers`, credential, transport: "http", body: { answers: [] } })).status).toBe(404);
      expect((await router.invoke({ method: "POST", url: `/api/asks/${askId}/submit`, credential, transport: "http", body: { expected_lifecycle_event_id: "untrusted", answers: [] } })).status).toBe(404);
    }
    expect((await router.invoke({ method: "POST", url: `/api/asks/${askId}/answers`, credential: "agent", transport: "http", body: { answers: [] } })).status).toBe(403);
    expect((await router.invoke({ method: "DELETE", url: `/api/asks/${askId}`, credential: "human", transport: "http" })).status).toBe(403);
    expect((await router.invoke({ method: "GET", url: `/api/asks/${askId}/result`, credential: "operator" })).status).toBe(200);
  });

  it("admits requester operations and denies human mutations through actual file RPC", async () => {
    addGrant(db, { subject_type: "user", subject: agentId, resource_type: "global", permission: "ask.create" });
    const created = await fileRpc("POST", "/api/asks", "agent", packet());
    expect(created.status).toBe(201);
    const askId = (created.body as { ask_id: string }).ask_id;
    expect((await fileRpc("GET", `/api/asks/${askId}`, "agent")).status).toBe(200);
    expect((await fileRpc("GET", `/api/asks/${askId}/result`, "agent")).status).toBe(200);
    expect((await fileRpc("GET", `/api/asks/${askId}/wait?timeout_ms=0`, "agent")).status).toBe(200);
    expect((await fileRpc("POST", `/api/asks/${askId}/answers`, "human", { answers: [] })).status).toBe(403);
    expect((await fileRpc("POST", `/api/asks/${askId}/submit`, "human", {})).status).toBe(403);
    expect((await fileRpc("DELETE", `/api/asks/${askId}`, "operator")).status).toBe(403);
  });

  it("returns exact envelopes and excludes unsubmitted answers from requester read and result", async () => {
    addGrant(db, { subject_type: "user", subject: agentId, resource_type: "global", permission: "ask.create" });
    const created = (await create()).body as any;
    const responderForm = (await router.invoke({ method: "GET", url: `/api/asks/${created.ask_id}`, credential: "human" })).body as any;
    const item = responderForm.items[0];
    await router.invoke({
      method: "POST", url: `/api/asks/${created.ask_id}/answers`, credential: "human", transport: "http",
      body: { answers: [{ item_id: item.id, item_revision_id: item.revision.id, operation: "set", value: { text: "unpublished secret" }, expected_response_event_id: null }] },
    });
    const requesterRead = await router.invoke({ method: "GET", url: `/api/asks/${created.ask_id}`, credential: "agent" });
    const result = await router.invoke({ method: "GET", url: `/api/asks/${created.ask_id}/result`, credential: "agent" });
    expect(JSON.stringify(requesterRead.body)).not.toContain("unpublished secret");
    expect(JSON.stringify(requesterRead.body)).not.toContain("effective_response");
    expect(result.body).toEqual({
      schema: "mandible-ask-result@1", ask_id: created.ask_id, state: "open",
      request_digest: created.request_digest, expires_at: 4_000_000_000_000, submission: null,
    });
  });

  it("emits each lifecycle topic once after commit without question or answer content", async () => {
    addGrant(db, { subject_type: "user", subject: agentId, resource_type: "global", permission: "ask.create" });
    const submitId = ((await create(packet(4_000_000_000_000, "submit-event"))).body as any).ask_id;
    const form = (await router.invoke({ method: "GET", url: `/api/asks/${submitId}`, credential: "human" })).body as any;
    const set = (await router.invoke({ method: "POST", url: `/api/asks/${submitId}/answers`, credential: "human", transport: "http", body: { answers: [{ item_id: form.items[0].id, item_revision_id: form.items[0].revision.id, operation: "set", value: { text: "sensitive answer" }, expected_response_event_id: null }] } })).body as any;
    await router.invoke({ method: "POST", url: `/api/asks/${submitId}/submit`, credential: "human", transport: "http", body: { expected_lifecycle_event_id: form.lifecycle_event_id, answers: [{ item_id: form.items[0].id, item_revision_id: form.items[0].revision.id, response_event_id: set.answer_event_ids[0] }] } });
    const cancelId = ((await create(packet(4_000_000_000_000, "cancel-event"))).body as any).ask_id;
    await router.invoke({ method: "DELETE", url: `/api/asks/${cancelId}`, credential: "operator", transport: "http" });
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const expireId = ((await create(packet(10_010, "expire-event"))).body as any).ask_id;
    vi.setSystemTime(10_011);
    await router.invoke({ method: "GET", url: `/api/asks/${expireId}/result`, credential: "agent" });
    for (const topic of ["ask:created", "ask:submitted", "ask:cancelled", "ask:expired"]) expect(events.some((event) => event.type === topic)).toBe(true);
    expect(events.filter((event) => event.type === "ask:expired")).toHaveLength(1);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("Question");
    expect(serialized).not.toContain("sensitive answer");
  });

  it("honors wait default, zero, maximum, terminal wake-up, and timeout immutability", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    addGrant(db, { subject_type: "user", subject: agentId, resource_type: "global", permission: "ask.create" });
    const askId = ((await create(packet(100_000, "wait-bounds"))).body as any).ask_id;
    const before = (db.prepare("SELECT COUNT(*) AS n FROM feedback_collection_events").get() as { n: number }).n;
    const defaultWait = router.invoke({ method: "GET", url: `/api/asks/${askId}/wait`, credential: "agent" });
    await vi.advanceTimersByTimeAsync(25_000);
    expect((await defaultWait).body).toMatchObject({ state: "open", wait_timed_out: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM feedback_collection_events").get()).toEqual({ n: before });
    expect((await router.invoke({ method: "GET", url: `/api/asks/${askId}/wait?timeout_ms=0`, credential: "agent" })).status).toBe(200);
    const terminalWait = router.invoke({ method: "GET", url: `/api/asks/${askId}/wait?timeout_ms=55000`, credential: "agent" });
    await router.invoke({ method: "DELETE", url: `/api/asks/${askId}`, credential: "operator", transport: "http" });
    await vi.advanceTimersByTimeAsync(75);
    expect((await terminalWait).body).toMatchObject({ state: "cancelled" });
    expect((await router.invoke({ method: "GET", url: `/api/asks/${askId}/wait?timeout_ms=55001`, credential: "agent" })).status).toBe(400);
  });
});
