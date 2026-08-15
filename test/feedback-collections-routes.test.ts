import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setSetting } from "../src/client-auth/settings-kv.js";
import { migrate, type Db } from "../src/db.js";
import { addGrant } from "../src/permissions/store.js";
import { readAsk } from "../src/feedback/asks.js";
import { listFeedbackCollections } from "../src/feedback/collections.js";
import { registerAskRoutes } from "../src/routes/asks.js";
import { registerFeedbackRoutes } from "../src/routes/feedback.js";
import { Router, type ClientAuthGate, type ResolvedClientIdentity } from "../src/server.js";
import { createUser, OPERATOR_SETTING_KEY } from "../src/users/store.js";

let db: Db;
let router: Router;
let operatorId: string;
let agentId: string;
let responderId: string;

class SlugGate implements ClientAuthGate {
  authenticate(credential: string | null | undefined): ResolvedClientIdentity | null {
    if (!credential) return null;
    const row = db.prepare("SELECT id, slug FROM users WHERE slug = ? AND status = 'active'")
      .get(credential) as { id: string; slug: string } | undefined;
    return row ? {
      user_id: row.id,
      slug: row.slug,
      method: "api_token",
      credential_id: null,
      source: "in_process",
    } : null;
  }
  mode() { return "strict" as const; }
  recordUnattributedWrite() {}
}

function askPacket(requestKey = "route-ask") {
  return {
    request_key: requestKey,
    session_id: "collection-route-session",
    responder_user_ids: [responderId],
    expires_at: 4_000_000_000_000,
    items: [{
      client_item_key: "answer",
      item_kind: "item",
      title: "Question",
      prompt: "Sensitive prompt",
      response_type: "free_text",
      required: true,
    }],
  };
}

async function createAsk(requestKey?: string): Promise<string> {
  const response = await router.invoke({
    method: "POST",
    url: "/api/asks",
    credential: "agent",
    body: askPacket(requestKey),
  });
  expect(response.status).toBe(201);
  return (response.body as { ask_id: string }).ask_id;
}

