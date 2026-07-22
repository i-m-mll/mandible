import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, setDb, type Db } from "../src/db.js";
import { Router } from "../src/server.js";
import { FileRpcTransport } from "../src/file-rpc-transport.js";
import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { setClientAuthMode } from "../src/client-auth/mode.js";
import { mintApiToken } from "../src/client-auth/tokens.js";
import { createUser, setupOperator } from "../src/users/store.js";

let tempDir = "";
let db: Db;
let authenticator: ClientAuthenticator;
let router: Router;

function buildRouter(): Router {
  const r = new Router({ clientAuth: authenticator });
  r.post("/api/write", (req, res) => {
    res.json({ ok: true, identity: req.client_identity ?? null });
  }, { fileRpc: "allow" });
  r.get("/api/read", (_req, res) => {
    res.json({ ok: true });
  }, { fileRpc: "allow" });
  return r;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-client-auth-gate-"));
  db = openDb(path.join(tempDir, "mandible.db"));
  setDb(db);
  authenticator = new ClientAuthenticator(db);
  router = buildRouter();
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("client-auth gate: middleware resolution matrix", () => {
  it("compat mode: allows unauthenticated mutation and counts it", async () => {
    const response = await router.invoke({ method: "POST", url: "/api/write", body: {}, transport: "http" });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, identity: null });
    expect(authenticator.telemetrySnapshot().unattributed_writes_total).toBe(1);
  });

  it("compat mode: resolves a valid token to its user without counting", async () => {
    const user = createUser(db, { slug: "agent-x", kind: "agent", display_name: "Agent X" });
    const { token } = mintApiToken(db, user.slug);
    const response = await router.invoke({
      method: "POST",
      url: "/api/write",
      body: {},
      credential: `Bearer ${token}`,
      transport: "http",
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      identity: { user_id: user.id, slug: "agent-x", method: "api_token", source: "http_bearer" },
    });
    expect(authenticator.telemetrySnapshot().unattributed_writes_total).toBe(0);
  });

  it("strict mode: rejects an anonymous mutation with 401", async () => {
    setClientAuthMode(db, "strict");
    const response = await router.invoke({ method: "POST", url: "/api/write", body: {}, transport: "http" });
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ error: "authentication_required" });
  });

  it("strict mode: allows a token-authenticated mutation", async () => {
    setClientAuthMode(db, "strict");
    const user = createUser(db, { slug: "agent-y", kind: "agent", display_name: "Agent Y" });
    const { token } = mintApiToken(db, user.slug);
    const response = await router.invoke({
      method: "POST",
      url: "/api/write",
      body: {},
      credential: token,
      transport: "http",
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, identity: { slug: "agent-y" } });
  });

  it("strict mode: leaves reads open in phase 1", async () => {
    setClientAuthMode(db, "strict");
    const response = await router.invoke({ method: "GET", url: "/api/read", transport: "http" });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true });
  });

  it("strict mode: a bootstrap ephemeral token authenticates as the operator", async () => {
    setClientAuthMode(db, "strict");
    const operator = setupOperator(db, { display_name: "Op", email: "op@example.com" });
    const token = authenticator.bootstrapToken();
    expect(token).toBeTruthy();
    const response = await router.invoke({
      method: "POST",
      url: "/api/write",
      body: {},
      credential: `Bearer ${token}`,
      transport: "http",
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      identity: { user_id: operator.id, method: "ephemeral", source: "http_bearer" },
    });
  });

  it("reuses one bootstrap token for the daemon lifetime", () => {
    setupOperator(db, { display_name: "Op", email: "op@example.com" });
    expect(authenticator.bootstrapToken()).toBe(authenticator.bootstrapToken());
  });

  it("returns no bootstrap token before an operator is configured", () => {
    expect(authenticator.bootstrapToken()).toBeNull();
  });
});

describe("client-auth gate: file-RPC capability tokens", () => {
  it("compat: a file-RPC mutation without a capability token is allowed and counted as file-rpc", async () => {
    const transport = new FileRpcTransport({ router, dir: path.join(tempDir, "rpc") });
    const response = await runFileRpc(transport, { method: "POST", path: "/api/write", body: {} });
    expect(response.status).toBe(200);
    const snapshot = authenticator.telemetrySnapshot();
    expect(snapshot.unattributed_writes_total).toBe(1);
    expect(snapshot.by_transport).toEqual({ "file-rpc": 1 });
  });

  it("strict: a file-RPC mutation without a capability token is rejected", async () => {
    setClientAuthMode(db, "strict");
    const transport = new FileRpcTransport({ router, dir: path.join(tempDir, "rpc") });
    const response = await runFileRpc(transport, { method: "POST", path: "/api/write", body: {} });
    expect(response.status).toBe(401);
  });

  it("strict: a valid capability token in the envelope authenticates", async () => {
    setClientAuthMode(db, "strict");
    const user = createUser(db, { slug: "agent-rpc", kind: "agent", display_name: "Agent RPC" });
    const { token } = mintApiToken(db, user.slug);
    const transport = new FileRpcTransport({ router, dir: path.join(tempDir, "rpc") });
    const response = await runFileRpc(transport, {
      method: "POST",
      path: "/api/write",
      body: {},
      capability_token: token,
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      identity: { slug: "agent-rpc", method: "api_token", source: "file_rpc_capability" },
    });
  });
});

async function runFileRpc(
  transport: FileRpcTransport,
  request: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  fs.mkdirSync(transport.dir, { recursive: true });
  const id = `test-${Math.random().toString(36).slice(2)}`;
  const requestFile = path.join(transport.dir, `${id}.request.json`);
  fs.writeFileSync(requestFile, JSON.stringify({ id, ...request }));
  await transport.processOnce();
  const responseFile = path.join(transport.dir, `${id}.response.json`);
  const parsed = JSON.parse(fs.readFileSync(responseFile, "utf8")) as { status: number; body: unknown };
  return { status: parsed.status, body: parsed.body };
}
