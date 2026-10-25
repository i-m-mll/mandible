import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import type { Logger } from "./types.js";
import { EVENT_LOOP_STALL_BUDGET_MS, type DiagnosticInterval } from "./runtime-health-contract.js";

export { EVENT_LOOP_STALL_BUDGET_MS } from "./runtime-health-contract.js";

const WARNING_THRESHOLD_MS = 100;
const WARNING_CLEAR_MS = 50;
const TURN_RESOLUTION_MS = 5;
/**
 * A cheap read answers in milliseconds, so any single turn that holds the loop
 * longer than this is a visible stall for every client. A lone multi-second
 * stall barely moves a window's p95, so it is reported on its own (issue 63c9031).
 */
export interface EventLoopLagSnapshot extends DiagnosticInterval {
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  highWaterMs: number;
  warning: boolean;
  backgroundBackoffMs: number;
}

/** Constant-space event-loop delay diagnostics with warning hysteresis. */
export class EventLoopLagDiagnostics {
  private readonly histogram: IntervalHistogram;
  private readonly logger: Logger;
  private warning = false;
  private highWaterMs = 0;
  private sequence = 0;
  private intervalStartedAt: number;
  private last: EventLoopLagSnapshot;
  private turnTimer: ReturnType<typeof setInterval> | null = null;
  private turnMaxMs = 0;

  constructor(logger: Logger, resolutionMs = 20, now = Date.now()) {
    this.logger = logger;
    this.histogram = monitorEventLoopDelay({ resolution: resolutionMs });
    this.histogram.enable();
    this.intervalStartedAt = now;
    this.last = emptySnapshot(now);
  }

  sample(intervalEndedAt = Date.now()): EventLoopLagSnapshot {
    const p50Ms = finiteMilliseconds(this.histogram.percentile(50));
    const p95Ms = finiteMilliseconds(this.histogram.percentile(95));
    const maxMs = finiteMilliseconds(this.histogram.max);
    this.highWaterMs = Math.max(this.highWaterMs, maxMs);

    if (maxMs >= EVENT_LOOP_STALL_BUDGET_MS) {
      this.logger("warn", "daemon_event_loop_stall", { max_ms: maxMs, p95_ms: p95Ms, budget_ms: EVENT_LOOP_STALL_BUDGET_MS });
    }
    if (!this.warning && p95Ms >= WARNING_THRESHOLD_MS) {
      this.warning = true;
      this.logger("warn", "daemon_event_loop_lag", { p95_ms: p95Ms, max_ms: maxMs });
    } else if (this.warning && p95Ms < WARNING_CLEAR_MS) {
      this.warning = false;
      this.logger("info", "daemon_event_loop_recovered", { p95_ms: p95Ms, max_ms: maxMs });
    }

    this.last = {
      sequence: ++this.sequence,
      intervalStartedAt: this.intervalStartedAt,
      intervalEndedAt,
      p50Ms,
      p95Ms,
      maxMs,
      highWaterMs: this.highWaterMs,
      warning: this.warning,
      backgroundBackoffMs: backoffForLag(p95Ms),
    };
    this.intervalStartedAt = intervalEndedAt;
    this.histogram.reset();
    return { ...this.last };
  }

  snapshot(): EventLoopLagSnapshot {
    return { ...this.last };
  }

  /**
   * The longest the loop was blocked since the previous call, in ms. The first
   * call starts a 5 ms drift timer and returns 0. It is not a second
   * monitorEventLoopDelay: Bun backs every such monitor with one shared
   * histogram, so resetting another one would reset the health window. Used by
   * scripts/route-cost-sweep.ts to charge each request its own blocking time.
   */
  readTurnMs(): number {
    if (!this.turnTimer) {
      let last = performance.now();
      this.turnTimer = setInterval(() => {
        const now = performance.now();
        this.turnMaxMs = Math.max(this.turnMaxMs, now - last - TURN_RESOLUTION_MS);
        last = now;
      }, TURN_RESOLUTION_MS);
      this.turnTimer.unref();
      return 0;
    }
    const maxMs = Math.round(this.turnMaxMs * 10) / 10;
    this.turnMaxMs = 0;
    return maxMs;
  }

  close(): void {
    this.histogram.disable();
    if (this.turnTimer) clearInterval(this.turnTimer);
  }
}

function finiteMilliseconds(nanoseconds: number): number {
  return Number.isFinite(nanoseconds) ? Math.round((nanoseconds / 1e6) * 10) / 10 : 0;
}

function backoffForLag(p95Ms: number): number {
  if (p95Ms >= 250) return 250;
  if (p95Ms >= 100) return 100;
  if (p95Ms >= 50) return 25;
  return 0;
}

function emptySnapshot(now: number): EventLoopLagSnapshot {
  return { sequence: 0, intervalStartedAt: now, intervalEndedAt: now, p50Ms: 0, p95Ms: 0, maxMs: 0, highWaterMs: 0, warning: false, backgroundBackoffMs: 0 };
}
