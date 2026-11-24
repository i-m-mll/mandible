// @vitest-environment node
import { migratedFileDb } from './helpers/ledger-fixtures.js';
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { setDb, type Db } from "../src/db.js";
import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { attributionForRequest } from "../src/client-auth/authz.js";
import { Router } from "../src/server.js";
import { registerUserRoutes } from "../src/routes/users.js";
import { registerSettingsRoutes } from "../src/routes/settings.js";
import { OPERATOR_STATEMENT_NAMESPACE, OperatorSigningAuthority, listTrustChanges, verifySshSignature } from "../src/operator-signing/authority.js";
import { addBinding, createUser, listCredentials, setupOperator } from "../src/users/store.js";
import { SoftwareOperatorSigner } from "./helpers/operator-signing-fixtures.js";

let db: Db; let root: string; let auth: ClientAuthenticator; let router: Router;
let agentId: string; let operatorId: string; let operatorToken: string; let agentToken: string;
let signer: SoftwareOperatorSigner; let signing: OperatorSigningAuthority;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-signed-actions-"));
  db = migratedFileDb(path.join(root, "db")); setDb(db);
  operatorId = setupOperator(db, { display_name: "Operator" }).id;
  const agent = createUser(db, { slug: "agent", kind: "agent", display_name: "Agent" }); agentId = agent.id;
  addBinding(db, agent.id, { binding_type: "provider_session_env", value: "CODEX_THREAD_ID" });
  auth = new ClientAuthenticator(db, { secretsDir: path.join(root, "auth") });
  operatorToken = auth.mintApiToken(operatorId).token;
  agentToken = auth.mintApiToken(agentId).token;
  signer = new SoftwareOperatorSigner();
  signing = new OperatorSigningAuthority(db, signer, path.join(root, "approval-keys"));
  router = new Router({ clientAuth: auth });
  registerUserRoutes(router, signing); registerSettingsRoutes(router, "main", signing);
  router.post("/api/write", (req, res) => res.json({ user: req.client_identity?.user_id, session: req.client_identity?.session_id,
    attribution: attributionForRequest(db, req) }), { operation: { id: "ordinary-write", effects: ["ledger:write"], requestSchema: null, reportingCategory: "ledger" }, fileRpc: "allow" });
});
afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

const asOperator = (method: string, url: string, body: unknown = {}) => router.invoke({ method, url, body, credential: operatorToken, transport: "http" });
const setBranches = (value: string) => asOperator("PUT", "/api/settings/protected_branches", { value });
const branches = () => (db.prepare("SELECT value FROM settings WHERE key = 'protected_branches'").get() as { value: string } | undefined)?.value;
const enroll = (confirm_bootstrap?: boolean) => asOperator("POST", "/api/users/operator/approval-key", confirm_bootstrap ? { confirm_bootstrap } : {});
const enclaveKey = () => listCredentials(db, operatorId).find((credential) => credential.custody === "enclave")!;

it("attributes tokenless writes to their agent session and rejects unknown managed identities instead of human-authoring them", async () => {
  const ambientIdentity = { provider: "codex", provider_session_id: "worker-session" };
  const response = await router.invoke({ method: "POST", url: "/api/write", body: {}, ambient_identity: ambientIdentity, transport: "local-socket" });
  expect(response).toMatchObject({ status: 200, body: { user: agentId, session: "worker-session", attribution: { user_id: agentId, evidence_method: "session_claim" } } });
  expect((await router.invoke({ method: "POST", url: "/api/write", body: {}, ambient_identity: { provider: "antigravity", provider_session_id: "unknown" }, transport: "local-socket" })).status).toBe(401);
});

it("performs courtesy actions on the route's identity check alone, without a touch", async () => {
  const body = { slug: "new-agent", kind: "agent", display_name: "New agent" };
  expect((await router.invoke({ method: "POST", url: "/api/users", body, credential: agentToken, transport: "http" })).status).toBe(403);
  expect((await asOperator("POST", "/api/users", body)).status).toBe(201);
  expect(signer.touches).toEqual([]);
});

