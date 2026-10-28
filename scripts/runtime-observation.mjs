export class RuntimeObservationError extends Error {
  constructor(code, message, evidence, outcome = 'failed') {
    super(message);
    this.name = 'RuntimeObservationError';
    this.code = code;
    this.evidence = evidence;
    this.outcome = outcome;
  }
  toJSON() {
    return { schema: 'mandible-runtime-observation@1', outcome: this.outcome,
      code: this.code, message: this.message, evidence: this.evidence };
  }
}

export const observationPending = error => error instanceof RuntimeObservationError && error.outcome === 'pending';

/** Bound each observation by the caller's original deadline. */
export function runtimeObservationTimeout(until, maximumMs) {
  if (until === undefined) return maximumMs;
  const remaining = until - Date.now();
  if (remaining <= 0) throw new RuntimeObservationError('observation_deadline', 'Runtime observation deadline exceeded.', null, 'pending');
  return Math.max(1, Math.min(maximumMs, remaining));
}

export function runtimeProcessChanged(expected, current) {
  return !!expected?.pid && (!current?.pid || !current.startedAt || expected.pid !== current.pid
    || expected.startedAt !== current.startedAt || current.runs > expected.runs);
}

export function decodeObservationError(text) {
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (value?.schema !== 'mandible-runtime-observation@1' || !['pending', 'failed'].includes(value.outcome)
    || typeof value.code !== 'string' || typeof value.message !== 'string') return null;
  return new RuntimeObservationError(value.code, value.message, value.evidence, value.outcome);
}

export function runtimeObservationAcceptance(run, journal) {
  const b = journal.binding;
  if (!run || run.id !== b.executionId || run.auth_request_id !== b.requestId
      || run.hook_id !== b.hookId || run.command_digest !== b.commandDigest) return 'inconsistent';
  if (run.state !== 'complete') return ['pending', 'running', 'failed'].includes(run.state) ? 'unaccepted' : 'inconsistent';
  const marker = journal.recovery ? `MANDIBLE_RUNTIME_RECOVERY_ACCEPTED:${journal.recovery.digest}`
    : `MANDIBLE_RUNTIME_HANDOFF_ACCEPTED:${journal.bindingDigest}`;
  return run.output.includes(marker) ? 'accepted' : 'inconsistent';
}

export function runtimeVerificationDisposition(run, journal) {
  const acceptance = runtimeObservationAcceptance(run, journal);
  if (acceptance === 'inconsistent') return 'inconsistent';
  if (journal.phase === 'retired') return 'retired';
  if (journal.phase === 'acknowledged') return acceptance === 'accepted' ? 'confirmed' : 'inconsistent';
  if (journal.phase === 'complete') return acceptance === 'accepted' ? 'acknowledge' : 'await_acceptance';
  if (['armed', 'unloading', 'dependencies', 'build', 'desktop', 'instructions'].includes(journal.phase)) return acceptance === 'unaccepted' ? 'helper_pending' : 'inconsistent';
  if (!['failed', 'verification-pending', 'starting', 'observing'].includes(journal.phase)) return 'inconsistent';
  if (acceptance === 'accepted') return journal.recovery ? 'complete_accepted' : 'inconsistent';
  if (journal.phase !== 'failed' && (!journal.launch || typeof journal.launch !== 'object' || !Number.isFinite(journal.launch.enteredAt))) return 'inconsistent';
  return 'observe';
}
