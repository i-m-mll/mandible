// @vitest-environment node
import { expect, it, vi } from "vitest";
import { waitUntil } from "./helpers/wait-until.js";
import { DaemonMemoryDiagnostics } from "../src/daemon-memory.js";
import { observeRuntimeHealthCoverage } from "../src/runtime-health-contract.js";
import { EVENT_LOOP_STALL_BUDGET_MS, EventLoopLagDiagnostics } from "../src/daemon-event-loop.js";

it("retains live workload stalls and current memory across periodic rollover without read-side resets or warnings", async () => {
  const logger = vi.fn();
  const diagnostics = new EventLoopLagDiagnostics(logger, 10);
  let rss = 20;
  const memory = new DaemonMemoryDiagnostics({ logger, warningFraction: 0.5, sources: {
    memoryUsage: () => ({ rss, heapUsed: 0, heapTotal: 0, external: 0, arrayBuffers: 0 }), totalMemory: () => 100,
  } });
  const read = async () => {
    const current = await diagnostics.currentAfterTurn();
    const observedAt = current.eventLoop.intervalEndedAt;
    return { eventLoop: diagnostics.snapshot(), memory: memory.snapshot(),
      current: { ...current, observedAt, memory: memory.current(observedAt) } };
  };
  try {
    const initialAt = Date.now();
    diagnostics.sample(initialAt); memory.sample(initialAt);
    const ready = await read();
    const before = diagnostics.snapshot();
    const until = performance.now() + EVENT_LOOP_STALL_BUDGET_MS + 50;
    while (performance.now() < until) { /* the actual workload blocks this collector's event loop */ }
    rss = 60;
    const stalled = await read();
    expect(stalled.current.eventLoop.maxMs).toBeGreaterThanOrEqual(EVENT_LOOP_STALL_BUDGET_MS);
    expect(stalled.current.memory).toMatchObject({ rss: 60, warning: true });
    expect(diagnostics.snapshot()).toEqual(before);
    expect(memory.snapshot()).toMatchObject({ rss: 20, warning: false });
    expect(logger).not.toHaveBeenCalled();
    expect((await read()).current.eventLoop.maxMs).toBeGreaterThanOrEqual(EVENT_LOOP_STALL_BUDGET_MS);
    const rollover = Date.now();
    diagnostics.sample(rollover); memory.sample(rollover);
    rss = 20;
    const final = await read();
    expect(final.eventLoop).toMatchObject({ sequence: before.sequence + 1, intervalEndedAt: rollover });
    expect(final.eventLoop.maxMs).toBeGreaterThanOrEqual(EVENT_LOOP_STALL_BUDGET_MS);
    expect(final.memory.warning).toBe(true);
    expect(final.current.memory).toMatchObject({ rss: 20, warning: false });
    expect(logger.mock.calls.map(([, message]) => message)).toContain("daemon_event_loop_stall");
    expect(logger.mock.calls.map(([, message]) => message)).toContain("daemon_memory_warning");
    expect(logger.mock.calls.map(([, message]) => message)).not.toContain("daemon_memory_recovered");
    const points = [ready, stalled, final];
    let index = 0;
    let time = ready.current.observedAt;
    let guiCompletedAt: number | null = null;
    const result = await observeRuntimeHealthCoverage({
      live: { startedAt: time, through: () => guiCompletedAt }, observationMs: 0, deadlineMs: 2000,
      now: () => time, healthOf: value => value, probe: async () => points[index],
      wait: async () => { index++; time = points[index].current.observedAt; if (index === 2) guiCompletedAt = time - 1; },
    });
    expect(index).toBe(2);
    expect(result.observation.mustCover).toBe(guiCompletedAt);
    expect(result.performance.findings.map(finding => finding.code)).toEqual(expect.arrayContaining(["event_loop_stall", "memory_warning"]));
    expect(result.samples.last.eventLoop).toEqual(final.eventLoop);
  } finally { diagnostics.close(); }
});

it("reads turns since the previous read without resetting the health window", async () => {
  const logger = vi.fn();
  const diagnostics = new EventLoopLagDiagnostics(logger, 10);
  try {
    expect(diagnostics.readTurnMs()).toBe(0);
    await waitUntil(() => diagnostics.readTurnMs() > 0, "turn sampling to start");
    const until = performance.now() + EVENT_LOOP_STALL_BUDGET_MS + 50;
    while (performance.now() < until) { /* hold the event loop */ }
    await waitUntil(() => diagnostics.readTurnMs() >= EVENT_LOOP_STALL_BUDGET_MS, "the injected stall to be sampled");
    expect(diagnostics.readTurnMs()).toBeLessThan(EVENT_LOOP_STALL_BUDGET_MS);
    diagnostics.sample();
    expect(logger).toHaveBeenCalledWith("warn", "daemon_event_loop_stall", expect.objectContaining({ budget_ms: EVENT_LOOP_STALL_BUDGET_MS }));
  } finally {
    diagnostics.close();
  }
});