it("refuses a signed action without an enrolled key, then bootstraps enrollment and signs with one touch", async () => {
  const before = branches();
  expect(await setBranches('["main"]')).toMatchObject({ status: 409, body: { code: "operator_signature_approval_key_required" } });
  expect(branches()).toBe(before);

  const enrolled = await enroll();
  expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
  expect(enrolled.body).toMatchObject({ trust_change: { kind: "approval_key_enrollment", authorization: "bootstrap" } });
  expect(signer.touches).toHaveLength(1);

  expect((await setBranches('["main"]')).status).toBe(200);
  expect(branches()).toBe('["main"]');
  expect(signer.touches).toHaveLength(2);
  expect(signer.touches[1]).toMatchObject({ namespace: OPERATOR_STATEMENT_NAMESPACE, key: signing.keyPath(enclaveKey().fingerprint) });
  const [change] = listTrustChanges(db).filter((entry) => entry.kind === "protected_branches");
  expect(change).toMatchObject({ authorization: "signed", signatures: [{ credential_id: enclaveKey().id, role: "approval_key" }] });
  expect(await verifySshSignature(enclaveKey().public_material!, OPERATOR_STATEMENT_NAMESPACE, change!.statement, change!.signatures[0]!.signature)).toBe(true);
});

it("refuses forged, foreign, cancelled and failed helper output without changing state", async () => {
  expect((await enroll()).status).toBe(201);
  const before = branches();
  const foreign = new SoftwareOperatorSigner();
  const foreignKey = path.join(root, "foreign.key");
  await foreign.create(foreignKey);
  const foreignSignature = await foreign.sign({ key: foreignKey, namespace: OPERATOR_STATEMENT_NAMESPACE, message: Buffer.from("anything"), reason: "x" });
  if (foreignSignature.result !== "signed") throw new Error("fixture signing failed");

  signer.next.push({ result: "signed", signature: foreignSignature.signature });
  expect(await setBranches("[]")).toMatchObject({ status: 403, body: { code: "operator_signature_untrusted_signature" } });
  signer.next.push({ result: "signed", signature: "-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----\n" });
  expect(await setBranches("[]")).toMatchObject({ status: 403, body: { code: "operator_signature_untrusted_signature" } });
  signer.next.push({ result: "cancelled" });
  expect(await setBranches("[]")).toMatchObject({ status: 409, body: { code: "operator_signature_cancelled" } });
  signer.next.push({ result: "failed", detail: "helper crashed" });
  expect(await setBranches("[]")).toMatchObject({ status: 502, body: { code: "operator_signature_signing_failed" } });
  expect(branches()).toBe(before);
  expect(listTrustChanges(db).map((entry) => entry.kind)).toEqual(["approval_key_enrollment"]);
});

it("replaces a usable key with both signatures and revokes the old key", async () => {
  expect((await enroll()).status).toBe(201);
  expect((await setBranches('["main"]')).status).toBe(200);
  const first = enclaveKey();
  const signedChange = listTrustChanges(db).find((entry) => entry.kind === "protected_branches")!;

  const replaced = await enroll();
  expect(replaced.status, JSON.stringify(replaced.body)).toBe(201);
  expect(replaced.body).toMatchObject({ trust_change: { authorization: "signed", signatures: [{ role: "new_key" }, { role: "approval_key", credential_id: first.id }] } });
  expect(signer.touches.slice(-2).map((touch) => touch.key)).toEqual([signing.keyPath(enclaveKey().fingerprint), signing.keyPath(first.fingerprint)]);
  const old = listCredentials(db, operatorId, { includeRevoked: true }).find((credential) => credential.id === first.id)!;
  expect(old).toMatchObject({ status: "revoked", custody: "enclave" });
  expect(enclaveKey().id).not.toBe(first.id);
  expect(await verifySshSignature(old.public_material!, OPERATOR_STATEMENT_NAMESPACE, signedChange.statement, signedChange.signatures[0]!.signature)).toBe(true);
  expect((await setBranches("[]")).status).toBe(200);
  expect(signer.touches.at(-1)!.key).toBe(signing.keyPath(enclaveKey().fingerprint));
});

it("bootstraps automatically for a missing key, asks first for an unclassified failure, and never for a transient one", async () => {
  expect((await enroll()).status).toBe(201);
  const key = signing.keyPath(enclaveKey().fingerprint);

  signer.states.set(key, { state: "biometry_locked_out" });
  expect(await enroll()).toMatchObject({ status: 409, body: { code: "operator_signature_biometry_locked_out" } });
  signer.states.set(key, { state: "failed", detail: "unreadable wrapped key" });
  expect(await enroll()).toMatchObject({ status: 409, body: { code: "operator_signature_bootstrap_confirmation_required" } });
  expect(listTrustChanges(db)).toHaveLength(1);
  expect(await enroll(true)).toMatchObject({ status: 201, body: { trust_change: { authorization: "bootstrap" } } });

  fs.rmSync(signing.keyPath(enclaveKey().fingerprint));
  expect(await enroll()).toMatchObject({ status: 201, body: { trust_change: { authorization: "bootstrap" } } });
  expect(listCredentials(db, operatorId).filter((credential) => credential.custody === "enclave")).toHaveLength(1);
});

