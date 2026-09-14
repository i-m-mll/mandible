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
import { resolveInstanceInfo } from "../src/instance-policy.js";

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
  it("limits a process-bound preview proof to the dashboard handshake", () => {
    const operator = setupOperator(db, { display_name: "Op", email: "op@example.com" });
    const previewRoot = path.join(tempDir, "preview");
    fs.mkdirSync(previewRoot);
    const previewDb = path.join(previewRoot, "copy.db");
    const sourceDb = path.join(tempDir, "source.db");
    fs.writeFileSync(previewDb, "preview");
    fs.writeFileSync(sourceDb, "source");
    const instance = resolveInstanceInfo({
      env: {
        MANDIBLE_INSTANCE_ROLE: "preview",
        MANDIBLE_OPERATIONAL_MUTATIONS: "reject",
        MANDIBLE_PREVIEW_ROOT: previewRoot,
      },
      dbPath: previewDb,
      sourceDbPath: sourceDb,
    });
    expect(instance.preview_browser_enrollment).toBe("allow");
    const previewAuth = new ClientAuthenticator(db, {
      secretsDir: path.join(previewRoot, "config", "client-auth"),
      instance,
      startupEpoch: "epoch-one",
    });
    previewAuth.publishPreviewBrowserEnrollmentProof();
    const proofPath = path.join(previewRoot, "preview-browser-enrollment.json");
    const proof = JSON.parse(fs.readFileSync(proofPath, "utf8")) as {
      pid: number; startup_epoch: string; token: string;
    };
    expect(proof).toMatchObject({ pid: process.pid, startup_epoch: "epoch-one" });
    expect(fs.statSync(proofPath).mode & 0o077).toBe(0);
    expect(previewAuth.authenticate(proof.token, "http_bearer", {
      method: "GET", pathname: "/api/briefings",
    })).toBeNull();
    const enrollmentIdentity = previewAuth.authenticate(proof.token, "http_bearer", {
      method: "POST", pathname: "/api/client-auth/handshake",
    });
    expect(enrollmentIdentity).toMatchObject({
      user_id: operator.id,
      ephemeral_purpose: "preview_browser_enrollment:epoch-one",
    });
    const dashboard = previewAuth.issueDashboardToken(enrollmentIdentity!);
    expect(previewAuth.authenticate(dashboard.token, "http_bearer", {
      method: "GET", pathname: "/api/briefings",
    })).toMatchObject({ user_id: operator.id, ephemeral_purpose: "dashboard_handshake" });

    const otherProcess = new ClientAuthenticator(db, {
      secretsDir: path.join(previewRoot, "other-client-auth"),
      instance,
      startupEpoch: "epoch-two",
    });
    expect(otherProcess.authenticate(proof.token, "http_bearer", {
      method: "POST", pathname: "/api/client-auth/handshake",
    })).toBeNull();

    const mainRoot = path.join(tempDir, "main-instance");
    fs.mkdirSync(mainRoot);
    const mainAuth = new ClientAuthenticator(db, {
      secretsDir: path.join(mainRoot, "client-auth"),
      instance: resolveInstanceInfo({
        env: { MANDIBLE_INSTANCE_ROLE: "main", MANDIBLE_PREVIEW_ROOT: mainRoot },
        dbPath: previewDb,
        sourceDbPath: sourceDb,
      }),
      startupEpoch: "main-epoch",
    });
    expect(mainAuth.publishPreviewBrowserEnrollmentProof()).toBe(false);
    expect(fs.existsSync(path.join(mainRoot, "preview-browser-enrollment.json"))).toBe(false);
  });
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

  it("strict mode: gives reads and writes one coherent identity boundary", async () => {
    setClientAuthMode(db, "strict");
    const anonymous = await router.invoke({ method: "GET", url: "/api/read", transport: "http" });
    expect(anonymous.status).toBe(401);
    const user = createUser(db, { slug: "reader", kind: "agent", display_name: "Reader" });
    const token = authenticator.mintApiToken(user.slug).token;
    const authenticated = await router.invoke({
      method: "GET",
      url: "/api/read",
      credential: token,
      transport: "http",
    });
    expect(authenticated.status).toBe(200);
    expect(authenticated.body).toMatchObject({ ok: true });
  });

  it("strict mode: a bootstrap proof is limited to the handshake route", async () => {
    setClientAuthMode(db, "strict");
    setupOperator(db, { display_name: "Op", email: "op@example.com" });
    const token = authenticator.bootstrapToken();
    expect(token).toBeTruthy();
    const response = await router.invoke({
      method: "POST",
      url: "/api/write",
      body: {},
      credential: `Bearer ${token}`,
      transport: "http",
    });
    expect(response.status).toBe(401);
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

  it("revokeOperatorBootstrap unconditionally removes the proof even before enrollment", () => {
    // Round 2 (issue a9ede3c): the revoke is unconditional again — the original
    // anti-theft guarantee that no readable proof coexists with a constructed
    // non-operator backend. Enrollment-first protection lives in init()
    // construction deferral, NOT in a per-caller guard here, so calling revoke
    // directly always destroys the proof regardless of operator credential state.
    setupOperator(db, { slug: "operator", display_name: "Operator" });
    const token = authenticator.bootstrapToken();
    expect(token).toBeTruthy();
    authenticator.refreshBootstrapTokenFile();
    const bootstrapPath = path.join(tempDir, "client-auth", "bootstrap-token");
    expect(fs.existsSync(bootstrapPath)).toBe(true);

    authenticator.revokeOperatorBootstrap();

    // Both the on-disk proof and the in-memory ephemeral token are gone.
    expect(fs.existsSync(bootstrapPath)).toBe(false);
    expect(authenticator.authenticate(token)).toBeNull();
  });

  it("counts an operator whose only credential is an ssh_key as still un-enrolled", () => {
    // Round-2 Medium finding (issue a9ede3c): only api_token credentials can
    // authenticate a presented bearer. An operator holding only an ssh_key still
    // cannot log in, so the enrollment window must stay open (deferral active)
    // until they actually enroll an api_token.
    const operator = setupOperator(db, { slug: "operator", display_name: "Operator" });
    expect(authenticator.isOperatorEnrollmentWindowActive()).toBe(true);
    addCredential(db, operator.id, {
      type: "ssh_key",
      fingerprint: "SHA256:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
    });
    expect(authenticator.isOperatorEnrollmentWindowActive()).toBe(true);
    addCredential(db, operator.id, { type: "api_token", fingerprint: "tokfp-real-enroll" });
    expect(authenticator.isOperatorEnrollmentWindowActive()).toBe(false);
  });

  it("init() defers retained non-operator backends during the enrollment window, leaving the bootstrap intact", () => {
    // Round-2 fix for issue a9ede3c defect 1. At startup sessionManager retains
    // up to N non-running console sessions; normally each is built as a real
    // backend and every non-operator construction revokes the bootstrap. While
    // the operator holds no active api_token, that construction is deferred
    // (DormantBackend), so the 0600 enrollment proof survives daemon startup.
    setupOperator(db, { slug: "operator", display_name: "Operator" });
    const agent = createUser(db, { slug: "bg-agent", kind: "agent", display_name: "BG Agent" });
    addBinding(db, agent.id, { binding_type: "app_name", value: "claude" });

    // Seed one stopped non-operator console session in the DB. Its creation is a
    // deliberate spawn that legitimately revokes the proof, so re-mint the file
    // afterward to model a fresh daemon boot that finds the row already stopped.
    const seedManager = new SessionManager(db, () => undefined, undefined, undefined, authenticator);
    seedManager.create({ label: "Claude", command: "claude", backend_type: "sdk" });
    seedManager.close();
    authenticator.refreshBootstrapTokenFile();
    const bootstrapPath = path.join(tempDir, "client-auth", "bootstrap-token");
    expect(fs.existsSync(bootstrapPath)).toBe(true);

    const manager = new SessionManager(db, () => undefined, undefined, undefined, authenticator);
    manager.init();

    expect(fs.existsSync(bootstrapPath)).toBe(true);
    expect(manager.getRetentionStats().dormant).toBeGreaterThan(0);
    manager.close();
  });

  it("init() constructs retained backends once the operator has enrolled, revoking the bootstrap", () => {
    // Enrollment (an active api_token) closes the window, so init() no longer
    // defers: retained non-operator construction runs and the unconditional
    // revoke destroys the proof, exactly as the anti-theft guarantee requires.
    const operator = setupOperator(db, { slug: "operator", display_name: "Operator" });
    const agent = createUser(db, { slug: "bg-agent", kind: "agent", display_name: "BG Agent" });
    addBinding(db, agent.id, { binding_type: "app_name", value: "claude" });

    const seedManager = new SessionManager(db, () => undefined, undefined, undefined, authenticator);
    seedManager.create({ label: "Claude", command: "claude", backend_type: "sdk" });
    seedManager.close();
    addCredential(db, operator.id, { type: "api_token", fingerprint: "tokfp-enrolled-abc" });
    authenticator.refreshBootstrapTokenFile();
    const bootstrapPath = path.join(tempDir, "client-auth", "bootstrap-token");
    expect(fs.existsSync(bootstrapPath)).toBe(true);

    const manager = new SessionManager(db, () => undefined, undefined, undefined, authenticator);
    manager.init();

    expect(fs.existsSync(bootstrapPath)).toBe(false);
    expect(manager.getRetentionStats().dormant).toBe(0);
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
    setupOperator(db, { slug: "operator", display_name: "Operator" });
    // create() is a deliberate user-initiated spawn, not startup retention, so
    // it constructs a real backend and the unconditional revoke destroys the
    // bootstrap proof (a deliberate spawn forfeits the enrollment window). No
    // operator credential is needed to observe that (issue a9ede3c round 2).
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
