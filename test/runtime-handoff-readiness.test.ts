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

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); });

function inspection(ready: boolean, generation = "merge", backend: { pid: number | null; runs?: number; lastExit?: string } = { pid: 41 }) {
  return {
    status: { dashboard_ready: ready, state: ready ? "running" : "starting", detail: ready ? null : "Backend: The service responded, but Mandible is not ready yet." },
    main: { backend_generation: generation },
    backendJob: { loaded: true, runs: 1, lastExit: "(never exited)", ...backend },
    gatewayJob: { loaded: true, pid: 7, runs: 3, lastExit: "0" },
  };
}

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

it("reports a pending handoff's rebuild as failed only once its journal fails", async () => {
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
    verifyRuntimeHandoffReceipt: async () => { throw new Error("no receipt"); },
    acknowledgeRuntimeHandoff: async () => { throw new Error("no receipt"); },
  } });
  const events: SseEvent[] = [];
  const queue = new AuthQueue({ db, hookManager: hooks, backgroundMaintenance: false, broadcast: (event) => { events.push(event); },
    executor: async () => { throw new Error("no command runs"); } });
  cleanups.push(async () => { (await queue.dispose()); db.close(); });
  // The fixture has no signed merge evidence; this lane is about convergence only.
  vi.spyOn(queue as unknown as { successfulMergeEvidenceFailure: () => string | null }, "successfulMergeEvidenceFailure").mockReturnValue(null);
  const failures = () => events.filter((event) => event.event === DOMAIN_EVENTS.MANDIBLE_REBUILD_FAILED);

  await queue.resumeHookConvergence();
  expect(failures()).toHaveLength(0);
  expect(queue.rebuildFailure).toBeNull();
  expect(queue.isRebuilding).toBe(false);
  expect(hooks.getRun("self-update", "builtin-mandible-rebuild")).toMatchObject({ state: "pending", exit_code: 75 });

  Object.assign(journal, { phase: "failed", error: "Candidate production front door is not ready at the exact merge generation: Health check exceeded its 900 ms deadline." });
  await queue.resumeHookConvergence();
  await queue.resumeHookConvergence();
  expect(failures()).toHaveLength(1);
  // The operator sees the handoff's own error.
  expect(failures()[0]!.data).toMatchObject({ request_id: "self-update", message: expect.stringContaining(journal.error.replace(/\.$/, "")) });
  expect(hooks.getRun("self-update", "builtin-mandible-rebuild")?.output.match(/recovery refused/g)).toHaveLength(1);
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
  expect(validatedReads).toEqual(["unacknowledged"]);
  expect(phases.get("unacknowledged")).toBe("acknowledged");

  phaseReads.length = 0; validatedReads.length = 0;
  await sweep();
  expect(phaseReads).toEqual(["unacknowledged"]);
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
