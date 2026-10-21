import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import type { Logger } from "./types.js";

const WARNING_THRESHOLD_MS = 100;
const WARNING_CLEAR_MS = 50;
/**
 * A cheap read answers in milliseconds, so any single turn that holds the loop
 * longer than this is a visible stall for every client. A lone multi-second
 * stall barely moves a window's p95, so it is reported on its own (issue 63c9031).
 */
export const EVENT_LOOP_STALL_BUDGET_MS = 250;

export interface EventLoopLagSnapshot {
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
  private last: EventLoopLagSnapshot = emptySnapshot();

  constructor(logger: Logger, resolutionMs = 20) {
    this.logger = logger;
    this.histogram = monitorEventLoopDelay({ resolution: resolutionMs });
    this.histogram.enable();
  }

  sample(): EventLoopLagSnapshot {
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
      p50Ms,
      p95Ms,
      maxMs,
      highWaterMs: this.highWaterMs,
      warning: this.warning,
      backgroundBackoffMs: backoffForLag(p95Ms),
    };
    this.histogram.reset();
    return { ...this.last };
  }

  snapshot(): EventLoopLagSnapshot {
    return { ...this.last };
  }

  close(): void {
    this.histogram.disable();
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

function emptySnapshot(): EventLoopLagSnapshot {
  return { p50Ms: 0, p95Ms: 0, maxMs: 0, highWaterMs: 0, warning: false, backgroundBackoffMs: 0 };
}
