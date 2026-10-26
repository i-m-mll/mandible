// The one installation-wide runtime handoff lock. A handoff holds it from
// admission until acknowledgment; a failed handoff keeps holding it until
// verification-only recovery succeeds or an operator retires it.
import fs from 'node:fs';
import path from 'node:path';

export const runtimeHandoffLockFile = home => path.join(home, 'config', 'local-sessions', 'handoff-active.json');

/** Read the lock and its owning journal without validating or changing either. */
export function readRuntimeHandoffLock(home) {
  const file = runtimeHandoffLockFile(home);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return { file, journalPath: null, bindingDigest: null, requestId: null, executionId: null, phase: null, error: `Lock is unreadable: ${error.message}` };
  }
  let owner = null;
  try { owner = JSON.parse(raw); } catch { /* reported below */ }
  let journal = null;
  let journalError = null;
  if (typeof owner?.journal === 'string') {
    try { journal = JSON.parse(fs.readFileSync(owner.journal, 'utf8')); } catch (error) { journalError = `Owning journal is unreadable: ${error.message}`; }
  }
  return {
    file,
    journalPath: typeof owner?.journal === 'string' ? owner.journal : null,
    bindingDigest: typeof owner?.bindingDigest === 'string' ? owner.bindingDigest : null,
    requestId: journal?.binding?.requestId ?? null,
    executionId: journal?.binding?.executionId ?? null,
    phase: typeof journal?.phase === 'string' ? journal.phase : null,
    error: typeof journal?.error === 'string' ? journal.error : journalError ?? (owner ? null : 'Lock is not valid JSON'),
  };
}

/** The visible refusal for every action that needs the lock to be free. */
export function runtimeHandoffLockRefusal(lock) {
  const owner = lock.requestId ? `request ${lock.requestId.slice(0, 8)}` : 'an unknown request';
  const state = `${owner} is in phase ${lock.phase ?? 'unknown'}${lock.error ? ` (${lock.error})` : ''}`;
  const next = lock.phase === 'failed'
    ? `The daemon verifies and releases it by itself once the approved generation is running and healthy. If that generation never went live, the update has to be abandoned: \`mandible auth handoff retire --binding-digest ${lock.bindingDigest ?? '<digest>'} --reason <text>\`.`
    : 'The daemon is waiting for that handoff to converge and be acknowledged.';
  return `Runtime handoff lock ${lock.file} is not acknowledged: ${state}. A Mandible self-update cannot go live while it is held. ${next}`;
}
