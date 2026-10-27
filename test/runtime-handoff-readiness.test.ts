// @vitest-environment node
// Issue 54a0b88 — a runtime handoff awaits the started daemon's actual answers
// within its deadline, and a rebuild hook that exited 75 belongs to its handoff:
// it is pending, never a failed rebuild, until that handoff actually fails.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../src/runtime-handoff-proof.js", async (original) => ({
  ...await original<typeof import("../src/runtime-handoff-proof.js")>(),
  // The fixture has no signed publication; the proof has its own tests.
  verifyRuntimeHandoffPublication: () => ({}),
}));

import { awaitHandoffReadiness, handoffProbeTimeout, probeJson } from "../scripts/local-runtime.mjs";
import { AuthHookManager, type RuntimeHandoffJournal } from "../src/auth-hooks.js";
import { AuthQueue } from "../src/auth-queue.js";
import { DOMAIN_EVENTS } from "../src/contracts.js";
import type { SseEvent } from "../src/types.js";
import { createMigratedDb } from "./helpers/auth-queue-fixtures.js";
import { fileRpc, runCli } from "./helpers/cli-process.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); });

function inspection(ready: boolean, generation = "merge", backend: { pid: number | null; loaded?: boolean; runs?: number; lastExit?: string } = { pid: 41 }) {
  return {
    status: { dashboard_ready: ready, state: ready ? "running" : "starting", detail: ready ? null : "Backend: The service responded, but Mandible is not ready yet." },
    main: { backend_generation: generation },
    backendJob: { loaded: true, runs: 1, lastExit: "(never exited)", ...backend },
    gatewayJob: { loaded: true, pid: 7, runs: 3, lastExit: "0" },
  };
}

it.each([true, false])('keeps startup pending before the first PID is observed (loaded=%s)', async loaded => {
  let time = 100;
  const answers = [inspection(false, 'merge', { loaded, pid: null }), inspection(false), inspection(true)];
  const inspect = vi.fn(async () => answers.shift()!);
  const expectedProcesses = {};
  await expect(awaitHandoffReadiness('merge', 5000, inspect, { expectedProcesses, now: () => time, wait: async milliseconds => { time += milliseconds; } }))
    .resolves.toMatchObject({ outcome: 'confirmed', exited: false, error: null });
  expect(inspect).toHaveBeenCalledTimes(3);
  expect(expectedProcesses).toEqual({});
  const gone = [inspection(false, 'merge', { loaded, pid: null }), inspection(false), inspection(false, 'merge', { pid: null })];
  await expect(awaitHandoffReadiness('merge', 10000, async () => gone.shift()!, { now: () => time, wait: async milliseconds => { time += milliseconds; } }))
    .resolves.toMatchObject({ outcome: 'failed', exited: true, error: expect.stringContaining('process exited') });
  await expect(awaitHandoffReadiness('merge', 10000, async () => inspection(false, 'merge', { loaded, pid: null, lastExit: '1' })))
    .resolves.toMatchObject({ outcome: 'failed', exited: true, error: expect.stringContaining('last exit code 1') });
});

