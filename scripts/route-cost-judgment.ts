export const CONFIRMATION_TRIALS = 3;

/** Exercised prerequisites in write order, excluding the target itself. */
export function writeReplayPlan(writeOrder: readonly string[], exercised: readonly string[], target: string): string[] {
  const targetIndex = writeOrder.indexOf(target);
  if (targetIndex < 0 || !exercised.includes(target)) throw new Error(`Not an exercised write: ${target}`);
  const included = new Set(exercised);
  return writeOrder.slice(0, targetIndex).filter((key) => included.has(key));
}

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
