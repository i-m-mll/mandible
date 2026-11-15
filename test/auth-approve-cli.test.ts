/** @vitest-environment node */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { setDb } from "../src/db.js";
import { inlineLedgerReader } from "../src/ledger-reads/index.js";
import { addGrant } from "../src/permissions/store.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { Router } from "../src/server.js";
import { SseManager, setSseManager } from "../src/sse.js";
import { createUser, listCredentials } from "../src/users/store.js";
import { git } from "./helpers/auth-queue-fixtures.js";
import { rig, type Rig } from "./helpers/approval-gate-rig.js";

const markerEnv = /^(CLAUDE|CODEX_|GEMINI_|MANDIBLE_(MANAGED_|SESSION_|EXECUTION_CONTEXT$|AGENT_REF$))/;

interface Harness {
  r: Rig;
  auth: ClientAuthenticator;
  token: string;
  base: string;
  approvePosts: () => number;
  cancelPosts: () => number;
  holdSubscription: (gate: () => Promise<unknown>) => void;
  resolvedBroadcast: (id: string) => Promise<void>;
  approve: (args: string[], env?: Record<string, string>) => { child: ChildProcess; done: Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> };
  close: () => Promise<void>;
}

let harness: Harness;

beforeEach(async () => {
  const r = rig();
  setDb(r.db);
  const sse = new SseManager();
  setSseManager(sse);
  const resolved = new Set<string>();
  sse.observeEvents((event) => {
    if (event.type === "auth:resolved") resolved.add((event.data as { request_id: string }).request_id);
  });
  const auth = new ClientAuthenticator(r.db, { secretsDir: fs.mkdtempSync(path.join(os.tmpdir(), "approve-cli-credentials-")) });
  const token = auth.mintApiToken(r.operatorId).token;
  const router = new Router({ clientAuth: auth });
  registerAuthRoutes(router, r.queue, inlineLedgerReader(() => r.db));
  let approvePosts = 0, cancelPosts = 0;
  let gate: (() => Promise<unknown>) | null = null;
  const server = http.createServer(async (req, res) => {
    if (req.url === "/api/instance") {
      const operations = router.operationCatalog("test");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ instance: { role: "main", operational_mutations: "allow",
        instance_id: operations.runtime.instance_id, backend_generation: operations.runtime.backend_generation }, operations }));
      return;
    }
    if (req.url === "/api/events/subscribe") {
      if (gate) await gate();
      sse.addClient(req, res, ["auth:"]);
      return;
    }
    if (req.method === "POST" && req.url?.endsWith("/approve")) approvePosts += 1;
    if (req.method === "POST" && req.url?.endsWith("/cancel-proof")) cancelPosts += 1;
    if (!await router.handle(req, res)) { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const operatorEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !markerEnv.test(key)));
  harness = {
    r, auth, token, base,
    approvePosts: () => approvePosts,
    cancelPosts: () => cancelPosts,
    holdSubscription: (next) => { gate = next; },
    resolvedBroadcast: (id) => expect.poll(() => resolved.has(id), { timeout: 15_000 }).toBe(true),
    approve(args, env = {}) {
      const child = spawn("zsh", ["bin/mandible", "auth", "approve", ...args], {
        cwd: process.cwd(), timeout: 20_000, stdio: ["ignore", "pipe", "pipe"],
        env: { ...operatorEnv, MANDIBLE_BASE: base, MANDIBLE_TOKEN: token, MANDIBLE_NO_KEYCHAIN_TOKEN: "1", ...env },
      });
      let stderr = "";
      child.stderr!.on("data", (data) => { stderr += data; });
      child.stdout!.resume();
      const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal, stderr }));
      });
      return { child, done };
    },
    async close() {
      sse.closeAll();
      setSseManager(null);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await r.dispose();
    },
  };
});

afterEach(async () => harness.close());

function revision(id: string): string {
  return String(harness.r.queue.lifecycleRevision(id));
}

it("one touch publishes the merge signed by the approval key, even when it settles before the subscription", async () => {
  const { r } = harness;
  const request = await r.submit("feature/terminal-approve");
  harness.holdSubscription(() => harness.resolvedBroadcast(request.id));
  const result = await harness.approve([request.id.slice(0, 8), "--revision", revision(request.id)]).done;
  expect(result.code, result.stderr).toBe(0);
  expect(r.signer.touches).toHaveLength(1);
  expect(git(r.repo, ["rev-parse", "main^2"])).toBe(request.merge_head_sha);
  const approvalKey = listCredentials(r.db, r.operatorId).find((credential) => credential.id === r.enclaveCredentialId)!;
  const signers = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "approve-cli-signers-")), "allowed_signers");
  fs.writeFileSync(signers, `* ${approvalKey.public_material}\n`);
  git(r.repo, ["-c", "gpg.format=ssh", "-c", `gpg.ssh.allowedSignersFile=${signers}`, "verify-commit", "main"]);
});

it("refuses a stale revision without a touch", async () => {
  const { r } = harness;
  const request = await r.submit("feature/stale-revision");
  const result = await harness.approve([request.id, "--revision", String(Number(revision(request.id)) - 1)]).done;
  expect(result.code).toBe(1);
  expect(r.signer.touches).toHaveLength(0);
  expect((await r.queue.getRequest(request.id))!.status).toBe("pending");
});

it("a cancelled touch leaves the request pending", async () => {
  const { r } = harness;
  const request = await r.submit("feature/cancelled-touch");
  r.signer.next.push({ result: "cancelled" });
  const result = await harness.approve([request.id, "--revision", revision(request.id)]).done;
  expect(result.code).toBe(1);
  expect(r.signer.touches).toHaveLength(1);
  expect((await r.queue.getRequest(request.id))!.status).toBe("pending");
});

it("TERM while the sheet is up dismisses it and leaves the request pending", async () => {
  const { r } = harness;
  const request = await r.submit("feature/terminated");
  const held = r.signer.block();
  const run = harness.approve([request.id, "--revision", revision(request.id)]);
  await held.entered;
  run.child.kill("SIGTERM");
  const result = await run.done;
  held.release();
  expect(result.code).toBe(130);
  expect(harness.cancelPosts()).toBe(1);
  await expect.poll(() => (r.queue as unknown as { operatorProofInFlight: Map<string, unknown> }).operatorProofInFlight.size).toBe(0);
  expect((await r.queue.getRequest(request.id))!.status).toBe("pending");
});

it("an agent context is refused before any approval request", async () => {
  const { r } = harness;
  const request = await r.submit("feature/agent-context");
  const result = await harness.approve([request.id, "--revision", revision(request.id)], { CLAUDE_CODE_SESSION_ID: "agent-session" }).done;
  expect(result.code).toBe(1);
  expect(harness.approvePosts()).toBe(0);
  expect(r.signer.touches).toHaveLength(0);
});

it("a non-operator holding approve_auth is refused with 403, not a server error", async () => {
  const { r } = harness;
  const request = await r.submit("feature/deputy");
  const deputy = createUser(r.db, { slug: "deputy", kind: "human", display_name: "Deputy" });
  addGrant(r.db, { subject_type: "user", subject: deputy.id, permission: "approve_auth" });
  const response = await fetch(`${harness.base}/api/auth/request/${request.id}/approve`, {
    method: "POST", headers: { Authorization: `Bearer ${harness.auth.mintApiToken(deputy.id).token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ lifecycle_revision: r.queue.lifecycleRevision(request.id) }),
  });
  expect(response.status).toBe(403);
  expect(r.signer.touches).toHaveLength(0);
});
