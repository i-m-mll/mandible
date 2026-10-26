import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { expect, it, vi } from "vitest";
import { AuthAutoApproveManager } from "../src/auth-auto-approve.js";
import { AuthHookManager } from "../src/auth-hooks.js";
import { AuthQueue } from "../src/auth-queue.js";
import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { inlineLedgerReader } from "../src/ledger-reads/index.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { Router } from "../src/server.js";
import { addAttributionEvidence, getOperator } from "../src/users/store.js";
import { createMigratedDb } from "./helpers/ledger-fixtures.js";
import { testRuntimeRoot } from "./helpers/runtime-isolation.js";

it("retries a failed hook through the CLI and real route without replaying the merge or claiming premature completion", async () => {
  const dir = fs.mkdtempSync(path.join(testRuntimeRoot, "retry-cli-"));
  const db = createMigratedDb({ operator: { slug: "retry-cli" } });
  const operator = getOperator(db)!;
  const auth = new ClientAuthenticator(db, { secretsDir: path.join(dir, "credentials") });
  const token = auth.mintApiToken(operator.id).token;
  const hooks = new AuthHookManager(db);
  const executor = vi.fn(async () => ({ exit_code: 0, output: "merge executed" }));
  const queue = new AuthQueue({ db, hookManager: hooks, executor, backgroundMaintenance: false });
  const router = new Router({ clientAuth: auth });
  registerAuthRoutes(router, queue, new AuthAutoApproveManager({ db }), undefined, inlineLedgerReader(() => db));
  const requestId = crypto.randomUUID();
  const mergeSha = "a".repeat(40);
  // Retained successful publication: only convergence remains to be repaired.
  const evidence = addAttributionEvidence(db, { evidence_method: "credential_signature", details: {
    publication_verified: true, verified: true, commit_sha: mergeSha, signer_user_id: operator.id,
  } });
  db.prepare(`INSERT INTO auth_requests
    (id, type, command, title, repo, cwd, status, exit_code, output, approved_by_user_id,
     execution_evidence_id, created_at, updated_at, expires_at)
    VALUES (?, 'merge', 'echo merge-must-not-rerun', 'Retry fixture', 'retry-cli', ?, 'completed', 0, ?, ?, ?, 1, 1, ?)`)
    .run(requestId, dir, `MANDIBLE_MERGE_RESULT ${JSON.stringify({ merge_sha: mergeSha })}`, operator.id, evidence.id, Date.now() + 60_000);
  const marker = path.join(dir, "repaired");
  const hook = hooks.create({ repo_pattern: "retry-cli", auth_type: "merge", label: "Repair hook", position: 0,
    required: true, command: `test -f '${marker}'` });
  const request = queue.getRequestReference(requestId)!;
  await hooks.executeHooks(request);
  db.prepare("UPDATE auth_hook_executions SET state = 'failed', max_attempts = attempts WHERE auth_request_id = ?").run(requestId);
  expect(queue.convergenceForRequest(requestId).state).toBe("failed");
  const before = hooks.getRun(requestId, hook.id)!.attempts;
  const mergeExecutions = executor.mock.calls.length;
  let posts = 0;
  let disconnect = false;
  const server = http.createServer(async (req, res) => {
    if (req.url === "/api/instance") {
      res.setHeader("Content-Type", "application/json");
      const operations = router.operationCatalog("test");
      res.end(JSON.stringify({ instance: { role: "main", operational_mutations: "allow",
        instance_id: operations.runtime.instance_id, backend_generation: operations.runtime.backend_generation }, operations }));
      return;
    }
    if (req.method === "POST") {
      posts += 1;
      if (disconnect) { req.socket.destroy(); return; }
    }
    if (!await router.handle(req, res)) { res.statusCode = 404; res.end(); }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as { port: number }).port;
    const run = (...args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn("zsh", ["bin/mandible", "auth", "retry-convergence", requestId, ...args], {
        cwd: process.cwd(), timeout: 15_000,
        env: { ...process.env, MANDIBLE_BASE: `http://127.0.0.1:${port}`, MANDIBLE_TOKEN: token,
          MANDIBLE_HTTP_RETRIES: "3", MANDIBLE_NO_KEYCHAIN_TOKEN: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", data => { stdout += data; });
      child.stderr.on("data", data => { stderr += data; });
      child.once("error", reject);
      child.once("close", code => resolve({ code, stdout, stderr }));
    });
    const failed = await run("--hook", hook.id);
    expect(failed.code, failed.stderr).toBe(1);
    expect(failed.stderr).toContain("Convergence failed");
    expect(failed.stdout).not.toContain("complete");
    expect(hooks.getRun(requestId, hook.id)!.attempts).toBe(before + 1);
    const failedJson = await run("--json");
    expect(failedJson.code, failedJson.stderr).toBe(1);
    expect(JSON.parse(failedJson.stdout).convergence.state).toBe("failed");
    fs.writeFileSync(marker, "repaired");
    const complete = await run("--hook", hook.id, "--json");
    expect(complete.code, complete.stderr).toBe(0);
    expect(JSON.parse(complete.stdout).convergence.state).toBe("complete");
    expect(hooks.getRun(requestId, hook.id)!.attempts).toBe(before + 3);

    const running = hooks.create({ repo_pattern: "retry-cli", auth_type: "merge", label: "Already running", position: 1,
      required: true, command: "exit 0" });
    hooks.planRuns(request);
    db.prepare("UPDATE auth_hook_executions SET state = 'running' WHERE auth_request_id = ? AND hook_id = ?").run(requestId, running.id);
    const pending = await run();
    expect(pending.code, pending.stderr).toBe(0);
    expect(pending.stdout).toContain("retry admitted, still running");
    expect(pending.stdout).not.toContain("complete");
    const pendingJson = await run("--json");
    expect(pendingJson.code, pendingJson.stderr).toBe(0);
    expect(JSON.parse(pendingJson.stdout).convergence.state).toBe("pending");

    disconnect = true;
    const postsBeforeDisconnect = posts;
    const unconfirmed = await run();
    expect(unconfirmed.code).toBe(1);
    expect(unconfirmed.stderr).toContain("outcome unconfirmed");
    expect(unconfirmed.stderr).toContain(`mandible auth show ${requestId}`);
    expect(unconfirmed.stdout).not.toContain("complete");
    expect(posts).toBe(postsBeforeDisconnect + 1);
    expect(executor.mock.calls.length).toBe(mergeExecutions);
    expect(queue.getRequestReference(requestId)).toMatchObject({ status: "completed", exit_code: 0, execution_evidence_id: evidence.id });
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await queue.dispose();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
