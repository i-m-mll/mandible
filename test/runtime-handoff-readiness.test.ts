// @vitest-environment node
// Readiness waits for qualified service identities within the original deadline.
import http from "node:http";
import { afterEach, expect, it, vi } from "vitest";

import { awaitHandoffReadiness, handoffProbeTimeout, probeJson } from "../scripts/local-runtime.mjs";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); });

function inspection(ready: boolean, generation = "merge", backend: { pid: number | null; loaded?: boolean; runs?: number; lastExit?: string } = { pid: 41 }) {
  return {
    status: { dashboard_ready: ready, state: ready ? "running" : "starting", detail: ready ? null : "Backend: The service responded, but Mandible is not ready yet." },
    main: { backend_generation: generation },
    backendJob: { loaded: true, runs: 1, lastExit: "(never exited)", ...backend },
    gatewayJob: { loaded: true, pid: 7, runs: 3, lastExit: "0" },
    qualifiedProcesses: backend.pid ? { backend: { pid: backend.pid, runs: backend.runs ?? 1 } } : {},
  };
}

it('does not admit raw launcher PIDs into process continuity or ready health', async () => {
  let time = 0;
  const unqualified = (pid: number) => ({ ...inspection(true, 'merge', { pid }), qualifiedProcesses: {},
    nativeOwnershipPending: { message: 'Native launcher ownership is unconfirmed.' } });
  const answers = [unqualified(41), unqualified(42), inspection(true, 'merge', { pid: 42 })];
  const inspect = vi.fn(async () => answers.shift()!);
  const result = await awaitHandoffReadiness('merge', 10000, inspect, { now: () => time, wait: async ms => { time += ms; } });
  expect(result).toMatchObject({ outcome: 'confirmed', error: null, exited: false });
  expect(inspect).toHaveBeenCalledTimes(3);
});

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
