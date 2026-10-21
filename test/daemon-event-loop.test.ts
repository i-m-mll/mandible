// @vitest-environment node
import { expect, it, vi } from "vitest";
import { EVENT_LOOP_STALL_BUDGET_MS, EventLoopLagDiagnostics } from "../src/daemon-event-loop.js";

it("reports a lone stall over budget, which barely moves the window's p95", async () => {
  const logger = vi.fn();
  const diagnostics = new EventLoopLagDiagnostics(logger, 10);
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const until = performance.now() + EVENT_LOOP_STALL_BUDGET_MS + 100;
    while (performance.now() < until) { /* hold the event loop */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
    diagnostics.sample();
    expect(logger).toHaveBeenCalledWith("warn", "daemon_event_loop_stall", expect.objectContaining({ budget_ms: EVENT_LOOP_STALL_BUDGET_MS }));
    expect(logger.mock.calls.find(([, message]) => message === "daemon_event_loop_stall")![2].max_ms).toBeGreaterThanOrEqual(EVENT_LOOP_STALL_BUDGET_MS);
  } finally {
    diagnostics.close();
  }
});
