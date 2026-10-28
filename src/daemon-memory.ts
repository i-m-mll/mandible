import os from "node:os";
import type { Logger } from "./types.js";
import type { DiagnosticInterval } from "./runtime-health-contract.js";

export const DEFAULT_MEMORY_WARNING_FRACTION = 0.1;
const WARNING_CLEAR_RATIO = 0.9;

export interface ProcessMemoryValues {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

export interface DaemonMemorySnapshot extends ProcessMemoryValues, DiagnosticInterval {
  uptime: number;
  totalMemory: number;
  rssFraction: number;
  warningThresholdFraction: number;
  warning: boolean;
  highWater: ProcessMemoryValues;
}

interface DaemonMemorySources {
  memoryUsage: () => ProcessMemoryValues;
  uptime: () => number;
  totalMemory: () => number;
}

export interface DaemonMemoryDiagnosticsOptions {
  logger: Logger;
  warningFraction?: number;
  sources?: Partial<DaemonMemorySources>;
}

/**
 * Collect process memory without retaining samples or registering listeners.
 *
 * The collector keeps only five numeric high-water marks and the current
 * warning state. Sampling is therefore constant-space regardless of uptime.
 */
export class DaemonMemoryDiagnostics {
  private readonly logger: Logger;
  private readonly sources: DaemonMemorySources;
  private readonly warningFraction: number;
  private readonly warningClearFraction: number;
  private warning = false;
  private highWater: ProcessMemoryValues = emptyMemoryValues();
  private sequence = 0;
  private intervalStartedAt: number;
  private last: DaemonMemorySnapshot;

  constructor(options: DaemonMemoryDiagnosticsOptions) {
    this.logger = options.logger;
    this.warningFraction = normalizeWarningFraction(options.warningFraction);
    this.warningClearFraction = this.warningFraction * WARNING_CLEAR_RATIO;
    this.sources = {
      memoryUsage: options.sources?.memoryUsage ?? process.memoryUsage,
      uptime: options.sources?.uptime ?? process.uptime,
      totalMemory: options.sources?.totalMemory ?? os.totalmem,
    };
    this.intervalStartedAt = Date.now();
    this.last = { ...emptyMemorySnapshot(this.intervalStartedAt), warningThresholdFraction: this.warningFraction };
  }

  current(intervalEndedAt = Date.now()): DaemonMemorySnapshot {
    const usage = this.sources.memoryUsage();
    const totalMemory = Math.max(0, this.sources.totalMemory());
    const rssFraction = totalMemory > 0 ? usage.rss / totalMemory : 0;
    return {
      sequence: this.sequence,
      intervalStartedAt: this.intervalStartedAt,
      intervalEndedAt,
      ...usage,
      uptime: this.sources.uptime(), totalMemory, rssFraction,
      warningThresholdFraction: this.warningFraction,
      warning: this.warning ? rssFraction >= this.warningClearFraction : rssFraction >= this.warningFraction,
      highWater: maxMemoryValues(this.highWater, usage),
    };
  }

  sample(intervalEndedAt = Date.now()): DaemonMemorySnapshot {
    const current = this.current(intervalEndedAt);
    this.updateWarningState(current);
    this.highWater = current.highWater;
    this.last = { ...current, sequence: ++this.sequence };
    this.intervalStartedAt = intervalEndedAt;
    return { ...this.last };
  }

  /**
   * Return the most recent sampled snapshot without collecting a new one.
   * Periodic warning state and logging stay on the diagnostics timer; current()
   * evaluates a read without mutating either.
   */
  snapshot(): DaemonMemorySnapshot {
    return { ...this.last };
  }

  private updateWarningState({ rss, totalMemory, rssFraction, warning }: DaemonMemorySnapshot): void {
    if (!this.warning && warning) {
      this.warning = true;
      this.logger("warn", "daemon_memory_warning", {
        subsystem: "daemon",
        rss,
        total_memory: totalMemory,
        rss_fraction: rssFraction,
        warning_threshold_fraction: this.warningFraction,
      });
      return;
    }

    if (this.warning && !warning) {
      this.warning = false;
      this.logger("info", "daemon_memory_recovered", {
        subsystem: "daemon",
        rss,
        total_memory: totalMemory,
        rss_fraction: rssFraction,
        warning_clear_fraction: this.warningClearFraction,
      });
    }
  }
}

export function memoryWarningFractionFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MANDIBLE_MEMORY_WARNING_FRACTION;
  if (!raw) {
    return DEFAULT_MEMORY_WARNING_FRACTION;
  }
  return normalizeWarningFraction(Number(raw));
}

function normalizeWarningFraction(value: number | undefined): number {
  if (value !== undefined && Number.isFinite(value) && value > 0 && value <= 1) {
    return value;
  }
  return DEFAULT_MEMORY_WARNING_FRACTION;
}

function emptyMemoryValues(): ProcessMemoryValues {
  return { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
}

function emptyMemorySnapshot(now: number): DaemonMemorySnapshot {
  return {
    sequence: 0,
    intervalStartedAt: now,
    intervalEndedAt: now,
    ...emptyMemoryValues(),
    uptime: 0,
    totalMemory: 0,
    rssFraction: 0,
    warningThresholdFraction: DEFAULT_MEMORY_WARNING_FRACTION,
    warning: false,
    highWater: emptyMemoryValues(),
  };
}

function maxMemoryValues(left: ProcessMemoryValues, right: ProcessMemoryValues): ProcessMemoryValues {
  return {
    rss: Math.max(left.rss, right.rss),
    heapTotal: Math.max(left.heapTotal, right.heapTotal),
    heapUsed: Math.max(left.heapUsed, right.heapUsed),
    external: Math.max(left.external, right.external),
    arrayBuffers: Math.max(left.arrayBuffers, right.arrayBuffers),
  };
}
