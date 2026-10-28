import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { runSupervisedCommand } from "./process-group-supervisor.mjs";

export class SweepBudget {
  readonly started: number;
  readonly deadline: number;
  readonly controller = new AbortController();
  readonly totals: Record<string, number> = {};
  readonly completed: string[] = [];
  phase = "initializing";
  private phaseStarted: number;
  private timer: ReturnType<typeof setTimeout>;

  constructor(readonly totalMs: number, readonly reserveMs = 5_000, readonly now = Date.now, started = now()) {
    if (!(totalMs > reserveMs)) throw new Error("Sweep budget must exceed its cleanup reserve");
    this.started = started;
    this.phaseStarted = this.started;
    this.deadline = this.started + totalMs;
    this.timer = setTimeout(() => this.controller.abort(new Error("Sweep total deadline reached; cleanup reserve started")), Math.max(0, this.deadline - now() - reserveMs));
  }

  remaining(cleanup = false) {
    const remaining = this.deadline - this.now() - (cleanup ? 0 : this.reserveMs);
    if (remaining <= 0 || (!cleanup && this.controller.signal.aborted)) throw new Error("Sweep total deadline reached");
    return remaining;
  }

  async wait(ms: number) {
    const remaining = this.remaining();
    await delay(Math.min(ms, remaining), undefined, { signal: this.controller.signal });
    this.remaining();
  }

  async measure<T>(phase: string, checkpoint: () => void, operation: () => T | Promise<T>): Promise<T> {
    this.remaining(phase === "shutdown");
    const previous = this.phase;
    this.phase = phase;
    this.phaseStarted = this.now();
    checkpoint();
    const started = this.now();
    let completed = false;
    try {
      const value = await operation();
      this.remaining(phase === "shutdown");
      if (!this.completed.includes(phase)) this.completed.push(phase);
      completed = true;
      return value;
    } finally {
      this.totals[phase] = (this.totals[phase] ?? 0) + this.now() - started;
      if (completed) {
        this.phase = previous;
        this.phaseStarted = this.now();
      }
      checkpoint();
    }
  }

  progress() {
    return { started_at: this.started, phase_started_at: this.phaseStarted, elapsed_ms: this.now() - this.started, budget_ms: this.totalMs, cleanup_reserve_ms: this.reserveMs,
      phase: this.phase, phase_elapsed_ms: this.now() - this.phaseStarted, completed_phases: this.completed, phase_ms: this.totals };
  }

  close() { clearTimeout(this.timer); }
}

export function writeSweepProgress(file: string, report: unknown) {
  const text = JSON.stringify(report);
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("Sweep report exceeds its 1 MiB retention bound; previous atomic checkpoint preserved");
  const temporary = `${file}.partial`;
  fs.writeFileSync(temporary, text);
  fs.renameSync(temporary, file);
}

export async function runSweepWorker(budget: SweepBudget, binary: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: unknown; graceMs?: number } = {}) {
  await runSupervisedCommand(binary, args, { ...options, timeout: budget.remaining(), deadline: budget.deadline, graceMs: options.graceMs ?? Math.min(1_000, Math.floor(budget.reserveMs / 3)) });
}
