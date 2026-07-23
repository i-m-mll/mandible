import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, setDb, type Db } from "../src/db.js";
import { createServer, Router } from "../src/server.js";
import { SseManager } from "../src/sse.js";
import { registerClientAuthRoutes } from "../src/routes/client-auth.js";
import { registerUserRoutes } from "../src/routes/users.js";
import { registerSettingsRoutes } from "../src/routes/settings.js";
import { registerPresetRoutes } from "../src/routes/presets.js";
import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import {
  authorizeManagedSessionWebSocket,
  authorizeOperatorWebSocket,
  credentialFromWebSocketProtocols,
} from "../src/client-auth/authz.js";
import { setClientAuthMode } from "../src/client-auth/mode.js";
import { addBinding, createUser, setupOperator } from "../src/users/store.js";

let tempDir = "";
let db: Db;
let authenticator: ClientAuthenticator;
let server: http.Server;
let sse: SseManager;
let port = 0;

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** Set up the operator and return a valid operator bearer token. */
function operatorToken(): string {
  const operator = setupOperator(db, { display_name: "Op", email: "op@example.com" });
  return authenticator.mintApiToken(operator.id, { label: "test-operator" }).token;
}

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-client-auth-server-"));
  db = openDb(path.join(tempDir, "mandible.db"));
  setDb(db);
  authenticator = new ClientAuthenticator(db, { secretsDir: path.join(tempDir, "client-auth") });
  const router = new Router({ clientAuth: authenticator });
  router.post("/api/write", (req, res) => {
    res.json({ ok: true, identity: req.client_identity ?? null });
  }, { fileRpc: "allow" });
  router.get("/api/read", (_req, res) => {
    res.json({ ok: true });
  }, { fileRpc: "allow" });
  registerClientAuthRoutes(router, authenticator);
  registerUserRoutes(router, authenticator);
  registerSettingsRoutes(router);
  registerPresetRoutes(router, {
    isCredentialBearing: (id: string) => id === "operator-session" || id === "agent-session",
  });

  sse = new SseManager();
  server = createServer({
    db,
    sse,
    logger: () => undefined,
    version: "test",
    router,
    getStartupInfo: () => null,
    clientAuth: authenticator,
  });
  port = await listen(server);
});

afterEach(async () => {
  await close(server);
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("client-auth over HTTP (compat regression)", () => {
  it("an unauthenticated local mutation still succeeds with no new required headers", async () => {
    const response = await requestJson("POST", "/api/write", { hello: "cli" });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, identity: null });
  });

  it("a garbage Authorization header resolves to anonymous, identical to no header", async () => {
    const withGarbage = await requestJson("POST", "/api/write", { x: 1 }, {
      Authorization: "Bearer not-a-real-token",
    });
    const without = await requestJson("POST", "/api/write", { x: 1 });
    expect(withGarbage.status).toBe(200);
    expect(withGarbage.body).toEqual(without.body);
    expect(withGarbage.body).toMatchObject({ ok: true, identity: null });
  });

  it("resolves an Authorization bearer header to the token's user", async () => {
    const user = createUser(db, { slug: "agent-x", kind: "agent", display_name: "Agent X" });
    const { token } = authenticator.mintApiToken(user.id);
    const response = await requestJson("POST", "/api/write", { hello: "cli" }, bearer(token));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      identity: { slug: "agent-x", method: "api_token", source: "http_bearer" },
    });
  });

  it("surfaces mode and the unattributed-write ratchet on /api/health", async () => {
    await requestJson("POST", "/api/write", {});
    const health = await requestJson("GET", "/api/health");
    expect(health.status).toBe(200);
    expect((health.body as { client_auth?: unknown }).client_auth).toMatchObject({
      mode: "compat",
      telemetry: { unattributed_writes_total: 1 },
    });
  });
});

