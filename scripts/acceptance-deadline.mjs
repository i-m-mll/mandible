export const ACCEPTANCE_TOTAL_MS = 60_000;
export const ACCEPTANCE_CLEANUP_MS = 5_000;

/** One wall-clock deadline, inherited from the executor before preparation. */
export function acceptanceDeadline(env = process.env, now = Date.now) {
  const entered = now();
  const inherited = env.MANDIBLE_ACCEPTANCE_DEADLINE;
  const deadline = inherited === undefined ? entered + ACCEPTANCE_TOTAL_MS : Number(inherited);
  const started = inherited === undefined ? entered : Number(env.MANDIBLE_ACCEPTANCE_STARTED_AT);
  if (!Number.isFinite(started) || !Number.isFinite(deadline) || deadline <= started || deadline - started > ACCEPTANCE_TOTAL_MS) throw new Error('Invalid acceptance deadline binding.');
  const remaining = (cleanup = false) => {
    const ms = deadline - now() - (cleanup ? 0 : ACCEPTANCE_CLEANUP_MS);
    if (ms <= 0) throw new Error(`Acceptance total deadline reached${cleanup ? ' during cleanup' : '; cleanup reserve started'}.`);
    return ms;
  };
  return { started, deadline, remaining,
    env: { MANDIBLE_ACCEPTANCE_STARTED_AT: String(started), MANDIBLE_ACCEPTANCE_DEADLINE: String(deadline) },
    reading: () => ({ started_at: started, deadline, elapsed_ms: now() - started, cleanup_reserve_ms: ACCEPTANCE_CLEANUP_MS,
      scope: inherited === undefined ? 'candidate-script; installed executor preparation excluded' : 'executor including checkout, runtime and dependency preparation' }),
  };
}
