import { DOMAIN_EVENTS } from "./contracts.js";
import type { SessionRegistry } from "./registry.js";
import { broadcast } from "./sse.js";
import type { Logger } from "./types.js";

/** Periodically ends registered sessions whose processes are gone. */
export class ReaperTimer {
  private timer: ReturnType<typeof setInterval> | null = null;
  private totalReaped = 0;
  private totalRuns = 0;

  constructor(
    private readonly registry: SessionRegistry,
    private readonly log: Logger,
    private readonly intervalMs = 60_000,
  ) {}

  /** Start the periodic reaper. Safe to call multiple times. */
  start(): void {
    if (this.timer) return;
    this.log("info", "reaper_timer_started", { interval_ms: this.intervalMs });
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.log("info", "reaper_timer_stopped");
  }

  private tick(): void {
    const start = Date.now();
    try {
      const reaped = this.registry.reapDead().length;
      const duration = Date.now() - start;
      this.totalReaped += reaped;
      this.totalRuns++;
      if (reaped === 0) return;
      this.log("info", "reaper_tick", { reaped, duration_ms: duration });
      broadcast(DOMAIN_EVENTS.REAPER_TICK, {
        reaped,
        duration_ms: duration,
        total_reaped: this.totalReaped,
        total_runs: this.totalRuns,
      });
    } catch (error) {
      this.log("warn", "reaper_tick_error", { error: String(error) });
    }
  }
}