describe("client-auth: identity configuration authorization", () => {
  it("does not let anonymous compat callers or non-operators control agent identity bindings", async () => {
    const operatorBearer = operatorToken();
    const agent = createUser(db, { slug: "agent-binding", kind: "agent", display_name: "Agent" });
    const { token: agentToken } = authenticator.mintApiToken(agent.id);
    const binding = addBinding(db, agent.id, { binding_type: "app_name", value: "claude" });

    const anonymousCreate = await requestJson("POST", "/api/users", {
      slug: "attacker", kind: "agent", display_name: "Attacker",
    });
    expect(anonymousCreate.status).toBe(401);

    const selfBind = await requestJson(
      "POST",
      `/api/users/${agent.id}/bindings`,
      { binding_type: "app_name", value: "codex" },
      bearer(agentToken),
    );
    expect(selfBind.status).toBe(403);

    const selfRemove = await requestJson(
      "DELETE",
      `/api/users/bindings/${binding.id}`,
      undefined,
      bearer(agentToken),
    );
    expect(selfRemove.status).toBe(403);

    const operatorRemove = await requestJson(
      "DELETE",
      `/api/users/bindings/${binding.id}`,
      undefined,
      bearer(operatorBearer),
    );
    expect(operatorRemove.status).toBe(200);
  });
});

describe("client-auth: no token material in served HTML (finding 1)", () => {
  it("GET / injects only instance metadata, never a token", async () => {
    const token = operatorToken();
    authenticator.refreshBootstrapTokenFile();
    const response = await requestRaw("GET", "/");
    expect(response.status).toBe(200);
    expect(response.text).not.toContain(token);
    expect(response.text).not.toContain("mandible_pat_");
    expect(response.text).not.toContain("client_auth");
  });
});

describe("client-auth: dashboard handshake (finding 1/3)", () => {
  it("compat: never issues an operator token anonymously", async () => {
    setupOperator(db, { display_name: "Op", email: "op@example.com" });
    const response = await requestJson("POST", "/api/client-auth/handshake");
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: "authentication_required" });
  });

  it("returns 401 rather than exposing operator state to an anonymous caller", async () => {
    const response = await requestJson("POST", "/api/client-auth/handshake");
    expect(response.status).toBe(401);
  });

  it("strict: rejects an anonymous handshake (needs an already-valid token)", async () => {
    setupOperator(db, { display_name: "Op", email: "op@example.com" });
    setClientAuthMode(db, "strict");
    const response = await requestJson("POST", "/api/client-auth/handshake");
    expect(response.status).toBe(401);
  });

  it("strict: rejects an authenticated non-operator instead of upgrading it", async () => {
    setupOperator(db, { display_name: "Op", email: "op@example.com" });
    const user = createUser(db, { slug: "agent-a", kind: "agent", display_name: "Agent A" });
    const { token } = authenticator.mintApiToken(user.id);
    setClientAuthMode(db, "strict");
    const response = await requestJson(
      "POST",
      "/api/client-auth/handshake",
      undefined,
      bearer(token),
    );
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: "operator_required" });
  });

  it("rotates an authenticated operator session and restores it after restart", async () => {
    const opToken = operatorToken();
    const response = await requestJson(
      "POST",
      "/api/client-auth/handshake",
      undefined,
      bearer(opToken),
    );
    expect(response.status).toBe(200);
    const token = (response.body as { token: string }).token;
    expect(token).toMatch(/^mandible_pat_/);
    const persisted = fs.readFileSync(
      path.join(tempDir, "client-auth", "dashboard-session.json"),
      "utf8",
    );
    expect(persisted).not.toContain(token);
    expect(persisted).toContain("token_fingerprint");

    const restarted = new ClientAuthenticator(db, {
      secretsDir: path.join(tempDir, "client-auth"),
    });
    expect(restarted.authenticate(token, "http_bearer")).toMatchObject({
      user_id: setupOperator(db).id,
      method: "ephemeral",
    });
  });

  it("renews an expired dashboard only at the handshake during a bounded grace", () => {
    let now = 1_000;
    const operator = setupOperator(db, { display_name: "Op", email: "op@example.com" });
    const renewalDir = path.join(tempDir, "renewal-auth");
    const expiring = new ClientAuthenticator(db, {
      secretsDir: renewalDir,
      dashboardSessionTtlMs: 10,
      dashboardSessionRenewalGraceMs: 20,
      now: () => now,
    });
    const durable = expiring.mintApiToken(operator.id).token;
    const identity = expiring.authenticate(durable, "http_bearer");
    expect(identity).not.toBeNull();
    const first = expiring.issueDashboardToken(identity!);

    now = 1_011;
    expect(expiring.authenticate(first.token, "http_bearer", {
      method: "POST",
      pathname: "/api/write",
    })).toBeNull();

    const restarted = new ClientAuthenticator(db, {
      secretsDir: renewalDir,
      dashboardSessionTtlMs: 10,
      dashboardSessionRenewalGraceMs: 20,
      now: () => now,
    });
    const renewalIdentity = restarted.authenticate(first.token, "http_bearer", {
      method: "POST",
      pathname: "/api/client-auth/handshake",
    });
    expect(renewalIdentity).toMatchObject({ user_id: operator.id });
    const rotated = restarted.issueDashboardToken(renewalIdentity!);
    expect(restarted.authenticate(rotated.token, "http_bearer", {
      method: "POST",
      pathname: "/api/write",
    })).toMatchObject({ user_id: operator.id });

    now = 1_042;
    expect(restarted.authenticate(rotated.token, "http_bearer", {
      method: "POST",
      pathname: "/api/client-auth/handshake",
    })).toBeNull();
  });
});

