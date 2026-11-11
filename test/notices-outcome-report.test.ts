import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { expect, it } from "vitest";
import { AuthAutoApproveManager } from "../src/auth-auto-approve.js";
import { AuthHookManager } from "../src/auth-hooks.js";
import { AuthQueue } from "../src/auth-queue.js";
import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { inlineLedgerReader } from "../src/ledger-reads/index.js";
import { outcomeReportDigest } from "../src/notices/contract.js";
import { createOutcomeReporter } from "../src/notices/report.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { Router } from "../src/server.js";
import { getOperator } from "../src/users/store.js";
import { createMigratedDb } from "./helpers/ledger-fixtures.js";
import { testRuntimeRoot } from "./helpers/runtime-isolation.js";
import type { Db } from "../src/db.js";

const MERGE_SHA = "a".repeat(40);

function insertRequest(db: Db, fields: { status: string; output?: string; error?: string; finalizer?: unknown }): string {
  const id = randomUUID();
  db.prepare(`INSERT INTO auth_requests (id, type, command, title, status, output, error, merge_finalizer_state, created_at, updated_at, expires_at)
    VALUES (?, 'merge', 'true', 'Fixture', ?, ?, ?, ?, 1, 1, ?)`)
    .run(id, fields.status, fields.output ?? "", fields.error ?? null,
      fields.finalizer === undefined ? null : JSON.stringify(fields.finalizer), Date.now() + 60_000);
  return id;
}

function insertAction(db: Db, requestId: string, ordinal: number, issue: string, state: string): void {
  db.prepare(`INSERT INTO auth_request_actions (id, auth_request_id, ordinal, kind, target_issue_ref, payload, state, staged_at, updated_at)
    VALUES (?, ?, ?, 'issue_close', ?, '{}', ?, 1, 1)`).run(randomUUID(), requestId, ordinal, issue, state);
}

function insertHook(db: Db, requestId: string, hookId: string, state: string, exitCode: number | null): void {
  db.prepare(`INSERT INTO auth_hook_executions (id, auth_request_id, hook_id, command, command_digest, required, state, exit_code, created_at, updated_at)
    VALUES (?, ?, ?, 'true', ?, 1, ?, ?, 1, 1)`).run(randomUUID(), requestId, hookId, "0".repeat(64), state, exitCode);
}

function seed(db: Db) {
  const merge = insertRequest(db, {
    status: "completed",
    output: `MANDIBLE_MERGE_RESULT ${JSON.stringify({ merge_sha: MERGE_SHA })}`,
    finalizer: {
      revalidate_pending: { state: "done", attempts: 1, at: 1 },
      auto_dismiss_duplicates: { state: "failed", attempts: 3, at: 1, error: "boom" },
      remove_merged_branches: { state: "done", attempts: 1, at: 1, output: { branches: [
        { branch: "feature/b", result: "kept", reason: "preview_running", worktree_path: "/w/b" },
        { branch: "feature/a", result: "removed", reason: null, worktree_path: null },
      ] } },
    },
  });
  insertAction(db, merge, 0, "2222222", "staged");
  insertAction(db, merge, 1, "1111111", "applied");
  insertAction(db, merge, 2, "3333333", "vetoed");
  insertHook(db, merge, "rebuild", "failed", 1);
  insertHook(db, merge, "notify", "complete", 0);

  const rejected = insertRequest(db, { status: "rejected" });
  db.prepare(`INSERT INTO auth_request_lifecycle_events (id, auth_request_id, revision, event_type, next_status, snapshot_json, snapshot_sha256, reason, occurred_at)
    VALUES (?, ?, 1, 'rejected', 'rejected', '{}', ?, 'Not this week', 1)`).run(randomUUID(), rejected, "0".repeat(64));
  const failed = insertRequest(db, { status: "failed", error: "merge conflict in src/a.ts\nfull trace" });
  const pending = insertRequest(db, { status: "pending" });
  return { merge, rejected, failed, pending };
}

it("reports each consequent action of a settled request with its state, stably", () => {
  const db = createMigratedDb({ operator: { slug: "outcome-report" } });
  try {
    const ids = seed(db);
    const report = createOutcomeReporter(db);
    expect(report(ids.merge)).toEqual({
      request_id: ids.merge, type: "merge", status: "completed", merge_commit: MERGE_SHA, reason: null,
      steps: [
        { kind: "action", action: "issue_close", issue: "1111111", state: "done", reason: null },
        { kind: "action", action: "issue_close", issue: "2222222", state: "withheld", reason: "awaiting_convergence" },
        { kind: "action", action: "issue_close", issue: "3333333", state: "skipped", reason: "vetoed" },
        { kind: "finalizer", step: "archive_worker_threads", state: "pending", reason: null },
        { kind: "finalizer", step: "auto_dismiss_duplicates", state: "failed", reason: null },
        { kind: "finalizer", step: "resolve_ancestry_work_units", state: "pending", reason: null },
        { kind: "finalizer", step: "revalidate_pending", state: "done", reason: null },
        { kind: "hook", hook_id: "notify", required: true, state: "done", reason: null },
        { kind: "hook", hook_id: "rebuild", required: true, state: "failed", reason: "exit 1" },
        { kind: "branch_removal", branch: "feature/a", state: "done", reason: null },
        { kind: "branch_removal", branch: "feature/b", state: "kept", reason: "preview_running" },
      ],
    });
    expect(report(ids.rejected)).toMatchObject({ status: "rejected", merge_commit: null, reason: "Not this week", steps: [] });
    expect(report(ids.failed)).toMatchObject({ status: "failed", reason: "merge conflict in src/a.ts" });
    expect(report(ids.pending)).toBeNull();

    const digest = outcomeReportDigest(report(ids.merge)!);
    expect(outcomeReportDigest(report(ids.merge)!)).toBe(digest);
    db.prepare("UPDATE auth_hook_executions SET state = 'complete', exit_code = 0 WHERE auth_request_id = ? AND hook_id = 'rebuild'").run(ids.merge);
    expect(outcomeReportDigest(report(ids.merge)!)).not.toBe(digest);
  } finally {
    db.close();
  }
});

