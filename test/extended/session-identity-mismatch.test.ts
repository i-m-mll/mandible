// Issue 499c148 — the daemon compares a session's authenticated client user
// against its binding-resolved user at registration, records the disagreement
// on the session row, and hands the connecting agent a warning immediately
// instead of letting it surface as a 403 at the auth-request gate hours later.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, setDb, type Db } from "../../src/db.js";
import { Router, type RouteHandler, type RouteRegistrar } from "../../src/server.js";
import { registerSessionRoutes } from "../../src/routes/sessions.js";
import { registerConsoleRoutes } from "../../src/routes/console.js";
import { getChannelRegistry } from "../../src/channel-registry.js";
import { SessionRegistry } from "../../src/registry.js";
import { addProject } from "../../src/ledger/project-registry.js";
import { LedgerStore } from "../../src/ledger/store.js";
import { SYSTEM_ACTOR } from "../helpers/ledger-fixtures.js";
import { ClientAuthenticator } from "../../src/client-auth/authenticator.js";
import { addBinding, createUser, removeBinding, setupOperator } from "../../src/users/store.js";
import {
  evaluateSessionIdentity,
  readSessionIdentityMismatch,
  readSessionIdentityMismatchBatch,
} from "../../src/identity/session-mismatch.js";

let tempDir = "";
let db: Db;
let authenticator: ClientAuthenticator;
let router: Router;
let operatorToken = "";
let agentToken = "";
let operatorId = "";
let agentId = "";

type RegisteredRoute = { method: string; path: string; handler: RouteHandler };

function makeRegistrar(): { server: RouteRegistrar; routes: RegisteredRoute[] } {
  const routes: RegisteredRoute[] = [];
  const register = (method: string) => (path: string, handler: RouteHandler) => {
    routes.push({ method, path, handler });
  };
  return {
    routes,
    server: {
      get: register("GET"),
      post: register("POST"),
      patch: register("PATCH"),
      put: register("PUT"),
      delete: register("DELETE"),
    } as unknown as RouteRegistrar,
  };
}

function makeJsonResponse(): {
  res: { status: (code: number) => unknown; json: (payload: unknown) => void };
  payloads: Array<{ code: number; payload: unknown }>;
} {
  const payloads: Array<{ code: number; payload: unknown }> = [];
  let currentCode = 200;
  return {
    payloads,
    res: {
      status(code: number) {
        currentCode = code;
        return this;
      },
      json(payload: unknown) {
        payloads.push({ code: currentCode, payload });
      },
    },
  };
}

/** Register a session as the given bearer, exactly as the channel server does. */
function register(credential: string | null, id = "channel-session") {
  return router.invoke({
    method: "POST",
    url: "/api/sessions/register",
    body: { id, app: "claude", status: "active" },
    credential,
    transport: "http",
  });
}

function recordToolCall(credential: string | null, id = "channel-session") {
  return router.invoke({
    method: "POST",
    url: `/api/sessions/${id}/channel-tool-call`,
    body: { tool_name: "mandible_check_inbox" },
    credential,
    transport: "http",
  });
}