describe("client-auth: operator WebSocket credential transport", () => {
  it("extracts the bearer from a subprotocol header without a URL token", () => {
    expect(credentialFromWebSocketProtocols(
      "mandible, mandible-auth.mandible_pat_secret",
    )).toBe("mandible_pat_secret");
    expect(credentialFromWebSocketProtocols("mandible")).toBeNull();
  });

  it("admits only the operator token to an operator terminal upgrade", () => {
    const operator = setupOperator(db, { display_name: "Op", email: "op@example.com" });
    const agent = createUser(db, { slug: "agent-ws", kind: "agent", display_name: "Agent WS" });
    const operatorBearer = authenticator.mintApiToken(operator.id).token;
    const agentBearer = authenticator.mintApiToken(agent.id).token;

    expect(authorizeOperatorWebSocket(
      db,
      authenticator,
      `mandible, mandible-auth.${operatorBearer}`,
      "/terminal/operator",
    )).toBe(true);
    expect(authorizeOperatorWebSocket(
      db,
      authenticator,
      `mandible, mandible-auth.${agentBearer}`,
      "/terminal/operator",
    )).toBe(false);
    expect(authorizeOperatorWebSocket(
      db,
      authenticator,
      "mandible",
      "/terminal/operator",
    )).toBe(false);

    expect(authorizeManagedSessionWebSocket(
      db,
      authenticator,
      `mandible, mandible-auth.${agentBearer}`,
      "/terminal/app-bound-agent",
      true,
    )).toBe(false);
    expect(authorizeManagedSessionWebSocket(
      db,
      authenticator,
      `mandible, mandible-auth.${operatorBearer}`,
      "/terminal/app-bound-agent",
      true,
    )).toBe(true);
    expect(authorizeManagedSessionWebSocket(
      db,
      authenticator,
      undefined,
      "/terminal/plain-shell",
      false,
    )).toBe(true);
  });
});

describe("client-auth: token administration requires auth (finding 2)", () => {
  it("compat: minting requires an authenticated identity", async () => {
    const user = createUser(db, { slug: "agent-x", kind: "agent", display_name: "Agent X" });
    const response = await requestJson("POST", `/api/users/${user.id}/tokens`, {});
    expect(response.status).toBe(401);
  });

  it("a non-operator may mint for themselves but not for another user", async () => {
    const userA = createUser(db, { slug: "agent-a", kind: "agent", display_name: "Agent A" });
    const userB = createUser(db, { slug: "agent-b", kind: "agent", display_name: "Agent B" });
    const { token } = authenticator.mintApiToken(userA.id);

    const self = await requestJson("POST", `/api/users/${userA.id}/tokens`, {}, bearer(token));
    expect(self.status).toBe(201);

    const other = await requestJson("POST", `/api/users/${userB.id}/tokens`, {}, bearer(token));
    expect(other.status).toBe(403);
    expect(other.body).toMatchObject({ code: "forbidden" });
  });

  it("the operator may mint for another user", async () => {
    const opToken = operatorToken();
    const user = createUser(db, { slug: "agent-c", kind: "agent", display_name: "Agent C" });
    const response = await requestJson("POST", `/api/users/${user.id}/tokens`, {}, bearer(opToken));
    expect(response.status).toBe(201);
  });
});

