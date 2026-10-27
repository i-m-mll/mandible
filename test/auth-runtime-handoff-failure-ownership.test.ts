// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { AuthHookManager } from "../src/auth-hooks.js";
import { AuthQueue } from "../src/auth-queue.js";
import { createMigratedDb } from "./helpers/ledger-fixtures.js";
import { testRuntimeRoot } from "./helpers/runtime-isolation.js";

it('drains a completion hint that arrives during an owned convergence sweep', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const reconcile = vi.fn(async () => {
    if (reconcile.mock.calls.length === 1) { entered.resolve(); await release.promise; }
  });
  const queue = Object.assign(Object.create(AuthQueue.prototype), {
    disposed: false, convergenceSweepInFlight: false, handoffCompletionPending: false,
    beginObservation: () => () => undefined, isDbOpen: () => true,
    reconcileRuntimeHandoffs: reconcile, runConvergenceSweep: async () => undefined,
    resumeDeferredLedgerActions: async () => undefined,
  }) as AuthQueue;
  const sweep = queue.resumeHookConvergence();
  await entered.promise;
  (queue as any).handoffCompletionPending = true;
  await queue.resumeHookConvergence();
  expect(reconcile).toHaveBeenCalledTimes(1);
  release.resolve();
  await sweep;
  expect(reconcile).toHaveBeenCalledTimes(2);
});

it("owns failure convergence through its rejection after recording the failed handoff", async () => {
  const home = fs.mkdtempSync(path.join(testRuntimeRoot, "handoff-failure-"));
  vi.stubEnv("MANDIBLE_HOME", home);
  const db = createMigratedDb();
  const now = Date.now();
  db.prepare(`INSERT INTO auth_requests (id, type, command, title, status, exit_code, repo, created_at, updated_at, expires_at)
    VALUES ('failure-request', 'merge', 'mandible auth merge feature/x --into main', 'Private failure', 'completed', 0, 'fixture', ?, ?, ?)`).run(now, now, now + 60_000);
  db.prepare(`INSERT INTO auth_hook_executions (id, auth_request_id, hook_id, command, command_digest, state, attempts, exit_code, output, created_at, updated_at)
    VALUES ('failure-run', 'failure-request', 'builtin-mandible-rebuild', 'rebuild', ?, 'pending', 1, 75, ?, ?, ?)`).run("c".repeat(64), `MANDIBLE_RUNTIME_HANDOFF_PENDING:${"a".repeat(64)}`, now, now);
  const hooks = new AuthHookManager(db);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const sentinel = new Error("Failure convergence rejected");
  const convergence = release.promise.then(() => { throw sentinel; });
  // Observe the negative control's detached rejection while testing ownership.
  void convergence.catch(() => undefined);
  const onFailed = vi.fn((_requestId: string, _reason: string) => {
    entered.resolve();
    return convergence;
  });
  const adopt = vi.fn(async () => () => undefined);
  const reconciliation = hooks.reconcileRuntimeHandoffs(adopt, onFailed);
  let settled = false;
  void reconciliation.then(() => { settled = true; }, () => { settled = true; });
  try {
    await entered.promise;
    expect(onFailed).toHaveBeenCalledExactlyOnceWith("failure-request", "The retained runtime handoff journal is unavailable");
    const failed = hooks.getRun("failure-request", "builtin-mandible-rebuild");
    expect(failed).toMatchObject({ state: "failed", attempts: 1, exit_code: 75 });
    expect(db.prepare("SELECT status, exit_code FROM auth_requests WHERE id = ?").get("failure-request"))
      .toEqual({ status: "completed", exit_code: 0 });
    expect(adopt).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect.soft(settled, "reconciliation must await failure convergence").toBe(false);
    release.resolve();
    await expect(reconciliation).rejects.toBe(sentinel);
    expect(hooks.getRun("failure-request", "builtin-mandible-rebuild")).toEqual(failed);
  } finally {
    release.resolve();
    await convergence.catch(() => undefined);
    await reconciliation.catch(() => undefined);
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});