beforeEach(() => {
  // The channel registry is a process singleton; drop leftovers so each test
  // starts with the same in-memory state against its own fresh database.
  const channelRegistry = getChannelRegistry();
  for (const session of channelRegistry.getAll()) {
    channelRegistry.disconnect(session.session_id);
  }
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-session-identity-"));
  db = openDb(path.join(tempDir, "mandible.db"));
  setDb(db);
  authenticator = new ClientAuthenticator(db, { secretsDir: path.join(tempDir, "client-auth") });

  const operator = setupOperator(db, { display_name: "Op", email: "op@example.com" });
  operatorId = operator.id;
  operatorToken = authenticator.mintApiToken(operator.id, { label: "mll-cli" }).token;

  const agent = createUser(db, {
    slug: "claude-code",
    kind: "agent",
    display_name: "Claude Code",
  });
  agentId = agent.id;
  agentToken = authenticator.mintApiToken(agent.id, { label: "claude-code-agent" }).token;
  // The binding that makes a `claude` session resolve to the agent user.
  addBinding(db, agent.id, { binding_type: "app_name", value: "claude" });

  router = new Router({ clientAuth: authenticator });
  registerSessionRoutes(router, new SessionRegistry(db));
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("session identity mismatch detection", () => {
  it("flags a session whose client token and app binding resolve to different users", async () => {
    const response = await register(operatorToken);

    expect(response.status).toBe(200);
    const body = response.body as { identity_warning: Record<string, unknown> | null };
    expect(body.identity_warning).toMatchObject({
      code: "client_session_identity_mismatch",
      client_method: "api_token",
      client: { user_id: operatorId, slug: "op", kind: "human" },
      binding: { user_id: agentId, slug: "claude-code", kind: "agent" },
    });
    expect(String(body.identity_warning?.message)).toContain("mandible user whoami");
    // The message must describe the gate that actually exists: `resolveAuthRequester`
    // refuses only when both sides resolve and disagree, so an unconditional
    // "will be refused" would send an operator hunting for a block that will not
    // happen once the binding side stops resolving.
    expect(String(body.identity_warning?.message))
      .toContain("refused while both identities resolve and disagree");
    expect(String(body.identity_warning?.message)).not.toContain("until the two agree");

    const stored = readSessionIdentityMismatch(db, "channel-session");
    expect(stored).toMatchObject({
      client: { user_id: operatorId },
      binding: { user_id: agentId },
    });
    expect(stored?.detected_at).toBeGreaterThan(0);
  });

  it("does not flag a session whose client token matches its binding", async () => {
    const response = await register(agentToken);

    expect((response.body as { identity_warning: unknown }).identity_warning).toBeNull();
    expect(readSessionIdentityMismatch(db, "channel-session")).toBeNull();
  });

  it("clears the flag when a later registration is consistent", async () => {
    await register(operatorToken);
    expect(readSessionIdentityMismatch(db, "channel-session")).not.toBeNull();

    const response = await register(agentToken);

    expect((response.body as { identity_warning: unknown }).identity_warning).toBeNull();
    expect(readSessionIdentityMismatch(db, "channel-session")).toBeNull();
    const row = db
      .prepare("SELECT identity_mismatch_at, identity_mismatch_json FROM sessions WHERE id = ?")
      .get("channel-session");
    expect(row).toEqual({ identity_mismatch_at: null, identity_mismatch_json: null });
  });

  it("rejects unauthenticated registration before mismatch evaluation", async () => {
    const response = await register(null);

    expect(response).toMatchObject({ status: 401, body: { error: "authentication_required" } });
    expect(readSessionIdentityMismatch(db, "channel-session")).toBeNull();
    expect(evaluateSessionIdentity(db, "channel-session", null)).toEqual({
      status: "indeterminate",
      reason: "no_client_identity",
    });
  });

  it("treats a session with no resolvable binding as indeterminate, not a mismatch", async () => {
    const response = await router.invoke({
      method: "POST",
      url: "/api/sessions/register",
      body: { id: "unbound-session", app: "some-unbound-app", status: "active" },
      credential: operatorToken,
      transport: "http",
    });

    expect((response.body as { identity_warning: unknown }).identity_warning).toBeNull();
    expect(readSessionIdentityMismatch(db, "unbound-session")).toBeNull();
  });

  // A binding that resolves to a non-agent user fails closed to no_match in the
  // resolver, so it can never masquerade as the session's principal — and it is
  // not a mismatch either, because only one side resolved.
  it("does not flag a session whose app binding resolves to a human user", async () => {
    addBinding(db, operatorId, { binding_type: "app_name", value: "operator-shell" });

    const response = await router.invoke({
      method: "POST",
      url: "/api/sessions/register",
      body: { id: "human-bound-session", app: "operator-shell", status: "active" },
      credential: agentToken,
      transport: "http",
    });

    expect((response.body as { identity_warning: unknown }).identity_warning).toBeNull();
    expect(readSessionIdentityMismatch(db, "human-bound-session")).toBeNull();
  });

  it("leaves an existing flag alone when a later request cannot resolve both sides", async () => {
    await register(operatorToken);

    const response = await register(null);

    // Unauthenticated ingress is rejected and is not evidence the
    // misconfiguration was fixed, so the recorded flag survives.
    expect(response).toMatchObject({ status: 401, body: { error: "authentication_required" } });
    expect(readSessionIdentityMismatch(db, "channel-session")).not.toBeNull();
  });

  // The rebind fix. Re-registering under an app that binds to a human leaves the
  // resolver at no_match (it constrains session claims to agent principals), so
  // the check is indeterminate — but the recorded flag names a binding this
  // session no longer has, and keeping it would keep asserting a disagreement
  // nobody can verify.
  it("retires the flag when the session is re-registered under a different app", async () => {
    await register(operatorToken);
    expect(readSessionIdentityMismatch(db, "channel-session")).not.toBeNull();
    addBinding(db, operatorId, { binding_type: "app_name", value: "operator-shell" });

    const response = await router.invoke({
      method: "POST",
      url: "/api/sessions/register",
      body: { id: "channel-session", app: "operator-shell", status: "active" },
      credential: operatorToken,
      transport: "http",
    });

    expect((response.body as { identity_warning: unknown }).identity_warning).toBeNull();
    expect(readSessionIdentityMismatch(db, "channel-session")).toBeNull();
  });

  // The case the flag exists for: the app is untouched and the token is still
  // wrong; the binding merely stopped resolving. Clearing here would be the
  // regression the transition rule must not cause.
  it("keeps the flag when the app is unchanged and its binding stops resolving", async () => {
    await register(operatorToken);
    expect(readSessionIdentityMismatch(db, "channel-session")).not.toBeNull();
    const binding = db
      .prepare("SELECT id FROM user_bindings WHERE user_id = ? AND value = ?")
      .get(agentId, "claude") as { id: string };
    removeBinding(db, binding.id);

    const response = await register(operatorToken);

    expect((response.body as { identity_warning: Record<string, unknown> | null }).identity_warning)
      .toMatchObject({ binding: { user_id: agentId }, client: { user_id: operatorId } });
    expect(readSessionIdentityMismatch(db, "channel-session")).not.toBeNull();
  });

  it("catches a token swapped mid-session on the channel tool-call route", async () => {
    await register(agentToken);
    expect(readSessionIdentityMismatch(db, "channel-session")).toBeNull();

    const response = await recordToolCall(operatorToken);

    expect(response.status).toBe(200);
    expect((response.body as { identity_warning: Record<string, unknown> | null }).identity_warning)
      .toMatchObject({ binding: { user_id: agentId }, client: { user_id: operatorId } });
    expect(readSessionIdentityMismatch(db, "channel-session")).not.toBeNull();
  });

  it("checks identity when an authenticated client links a session to an issue", async () => {
    await register(agentToken);
    const project = addProject(db, { project_key: "mandible", display_name: "Mandible" });
    const issue = new LedgerStore(db).createIssue({ ...SYSTEM_ACTOR, project_id: project.id, title: "Linked" });

    const response = await router.invoke({
      method: "POST",
      url: "/api/sessions/channel-session/issues",
      body: { issue_id: issue.id, repo_id: "mandible" },
      credential: operatorToken,
      transport: "http",
    });

    expect(response.status).toBe(200);
    expect((response.body as { identity_warning: Record<string, unknown> | null }).identity_warning)
      .toMatchObject({ code: "client_session_identity_mismatch" });
  });

  it("exposes the flag on the sessions read surface", async () => {
    await register(operatorToken);

    const listed = await router.invoke({ method: "GET", url: "/api/sessions/channel-session" });

    expect((listed.body as { identity_mismatch: Record<string, unknown> | null }).identity_mismatch)
      .toMatchObject({ client: { user_id: operatorId }, binding: { user_id: agentId } });
  });

  it("exposes the flag on the channel-connected listing", async () => {
    await register(operatorToken);
    await recordToolCall(operatorToken);

    const listed = await router.invoke({
      method: "GET",
      url: "/api/sessions/channel-connected",
    });

    const sessions = (listed.body as {
      sessions: Array<{ id: string; identity_mismatch: Record<string, unknown> | null }>;
    }).sessions;
    expect(sessions.find((row) => row.id === "channel-session")?.identity_mismatch)
      .toMatchObject({ client: { user_id: operatorId } });
  });

  // The listing reads every row's flag in one batched statement, so it has to
  // keep them attached to the right sessions: flagged, clean, and console rows
  // with no Mandible session at all, in one response.
  it("projects the flag onto the console session list via mandible_session_id", async () => {
    await register(operatorToken);
    await register(agentToken, "clean-session");

    const consoleSessions = [
      { id: "console-1", mandible_session_id: "channel-session" },
      { id: "console-2", mandible_session_id: "clean-session" },
      { id: "console-3", mandible_session_id: null },
      { id: "console-4", mandible_session_id: "never-registered" },
    ].map((row) => ({
      ...row,
      is_operator: false,
      owner_user_id: null,
      transport_lane: "channel",
    }));

    const { server, routes } = makeRegistrar();
    registerConsoleRoutes(
      server,
      { getAll: () => consoleSessions.map((meta) => ({ meta })) } as never,
    );
    const route = routes.find(
      (item) => item.method === "GET" && item.path === "/api/console/sessions",
    );
    const { res, payloads } = makeJsonResponse();

    route?.handler({ params: {}, query: {}, body: null } as never, res as never);

    const listed = (payloads[0].payload as {
      sessions: Array<{ id: string; identity_mismatch: Record<string, unknown> | null }>;
    }).sessions;
    const byId = new Map(listed.map((row) => [row.id, row.identity_mismatch]));
    expect(byId.get("console-1")).toMatchObject({
      client: { user_id: operatorId },
      binding: { user_id: agentId },
    });
    expect(byId.get("console-2")).toBeNull();
    expect(byId.get("console-3")).toBeNull();
    expect(byId.get("console-4")).toBeNull();
  });

  it("reads many sessions' flags in one batch, keyed by session id", async () => {
    await register(operatorToken);
    await register(agentToken, "clean-session");

    const found = readSessionIdentityMismatchBatch(db, [
      "channel-session",
      "clean-session",
      "never-registered",
      // Duplicates and empties must not produce extra or malformed lookups.
      "channel-session",
      "",
    ]);

    expect([...found.keys()]).toEqual(["channel-session"]);
    expect(found.get("channel-session")).toMatchObject({
      client: { user_id: operatorId },
      binding: { user_id: agentId },
    });
    expect(readSessionIdentityMismatchBatch(db, [])).toEqual(new Map());
  });
});