describe("client-auth: mode flip requires operator both directions (finding 2)", () => {
  it("rejects an anonymous flip and a non-operator flip", async () => {
    const user = createUser(db, { slug: "agent-a", kind: "agent", display_name: "Agent A" });
    const { token } = authenticator.mintApiToken(user.id);

    const anon = await requestJson("PUT", "/api/client-auth/mode", { mode: "strict" });
    expect(anon.status).toBe(401);

    const nonOperator = await requestJson("PUT", "/api/client-auth/mode", { mode: "strict" }, bearer(token));
    expect(nonOperator.status).toBe(403);
  });

  it("the operator can flip compat->strict and strict->compat", async () => {
    const opToken = operatorToken();
    const toStrict = await requestJson("PUT", "/api/client-auth/mode", { mode: "strict" }, bearer(opToken));
    expect(toStrict.status).toBe(200);
    expect(toStrict.body).toMatchObject({ mode: "strict" });

    // In strict, a non-operator token cannot downgrade.
    const user = createUser(db, { slug: "agent-a", kind: "agent", display_name: "Agent A" });
    const { token } = authenticator.mintApiToken(user.id);
    const downgradeBlocked = await requestJson("PUT", "/api/client-auth/mode", { mode: "compat" }, bearer(token));
    expect(downgradeBlocked.status).toBe(403);

    const toCompat = await requestJson("PUT", "/api/client-auth/mode", { mode: "compat" }, bearer(opToken));
    expect(toCompat.status).toBe(200);
    expect(toCompat.body).toMatchObject({ mode: "compat" });
  });
});

describe("client-auth: settings surface is protected (finding 4)", () => {
  it("403s generic access to client-auth and operator identity keys", async () => {
    // In compat the anonymous write reaches the handler, proving the denylist —
    // not the strict-mode gate — is what refuses it.
    const getKey = await requestJson("GET", "/api/settings/client_auth.mode");
    expect(getKey.status).toBe(403);
    expect(getKey.body).toMatchObject({ code: "identity_setting_protected" });
    const putKey = await requestJson("PUT", "/api/settings/client_auth.mode", { value: "compat" });
    expect(putKey.status).toBe(403);
    expect(putKey.body).toMatchObject({ code: "identity_setting_protected" });

    const operatorTakeover = await requestJson(
      "PUT",
      "/api/settings/user.operator_id",
      { value: "attacker" },
    );
    expect(operatorTakeover.status).toBe(403);
    expect(operatorTakeover.body).toMatchObject({ code: "identity_setting_protected" });

    const caseVariant = await requestJson(
      "PUT",
      "/api/settings/Client_Auth.mode",
      { value: "strict" },
    );
    expect(caseVariant.status).toBe(403);

    db.prepare(
      "UPDATE settings SET value = ? WHERE key = 'console_operator_session_id'",
    ).run("operator-session");
    const operatorSessionRead = await requestJson(
      "GET",
      "/api/settings/console_operator_session_id",
    );
    expect(operatorSessionRead.status).toBe(403);
    const operatorSessionRewrite = await requestJson(
      "PUT",
      "/api/settings/console_operator_session_id",
      { value: "attacker-session" },
    );
    expect(operatorSessionRewrite.status).toBe(403);
    expect(db.prepare(
      "SELECT value FROM settings WHERE key = 'console_operator_session_id'",
    ).pluck().get()).toBe("operator-session");
    const pinnedRewrite = await requestJson(
      "PUT",
      "/api/settings/console_pinned_sessions",
      { value: "[]" },
    );
    expect(pinnedRewrite.status).toBe(403);
  });

  it("hides client_auth.* keys from the generic settings listing", async () => {
    db.prepare(
      "UPDATE settings SET value = ? WHERE key = 'console_operator_session_id'",
    ).run("operator-session");
    setClientAuthMode(db, "strict");
    const all = await requestJson("GET", "/api/settings");
    expect(all.status).toBe(200);
    for (const key of Object.keys(all.body as Record<string, unknown>)) {
      expect(key.startsWith("client_auth.")).toBe(false);
    }
    expect(all.body).not.toHaveProperty("console_operator_session_id");
    expect(all.body).not.toHaveProperty("console_pinned_sessions");
  });
});

