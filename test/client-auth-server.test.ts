// @vitest-environment node

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { COOKIE_NAME } from "../src/client-auth/session-authority.js";
import { openDb, setDb, type Db } from "../src/db.js";
import { PRODUCTION_EFFECTS, STANDARD_PREVIEW_EFFECTS } from "../src/security/effect-policy.js";
import { createServer, Router } from "../src/server.js";
import { SseManager } from "../src/sse.js";
import type { InstanceInfo } from "../src/types.js";
import { setupOperator } from "../src/users/store.js";

const origin = "https://app.mandible.localhost:19420";
let root = "";
let db: Db;
let server: http.Server;
let port = 0;
let auth: ClientAuthenticator;
let browser: ReturnType<ClientAuthenticator["issueBrowserSession"]>;

function productionInstance(database: string): InstanceInfo {
  return {
    role: "main",
    instance_id: "production",
    installation_id: "install_test",
    public_origin: origin,
    backend_generation: "main-1",
    allowed_effects: PRODUCTION_EFFECTS,
    writable_roots: [root],
    preview_root: null,
    db_path: database,
    db_path_source: "test",
    source_db_path: null,
    source_db_path_source: null,
  };
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-auth-boundary-"));
  const database = path.join(root, "mandible.db");
  db = openDb(database);
  setDb(db);
  const instance = productionInstance(database);
  auth = new ClientAuthenticator(db, {
    instance,
    secretsDir: path.join(root, "client-auth"),
    sessionAuthorityDir: path.join(root, "local-sessions"),
    initializeSessionAuthority: true,
  });
  auth.registerInstance({
    instance_id: "production",
    installation_id: "install_test",
    role: "main",
    public_origin: origin,
    backend_origin: "http://127.0.0.1:29420",
    backend_generation: "main-1",
    effect_ceiling: PRODUCTION_EFFECTS,
    writable_roots: [root],
  });
  auth.registerInstance({
    instance_id: "preview-test",
    installation_id: "install_test",
    role: "preview",
    public_origin: "https://preview-test.mandible.localhost:19421",
    backend_origin: "http://127.0.0.1:29421",
    backend_generation: "preview-1",
    effect_ceiling: STANDARD_PREVIEW_EFFECTS,
    writable_roots: [root],
  });
  const operator = setupOperator(db, { display_name: "Operator", email: "operator@example.invalid" });
  const token = auth.mintApiToken(operator.id).token;
  const identity = auth.authenticate(token, "http_bearer")!;
  browser = auth.issueBrowserSession(identity, "production");

  const router = new Router({ clientAuth: auth, instance });
  router.get("/api/read", (req, res) => res.json({ user: req.client_identity?.user_id }), { fileRpc: "allow" });
  router.post("/api/write", (req, res) => res.json({ user: req.client_identity?.user_id }), { fileRpc: "allow" });
  const sse = new SseManager();
  server = createServer({
    db,
    sse,
    logger: () => undefined,
    version: "test",
    router,
    getStartupInfo: () => null,
    instance,
    clientAuth: auth,
  });
  port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("strict browser boundary", () => {
  it("rejects anonymous API reads and mutations", async () => {
    expect((await request("GET", "/api/read")).status).toBe(401);
    expect((await request("POST", "/api/write", {})).status).toBe(401);
  });

  it("rejects browser bearer fallback and hostile Host/Origin inputs", async () => {
    expect((await request("POST", "/api/write", {}, {
      Host: "app.mandible.localhost:19420",
      Origin: origin,
      Authorization: "Bearer forbidden-in-browser",
    })).status).toBe(400);
    expect((await request("POST", "/api/write", {}, {
      Host: "other.mandible.localhost:19420",
      Origin: origin,
      Cookie: `${COOKIE_NAME}=${browser.token}`,
      "X-Mandible-Csrf": browser.csrf_token,
    })).status).toBe(403);
    expect((await request("POST", "/api/write", {}, {
      Host: "app.mandible.localhost:19420",
      Origin: "https://evil.invalid",
      Cookie: `${COOKIE_NAME}=${browser.token}`,
      "X-Mandible-Csrf": browser.csrf_token,
    })).status).toBe(403);
  });

  it("requires exact Origin and session-bound CSRF for browser writes", async () => {
    const cookie = `${COOKIE_NAME}=${browser.token}`;
    expect((await request("POST", "/api/write", {}, {
      Host: "app.mandible.localhost:19420",
      Cookie: cookie,
    })).status).toBe(403);
    expect((await request("POST", "/api/write", {}, {
      Host: "app.mandible.localhost:19420",
      Origin: origin,
      Cookie: cookie,
    })).status).toBe(403);
    expect((await request("POST", "/api/write", {}, {
      Host: "app.mandible.localhost:19420",
      Origin: origin,
      Cookie: cookie,
      "X-Mandible-Csrf": browser.csrf_token,
    })).status).toBe(200);
  });

  it("rejects a preview-audience cookie at production and has no anonymous GET SSE", async () => {
    const operator = setupOperator(db);
    const token = auth.mintApiToken(operator.id).token;
    const preview = auth.issueBrowserSession(auth.authenticate(token, "http_bearer")!, "preview-test");
    const wrongAudience = await request("GET", "/api/read", undefined, {
      Host: "app.mandible.localhost:19420",
      Origin: origin,
      Cookie: `${COOKIE_NAME}=${preview.token}`,
    });
    expect(wrongAudience).toMatchObject({ status: 401, body: { reason: "wrong_audience" } });
    expect((await request("GET", "/api/events")).status).toBe(404);
  });
});

function request(
  method: string,
  requestPath: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const data = body === undefined ? "" : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: requestPath,
      method,
      headers: {
        ...(data ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(data)) } : {}),
        ...headers,
      },
    }, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 500, body: raw ? JSON.parse(raw) : null }));
    });
    req.on("error", reject);
    req.end(data);
  });
}