it("waits for a busy daemon's answer and for readiness, bounded by the handoff deadline", async () => {
  // Busy for longer than the 900 ms status probe, as a blocked event loop is.
  const server = http.createServer((_request, response) => { setTimeout(() => response.end('{"status":"ok"}'), 1500); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/health`;
  await expect(probeJson(url, { timeoutMs: handoffProbeTimeout(Date.now() + 5000) })).resolves.toMatchObject({ ok: true });

  const answers = [inspection(false), inspection(false), inspection(true)];
  const inspect = vi.fn(async (_timeoutMs: number) => answers.shift()!);
  await expect(awaitHandoffReadiness("merge", Date.now() + 5000, inspect, { pauseMs: 1 })).resolves.toMatchObject({ error: null });
  expect(inspect).toHaveBeenCalledTimes(3);
  expect(inspect.mock.calls.every(([timeoutMs]) => timeoutMs > 900)).toBe(true);

  // Past the deadline the last actual answer is the reason, not a generic one.
  const stuck = await awaitHandoffReadiness("merge", Date.now() + 30, async () => inspection(true, "older"), { pauseMs: 5 });
  expect(stuck.error).toContain("older");
});

it("fails at once when the started candidate exits or is replaced", async () => {
  const until = Date.now() + 10 * 60 * 1000;
  const started = Date.now();
  const crashed = [inspection(false), inspection(false, "merge", { pid: null, lastExit: "1" })];
  await expect(awaitHandoffReadiness("merge", until, async () => crashed.shift()!, { pauseMs: 1 }))
    .resolves.toMatchObject({ exited: true, error: "The candidate backend process exited (last exit code 1)." });
  const replaced = [inspection(false), inspection(false, "merge", { pid: 42, runs: 2, lastExit: "1" })];
  await expect(awaitHandoffReadiness("merge", until, async () => replaced.shift()!, { pauseMs: 1 }))
    .resolves.toMatchObject({ exited: true, error: expect.stringContaining("process 41 exited and launchd started 42") });
  // A crash that launchd already restarted before the first inspection.
  await expect(awaitHandoffReadiness("merge", until, async () => inspection(false, "merge", { pid: 43, runs: 2, lastExit: "1" }), { pauseMs: 1 }))
    .resolves.toMatchObject({ exited: true });
  expect(Date.now() - started).toBeLessThan(5000);
});

it.each(["complete", "failed"] as const)("reports a pending handoff as pending, then shows its %s convergence to the operator", async (outcome) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-handoff-pending-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  vi.stubEnv("MANDIBLE_HOME", home);
  const db = createMigratedDb();
  const now = Date.now();
  db.prepare(`INSERT INTO auth_requests (id, type, command, title, status, exit_code, repo, created_at, updated_at, expires_at)
    VALUES ('self-update', 'merge', 'mandible auth merge feature/x --into main', 'Self update', 'completed', 0, 'mandible', ?, ?, ?)`).run(now, now, now + 60_000);
  db.prepare(`INSERT INTO auth_hook_executions (id, auth_request_id, hook_id, command, command_digest, state, attempts, exit_code, output, created_at, updated_at)
    VALUES ('rebuild-run', 'self-update', 'builtin-mandible-rebuild', 'rebuild', ?, 'pending', 1, 75, ?, ?, ?)`).run("c".repeat(64), `MANDIBLE_RUNTIME_HANDOFF_PENDING:${"a".repeat(64)}`, now, now);
  // The new daemon is not the drained process, so it has no admitted drain identity.
  const journal = {
    schema: "mandible-runtime-handoff@1", bindingDigest: "a".repeat(64), phase: "starting",
    binding: { requestId: "self-update", executionId: "rebuild-run", hookId: "builtin-mandible-rebuild", commandDigest: "c".repeat(64) },
  } as unknown as RuntimeHandoffJournal;
  const hooks = new AuthHookManager(db, { handoffClient: {
    readRuntimeHandoff: () => journal,
    readRuntimeHandoffPhase: () => journal.phase,
    verifyRuntimeHandoffReceipt: async () => {},
    acknowledgeRuntimeHandoff: async () => { journal.phase = "acknowledged"; },
  } });
  const events: SseEvent[] = [];
  const queue = new AuthQueue({ db, hookManager: hooks, backgroundMaintenance: false, broadcast: (event) => { events.push(event); },
    executor: async () => { throw new Error("no command runs"); } });
  cleanups.push(async () => { (await queue.dispose()); db.close(); });
  // The fixture has no signed merge evidence; this lane is about convergence only.
  vi.spyOn(queue as unknown as { successfulMergeEvidenceFailure: () => string | null }, "successfulMergeEvidenceFailure").mockReturnValue(null);
  vi.spyOn(queue as unknown as { adoptRuntimePublication: () => Promise<() => void> }, "adoptRuntimePublication").mockResolvedValue(() => {});
  const failures = () => events.filter((event) => event.event === DOMAIN_EVENTS.MANDIBLE_REBUILD_FAILED);

  const pendingResult = { hook_id: "builtin-mandible-rebuild", label: "Build Mandible and install instructions after merge", exit_code: 75,
    output: `MANDIBLE_RUNTIME_HANDOFF_PENDING:${"a".repeat(64)}`, duration_ms: 790 };
  vi.spyOn(hooks, "executeHooks").mockResolvedValue([pendingResult]);
  vi.spyOn(hooks, "runPending").mockResolvedValue([pendingResult]);
  vi.spyOn(hooks, "listRequestIdsWithRunnableHooks").mockReturnValue(["self-update"]);
  await (queue as unknown as { runPostSuccessHooks: (request: unknown) => Promise<void> }).runPostSuccessHooks(await queue.getRequest("self-update"));

  await queue.resumeHookConvergence();
  expect(failures()).toHaveLength(0);
  expect(queue.rebuildFailure).toBeNull();
  expect(queue.isRebuilding).toBe(false);
  expect(hooks.getRun("self-update", "builtin-mandible-rebuild")).toMatchObject({ state: "pending", exit_code: 75 });

  const pendingOutput = (await queue.getRequest("self-update"))!.output;
  expect(pendingOutput).toMatch(/\[hook: .*\] handoff pending:/);
  expect(pendingOutput).toMatch(/\[hook: .*\] retry handoff pending:/);
  expect(pendingOutput).not.toMatch(/failed/i);
  vi.mocked(hooks.listRequestIdsWithRunnableHooks).mockReturnValue([]);

  Object.assign(journal, { phase: outcome, receipt: {}, error: "Candidate production front door is not ready at the exact merge generation: Health check exceeded its 900 ms deadline." });
  await queue.resumeHookConvergence();
  await queue.resumeHookConvergence();
  expect(failures()).toHaveLength(outcome === "failed" ? 1 : 0);
  if (outcome === "failed") {
    expect(failures()[0]!.data).toMatchObject({ request_id: "self-update", message: expect.stringContaining(journal.error.replace(/\.$/, "")) });
    expect(hooks.getRun("self-update", "builtin-mandible-rebuild")?.output.match(/recovery refused/g)).toHaveLength(1);
  }
  // A completed request's output is part of its custody; settlement reports through convergence.
  const settled = (await queue.getRequest("self-update"))!;
  expect(settled.output).toBe(pendingOutput);
  const stub = fileRpc(() => ({ status: 200, body: { ...settled, convergence: queue.convergenceForRequest("self-update") } }));
  cleanups.push(() => stub.responder.stop());
  const shown = await runCli(["auth", "show", "self-update"], { env: stub.env });
  expect(shown.status, shown.stderr).toBe(0);
  expect(shown.stdout).toMatch(outcome === "complete" ? /^Convergence: complete \(.*the merge is live\)$/m : /^Convergence: failed \(builtin-mandible-rebuild: .*Health check exceeded its 900 ms deadline.*\)$/m);
});

it("validates only unsettled handoff journals and revisits a settled one only after its run changes", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-handoff-settled-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  vi.stubEnv("MANDIBLE_HOME", home);
  const db = createMigratedDb();
  cleanups.push(() => db.close());
  const now = Date.now();
  const phases = new Map<string, string>([["old-1", "acknowledged"], ["old-2", "failed"], ["old-3", "acknowledged"], ["unacknowledged", "complete"]]);
  for (const id of phases.keys()) {
    db.prepare(`INSERT INTO auth_requests (id, type, command, title, status, exit_code, repo, created_at, updated_at, expires_at)
      VALUES (?, 'merge', 'mandible auth merge feature/x --into main', 'Self update', 'completed', 0, 'mandible', ?, ?, ?)`).run(id, now, now, now + 60_000);
    db.prepare(`INSERT INTO auth_hook_executions (id, auth_request_id, hook_id, command, command_digest, state, attempts, exit_code, output, created_at, updated_at)
      VALUES (?, ?, 'builtin-mandible-rebuild', 'rebuild', ?, 'complete', 1, 0, ?, ?, ?)`).run(`${id}-run`, id, "c".repeat(64), `MANDIBLE_RUNTIME_HANDOFF_ACCEPTED:${"a".repeat(64)}`, now, now);
  }
  const phaseReads: string[] = [];
  const validatedReads: string[] = [];
  const hooks = new AuthHookManager(db, { handoffClient: {
    readRuntimeHandoffPhase: (_home, requestId) => { phaseReads.push(requestId); return phases.get(requestId); },
    readRuntimeHandoff: (_home, requestId, executionId) => {
      validatedReads.push(requestId);
      return { schema: "mandible-runtime-handoff@1", bindingDigest: "b".repeat(64), phase: phases.get(requestId)!,
        binding: { requestId, executionId, hookId: "builtin-mandible-rebuild", commandDigest: "c".repeat(64) } } as unknown as RuntimeHandoffJournal;
    },
    verifyRuntimeHandoffReceipt: async () => {},
    acknowledgeRuntimeHandoff: async (binding) => { phases.set(binding.requestId, "acknowledged"); },
    retireFailedRuntimeHandoff: () => undefined,
  } });
  const sweep = () => hooks.reconcileRuntimeHandoffs(async () => { throw new Error("nothing to adopt"); }, () => {});

  await sweep();
  expect(validatedReads).toEqual(["unacknowledged", "unacknowledged"]);
  expect(phases.get("unacknowledged")).toBe("acknowledged");

  phaseReads.length = 0; validatedReads.length = 0;
  await sweep();
  expect(phaseReads).toEqual([]);
  expect(validatedReads).toEqual([]);

  phaseReads.length = 0;
  await sweep();
  expect(phaseReads).toEqual([]);

  // A retried rebuild changes its run without moving the clock.
  db.prepare("UPDATE auth_hook_executions SET state = 'pending', attempts = 2, exit_code = 75, output = ? WHERE id = 'old-2-run'").run(`MANDIBLE_RUNTIME_HANDOFF_PENDING:${"a".repeat(64)}`);
  phases.set("old-2", "starting");
  await sweep();
  expect(validatedReads).toEqual(["old-2"]);
});

it("finishes a recovery whose acceptance committed before the daemon stopped, and only then treats it as settled", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-handoff-recovery-crash-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  vi.stubEnv("MANDIBLE_HOME", home);
  const db = createMigratedDb();
  cleanups.push(() => db.close());
  const now = Date.now();
  const accepted = "d".repeat(64);
  const runs: Array<[string, string]> = [["recovered", accepted], ["other-recovery", "e".repeat(64)]];
  const journals = new Map<string, RuntimeHandoffJournal>();
  for (const [id, journalDigest] of runs) {
    db.prepare(`INSERT INTO auth_requests (id, type, command, title, status, exit_code, repo, created_at, updated_at, expires_at)
      VALUES (?, 'merge', 'mandible auth merge feature/x --into main', 'Self update', 'completed', 0, 'mandible', ?, ?, ?)`).run(id, now, now, now + 60_000);
    // The recovery transaction committed the row; the journal is still failed.
    db.prepare(`INSERT INTO auth_hook_executions (id, auth_request_id, hook_id, command, command_digest, state, attempts, exit_code, output, created_at, updated_at)
      VALUES (?, ?, 'builtin-mandible-rebuild', 'rebuild', ?, 'complete', 1, 0, ?, ?, ?)`).run(`${id}-run`, id, "c".repeat(64), `MANDIBLE_RUNTIME_RECOVERY_ACCEPTED:${accepted}`, now, now);
    journals.set(id, { schema: "mandible-runtime-handoff@1", bindingDigest: "b".repeat(64), phase: "failed", error: "first window stalled",
      recovery: { digest: journalDigest, failureDigest: "f", receipt: {}, actor: {}, observedAt: now },
      binding: { requestId: id, executionId: `${id}-run`, hookId: "builtin-mandible-rebuild", commandDigest: "c".repeat(64) } } as unknown as RuntimeHandoffJournal);
  }
  const completed: string[] = [];
  const acknowledged: string[] = [];
  const hooks = new AuthHookManager(db, { handoffClient: {
    readRuntimeHandoffPhase: (_home, requestId) => journals.get(requestId)?.phase,
    readRuntimeHandoff: (_home, requestId) => journals.get(requestId) ?? null,
    completeRuntimeHandoffRecovery: async (journal) => { completed.push(journal.binding.requestId); journal.phase = "complete"; return journal; },
    verifyRuntimeHandoffReceipt: async () => {},
    acknowledgeRuntimeHandoff: async (binding) => { acknowledged.push(binding.requestId); journals.get(binding.requestId)!.phase = "acknowledged"; },
    retireFailedRuntimeHandoff: () => undefined,
  } });
  const sweep = () => hooks.reconcileRuntimeHandoffs(async () => { throw new Error("nothing to adopt"); }, () => {});

  await sweep();
  expect(completed).toEqual(["recovered"]);
  expect(acknowledged).toEqual(["recovered"]);
  expect(journals.get("other-recovery")!.phase).toBe("failed");
  await sweep();
  await sweep();
  expect(completed).toEqual(["recovered"]);
  expect(acknowledged).toEqual(["recovered"]);
});

function terminalHandoff(id: string, output: string, journal: Partial<RuntimeHandoffJournal>) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-handoff-retry-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  vi.stubEnv("MANDIBLE_HOME", home);
  const db = createMigratedDb();
  cleanups.push(() => db.close());
  const now = Date.now();
  db.prepare(`INSERT INTO auth_requests (id, type, command, title, status, exit_code, repo, created_at, updated_at, expires_at)
    VALUES (?, 'merge', 'mandible auth merge feature/x --into main', 'Self update', 'completed', 0, 'mandible', ?, ?, ?)`).run(id, now, now, now + 60_000);
  db.prepare(`INSERT INTO auth_hook_executions (id, auth_request_id, hook_id, command, command_digest, state, attempts, exit_code, output, created_at, updated_at)
    VALUES (?, ?, 'builtin-mandible-rebuild', 'rebuild', ?, 'complete', 1, 0, ?, ?, ?)`).run(`${id}-run`, id, "c".repeat(64), output, now, now);
  return { db, journal: { schema: "mandible-runtime-handoff@1", bindingDigest: "b".repeat(64), ...journal,
    binding: { requestId: id, executionId: `${id}-run`, hookId: "builtin-mandible-rebuild", commandDigest: "c".repeat(64) } } as RuntimeHandoffJournal };
}

it("retries a completed handoff whose receipt probe failed transiently, and acknowledges it on the next sweep", async () => {
  const { db, journal } = terminalHandoff("transient", `MANDIBLE_RUNTIME_HANDOFF_ACCEPTED:${"a".repeat(64)}`, { phase: "complete" });
  let probes = 0;
  const hooks = new AuthHookManager(db, { handoffClient: {
    readRuntimeHandoffPhase: () => journal.phase,
    readRuntimeHandoff: () => journal,
    verifyRuntimeHandoffReceipt: async () => { probes += 1; if (probes === 1) throw new Error("Runtime handoff handoff-verify failed: health exceeded 900 ms"); },
    acknowledgeRuntimeHandoff: async () => { journal.phase = "acknowledged"; },
    retireFailedRuntimeHandoff: () => undefined,
  } });
  const stuck = vi.fn();
  const cleared = vi.fn();
  const sweep = () => hooks.reconcileRuntimeHandoffs(async () => { throw new Error("nothing to adopt"); }, () => {}, stuck, cleared);

  await sweep();
  expect(journal.phase).toBe("complete");
  expect(stuck).toHaveBeenCalledTimes(1);
  await sweep();
  expect(journal.phase).toBe("acknowledged");
  await sweep();
  expect(cleared).toHaveBeenCalledWith("transient");
  expect(stuck).toHaveBeenCalledTimes(1);
});

it("keeps retrying a recovery that cannot be finished, reporting it once per distinct failure", async () => {
  const digest = "d".repeat(64);
  const { db, journal } = terminalHandoff("stuck", `MANDIBLE_RUNTIME_RECOVERY_ACCEPTED:${digest}`, {
    phase: "failed", recovery: { digest, failureDigest: "f", receipt: {}, actor: {}, observedAt: Date.now() },
  });
  let failure: string | null = "Recovery observation changed before acceptance (attempt 1).";
  let completions = 0;
  const hooks = new AuthHookManager(db, { handoffClient: {
    readRuntimeHandoffPhase: () => journal.phase,
    readRuntimeHandoff: () => journal,
    completeRuntimeHandoffRecovery: async () => {
      completions += 1;
      if (failure) throw new Error(failure.replace(/\d+/, String(completions)));
      journal.phase = "complete";
      return journal;
    },
    verifyRuntimeHandoffReceipt: async () => {},
    acknowledgeRuntimeHandoff: async () => { journal.phase = "acknowledged"; },
    retireFailedRuntimeHandoff: () => undefined,
  } });
  const stuck = vi.fn();
  const sweep = () => hooks.reconcileRuntimeHandoffs(async () => { throw new Error("nothing to adopt"); }, () => {}, stuck);

  for (let tick = 0; tick < 4; tick++) await sweep();
  expect(completions).toBe(4);
  expect(stuck).toHaveBeenCalledTimes(1);
  failure = "Converged file changed.";
  await sweep(); await sweep();
  expect(stuck).toHaveBeenCalledTimes(2);
  // Alternating between failures already reported reports nothing new.
  failure = "Recovery observation changed before acceptance (attempt 1).";
  await sweep();
  failure = "Converged file changed.";
  await sweep();
  expect(stuck).toHaveBeenCalledTimes(2);
  failure = null;
  await sweep();
  expect(journal.phase).toBe("acknowledged");
});

it("keeps a completed handoff whose journal is briefly missing unsettled until it can be acknowledged", async () => {
  const { db, journal } = terminalHandoff("missing", `MANDIBLE_RUNTIME_HANDOFF_ACCEPTED:${"a".repeat(64)}`, { phase: "complete" });
  let present = false;
  const hooks = new AuthHookManager(db, { handoffClient: {
    readRuntimeHandoffPhase: () => present ? journal.phase : undefined,
    readRuntimeHandoff: () => present ? journal : null,
    verifyRuntimeHandoffReceipt: async () => {},
    acknowledgeRuntimeHandoff: async () => { journal.phase = "acknowledged"; },
    retireFailedRuntimeHandoff: () => undefined,
  } });
  const stuck = vi.fn();
  const sweep = () => hooks.reconcileRuntimeHandoffs(async () => { throw new Error("nothing to adopt"); }, () => {}, stuck);

  await sweep(); await sweep();
  expect(stuck).toHaveBeenCalledTimes(1);
  expect(stuck).toHaveBeenCalledWith("missing", expect.stringContaining("journal is unavailable"));
  present = true;
  await sweep();
  expect(journal.phase).toBe("acknowledged");
});

function queueFor(db: ReturnType<typeof createMigratedDb>, hooks: AuthHookManager) {
  const queue = new AuthQueue({ db, hookManager: hooks, backgroundMaintenance: false, executor: async () => { throw new Error("no command runs"); } });
  cleanups.push(async () => { (await queue.dispose()); });
  vi.spyOn(queue as unknown as { successfulMergeEvidenceFailure: () => string | null }, "successfulMergeEvidenceFailure").mockReturnValue(null);
  return queue;
}

const incident = (db: ReturnType<typeof createMigratedDb>, task: string) =>
  db.prepare("SELECT resolved_at FROM operational_incidents WHERE task = ?").get(task) as { resolved_at: number | null } | undefined;

it("raises a daemon incident for a stuck handoff and resolves it once the handoff settles", async () => {
  const { db, journal } = terminalHandoff("resolving", `MANDIBLE_RUNTIME_HANDOFF_ACCEPTED:${"a".repeat(64)}`, { phase: "complete" });
  let probes = 0;
  const queue = queueFor(db, new AuthHookManager(db, { handoffClient: {
    readRuntimeHandoffPhase: () => journal.phase,
    readRuntimeHandoff: () => journal,
    verifyRuntimeHandoffReceipt: async () => { probes += 1; if (probes === 1) throw new Error("Runtime handoff handoff-verify failed"); },
    acknowledgeRuntimeHandoff: async () => { journal.phase = "acknowledged"; },
    retireFailedRuntimeHandoff: () => undefined,
  } }));

  await queue.resumeHookConvergence();
  expect(incident(db, "runtime-handoff-reconcile/resolving")).toEqual({ resolved_at: null });
  await queue.resumeHookConvergence();
  await queue.resumeHookConvergence();
  expect(incident(db, "runtime-handoff-reconcile/resolving")?.resolved_at).toEqual(expect.any(Number));
});

it("reports an idle convergence that fails after recording a rebuild failure", async () => {
  const { db, journal } = terminalHandoff("unnotified", `MANDIBLE_RUNTIME_HANDOFF_PENDING:${"a".repeat(64)}`, { phase: "failed", error: "first window stalled" });
  db.prepare("UPDATE auth_hook_executions SET state = 'pending', exit_code = 75 WHERE id = 'unnotified-run'").run();
  const queue = queueFor(db, new AuthHookManager(db, { handoffClient: {
    readRuntimeHandoffPhase: () => journal.phase,
    readRuntimeHandoff: () => journal,
    verifyRuntimeHandoffReceipt: async () => {},
    acknowledgeRuntimeHandoff: async () => {},
    retireFailedRuntimeHandoff: () => undefined,
  } }));
  vi.spyOn(queue as unknown as { settleConvergence: () => Promise<void> }, "settleConvergence").mockRejectedValue(new Error("convergence write failed"));

  const converge = () => (queue as unknown as { convergeWhileIdle: () => Promise<void> }).convergeWhileIdle();
  await converge();
  expect(incident(db, "auth-idle-convergence")).toEqual({ resolved_at: null });
  await converge();
  expect(incident(db, "auth-idle-convergence")?.resolved_at).toEqual(expect.any(Number));
});
