// The one installation-wide runtime handoff lock. A handoff holds it from
// admission until acknowledgment; a failed handoff keeps holding it until
// verification-only recovery succeeds or an operator retires it.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const runtimeHandoffBindingDigest = binding => hash(JSON.stringify(binding));

function pendingVerification(home, owner, journal, bytes) {
  const b = journal?.binding;
  if (journal?.schema !== 'mandible-runtime-handoff@1' || journal.phase !== 'verification-pending' || !b || b.home !== home || !/^[a-zA-Z0-9_-]{8,128}$/.test(b.requestId ?? '') || !/^[a-zA-Z0-9_-]{8,128}$/.test(b.executionId ?? '')
      || typeof b.hookId !== 'string' || !b.hookId || !/^[0-9a-f]{64}$/.test(b.commandDigest ?? '')
      || owner.bindingDigest !== journal.bindingDigest || runtimeHandoffBindingDigest(b) !== owner.bindingDigest
      || owner.journal !== path.join(home, 'config/local-sessions/handoff', `${b.requestId}-${b.executionId}`, 'journal.json')) return null;
  const directory = path.dirname(owner.journal);
  const retirementFile = path.join(directory, 'retirement.json');
  if (fs.existsSync(retirementFile)) {
    const retired = JSON.parse(fs.readFileSync(retirementFile, 'utf8'));
    if (retired.schema === 'mandible-runtime-handoff-retirement@1' && retired.requestId === b.requestId && retired.executionId === b.executionId
        && retired.bindingDigest === journal.bindingDigest && retired.journalSha256 === hash(bytes)) return null;
  }
  const observation = journal.lastObservation;
  if (observation?.outcome !== 'pending' || typeof observation.code !== 'string' || !observation.code
      || typeof observation.reason !== 'string' || !observation.reason.trim()) return null;
  return { requestId: b.requestId, executionId: b.executionId, hookId: b.hookId, commandDigest: b.commandDigest,
    bindingDigest: journal.bindingDigest, phase: 'verification-pending', code: observation.code.slice(0, 100), reason: observation.reason.slice(0, 2000) };
}

export const runtimeHandoffLockFile = home => path.join(home, 'config', 'local-sessions', 'handoff-active.json');

/** Read the lock and its owning journal without validating or changing either. */
export function readRuntimeHandoffLock(home) {
  home = path.resolve(home);
  const file = runtimeHandoffLockFile(home);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return { file, journalPath: null, bindingDigest: null, requestId: null, executionId: null, phase: null, error: `Lock is unreadable: ${error.message}` };
  }
  let owner = null;
  try { owner = JSON.parse(raw); } catch { /* reported below */ }
  let journal = null;
  let journalBytes;
  let journalError = null;
  if (typeof owner?.journal === 'string') {
    try { journalBytes = fs.readFileSync(owner.journal, 'utf8'); journal = JSON.parse(journalBytes); } catch (error) { journalError = `Owning journal is unreadable: ${error.message}`; }
  }
  let verification = null;
  try {
    if (owner && journal && fs.readFileSync(file, 'utf8') === raw) verification = pendingVerification(home, owner, journal, journalBytes);
  } catch { /* Unproven pending evidence cannot become a user instruction. */ }
  return {
    file,
    journalPath: typeof owner?.journal === 'string' ? owner.journal : null,
    bindingDigest: typeof owner?.bindingDigest === 'string' ? owner.bindingDigest : null,
    requestId: journal?.binding?.requestId ?? null,
    executionId: journal?.binding?.executionId ?? null,
    phase: typeof journal?.phase === 'string' ? journal.phase : null,
    lastObservation: journal?.lastObservation ?? null,
    ...(verification ? { verification } : {}),
    error: typeof journal?.error === 'string' ? journal.error : journalError ?? (owner ? null : 'Lock is not valid JSON'),
  };
}

/** The visible refusal for every action that needs the lock to be free. */
export function runtimeHandoffLockRefusal(lock) {
  const owner = lock.requestId ? `request ${lock.requestId.slice(0, 8)}` : 'an unknown request';
  const state = `${owner} is in phase ${lock.phase ?? 'unknown'}${lock.error ? ` (${lock.error})` : ''}`;
  const next = ['failed', 'verification-pending'].includes(lock.phase)
    ? `The daemon verifies and releases it by itself once the approved generation is running and healthy. If that generation never went live, the update has to be abandoned: \`mandible auth handoff retire --binding-digest ${lock.bindingDigest ?? '<digest>'} --reason <text>\`.`
    : 'The daemon is waiting for that handoff to converge and be acknowledged.';
  return `Runtime handoff lock ${lock.file} is not acknowledged: ${state}. A Mandible self-update cannot go live while it is held. ${next}`;
}