function insertRecurringCollection(): void {
  db.prepare(
    `INSERT INTO feedback_collections
       (id, kind, interaction_mode, source, expires_at, created_at, tombstoned_at)
     VALUES ('recurring', 'recurring_feed', 'immediate_per_item', 'daily-digest', NULL, 10, NULL)`,
  ).run();
  db.prepare(
    `INSERT INTO feedback_recurring_profiles
       (collection_id, source_namespace, item_expiry_ms, created_at, updated_at)
     VALUES ('recurring', 'daily-digest', 1000, 10, 10)`,
  ).run();
  db.prepare(
    `INSERT INTO feedback_collection_events
       (id, collection_id, operation, previous_event_id, actor_user_id, metadata_json, created_at)
     VALUES ('recurring-open', 'recurring', 'opened', NULL, NULL, '{}', 10)`,
  ).run();
}

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  operatorId = createUser(db, { slug: "operator", kind: "human", display_name: "Operator" }).id;
  setSetting(db, OPERATOR_SETTING_KEY, operatorId);
  agentId = createUser(db, { slug: "agent", kind: "agent", display_name: "Agent" }).id;
  responderId = createUser(db, { slug: "responder", kind: "human", display_name: "Responder" }).id;
  createUser(db, { slug: "outsider", kind: "human", display_name: "Outsider" });
  db.prepare(
    "INSERT INTO sessions (id, app, status, owner_user_id) VALUES ('collection-route-session', 'codex', 'active', ?)",
  ).run(agentId);
  addGrant(db, {
    subject_type: "user",
    subject: agentId,
    resource_type: "global",
    permission: "ask.create",
  });
  router = new Router({ clientAuth: new SlugGate() });
  registerAskRoutes(router, db);
  registerFeedbackRoutes(router, db);
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe("feedback collection routes", () => {
  it("allows collection reads and denies collection mutations over file RPC", () => {
    expect(router.listRoutePolicies().filter((route) => route.path.startsWith("/api/feedback")))
      .toEqual([
        expect.objectContaining({ method: "GET", path: "/api/feedback/collections", fileRpc: "allow" }),
        expect.objectContaining({ method: "PATCH", path: "/api/feedback/collections/:id", fileRpc: "deny" }),
      ]);
  });

  it("returns recurring feeds and bounded asks through one projection and defaults state to all", async () => {
    insertRecurringCollection();
    const askId = await createAsk();
    const response = await router.invoke({
      method: "GET",
      url: "/api/feedback/collections",
      credential: "operator",
      transport: "http",
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ state: "all" });
    const rows = (response.body as { collections: Array<Record<string, unknown>> }).collections;
    expect(rows[0]?.id).toBe(askId);
    expect(rows.map((row) => row.id)).toEqual(expect.arrayContaining(["recurring", askId]));
    expect(rows.find((row) => row.id === "recurring")).toMatchObject({
      kind: "recurring_feed",
      interaction_mode: "immediate_per_item",
      label: "daily-digest",
      state: "open",
      expires_at: null,
      expiry_reversible: 0,
    });
    expect(rows.find((row) => row.id === askId)).toMatchObject({
      kind: "bounded_ask",
      interaction_mode: "explicit_submit",
      label: "route-ask",
      state: "open",
      expires_at: 4_000_000_000_000,
      item_count: 1,
    });
    expect(db.prepare("SELECT expires_at FROM feedback_collections WHERE id = ?").get(askId))
      .toEqual({ expires_at: null });
    expect(db.prepare("SELECT expires_at FROM feedback_ask_sessions WHERE collection_id = ?").get(askId))
      .toEqual({ expires_at: 4_000_000_000_000 });
    expect(JSON.stringify(response.body)).not.toContain("Sensitive prompt");
  });

  it("filters all/open/expired and scopes non-operators to their ask audience", async () => {
    insertRecurringCollection();
    const openAskId = await createAsk("open-ask");
    const expiredAskId = await createAsk("expired-ask");
    const expiredAskCreatedAt = (db.prepare(
      "SELECT created_at FROM feedback_ask_sessions WHERE collection_id = ?",
    ).get(expiredAskId) as { created_at: number }).created_at;
    db.prepare("UPDATE feedback_ask_sessions SET expires_at = ? WHERE collection_id = ?")
      .run(expiredAskCreatedAt + 1, expiredAskId);
    vi.useFakeTimers();
    vi.setSystemTime(expiredAskCreatedAt + 2);

    const ids = async (credential: string, state?: string) => {
      const response = await router.invoke({
        method: "GET",
        url: `/api/feedback/collections${state ? `?state=${state}` : ""}`,
        credential,
        transport: "http",
      });
      expect(response.status).toBe(200);
      return (response.body as { collections: Array<{ id: string }> }).collections.map((row) => row.id);
    };
    expect(await ids("operator", "open")).toEqual(expect.arrayContaining(["recurring", openAskId]));
    expect(await ids("operator", "open")).not.toContain(expiredAskId);
    expect(await ids("operator", "expired")).toEqual([expiredAskId]);
    expect(await ids("responder")).toEqual(expect.arrayContaining([openAskId, expiredAskId]));
    expect(await ids("responder")).toContain("recurring");
    expect(await ids("outsider")).toEqual(["recurring"]);
  });

  it("round-trips expiry through each kind's owner without duplicating ask expiry", async () => {
    insertRecurringCollection();
    const askId = await createAsk();
    const askCreatedAt = (db.prepare(
      "SELECT created_at FROM feedback_ask_sessions WHERE collection_id = ?",
    ).get(askId) as { created_at: number }).created_at;
    vi.useFakeTimers();
    vi.setSystemTime(askCreatedAt + 2);
    const expire = await router.invoke({
      method: "PATCH",
      url: `/api/feedback/collections/${askId}`,
      credential: "responder",
      transport: "http",
      body: { expires_at: askCreatedAt + 1 },
    });
    expect(expire.status).toBe(200);
    expect(expire.body).toMatchObject({
      id: askId, state: "expired", expires_at: askCreatedAt + 1, item_count: 1,
    });
    expect(db.prepare("SELECT expires_at FROM feedback_ask_sessions WHERE collection_id = ?").get(askId))
      .toEqual({ expires_at: askCreatedAt + 1 });
    expect(db.prepare("SELECT expires_at FROM feedback_collections WHERE id = ?").get(askId))
      .toEqual({ expires_at: null });
    expect((await router.invoke({
      method: "GET", url: `/api/asks/${askId}`, credential: "responder", transport: "http",
    })).body).toMatchObject({ state: "expired", expires_at: askCreatedAt + 1 });

    const reopen = await router.invoke({
      method: "PATCH",
      url: `/api/feedback/collections/${askId}`,
      credential: "responder",
      transport: "http",
      body: { expires_at: null },
    });
    expect(reopen.status).toBe(200);
    expect(reopen.body).toMatchObject({
      id: askId, state: "open", expires_at: null, item_count: 1, expiry_reversible: 1,
    });
    expect(db.prepare("SELECT expires_at FROM feedback_ask_sessions WHERE collection_id = ?").get(askId))
      .toEqual({ expires_at: null });
    expect(db.prepare("SELECT expires_at FROM feedback_collections WHERE id = ?").get(askId))
      .toEqual({ expires_at: null });
    expect((await router.invoke({
      method: "GET", url: `/api/asks/${askId}`, credential: "responder", transport: "http",
    })).body).toMatchObject({ state: "open", expires_at: null });
    expect(db.prepare("SELECT COUNT(*) AS n FROM feedback_items WHERE collection_id = ?").get(askId))
      .toEqual({ n: 1 });
    expect(db.prepare(
      "SELECT operation FROM feedback_collection_events WHERE collection_id = ? ORDER BY created_at, rowid",
    ).all(askId)).toEqual([{ operation: "opened" }, { operation: "expired" }, { operation: "opened" }]);

    const expireRecurring = await router.invoke({
      method: "PATCH",
      url: "/api/feedback/collections/recurring",
      credential: "operator",
      transport: "http",
      body: { expires_at: 1 },
    });
    expect(expireRecurring.status).toBe(200);
    expect(expireRecurring.body).toMatchObject({ id: "recurring", state: "expired", expires_at: 1 });
    expect(db.prepare("SELECT expires_at FROM feedback_collections WHERE id = 'recurring'").get())
      .toEqual({ expires_at: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM feedback_ask_sessions WHERE collection_id = 'recurring'").get())
      .toEqual({ n: 0 });

    const reopenRecurring = await router.invoke({
      method: "PATCH",
      url: "/api/feedback/collections/recurring",
      credential: "operator",
      transport: "http",
      body: { expires_at: null },
    });
    expect(reopenRecurring.status).toBe(200);
    expect(reopenRecurring.body).toMatchObject({ id: "recurring", state: "open", expires_at: null });
    expect(db.prepare("SELECT expires_at FROM feedback_collections WHERE id = 'recurring'").get())
      .toEqual({ expires_at: null });
  });

  it("keeps last-updated stable when ask detail materializes an already-derived expiry", async () => {
    const askId = await createAsk();
    const createdAt = (db.prepare(
      "SELECT created_at FROM feedback_collections WHERE id = ?",
    ).get(askId) as { created_at: number }).created_at;
    const expiresAt = createdAt + 1_000;
    db.prepare("UPDATE feedback_ask_sessions SET expires_at = ? WHERE collection_id = ?")
      .run(expiresAt, askId);

    const before = listFeedbackCollections(db, {
      operator: true,
      now: expiresAt + 1_000,
    }).find((row) => row.id === askId);
    expect(before).toMatchObject({ state: "expired", updated_at: expiresAt });

    expect(readAsk(db, askId, { now: expiresAt + 5_000 })?.ask.state).toBe("expired");
    const after = listFeedbackCollections(db, {
      operator: true,
      now: expiresAt + 5_000,
    }).find((row) => row.id === askId);
    expect(after).toMatchObject({ state: "expired", updated_at: expiresAt });
  });

  it("returns recurring feeds but no asks to anonymous and out-of-audience callers", async () => {
    insertRecurringCollection();
    await createAsk();
    for (const credential of [undefined, "outsider"] as const) {
      const response = await router.invoke({
        method: "GET",
        url: "/api/feedback/collections",
        credential,
        transport: "http",
      });
      expect(response.status).toBe(200);
      expect((response.body as { collections: Array<{ id: string }> }).collections)
        .toEqual([expect.objectContaining({ id: "recurring" })]);
      expect(JSON.stringify(response.body)).not.toContain("route-ask");
    }
  });

  it("lets a requester agent list its ask over file RPC and keeps PATCH human-only and scoped", async () => {
    insertRecurringCollection();
    const askId = await createAsk();
    expect(router.resolveFileRpcPolicy("GET", "/api/feedback/collections")).toBe(true);
    const requesterRead = await router.invoke({
      method: "GET",
      url: "/api/feedback/collections",
      credential: "agent",
      transport: "file-rpc",
    });
    expect(requesterRead.status).toBe(200);
    expect((requesterRead.body as { collections: Array<{ id: string }> }).collections.map(({ id }) => id))
      .toEqual(expect.arrayContaining(["recurring", askId]));

    expect((await router.invoke({
      method: "PATCH",
      url: `/api/feedback/collections/${askId}`,
      credential: "outsider",
      transport: "http",
      body: { expires_at: null },
    })).status).toBe(404);
    expect((await router.invoke({
      method: "PATCH",
      url: `/api/feedback/collections/${askId}`,
      credential: "agent",
      transport: "http",
      body: { expires_at: null },
    })).status).toBe(403);
    expect(router.resolveFileRpcPolicy("PATCH", "/api/feedback/collections/ask")).toBe(false);
  });
});
