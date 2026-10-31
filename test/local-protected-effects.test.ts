// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDb, setDb, type Db } from "../src/db.js";
import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { attributionForRequest } from "../src/client-auth/authz.js";
import { signOperatorChallenge } from "../src/auth-operator-proof.js";
import { Router, type RequestLike } from "../src/server.js";
import { registerUserRoutes } from "../src/routes/users.js";
import { registerSettingsRoutes } from "../src/routes/settings.js";
import { addBinding, addCredential, createUser, setupOperator } from "../src/users/store.js";

vi.mock("../src/auth-operator-proof.js", () => ({ signOperatorChallenge: vi.fn(), operatorGitEnv: () => process.env }));
let db: Db; let root: string; let auth: ClientAuthenticator; let router: Router;
let agentId: string; let credentialId: string;
beforeEach(() => {
  vi.mocked(signOperatorChallenge).mockReset().mockResolvedValue({ ok: false, reason: "cancelled", detail: "No operator presence" });
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-protected-"));
  db = openDb(path.join(root, "db")); setDb(db);
  const operator = setupOperator(db, { display_name: "Operator" });
  const agent = createUser(db, { slug: "agent", kind: "agent", display_name: "Agent" }); agentId = agent.id;
  addBinding(db, agent.id, { binding_type: "provider_session_env", value: "CODEX_THREAD_ID" });
  credentialId = addCredential(db, operator.id, { type: "ssh_key", fingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", public_material: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }).id;
  auth = new ClientAuthenticator(db, { secretsDir: path.join(root, "auth") });
  router = new Router({ clientAuth: auth });
  registerUserRoutes(router); registerSettingsRoutes(router);
  router.post("/api/write", (req, res) => res.json({ user: req.client_identity?.user_id, session: req.client_identity?.session_id,
    attribution: attributionForRequest(db, req) }), { operation: { id: "ordinary-write", effects: ["ledger:write"], requestSchema: null, reportingCategory: "ledger" }, fileRpc: "allow" });
});
afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
const ambientIdentity = { provider: "codex", provider_session_id: "worker-session" };

it("attributes tokenless writes to their agent session and rejects unknown managed identities instead of human-authoring them", async () => {
  const response = await router.invoke({ method: "POST", url: "/api/write", body: {}, ambient_identity: ambientIdentity, transport: "local-socket" });
  expect(response).toMatchObject({ status: 200, body: { user: agentId, session: "worker-session", attribution: { user_id: agentId, evidence_method: "session_claim" } } });
  expect((await router.invoke({ method: "POST", url: "/api/write", body: {}, ambient_identity: { provider: "gemini", provider_session_id: "unknown" }, transport: "local-socket" })).status).toBe(401);
  expect(signOperatorChallenge).not.toHaveBeenCalled();
});

it("requires fresh presence for real user and protection-setting effects with claimed or missing agent markers, including operator bearer possession", async () => {
  for (const ambient of [ambientIdentity, undefined]) {
    const operatorToken = auth.mintApiToken(db.prepare("SELECT value FROM settings WHERE key = 'user.operator_id'").get().value).token;
    expect((await router.invoke({ method: "POST", url: "/api/users", body: { slug: "new-agent", kind: "agent", display_name: "New agent" }, credential: operatorToken, ambient_identity: ambient, transport: "local-socket" })).status).toBe(403);
    expect((await router.invoke({ method: "PUT", url: "/api/settings/protected_branches", body: { value: "[]" }, credential: operatorToken, ambient_identity: ambient, transport: "local-socket" })).status).toBe(403);
  }
  expect(db.prepare("SELECT id FROM users WHERE slug = 'new-agent'").get()).toBeUndefined();
  expect(db.prepare("SELECT value FROM settings WHERE key = 'protected_branches'").get()).toEqual({ value: "main,develop" });
  vi.mocked(signOperatorChallenge).mockResolvedValueOnce({ ok: true, credentialId, signature: "verified-proof" });
  expect((await router.invoke({ method: "PUT", url: "/api/settings/protected_branches", body: { value: '["main"]' }, ambient_identity: ambientIdentity, transport: "local-socket" })).status).toBe(200);
  expect(db.prepare("SELECT value FROM settings WHERE key = 'protected_branches'").get()).toEqual({ value: '["main"]' });
  expect((await router.invoke({ method: "PUT", url: "/api/settings/protected_branches", body: { value: "[]" }, ambient_identity: ambientIdentity, transport: "local-socket" })).status).toBe(403);
});

it("rejects action tampering while signing and never reuses a preceding proof", async () => {
  const request: RequestLike = { method: "PUT", url: "/api/settings/protected_branches", params: { key: "protected_branches" }, query: {}, body: { value: '["main"]' }, client_identity: auth.localSocketIdentity(null, false) };
  vi.mocked(signOperatorChallenge).mockImplementationOnce(async () => {
    request.body = { value: "[]" };
    return { ok: true, credentialId, signature: "verified-proof" };
  });
  await expect(auth.authorizeProtectedMutation(request, { id: "test", effects: ["auth:credentials"] })).rejects.toMatchObject({ code: "operator_presence_stale" });
});
