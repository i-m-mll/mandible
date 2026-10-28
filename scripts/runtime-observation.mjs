import { createHash } from 'node:crypto';

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
  const current = runtimeHandoffDisposition(journal);
  const marker = current ? runtimeReceiptAcceptanceMarker(journal)
    : journal.recovery ? `MANDIBLE_RUNTIME_RECOVERY_ACCEPTED:${journal.recovery.digest}`
    : `MANDIBLE_RUNTIME_HANDOFF_ACCEPTED:${journal.bindingDigest}`;
  return marker && run.output.split('\n').includes(marker) ? 'accepted' : 'inconsistent';
}

export function runtimeHandoffDisposition(journal) {
  const attempt = journal.attempt;
  if (!attempt) return null;
  return { attemptId: attempt.id,
    mutation: attempt.fence ? 'fenced' : attempt.state === 'running' ? 'active' : 'quiescent',
    runtime: attempt.state === 'complete' ? 'complete' : attempt.state === 'failed' ? 'failed' : 'pending',
    receipt: attempt.receipt, receiptDigest: attempt.receiptDigest,
    cleanup: journal.cleanup ?? { state: 'pending' } };
}

export function runtimeReceiptAcceptanceMarker(journal) {
  const current = runtimeHandoffDisposition(journal);
  if (!current || current.runtime !== 'complete' || !current.receiptDigest || !current.receipt) return null;
  if (!['mandible-runtime-receipt@1', 'mandible-runtime-receipt@2'].includes(current.receipt.schema) || current.receipt.bindingDigest !== journal.bindingDigest
      || current.receipt.attemptId !== current.attemptId
      || createHash('sha256').update(JSON.stringify(current.receipt)).digest('hex') !== current.receiptDigest) return null;
  return `MANDIBLE_RUNTIME_RECEIPT_ACCEPTED:${journal.bindingDigest}:${current.attemptId}:${current.receiptDigest}`;
}
