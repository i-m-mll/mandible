export const ACCEPTANCE_TOTAL_MS = 60_000;
export const ACCEPTANCE_CLEANUP_MS = 5_000;

/** One executor clock allocates preparation, runtime work, reporting and forced cleanup once. */
export function acceptanceDeadline(env = process.env, now = Date.now) {
  const entered = now();
  const inherited = env.MANDIBLE_ACCEPTANCE_DEADLINE;
  const deadline = inherited === undefined ? entered + ACCEPTANCE_TOTAL_MS : Number(inherited);
  const started = inherited === undefined ? entered : Number(env.MANDIBLE_ACCEPTANCE_STARTED_AT);
  if (!Number.isFinite(started) || !Number.isFinite(deadline) || deadline <= started || deadline - started > ACCEPTANCE_TOTAL_MS) throw new Error('Invalid acceptance deadline binding.');
  const work = deadline - ACCEPTANCE_CLEANUP_MS;
  const cutoffs = Object.freeze({ preparation: work - 10_000, readiness: work - 5_000, work, report: deadline - 2000, total: deadline });
  const remaining = (phase = 'work') => {
    if (!Object.hasOwn(cutoffs, phase)) throw new Error('Unknown acceptance deadline phase.');
    const ms = cutoffs[phase] - now();
    if (ms <= 0) throw new Error(`Acceptance ${phase} budget exhausted${phase === 'preparation' ? '; readiness and desktop time is reserved' : ''}.`);
    return ms;
  };
  return { started, deadline, cutoffs, remaining,
    env: { MANDIBLE_ACCEPTANCE_STARTED_AT: String(started), MANDIBLE_ACCEPTANCE_DEADLINE: String(deadline) },
    reading: () => ({ started_at: started, deadline, elapsed_ms: now() - started, cleanup_reserve_ms: ACCEPTANCE_CLEANUP_MS,
      cutoffs, remaining_ms: Object.fromEntries(Object.entries(cutoffs).map(([name, end]) => [name, Math.max(0, end - now())])),
      scope: inherited === undefined ? 'candidate-script; installed executor preparation excluded' : 'executor including checkout, runtime and dependency preparation' }),
  };
}
