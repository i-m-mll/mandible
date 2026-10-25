export const EVENT_LOOP_STALL_BUDGET_MS = 250;
/**
 * The most one request may block the event loop, judged per route by
 * scripts/route-cost-sweep.ts on production data. It sits well under
 * EVENT_LOOP_STALL_BUDGET_MS because concurrent requests and background
 * work share the same loop.
 */
export const HANDLER_TURN_BUDGET_MS = 100;

export interface DiagnosticInterval {
  sequence: number;
  intervalStartedAt: number;
  intervalEndedAt: number;
}

export interface RuntimeHealthSnapshot {
  eventLoop?: DiagnosticInterval & { warning: boolean; maxMs: number };
  memory?: DiagnosticInterval & { warning: boolean };
}

export type RuntimeHealthFailureCode =
  | "invalid_diagnostics"
  | "event_loop_lag"
  | "event_loop_stall"
  | "memory_warning";

export interface RuntimeHealthFailure {
  code: RuntimeHealthFailureCode;
  message: string;
  sample: unknown;
}

export class RuntimeHealthObservationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly evidence: unknown,
  ) {
    super(message);
    this.name = "RuntimeHealthObservationError";
  }
}

export async function observeRuntimeHealthCoverage<T>(options: {
  probe: (deadline: number, signal: AbortSignal) => Promise<T>;
  healthOf: (value: T) => RuntimeHealthSnapshot;
  validate?: (value: T, initial: T) => void;
  recovery?: boolean;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  observationMs?: number;
  deadlineMs?: number;
  pollMs?: number;
}): Promise<{
  value: T;
  observation: { startedAt: number; mustCover: number; completedAt: number; deadline: number };
  samples: { initial: RuntimeHealthSnapshot; last: RuntimeHealthSnapshot };
  historicalHealth: RuntimeHealthFailure[];
}> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const startedAt = now();
  const mustCover = startedAt + (options.observationMs ?? 31_000);
  const deadline = startedAt + (options.deadlineMs ?? 62_000);
  let value: T;
  try {
    value = await probeByDeadline(options.probe, deadline, now);
  } catch (error) {
    if (error instanceof RuntimeHealthObservationError) throw error;
    throw new RuntimeHealthObservationError("probe_failed", `Runtime health probe failed: ${error instanceof Error ? error.message : String(error)}`, { startedAt, mustCover, deadline, lastSample: null });
  }
  if (now() > deadline) throw new RuntimeHealthObservationError("observation_deadline", "Runtime health probe exceeded the observation deadline.", { startedAt, mustCover, deadline, lastSample: options.healthOf(value) });
  const initial = value;
  const firstHealth = options.healthOf(value);
  const trackers = { eventLoop: intervalTracker(), memory: intervalTracker() };
  const historicalHealth: RuntimeHealthFailure[] = [];
  const historicalKeys = new Set<string>();

  for (;;) {
    try { options.validate?.(value, initial); }
    catch (error) {
      if (error instanceof RuntimeHealthObservationError) throw error;
      throw new RuntimeHealthObservationError("observation_changed", error instanceof Error ? error.message : String(error), { startedAt, mustCover, deadline, initial, current: value });
    }
    const health = options.healthOf(value);
    for (const name of ["eventLoop", "memory"] as const) updateIntervalCoverage(trackers[name], health[name], name, startedAt, now());
    const currentFailures: RuntimeHealthFailure[] = [];
    for (const failure of assessRuntimeHealth(health)) {
      if (options.recovery && failure.code === "event_loop_stall"
        && validInterval(failure.sample)
        && failure.sample.intervalEndedAt < startedAt) {
        const key = `${failure.code}:${failure.sample.sequence}`;
        if (!historicalKeys.has(key)) { historicalKeys.add(key); historicalHealth.push(failure); }
      } else currentFailures.push(failure);
    }
    if (currentFailures.length) throw new RuntimeHealthObservationError(currentFailures[0]!.code, currentFailures[0]!.message, {
      startedAt, mustCover, deadline, failures: currentFailures, initialSample: firstHealth, lastSample: health,
    });
    if (now() > deadline) throw new RuntimeHealthObservationError("observation_deadline", "Runtime health observation exceeded its fixed deadline.", { startedAt, mustCover, deadline, initialSample: firstHealth, lastSample: health });
    if (now() >= mustCover && trackers.eventLoop.coveredUntil >= mustCover && trackers.memory.coveredUntil >= mustCover) {
      return { value, observation: { startedAt, mustCover, completedAt: now(), deadline }, samples: { initial: firstHealth, last: health }, historicalHealth: historicalHealth.slice(0, 20) };
    }
    if (now() >= deadline) throw new RuntimeHealthObservationError("stale_diagnostics", "Runtime diagnostics did not produce contiguous fresh samples covering the observation.", { startedAt, mustCover, deadline, initialSample: firstHealth, lastSample: health });
    await wait(options.pollMs ?? 1_000);
    if (now() > deadline) throw new RuntimeHealthObservationError("observation_deadline", "Runtime health observation exceeded its fixed deadline.", { startedAt, mustCover, deadline, initialSample: firstHealth, lastSample: health });
    if (now() === deadline) throw new RuntimeHealthObservationError("stale_diagnostics", "Runtime diagnostics did not produce contiguous fresh samples covering the observation.", { startedAt, mustCover, deadline, initialSample: firstHealth, lastSample: health });
    try {
      value = await probeByDeadline(options.probe, deadline, now);
    } catch (error) {
      if (error instanceof RuntimeHealthObservationError) throw error;
      throw new RuntimeHealthObservationError("probe_failed", `Runtime health probe failed: ${error instanceof Error ? error.message : String(error)}`, { startedAt, mustCover, deadline, initialSample: firstHealth, lastSample: health });
    }
  }
}

