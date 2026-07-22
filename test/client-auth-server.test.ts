import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, setDb, type Db } from "../src/db.js";
import { createServer, Router } from "../src/server.js";
import { SseManager } from "../src/sse.js";
import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { setClientAuthMode } from "../src/client-auth/mode.js";
import { mintApiToken } from "../src/client-auth/tokens.js";
import { createUser } from "../src/users/store.js";

let tempDir = "";
let db: Db;
let authenticator: ClientAuthenticator;
let server: http.Server;
let port = 0;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-client-auth-server-"));
  db = openDb(path.join(tempDir, "mandible.db"));
  setDb(db);
  authenticator = new ClientAuthenticator(db);
  const router = new Router({ clientAuth: authenticator });
  router.post("/api/write", (req, res) => {
    res.json({ ok: true, identity: req.client_identity ?? null });
  }, { fileRpc: "allow" });
  router.get("/api/read", (_req, res) => {
    res.json({ ok: true });
  }, { fileRpc: "allow" });

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
  it("compat mode: an unauthenticated local mutation still succeeds with no new required headers", async () => {
    const response = await requestJson("POST", "/api/write", { hello: "cli" });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, identity: null });
  });

  it("resolves an Authorization bearer header to the token's user", async () => {
    const user = createUser(db, { slug: "agent-x", kind: "agent", display_name: "Agent X" });
    const { token } = mintApiToken(db, user.slug);
    const response = await requestJson("POST", "/api/write", { hello: "cli" }, {
      Authorization: `Bearer ${token}`,
    });
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
    const { token } = mintApiToken(db, user.slug);
    const response = await requestJson("POST", "/api/write", {}, {
      Authorization: `Bearer ${token}`,
    });
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