describe("client-auth: operator instruction routes", () => {
  it("protects every session-targeted preset surface for the canonical operator", async () => {
    const operator = setupOperator(db, { display_name: "Op", email: "op@example.com" });
    const agent = createUser(db, {
      slug: "agent-presets",
      kind: "agent",
      display_name: "Agent Presets",
    });
    const operatorBearer = authenticator.mintApiToken(operator.id).token;
    const agentBearer = authenticator.mintApiToken(agent.id).token;
    const sessionId = "operator-session";
    db.prepare(
      "UPDATE settings SET value = ? WHERE key = 'console_operator_session_id'",
    ).run(sessionId);

    const attempts: Array<[string, string, unknown]> = [
      ["GET", `/api/presets/union?session_id=${sessionId}`, undefined],
      ["GET", `/api/presets/diffs?session_id=${sessionId}`, undefined],
      ["POST", "/api/presets/diffs", { session_id: sessionId, diff_type: "add" }],
      ["POST", "/api/presets/violations", { sessionId, context: {} }],
      ["GET", `/api/presets/validate-session?session_id=${sessionId}`, undefined],
      ["GET", `/api/console/sessions/${sessionId}/presets`, undefined],
      ["POST", `/api/console/sessions/${sessionId}/presets`, { presetIds: ["guessed"] }],
      ["DELETE", `/api/console/sessions/${sessionId}/presets/guessed`, undefined],
    ];
    for (const [method, path, body] of attempts) {
      const denied = await requestJson(method, path, body, bearer(agentBearer));
      expect(denied.status, `${method} ${path}`).toBe(403);
      expect(denied.body).toMatchObject({ code: "operator_required" });
    }

    const appBoundAttempts = attempts.map(([method, path, body]) => [
      method,
      path.replaceAll(sessionId, "agent-session"),
      body && typeof body === "object"
        ? JSON.parse(JSON.stringify(body).replaceAll(sessionId, "agent-session"))
        : body,
    ] as [string, string, unknown]);
    for (const [method, path, body] of appBoundAttempts) {
      const denied = await requestJson(method, path, body, bearer(agentBearer));
      expect(denied.status, `${method} ${path}`).toBe(403);
      expect(denied.body).toMatchObject({ code: "operator_required" });
    }

    const anonymous = await requestJson(
      "GET",
      `/api/presets/union?session_id=${sessionId}`,
    );
    expect(anonymous.status).toBe(401);
    const allowed = await requestJson(
      "GET",
      `/api/presets/union?session_id=${sessionId}`,
      undefined,
      bearer(operatorBearer),
    );
    expect(allowed.status).toBe(200);
  });
});

