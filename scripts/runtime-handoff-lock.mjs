// The one installation-wide runtime handoff lock. `handoff-active.json` names
// the journal of the latest admitted handoff, and the lock is held exactly while
// that journal still holds mutation authority: no fence closed it, and it was
// neither acknowledged nor retired. A finished handoff therefore releases the
// lock through its own journal; removing the file afterwards is only tidying.
// A failed handoff stays unfenced, so it keeps the lock until verification-only
// recovery succeeds or an operator retires it.
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

/** Whether a journal no longer holds mutation authority over the installation. */
export const runtimeHandoffSettled = journal =>
  Boolean(journal?.attempt?.fence || journal?.mutationFence) || ['acknowledged', 'retired'].includes(journal?.phase);

function lockState(journal, verification, error) {
  if (error) return 'unreadable';
  if (journal.phase === 'failed' || journal.attempt?.state === 'failed') return 'failed';
  if (verification || journal.phase === 'verification-pending') return 'verifying';
  return 'installing';
}

/** Read the held lock and its owning journal without changing either; null when no handoff holds it. */
export function readRuntimeHandoffLock(home) {
  home = path.resolve(home);
  const file = runtimeHandoffLockFile(home);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return { file, journalPath: null, bindingDigest: null, requestId: null, executionId: null, phase: null, state: 'unreadable', error: `Lock is unreadable: ${error.message}` };
  }
  let owner = null;
  try { owner = JSON.parse(raw); } catch { /* reported below */ }
  let journal = null;
  let journalBytes;
  let journalError = null;
  if (typeof owner?.journal === 'string') {
    try { journalBytes = fs.readFileSync(owner.journal, 'utf8'); journal = JSON.parse(journalBytes); } catch (error) { journalError = `Owning journal is unreadable: ${error.message}`; }
  }
  const owned = journal && typeof owner?.bindingDigest === 'string' && journal.bindingDigest === owner.bindingDigest
    && runtimeHandoffBindingDigest(journal.binding) === owner.bindingDigest;
  if (owned && runtimeHandoffSettled(journal)) return null;
  let verification = null;
  try {
    if (owner && journal && fs.readFileSync(file, 'utf8') === raw) verification = pendingVerification(home, owner, journal, journalBytes);
  } catch { /* Unproven pending evidence cannot become a user instruction. */ }
  const error = !owner ? 'Lock is not valid JSON' : journalError ?? (owned ? null : 'Lock and its journal name different handoffs');
  return {
    file,
    journalPath: typeof owner?.journal === 'string' ? owner.journal : null,
    bindingDigest: typeof owner?.bindingDigest === 'string' ? owner.bindingDigest : null,
    requestId: journal?.binding?.requestId ?? null,
    executionId: journal?.binding?.executionId ?? null,
    phase: typeof journal?.phase === 'string' ? journal.phase : null,
    state: lockState(journal, verification, error),
    lastObservation: journal?.lastObservation ?? null,
    ...(verification ? { verification } : {}),
    error: error ?? (typeof journal?.error === 'string' ? journal.error : journal?.attempt?.lastObservation?.reason ?? null),
  };
}

/** The visible refusal for every action that needs the lock to be free. */
export function runtimeHandoffLockRefusal(lock) {
  const request = lock.requestId ? `auth request ${lock.requestId.slice(0, 8)}` : 'an earlier auth request';
  const recover = lock.requestId ? `\`mandible auth handoff recover ${lock.requestId.slice(0, 8)}\`` : '`mandible auth handoff recover <request>`';
  const retire = `\`mandible auth handoff retire --binding-digest ${lock.bindingDigest ?? '<digest>'} --reason <text>\``;
  const detail = text => (text ? `: ${String(text).trim().replace(/[.\s]*$/, '')}.` : '.');
  switch (lock.state) {
    case 'unreadable':
      return `Mandible cannot tell which self-update is in progress${detail(lock.error)} Until it can, no self-update can go live. This is a Mandible fault, not a problem with this request. Run \`mandible auth handoff status\` and report what it shows; the lock is ${lock.file}.`;
    case 'failed':
      return `The self-update from ${request} failed while going live${detail(lock.error)} Mandible keeps that update in place so it can be recovered, and no other self-update can go live until it is resolved. If the new version is running anyway, Mandible notices by itself; ${recover} makes it check now. If that version never went live, abandon it with ${retire}.`;
    case 'verifying':
      return `The self-update from ${request} is installed, but Mandible has not yet confirmed that the new version is running correctly${detail(lock.verification?.reason ?? lock.lastObservation?.reason)} No other self-update can go live until it does. Mandible keeps checking by itself, so this usually clears without you; ${recover} makes it check now. If that version never went live, abandon it with ${retire}.`;
    default:
      return `Mandible is still installing the self-update from ${request}, and only one self-update can go live at a time. This is expected and usually takes a minute or two: wait for it to finish, then try again. \`mandible auth handoff status\` shows its progress.`;
  }
}
