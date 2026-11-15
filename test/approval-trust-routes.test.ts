// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { setDb, type Db } from "../src/db.js";
import { listTrustChanges, OperatorSigningAuthority } from "../src/operator-signing/authority.js";
import { buildProtectedBranchGuardProjection } from "../src/protected-branch-guard.js";
import { operatorAllowedSignerLines } from "../src/protected-branch-signers.js";
import { registerProjectRoutes } from "../src/routes/projects.js";
import { registerUserRoutes } from "../src/routes/users.js";
import { Router } from "../src/server.js";
import { addCredential, createUser, getOperatorId, listCredentials, setupOperator } from "../src/users/store.js";
import { migratedFileDb } from "./helpers/ledger-fixtures.js";
import { SoftwareOperatorSigner } from "./helpers/operator-signing-fixtures.js";

let db: Db; let root: string; let router: Router; let signer: SoftwareOperatorSigner;
let operatorId: string; let operatorToken: string; let agentToken: string;

function softKey(name: string) {
  const file = path.join(root, name);
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "", "-f", file]);
  const pub = fs.readFileSync(`${file}.pub`, "utf8").trim();
  const fingerprint = execFileSync("ssh-keygen", ["-lf", `${file}.pub`, "-E", "sha256"], { encoding: "utf8" }).split(/\s+/)[1]!;
  return { pub, fingerprint };
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-trust-routes-"));
  db = migratedFileDb(path.join(root, "db")); setDb(db);
  operatorId = setupOperator(db, { display_name: "Operator", email: "op@example.test" }).id;
  const agent = createUser(db, { slug: "agent", kind: "agent", display_name: "Agent" });
  const auth = new ClientAuthenticator(db, { secretsDir: path.join(root, "auth") });
  operatorToken = auth.mintApiToken(operatorId).token;
  agentToken = auth.mintApiToken(agent.id).token;
  signer = new SoftwareOperatorSigner();
  const signing = new OperatorSigningAuthority(db, signer, path.join(root, "approval-keys"));
  router = new Router({ clientAuth: auth });
  registerUserRoutes(router, signing);
  registerProjectRoutes(router, signing);
  const enrolled = await signing.enroll();
  if (!enrolled.ok) throw new Error(JSON.stringify(enrolled.error));
  signer.touches = [];
});
afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

const asOperator = (method: string, url: string, body: unknown = {}) => router.invoke({ method, url, body, credential: operatorToken, transport: "http" });
const trusts = (pub: string) => operatorAllowedSignerLines(db).some((line) => line.includes(pub.split(" ")[1]!));

it("the operator signs with Touch ID only: no route adds another signing key to the operator", async () => {
  const given = softKey("given.key");
  const before = operatorAllowedSignerLines(db);
  const added = await asOperator("POST", `/api/users/${operatorId}/credentials`, { type: "ssh_key", fingerprint: given.fingerprint, public_material: given.pub });
  expect(added.status).toBe(400);
  expect(signer.touches).toHaveLength(0);
  expect(trusts(given.pub)).toBe(false);
  expect(operatorAllowedSignerLines(db)).toEqual(before);
  expect((await asOperator("POST", "/api/users/operator/signing-key", { public_key: given.pub })).status).toBe(404);

  expect(router.resolveFileRpcPolicy("POST", `/api/users/${operatorId}/credentials`)).toBe(false);
  expect(router.resolveFileRpcPolicy("POST", "/api/users/agent/credentials")).toBe(true);
});

it("the configured operator's status cannot change, so the trust set cannot be emptied without a signature", async () => {
  const before = operatorAllowedSignerLines(db);
  const retired = await router.invoke({ method: "PATCH", url: `/api/users/${operatorId}`, body: { status: "retired" }, transport: "local-socket" as never });
  expect(retired.status).toBe(400);
  expect(operatorAllowedSignerLines(db)).toEqual(before);
});

it("first-run setup does not adopt a user that already has signing keys", async () => {
  const second = createUser(db, { slug: "second", kind: "human", display_name: "Second" });
  const key = softKey("second.key");
  addCredential(db, second.id, { type: "ssh_key", fingerprint: key.fingerprint, public_material: key.pub });
  db.prepare("DELETE FROM settings WHERE key = 'user.operator_id'").run();
  const setup = await router.invoke({ method: "POST", url: "/api/users/setup", body: { slug: "second" }, transport: "in-process" });
  expect(setup.status).toBe(409);
  expect(getOperatorId(db)).toBeNull();
  expect(listCredentials(db, second.id)).toHaveLength(1);
});

it("changing a registered checkout's default branch is a signed trust change", async () => {
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo); execFileSync("git", ["init", "-q", "-b", "trunk", repo]);
  expect((await asOperator("POST", "/api/projects", { project_key: "demo", display_name: "Demo" })).status).toBe(201);
  expect((await asOperator("POST", "/api/projects/demo/checkouts", { root: repo, default_branch: "trunk" })).status).toBe(200);
  expect(signer.touches).toHaveLength(0);
  const refs = () => buildProtectedBranchGuardProjection(db).protectedRefs.map(([, ref]) => ref);
  const covered = refs();
  const changes = listTrustChanges(db).length;

  const agent = await router.invoke({ method: "POST", url: "/api/projects/checkouts", body: { project: "demo", root: repo, default_branch: "release" }, credential: agentToken, transport: "http" });
  expect(agent.status).toBe(403);
  signer.next.push({ result: "cancelled" });
  expect((await asOperator("POST", "/api/projects/demo/checkouts", { root: repo, default_branch: "" })).status).toBe(409);
  expect(refs()).toEqual(covered);
  expect(listTrustChanges(db)).toHaveLength(changes);

  expect((await asOperator("POST", "/api/projects/demo/checkouts", { root: repo, default_branch: "release" })).status).toBe(200);
  expect(refs()).not.toEqual(covered);
  expect(listTrustChanges(db)).toHaveLength(changes + 1);
  expect(signer.touches).toHaveLength(2);
});