describe("client-auth: explicit operator and credential administration", () => {
  it("allows first setup but requires the current operator for later setup", async () => {
    const first = await requestJson("POST", "/api/users/setup", {
      display_name: "Operator",
      email: "op@example.com",
    });
    expect(first.status).toBe(200);
    expect(
      fs.readFileSync(path.join(tempDir, "client-auth", "bootstrap-token"), "utf8").trim(),
    ).toMatch(/^mandible_pat_/);
    const opToken = authenticator.bootstrapToken();
    expect(opToken).toBeTruthy();

    const anonymousUpdate = await requestJson("POST", "/api/users/setup", {
      display_name: "Attacker",
    });
    expect(anonymousUpdate.status).toBe(401);

    const genericPatch = await requestJson(
      "PATCH",
      `/api/users/${(first.body as { user: { id: string } }).user.id}`,
      { status: "retired" },
    );
    expect(genericPatch.status).toBe(401);

    const user = createUser(db, { slug: "agent-a", kind: "agent", display_name: "Agent A" });
    const { token } = authenticator.mintApiToken(user.id);
    const nonOperatorUpdate = await requestJson(
      "POST",
      "/api/users/setup",
      { display_name: "Attacker" },
      bearer(token),
    );
    expect(nonOperatorUpdate.status).toBe(403);

    const authorized = await requestJson(
      "POST",
      "/api/users/setup",
      { display_name: "Operator Updated" },
      bearer(opToken!),
    );
    expect(authorized.status).toBe(200);
  });

  it("fails closed when operator_id is configured but dangling", async () => {
    db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('user.operator_id', 'missing-user', ?)",
    ).run(Date.now());
    const response = await requestJson("POST", "/api/users/setup", {
      slug: "attacker",
      display_name: "Attacker",
    });
    expect(response.status).toBe(401);
    expect(
      db.prepare("SELECT value FROM settings WHERE key = 'user.operator_id'").pluck().get(),
    ).toBe("missing-user");
  });

  it("does not expose credential metadata through alternate user routes", async () => {
    const operator = setupOperator(db, { display_name: "Op", email: "op@example.com" });
    authenticator.mintApiToken(operator.id);
    const credentials = await requestJson("GET", `/api/users/${operator.id}/credentials`);
    const userDetail = await requestJson("GET", `/api/users/${operator.id}`);
    expect(credentials.status).toBe(401);
    expect(userDetail.status).toBe(401);
  });
});

describe("client-auth: authenticated SSE identity without URL bearer leakage", () => {
  it("retains the identity from an Authorization header on POST subscribe", async () => {
    const user = createUser(db, { slug: "agent-sse", kind: "agent", display_name: "Agent SSE" });
    const { token } = authenticator.mintApiToken(user.id);
    const connection = await openSse("POST", "/api/events/subscribe", bearer(token));
    expect(connection.status).toBe(200);
    expect(sse.countForUser(user.id)).toBe(1);
    connection.close();
  });

  it("ignores legacy query bearer tokens instead of treating URLs as credentials", async () => {
    const user = createUser(db, { slug: "agent-sse", kind: "agent", display_name: "Agent SSE" });
    const { token } = authenticator.mintApiToken(user.id);
    const connection = await openSse("GET", `/api/events?token=${encodeURIComponent(token)}`);
    expect(connection.status).toBe(200);
    expect(sse.countForUser(user.id)).toBe(0);
    connection.close();
  });

  it("strict mode rejects an anonymous POST subscription", async () => {
    setClientAuthMode(db, "strict");
    const response = await requestJson("POST", "/api/events/subscribe");
    expect(response.status).toBe(401);
  });
});

describe("client-auth over HTTP (strict mode)", () => {
  it("rejects an anonymous mutation and keeps reads open", async () => {
    setClientAuthMode(db, "strict");
    const write = await requestJson("POST", "/api/write", {});
    expect(write.status).toBe(401);
    const read = await requestJson("GET", "/api/read");
    expect(read.status).toBe(200);
  });

  it("accepts a token-authenticated mutation", async () => {
    setClientAuthMode(db, "strict");
    const user = createUser(db, { slug: "agent-y", kind: "agent", display_name: "Agent Y" });
    const { token } = authenticator.mintApiToken(user.id);
    const response = await requestJson("POST", "/api/write", {}, bearer(token));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, identity: { slug: "agent-y" } });
  });
});

function listen(srv: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      srv.removeListener("error", reject);
      const address = srv.address();
      if (typeof address !== "object" || !address) {
        reject(new Error("test server did not expose a port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(srv: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    srv.close((error) => (error ? reject(error) : resolve()));
  });
}

function requestRaw(
  method: string,
  reqPath: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: reqPath, method, headers },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 500, text: raw }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function requestJson(
  method: string,
  reqPath: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const data = body === undefined ? "" : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: reqPath,
        method,
        headers: {
          ...(data
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(data).toString(),
              }
            : {}),
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 500, body: raw ? JSON.parse(raw) : null });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

function openSse(
  method: "GET" | "POST",
  reqPath: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: reqPath, method, headers },
      (res) => resolve({
        status: res.statusCode ?? 500,
        close: () => {
          req.destroy();
          res.destroy();
        },
      }),
    );
    req.on("error", reject);
    req.end();
  });
}