async function probeByDeadline<T>(
  probe: (deadline: number, signal: AbortSignal) => Promise<T>,
  deadline: number,
  now: () => number,
): Promise<T> {
  const remaining = deadline - now();
  if (remaining <= 0) throw new RuntimeHealthObservationError("observation_deadline", "Runtime health observation exceeded its fixed deadline.", { deadline });
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new RuntimeHealthObservationError("observation_deadline", "Runtime health probe exceeded the observation deadline.", { deadline });
      controller.abort(error);
      reject(error);
    }, remaining);
  });
  try {
    return await Promise.race([probe(deadline, controller.signal), expired]);
  } finally {
    clearTimeout(timer!);
  }
}

export function assessRuntimeHealth(health: RuntimeHealthSnapshot): RuntimeHealthFailure[] {
  const failures: RuntimeHealthFailure[] = [];
  if (!validInterval(health.eventLoop)
    || typeof health.eventLoop?.warning !== "boolean"
    || !finiteNonnegative(health.eventLoop?.maxMs)) {
    failures.push({ code: "invalid_diagnostics", message: "Event-loop diagnostics are missing or invalid.", sample: health.eventLoop });
  } else {
    if (health.eventLoop.warning) failures.push({ code: "event_loop_lag", message: "Event-loop lag warning is active.", sample: health.eventLoop });
    if (health.eventLoop.maxMs >= EVENT_LOOP_STALL_BUDGET_MS) failures.push({
      code: "event_loop_stall",
      message: `Event-loop delay ${health.eventLoop.maxMs} ms meets or exceeds the ${EVENT_LOOP_STALL_BUDGET_MS} ms budget.`,
      sample: health.eventLoop,
    });
  }
  if (!validInterval(health.memory) || typeof health.memory?.warning !== "boolean") {
    failures.push({ code: "invalid_diagnostics", message: "Memory diagnostics are missing or invalid.", sample: health.memory });
  } else if (health.memory.warning) {
    failures.push({ code: "memory_warning", message: "Memory warning is active.", sample: health.memory });
  }
  return failures;
}

export function diagnosticsCover(health: RuntimeHealthSnapshot, instant: number): boolean {
  return validInterval(health.eventLoop) && validInterval(health.memory)
    && health.eventLoop.intervalStartedAt <= instant && health.eventLoop.intervalEndedAt >= instant
    && health.memory.intervalStartedAt <= instant && health.memory.intervalEndedAt >= instant;
}

function validInterval(value: unknown): value is DiagnosticInterval {
  if (!value || typeof value !== "object") return false;
  const interval = value as Partial<DiagnosticInterval>;
  return Number.isInteger(interval.sequence) && (interval.sequence ?? 0) > 0
    && finiteNonnegative(interval.intervalStartedAt)
    && finiteNonnegative(interval.intervalEndedAt)
    && interval.intervalEndedAt! >= interval.intervalStartedAt!;
}

function intervalTracker() {
  return { sequence: 0, snapshot: "", intervalEndedAt: -1, coveredUntil: -1 };
}

function updateIntervalCoverage(
  tracker: ReturnType<typeof intervalTracker>,
  interval: unknown,
  name: "eventLoop" | "memory",
  observationStartedAt: number,
  observedAt: number,
): void {
  if (!validInterval(interval)) throw new RuntimeHealthObservationError("invalid_diagnostics", `${name} diagnostics are missing or invalid.`, { sample: interval });
  if (interval.intervalEndedAt > observedAt) throw new RuntimeHealthObservationError("future_diagnostics", `${name} diagnostics end in the future.`, { sample: interval, observedAt });
  const snapshot = JSON.stringify(interval);
  if (interval.sequence === tracker.sequence) {
    if (tracker.snapshot && tracker.snapshot !== snapshot) throw new RuntimeHealthObservationError("diagnostics_mutated", `${name} diagnostics changed without advancing sequence.`, { prior: tracker.snapshot, current: interval });
    return;
  }
  if (tracker.sequence && interval.sequence !== tracker.sequence + 1) throw new RuntimeHealthObservationError("diagnostics_gap", `${name} diagnostics skipped a completed interval.`, { priorSequence: tracker.sequence, current: interval });
  if (tracker.sequence && interval.intervalStartedAt > tracker.intervalEndedAt) throw new RuntimeHealthObservationError("diagnostics_gap", `${name} diagnostics contain an uncovered interval.`, { priorEndedAt: tracker.intervalEndedAt, current: interval });
  if (tracker.sequence && interval.intervalEndedAt < tracker.intervalEndedAt) throw new RuntimeHealthObservationError("diagnostics_sequence_changed", `${name} diagnostics interval moved backwards.`, { priorEndedAt: tracker.intervalEndedAt, current: interval });
  tracker.sequence = interval.sequence;
  tracker.snapshot = snapshot;
  tracker.intervalEndedAt = interval.intervalEndedAt;
  if (interval.intervalStartedAt <= observationStartedAt && interval.intervalEndedAt >= observationStartedAt) tracker.coveredUntil = Math.max(tracker.coveredUntil, interval.intervalEndedAt);
  else if (tracker.coveredUntil >= observationStartedAt && interval.intervalStartedAt <= tracker.coveredUntil) tracker.coveredUntil = Math.max(tracker.coveredUntil, interval.intervalEndedAt);
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
