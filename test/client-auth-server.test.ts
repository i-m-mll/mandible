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
import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { setClientAuthMode } from "../src/client-auth/mode.js";
import { createUser, setupOperator } from "../src/users/store.js";

let tempDir = "";
let db: Db;
let authenticator: ClientAuthenticator;
let server: http.Server;
let port = 0;

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** Set up the operator and return a valid operator bearer token. */
function operatorToken(): string {
  setupOperator(db, { display_name: "Op", email: "op@example.com" });
  const token = authenticator.bootstrapToken();
  if (!token) throw new Error("expected an operator bootstrap token");
  return token;
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
  registerUserRoutes(router);
  registerSettingsRoutes(router);

  server = createServer({
    db,
    sse: new SseManager(),
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
  it("compat: issues an ephemeral operator token anonymously", async () => {
    setupOperator(db, { display_name: "Op", email: "op@example.com" });
    const response = await requestJson("POST", "/api/client-auth/handshake");
    expect(response.status).toBe(200);
    expect((response.body as { token?: string }).token).toMatch(/^mandible_pat_/);
  });

  it("compat: returns 409 when no operator is configured", async () => {
    const response = await requestJson("POST", "/api/client-auth/handshake");
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "operator_not_configured" });
  });

  it("strict: rejects an anonymous handshake (needs an already-valid token)", async () => {
    setupOperator(db, { display_name: "Op", email: "op@example.com" });
    setClientAuthMode(db, "strict");
    const response = await requestJson("POST", "/api/client-auth/handshake");
    expect(response.status).toBe(401);
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
  it("403s reads and writes of client_auth.* keys (compat, so the gate does not preempt)", async () => {
    // In compat the anonymous write reaches the handler, proving the denylist —
    // not the strict-mode gate — is what refuses it.
    const getKey = await requestJson("GET", "/api/settings/client_auth.mode");
    expect(getKey.status).toBe(403);
    expect(getKey.body).toMatchObject({ code: "client_auth_setting_protected" });
    const putKey = await requestJson("PUT", "/api/settings/client_auth.mode", { value: "compat" });
    expect(putKey.status).toBe(403);
    expect(putKey.body).toMatchObject({ code: "client_auth_setting_protected" });
  });

  it("hides client_auth.* keys from the generic settings listing", async () => {
    setClientAuthMode(db, "strict");
    const all = await requestJson("GET", "/api/settings");
    expect(all.status).toBe(200);
    for (const key of Object.keys(all.body as Record<string, unknown>)) {
      expect(key.startsWith("client_auth.")).toBe(false);
    }
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
