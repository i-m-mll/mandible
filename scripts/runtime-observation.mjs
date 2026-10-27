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
  return journal.recovery && run.output.includes(`MANDIBLE_RUNTIME_RECOVERY_ACCEPTED:${journal.recovery.digest}`) ? 'accepted' : 'inconsistent';
}
