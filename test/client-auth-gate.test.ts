import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, setDb, type Db } from "../src/db.js";
import { Router } from "../src/server.js";
import { FileRpcTransport } from "../src/file-rpc-transport.js";
import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { setClientAuthMode } from "../src/client-auth/mode.js";
import { addBinding, addCredential, createUser, removeBinding, setupOperator } from "../src/users/store.js";
import { SessionManager } from "../src/session-manager.js";

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
  authenticator = new ClientAuthenticator(db, { secretsDir: path.join(tempDir, "client-auth") });
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
    const { token } = authenticator.mintApiToken(user.slug);
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
    const { token } = authenticator.mintApiToken(user.slug);
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
    const replay = await router.invoke({
      method: "POST",
      url: "/api/write",
      body: {},
      credential: `Bearer ${token}`,
      transport: "http",
    });
    expect(replay.status).toBe(401);
  });

  it("reuses one bootstrap token for the daemon lifetime", () => {
    setupOperator(db, { display_name: "Op", email: "op@example.com" });
    expect(authenticator.bootstrapToken()).toBe(authenticator.bootstrapToken());
  });

  it("returns no bootstrap token before an operator is configured", () => {
    expect(authenticator.bootstrapToken()).toBeNull();
  });

  it("keeps the operator bootstrap when the operator has zero active credentials", () => {
    // Enrollment must win before the anti-theft guard applies. Backend
    // construction calls revokeOperatorBootstrap on every non-operator session;
    // if that revoked the bootstrap while the operator has no credential, first
    // enrollment would be impossible on a machine that already runs agents
    // (issue a9ede3c). The proof must survive until enrollment completes.
    setupOperator(db, { slug: "operator", display_name: "Operator" });
    const token = authenticator.bootstrapToken();
    expect(token).toBeTruthy();
    authenticator.refreshBootstrapTokenFile();
    const bootstrapPath = path.join(tempDir, "client-auth", "bootstrap-token");
    expect(fs.existsSync(bootstrapPath)).toBe(true);

    authenticator.revokeOperatorBootstrap();

    // The on-disk proof must survive the revoke so the operator can still read
    // it. (Check the file first: authenticating a bootstrap token is one-shot
    // and legitimately clears the file — that is enrollment succeeding.)
    expect(fs.existsSync(bootstrapPath)).toBe(true);
    // The in-memory ephemeral token also survives the revoke and authenticates.
    expect(authenticator.authenticate(token)).toMatchObject({ method: "ephemeral" });
  });

  it("revokes the operator bootstrap once the operator has an active credential", () => {
    // With the guard fully restored after enrollment, revokeOperatorBootstrap
    // must delete the proof exactly as before so no managed agent can read it.
    const operator = setupOperator(db, { slug: "operator", display_name: "Operator" });
    addCredential(db, operator.id, { type: "api_token", fingerprint: "tokfp-enrolled-abc" });
    const token = authenticator.bootstrapToken();
    expect(token).toBeTruthy();
    authenticator.refreshBootstrapTokenFile();
    const bootstrapPath = path.join(tempDir, "client-auth", "bootstrap-token");
    expect(fs.existsSync(bootstrapPath)).toBe(true);

    authenticator.revokeOperatorBootstrap();

    expect(authenticator.authenticate(token)).toBeNull();
    expect(fs.existsSync(bootstrapPath)).toBe(false);
  });

  it("bootstrap survives agent backend construction until the operator enrolls", () => {
    // End-to-end reproduction of issue a9ede3c defect 1: sessionManager builds
    // backends for retained/non-operator console sessions and each construction
    // calls revokeOperatorBootstrap. With no operator credential yet, the proof
    // must survive so the human can still enroll.
    setupOperator(db, { slug: "operator", display_name: "Operator" });
    authenticator.refreshBootstrapTokenFile();
    const bootstrapPath = path.join(tempDir, "client-auth", "bootstrap-token");
    expect(fs.existsSync(bootstrapPath)).toBe(true);

    const agent = createUser(db, { slug: "bg-agent", kind: "agent", display_name: "BG Agent" });
    addBinding(db, agent.id, { binding_type: "app_name", value: "claude" });
    const manager = new SessionManager(db, () => undefined, undefined, undefined, authenticator);
    manager.create({ label: "Claude", command: "claude", backend_type: "sdk" });

    expect(fs.existsSync(bootstrapPath)).toBe(true);
    manager.close();
  });

  it("expires ephemeral credentials and caps retained state", () => {
    let now = 1_000;
    const bounded = new ClientAuthenticator(db, {
      secretsDir: path.join(tempDir, "bounded-client-auth"),
      maxEphemeralTokens: 2,
      now: () => now,
    });
    const user = createUser(db, { slug: "agent-bound", kind: "agent", display_name: "Agent Bound" });
    const identity = { user_id: user.id, slug: user.slug };
    const first = bounded.issueEphemeralToken(identity, "first", { ttlMs: 100 });
    now += 1;
    const second = bounded.issueEphemeralToken(identity, "second", { ttlMs: 100 });
    now += 1;
    const third = bounded.issueEphemeralToken(identity, "third", { ttlMs: 100 });
    expect(bounded.authenticate(first)).toBeNull();
    expect(bounded.authenticate(second)).not.toBeNull();
    expect(bounded.authenticate(third)).not.toBeNull();

    now += 100;
    expect(bounded.authenticate(second)).toBeNull();
    expect(bounded.authenticate(third)).toBeNull();
  });

  it("invalidates a spawned-agent capability when its identity binding is removed", () => {
    const operator = setupOperator(db, { slug: "operator", display_name: "Operator" });
    // The anti-theft revoke-on-backend-construction guard only applies once the
    // operator has enrolled at least one active credential (issue a9ede3c);
    // give it one so this test exercises the guarded path, not enrollment.
    addCredential(db, operator.id, { type: "api_token", fingerprint: "tokfp-operator-enrolled" });
    authenticator.refreshBootstrapTokenFile();
    const bootstrapPath = path.join(tempDir, "client-auth", "bootstrap-token");
    expect(fs.existsSync(bootstrapPath)).toBe(true);
    const user = createUser(db, { slug: "bound-agent", kind: "agent", display_name: "Bound Agent" });
    const binding = addBinding(db, user.id, { binding_type: "app_name", value: "claude" });
    const manager = new SessionManager(db, () => undefined, undefined, undefined, authenticator);
    const session = manager.create({ label: "Claude", command: "claude", backend_type: "sdk" });
    expect(fs.existsSync(bootstrapPath)).toBe(false);
    const backend = manager.get(session.id) as unknown as {
      buildClientEnv(): Record<string, string | undefined>;
    };
    const token = backend.buildClientEnv().MANDIBLE_TOKEN;
    expect(token).toBeTruthy();
    expect(authenticator.authenticate(token)).toMatchObject({ user_id: user.id });

    removeBinding(db, binding.id);
    expect(authenticator.authenticate(token)).toBeNull();
    addBinding(db, user.id, { binding_type: "app_name", value: "claude" });
    const rotated = backend.buildClientEnv().MANDIBLE_TOKEN;
    expect(rotated).toBeTruthy();
    expect(rotated).not.toBe(token);
    expect(authenticator.authenticate(rotated)).toMatchObject({ user_id: user.id });
    manager.close();
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
    const { token } = authenticator.mintApiToken(user.slug);
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
