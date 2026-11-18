import { createHash } from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';

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

/**
 * Go-live time rule: a clock decides when to look again, never an outcome.
 * Every external command on the go-live path runs through runRuntimeCommand.
 * Its timeout is what remains of the current budget; a command that does not
 * answer in time, or is killed, is `pending`. Its exit status is returned for
 * the caller to judge, so only the thing itself can report failure.
 */
const commandScope = new AsyncLocalStorage();
/** The budget of a command issued outside any go-live scope, such as a status read. */
export const RUNTIME_OBSERVATION_WINDOW_MS = 10_000;

function scope() { return commandScope.getStore() ?? {}; }
/** Run `operation` with `budget()` as the deadline of every runtime command it issues without its own. */
export function withRuntimeBudget(budget, operation) {
  return commandScope.run({ ...scope(), budget }, operation);
}
/** Substitute the process runner and clock of every runtime command issued by `operation`. */
export function withRuntimeCommands({ spawn, now }, operation) {
  return commandScope.run({ ...scope(), ...(spawn ? { spawn } : {}), ...(now ? { now } : {}) }, operation);
}
export function runtimeNow() { return (scope().now ?? Date.now)(); }
export function runtimeDeadline(until) {
  return until ?? scope().budget?.() ?? runtimeNow() + RUNTIME_OBSERVATION_WINDOW_MS;
}

/** What remains of the caller's deadline, or of the current budget; nothing left is `pending`. */
export function runtimeObservationTimeout(until) {
  const remaining = runtimeDeadline(until) - runtimeNow();
  if (!(remaining > 0)) throw new RuntimeObservationError('observation_deadline', 'Runtime observation deadline exceeded.', null, 'pending');
  return remaining;
}

export function runRuntimeCommand(binary, args, { until, ...options } = {}) {
  const timeout = runtimeObservationTimeout(until);
  const command = `${path.basename(binary)}${args[0] ? ` ${args[0]}` : ''}`;
  const result = (scope().spawn ?? spawnSync)(binary, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options, timeout });
  if (result.error?.code === 'ETIMEDOUT' || !result.error && result.status === null) {
    throw new RuntimeObservationError('command_unanswered', `${command} did not answer within ${timeout} ms.`,
      { command: [binary, ...args], timeoutMs: timeout, signal: result.signal ?? null }, 'pending');
  }
  if (result.error) throw new RuntimeObservationError('command_failed', `${command} could not run: ${result.error.message}`,
    { command: [binary, ...args], code: result.error.code ?? null });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
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