it("reports each declared preview teardown, withheld until the merge is live", () => {
  const db = createMigratedDb({ operator: { slug: "outcome-report-teardown" } });
  try {
    const merge = insertRequest(db, { status: "completed", output: `MANDIBLE_MERGE_RESULT ${JSON.stringify({ merge_sha: MERGE_SHA })}` });
    const declared: Array<[string, string, string | null]> = [
      ["feature/done", "applied", "Torn down run r1"],
      ["feature/vetoed", "vetoed", null],
      ["feature/unlanded", "failed", "not_merged"],
      ["feature/broken", "failed", "cleanup refused"],
      ["feature/waiting", "staged", null],
    ];
    declared.forEach(([branch, state, detail], ordinal) => db.prepare(
      `INSERT INTO auth_request_actions (id, auth_request_id, ordinal, kind, target_issue_ref, payload, state, outcome_detail, staged_at, updated_at)
       VALUES (?, ?, ?, 'preview_teardown', '1111111', ?, ?, ?, 1, 1)`,
    ).run(randomUUID(), merge, ordinal, JSON.stringify({ branch }), state, detail));
    insertHook(db, merge, "rebuild", "pending", null);
    const teardowns = () => Object.fromEntries(createOutcomeReporter(db)(merge)!.steps
      .flatMap(step => step.kind === "preview_teardown" ? [[step.branch, `${step.state} ${step.reason}`]] : []));
    expect(teardowns()).toEqual({
      "feature/done": "done null",
      "feature/vetoed": "skipped vetoed",
      "feature/unlanded": "kept not_merged",
      "feature/broken": "failed cleanup refused",
      "feature/waiting": "withheld awaiting_convergence",
    });
    db.prepare("UPDATE auth_hook_executions SET state = 'complete', exit_code = 0 WHERE auth_request_id = ?").run(merge);
    expect(teardowns()["feature/waiting"]).toBe("pending null");
  } finally {
    db.close();
  }
});

it("serves the report through `mandible auth show`", async () => {
  const dir = fs.mkdtempSync(path.join(testRuntimeRoot, "outcome-report-cli-"));
  const db = createMigratedDb({ operator: { slug: "outcome-report-cli" } });
  const auth = new ClientAuthenticator(db, { secretsDir: path.join(dir, "credentials") });
  const token = auth.mintApiToken(getOperator(db)!.id).token;
  const queue = new AuthQueue({ db, hookManager: new AuthHookManager(db), backgroundMaintenance: false });
  const router = new Router({ clientAuth: auth });
  registerAuthRoutes(router, queue, new AuthAutoApproveManager({ db }), undefined, inlineLedgerReader(() => db));
  const server = http.createServer(async (req, res) => {
    if (req.url === "/api/instance") {
      res.setHeader("Content-Type", "application/json");
      const operations = router.operationCatalog("test");
      res.end(JSON.stringify({ instance: { role: "main", operational_mutations: "allow",
        instance_id: operations.runtime.instance_id, backend_generation: operations.runtime.backend_generation }, operations }));
      return;
    }
    if (!await router.handle(req, res)) { res.statusCode = 404; res.end(); }
  });
  try {
    const ids = seed(db);
    const report = createOutcomeReporter(db);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as { port: number }).port;
    const show = (...args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn("zsh", ["bin/mandible", "auth", "show", ...args], {
        cwd: process.cwd(), timeout: 15_000,
        env: { ...process.env, MANDIBLE_BASE: `http://127.0.0.1:${port}`, MANDIBLE_TOKEN: token, MANDIBLE_NO_KEYCHAIN_TOKEN: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", data => { stdout += data; });
      child.stderr.on("data", data => { stderr += data; });
      child.once("error", reject);
      child.once("close", code => resolve({ code, stdout, stderr }));
    });
    for (const id of [ids.merge, ids.rejected, ids.failed]) {
      const json = await show(id, "--json");
      expect(json.code, json.stderr).toBe(0);
      expect(JSON.parse(json.stdout).outcome_report).toEqual(report(id));
    }
    const human = await show(ids.merge);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toContain("feature/b");
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await queue.dispose();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
