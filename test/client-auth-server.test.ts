// @vitest-environment node

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { COOKIE_NAME } from "../src/client-auth/session-authority.js";
import { fingerprintForToken } from "../src/client-auth/tokens.js";
import { openDb, setDb, type Db } from "../src/db.js";
import { PRODUCTION_EFFECTS, STANDARD_PREVIEW_EFFECTS } from "../src/security/effect-policy.js";
import { attachWebSocketUpgrade, createServer, Router } from "../src/server.js";
import { registerClientAuthRoutes } from "../src/routes/client-auth.js";
import { registerUserRoutes } from "../src/routes/users.js";
import { SseManager } from "../src/sse.js";
import type { InstanceInfo } from "../src/types.js";
import { createUser, setupOperator, updateUser } from "../src/users/store.js";

const origin = "https://app.mandible.localhost:19420";
let root = "";
let db: Db;
let server: http.Server;
let port = 0;
let auth: ClientAuthenticator;
let browser: ReturnType<ClientAuthenticator["issueBrowserSession"]>;
let sse: SseManager;

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
  registerClientAuthRoutes(router, auth);
  registerUserRoutes(router, auth);
  router.get("/api/read", (req, res) => res.json({ user: req.client_identity?.user_id }), { fileRpc: "allow" });
  router.post("/api/issues/test-write", (req, res) => res.json({ user: req.client_identity?.user_id }), { fileRpc: "allow" });
  sse = new SseManager();
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
  const browserSockets = new Set<{ socket: net.Socket; family: string; user: string }>();
  auth.onBrowserSessionRevoked((scope) => {
    sse.closeForBrowserSessions(scope.family_ids, scope.user_id);
    for (const entry of browserSockets) {
      if (entry.user === scope.user_id && scope.family_ids.includes(entry.family)) entry.socket.destroy();
    }
  });
  attachWebSocketUpgrade(server, (req, socket) => {
    const rawCookie = Array.isArray(req.headers.cookie) ? req.headers.cookie[0] : req.headers.cookie;
    const token = rawCookie?.split(";").map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1);
    const identity = auth.authenticateBrowserSession(token);
    if (!identity?.session_family) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    browserSockets.add({ socket: socket as net.Socket, family: identity.session_family, user: identity.user_id });
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
  }, instance);
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
  it("serves a public preview bootstrap while keeping private preview reads authenticated", async () => {
    const headers = {
      Host: "app.mandible.localhost:19420",
      "X-Mandible-Target-Instance": "preview-test",
    };
    const bootstrap = await requestRaw("GET", "/api/client-auth/preview-bootstrap", undefined, headers);
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.body).toContain("/api/client-auth/preview-transfer/prepare");
    expect((await request("GET", "/api/read", undefined, headers)).status).toBe(401);
    const prepared = await request("POST", "/api/client-auth/preview-transfer/prepare", { return_path: "/#/issues" }, {
      ...headers,
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
    });
    expect(prepared).toMatchObject({ status: 201, body: { authorize_url: expect.stringContaining("/preview-transfer/authorize") } });
  });

  it("rejects anonymous API reads and mutations", async () => {
    expect((await request("GET", "/api/read")).status).toBe(401);
    expect((await request("POST", "/api/issues/test-write", {})).status).toBe(401);
  });

  it("rejects browser bearer fallback and hostile Host/Origin inputs", async () => {
    expect((await request("POST", "/api/issues/test-write", {}, {
      Host: "app.mandible.localhost:19420",
      Origin: origin,
      Authorization: "Bearer forbidden-in-browser",
    })).status).toBe(400);
    expect((await request("POST", "/api/issues/test-write", {}, {
      Host: "other.mandible.localhost:19420",
      Origin: origin,
      Cookie: `${COOKIE_NAME}=${browser.token}`,
      "X-Mandible-Csrf": browser.csrf_token,
    })).status).toBe(403);
    expect((await request("POST", "/api/issues/test-write", {}, {
      Host: "app.mandible.localhost:19420",
      Origin: "https://evil.invalid",
      Cookie: `${COOKIE_NAME}=${browser.token}`,
      "X-Mandible-Csrf": browser.csrf_token,
    })).status).toBe(403);
  });

  it("requires exact Origin and session-bound CSRF for browser writes", async () => {
    const cookie = `${COOKIE_NAME}=${browser.token}`;
    expect((await request("POST", "/api/issues/test-write", {}, {
      Host: "app.mandible.localhost:19420",
      Cookie: cookie,
    })).status).toBe(403);
    expect((await request("POST", "/api/issues/test-write", {}, {
      Host: "app.mandible.localhost:19420",
      Origin: origin,
      Cookie: cookie,
    })).status).toBe(403);
    expect((await request("POST", "/api/issues/test-write", {}, {
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

  it("invalidates browser families as soon as their user is retired", () => {
    const identity = auth.authenticateBrowserSession(browser.token)!;
    let revokedFamilies: string[] = [];
    auth.onBrowserSessionRevoked((scope) => { revokedFamilies = scope.family_ids; });
    updateUser(db, identity.user_id, { status: "retired" });
    expect(auth.classifyBrowserSession(browser.token)).toMatchObject({ state: "revoked", identity: null });
    expect(revokedFamilies).toContain(browser.family_id);
    expect(auth.authenticateBrowserSession(browser.token)).toBeNull();
  });

  it("does not let a retired user reactivate itself through the users route", async () => {
    const user = createUser(db, { slug: "retired-agent", kind: "agent", display_name: "Retired Agent" });
    const pat = auth.mintApiToken(user.id).token;
    const session = auth.issueBrowserSession(auth.authenticate(pat, "http_bearer")!, "production");
    updateUser(db, user.id, { status: "retired" });
    const response = await request("PATCH", `/api/users/${user.id}`, { status: "active" }, {
      Host: "app.mandible.localhost:19420",
      Origin: origin,
      Cookie: `${COOKIE_NAME}=${session.token}`,
      "X-Mandible-Csrf": session.csrf_token,
    });
    expect(response).toMatchObject({ status: 401, body: { reason: "revoked" } });
  });

  it("maps the preserved legacy preview port to its registered preview replacement", () => {
    const current = auth.authenticateBrowserSession(browser.token)!;
    const conversion = auth.beginLegacyConversion({
      ...current,
      method: "legacy_browser_session",
      source: "legacy_browser_conversion",
      legacy_fingerprint: "legacy-preview-fingerprint",
      legacy_authenticated_at: Date.now(),
    }, "legacy-preview-token", "/#/timeline", { "mandible.timeline.view": "saved" }, "http://127.0.0.1:19421", "preview-test");
    expect(conversion.target_audience).toBe("preview-test");
    expect(auth.completeLegacyConversion(conversion.reference, conversion.secret)).toMatchObject({
      audience: "preview-test",
      effect_ceiling: STANDARD_PREVIEW_EFFECTS,
    });
  });

  it.each([
    ["production", "http://127.0.0.1:19420", "production"],
    ["preview", "http://127.0.0.1:19421", "preview-test"],
  ] as const)("converts an old %s browser through its source backend and the shared installation authority", async (
    _label,
    legacyOrigin,
    targetAudience,
  ) => {
    const priorMigration = process.env.MANDIBLE_LEGACY_CONVERSION;
    process.env.MANDIBLE_LEGACY_CONVERSION = "allow";
    let previewServer: http.Server | null = null;
    try {
      const legacyToken = `legacy-${targetAudience}`;
      const sourceSecrets = targetAudience === "production"
        ? path.join(root, "client-auth")
        : path.join(root, "preview-client-auth");
      let sourceAuth = auth;
      let sourcePort = port;
      if (targetAudience !== "production") {
        fs.mkdirSync(sourceSecrets, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(sourceSecrets, "pepper"), "preview-pepper", { mode: 0o600 });
        const previewInstance: InstanceInfo = {
          ...productionInstance(path.join(root, "mandible.db")),
          role: "preview",
          instance_id: "preview-test",
          public_origin: "https://preview-test.mandible.localhost:19421",
          allowed_effects: STANDARD_PREVIEW_EFFECTS,
          preview_root: root,
        };
        sourceAuth = new ClientAuthenticator(db, {
          instance: previewInstance,
          secretsDir: sourceSecrets,
          sessionAuthorityDir: path.join(root, "local-sessions"),
          initializeSessionAuthority: false,
        });
        const previewRouter = new Router({ clientAuth: sourceAuth, instance: previewInstance });
        registerClientAuthRoutes(previewRouter, sourceAuth);
        previewServer = createServer({
          db, sse: new SseManager(), logger: () => undefined, version: "test", router: previewRouter,
          getStartupInfo: () => null,
          instance: previewInstance,
          clientAuth: sourceAuth,
        });
        sourcePort = await listen(previewServer);
      }
      const pepper = fs.readFileSync(path.join(sourceSecrets, "pepper"), "utf8").trim();
      const current = Date.now();
      fs.writeFileSync(path.join(sourceSecrets, "dashboard-session.json"), JSON.stringify({
        version: 2,
        sessions: [{
          token_fingerprint: fingerprintForToken(pepper, legacyToken),
          user_id: auth.authenticateBrowserSession(browser.token)!.user_id,
          slug: auth.authenticateBrowserSession(browser.token)!.slug,
          created_at: current - 1_000,
          expires_at: current + 60_000,
          renew_until: current + 120_000,
        }],
      }), { mode: 0o600 });

      const prepared = await requestAt(sourcePort, "POST", "/api/client-auth/legacy-conversion/prepare", {
        return_path: "/#/timeline?project=mandible",
        browser_state: { "mandible.timeline.view": "saved" },
      }, {
        Host: new URL(legacyOrigin).host,
        Origin: legacyOrigin,
        "Sec-Fetch-Site": "same-origin",
        "X-Mandible-Target-Instance": targetAudience,
        Authorization: `Bearer ${legacyToken}`,
      });
      expect(prepared.status).toBe(201);
      expect(prepared.body.complete_url).toBe(targetAudience === "production"
        ? "https://app.mandible.localhost:19419/api/client-auth/legacy-conversion/complete"
        : "https://preview-test.mandible.localhost:19419/api/client-auth/legacy-conversion/complete");

      const completed = await requestAt(port, "POST", "/api/client-auth/legacy-conversion/complete", {
        reference: prepared.body.reference,
        secret: prepared.body.secret,
      }, {
        Host: "app.mandible.localhost:19420",
        Origin: origin,
        "Sec-Fetch-Site": "cross-site",
        "X-Mandible-Legacy-Migration": "complete-v1",
        "X-Mandible-Legacy-Origin": legacyOrigin,
        "X-Mandible-Target-Instance": targetAudience,
      });
      expect(completed.status).toBe(200);
      const cookie = String(completed.headers["set-cookie"]?.[0] ?? "").split(";", 1)[0];
      expect(cookie).toMatch(/^__Host-mandible-session=/);
      const whoami = await requestAt(port, "GET", "/api/client-auth/whoami", undefined, {
        Host: "app.mandible.localhost:19420", Origin: origin, Cookie: cookie,
        "X-Mandible-Target-Instance": targetAudience,
      });
      expect(whoami.body).toMatchObject({ authenticated: true, audience: targetAudience });

      for (const [hostileLabel, hostile] of [
        ["hostile origin", { Origin: "https://evil.invalid" }],
        ["same-site completion", { "Sec-Fetch-Site": "same-origin" }],
        ["wrong target", { "X-Mandible-Target-Instance": targetAudience === "production" ? "preview-test" : "production" }],
      ] as const) {
        const refused = await requestAt(port, "POST", "/api/client-auth/legacy-conversion/complete", {
          reference: prepared.body.reference, secret: prepared.body.secret,
        }, {
          Host: "app.mandible.localhost:19420", Origin: origin,
          "Sec-Fetch-Site": "cross-site", "X-Mandible-Legacy-Migration": "complete-v1",
          "X-Mandible-Legacy-Origin": legacyOrigin,
          "X-Mandible-Target-Instance": targetAudience,
          ...hostile,
        });
        expect(refused.status, hostileLabel).toBeGreaterThanOrEqual(400);
      }
    } finally {
      if (previewServer) await new Promise<void>((resolve) => previewServer!.close(() => resolve()));
      if (priorMigration === undefined) delete process.env.MANDIBLE_LEGACY_CONVERSION;
      else process.env.MANDIBLE_LEGACY_CONVERSION = priorMigration;
    }
  });

  it("keeps real fetch, SSE, and WebSocket traffic on one session and closes streams on revocation", async () => {
    const headers = {
      Host: "app.mandible.localhost:19420",
      Origin: origin,
      Cookie: `${COOKIE_NAME}=${browser.token}`,
      "X-Mandible-Csrf": browser.csrf_token,
    };
    expect((await request("GET", "/api/read", undefined, headers)).status).toBe(200);

    const eventStream = await openEventStream(headers);
    const webSocket = await openWebSocket(headers);
    expect(sse.count()).toBe(1);

    const rootIdentity = auth.authenticateBrowserSession(browser.token)!;
    const transfer = auth.beginPreviewTransfer("preview-test", "/");
    auth.authorizePreviewTransfer(transfer.reference, rootIdentity);
    const preview = auth.completePreviewTransfer(transfer.reference, transfer.secret)!;
    const previewIdentity = auth.authenticateBrowserSessionForAudience(preview.token, "preview-test")!;
    const previewEventStream = addManagedEventStream(previewIdentity);
    expect(sse.count()).toBe(2);
    expect(auth.revokeBrowserFamily(previewIdentity)).toBe(true);
    await Promise.all([
      eventStream.closed,
      webSocket.closed,
      previewEventStream.closed,
    ]);
    expect(sse.count()).toBe(0);
    expect((await request("GET", "/api/read", undefined, headers)).status).toBe(401);
  });
});

function addManagedEventStream(identity: ReturnType<ClientAuthenticator["authenticateBrowserSessionForAudience"]>): { closed: Promise<void> } {
  const req = new EventEmitter();
  const res = new EventEmitter() as EventEmitter & {
    writableLength: number;
    writeHead: () => void;
    write: () => boolean;
    destroy: () => void;
  };
  res.writableLength = 0;
  res.writeHead = () => undefined;
  res.write = () => true;
  const closed = new Promise<void>((resolve) => res.once("close", resolve));
  res.destroy = () => { res.emit("close"); };
  sse.addClient(req as never, res as never, [], identity);
  return { closed };
}

function openEventStream(headers: Record<string, string>): Promise<{ closed: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: "/api/events/subscribe", method: "POST", headers }, (res) => {
      const closed = new Promise<void>((closedResolve) => res.once("close", closedResolve));
      res.once("data", () => resolve({ closed }));
    });
    req.on("error", reject);
    req.end(JSON.stringify({ topics: [] }));
  });
}

function openWebSocket(headers: Record<string, string>): Promise<{ closed: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.write([
        "GET /terminal/test HTTP/1.1",
        ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "",
        "",
      ].join("\r\n"));
    });
    const closed = new Promise<void>((closedResolve) => socket.once("close", closedResolve));
    socket.once("data", (chunk) => {
      if (!chunk.toString("utf8").startsWith("HTTP/1.1 101")) {
        reject(new Error(`WebSocket upgrade failed: ${chunk.toString("utf8")}`));
        return;
      }
      resolve({ closed });
    });
    socket.on("error", reject);
  });
}

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

function requestRaw(
  method: string,
  requestPath: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const data = body === undefined ? "" : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1", port, path: requestPath, method,
      headers: { ...(data ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(data)) } : {}), ...headers },
    }, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 500, body: raw }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}

function requestAt(
  targetPort: number,
  method: string,
  requestPath: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  const data = body === undefined ? "" : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1", port: targetPort, path: requestPath, method,
      headers: { ...(data ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(data)) } : {}), ...headers },
    }, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        let parsed: any = raw;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { /* HTML response */ }
        resolve({ status: res.statusCode ?? 500, body: parsed, headers: res.headers });
      });
    });
    req.on("error", reject);
    req.end(data);
  });
}
