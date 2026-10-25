export const CONFIRMATION_TRIALS = 3;
export const LOAD_WAIT_MS = 180_000;

export interface TurnReading {
  pass: number;
  worstTurnMs: number;
}

export function trialTurns(readings: readonly TurnReading[]) {
  const worst = (first: boolean) => readings
    .filter((reading) => (reading.pass === 1) === first)
    .reduce((max, reading) => Math.max(max, reading.worstTurnMs), 0);
  return { firstCallMs: worst(true), warmMs: worst(false) };
}

/** A call kind must reach the budget in the main pass and every confirmation. */
export function judgeRoute(trials: readonly (readonly TurnReading[])[], thresholdMs: number) {
  if (trials.length === 0) throw new Error("A route judgment needs a main trial");
  const turns = trials.map(trialTurns);
  const firstCallMs = Math.min(...turns.map((turn) => turn.firstCallMs));
  const warmMs = Math.min(...turns.map((turn) => turn.warmMs));
  const worstMs = Math.max(firstCallMs, warmMs);
  return { firstCallMs, warmMs, worstMs, overBudget: worstMs >= thresholdMs };
}

/** Load only delays measurement; reaching the deadline still permits the sweep. */
export async function waitForLoad({
  cpus,
  readLoad,
  now = Date.now,
  wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  maxWaitMs = LOAD_WAIT_MS,
  intervalMs = 5_000,
}: {
  cpus: number;
  readLoad: () => number;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  maxWaitMs?: number;
  intervalMs?: number;
}) {
  const started = now();
  const start = readLoad();
  let measurementStart = start;
  while (measurementStart >= cpus && now() - started < maxWaitMs) {
    await wait(Math.min(intervalMs, maxWaitMs - (now() - started)));
    measurementStart = readLoad();
  }
  return { start, measurement_start: measurementStart, waited_ms: now() - started, wait_limit_ms: maxWaitMs, cpus };
}
