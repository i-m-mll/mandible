import fs from 'node:fs';
import path from 'node:path';
import { acquireProcessLock } from './process-lock.mjs';
import { assertLifecycleLockHeld, retireLifecycleLock } from './lifecycle-lock.mjs';
import { ACCEPTED_RELEASE_RUN_SCHEMA, OWNED_RUN_SCHEMA, ownedRunReceipt, withOwnedRunLock } from './owned-run.mjs';
import { isVersionedReleaseStorage } from './accepted-release-storage.mjs';

const lstat = file => fs.lstatSync(file, { throwIfNoEntry: false });
const unavailableReasons = {
  occupied: 'Accepted release run ID already has custody or disposition.',
  completed: 'Accepted release cleanup is complete.',
  absent: 'Accepted release root is absent.',
};

function unavailable({ root, runId, mode }) {
  const entry = lstat(root);
  if (entry && !entry.isDirectory()) throw new Error('Accepted release root is not an owned directory.');
  if (entry && mode !== 'create') return null;

  const receipts = path.join(path.dirname(root), '.receipts');
  const directory = lstat(receipts);
  if (directory && !directory.isDirectory()) throw new Error('Accepted release receipt directory is not canonical.');
  const dispositionFile = lstat(path.join(receipts, `${runId}.json`));
  if (dispositionFile && !dispositionFile.isFile()) throw new Error('Accepted release disposition is not a regular file.');
  const outcome = dispositionFile ? ownedRunReceipt({ root, runId }) : null;
  if (outcome && (outcome.schema !== releaseRunSchema(path.dirname(root)) || !['accepted', 'assessed', 'failed', 'abandoned'].includes(outcome.outcome))) {
    throw new Error('Invalid accepted release disposition receipt.');
  }
  if (mode === 'create') {
    return entry || outcome || lstat(path.join(receipts, `${runId}-accepted-release.json`)) ? 'occupied' : null;
  }
  if (outcome?.cleanup === 'completed') {
    if (outcome.schema === ACCEPTED_RELEASE_RUN_SCHEMA && (!Array.isArray(outcome.remaining) || outcome.remaining.length
        || !Number.isSafeInteger(outcome.rootIdentity?.dev) || !Number.isSafeInteger(outcome.rootIdentity?.ino)
        || !/^[a-f0-9]{64}$/.test(outcome.manifestDigest))) throw new Error('Incomplete accepted release cleanup proof.');
    return 'completed';
  }
  if (mode === 'recover' && outcome?.cleanup === 'pending') return null;
  return 'absent';
}

export function acceptedReleaseHome(root) {
  const storage = path.dirname(root);
  return isVersionedReleaseStorage(storage) ? path.dirname(path.dirname(storage)) : path.dirname(storage);
}

export function releaseRunSchema(storage) {
  return isVersionedReleaseStorage(storage) ? ACCEPTED_RELEASE_RUN_SCHEMA : OWNED_RUN_SCHEMA;
}

function releaseLockTarget(root) {
  const runId = path.basename(root);
  if (!/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error('Invalid accepted release run ID.');
  const storage = fs.realpathSync(path.dirname(root));
  // The legacy lifecycle always generates .<name>.lock.process, even for a supplied path.
  const lock = isVersionedReleaseStorage(storage) ? path.join(storage, '.run-locks', runId) : undefined;
  return { root: path.join(storage, runId), storage, runId, lock };
}

const acquireNamespace = storage => acquireProcessLock(path.join(storage, '.release-lock-namespace'), { label: 'Accepted release namespace lock', waitMs: 2000 });

function assertLockDirectory(target) {
  if (!target.lock) return;
  const directory = lstat(path.dirname(target.lock));
  if (directory && !directory.isDirectory()) throw new Error('Accepted release lock directory is not canonical.');
}

async function retireTerminalRun(target) {
  assertLockDirectory(target);
  if (!target.lock || !lstat(`${target.lock}.process`) && !lstat(`${target.lock}.process.owner`)) return false;
  if (unavailable({ ...target, mode: 'existing' }) !== 'completed') return false;
  const namespace = await acquireNamespace(target.storage);
  try {
    const assertTerminal = () => {
      namespace.assertHeld();
      assertLifecycleLockHeld();
      assertLockDirectory(target);
      if (unavailable({ ...target, mode: 'existing' }) !== 'completed') throw new Error('Accepted release custody changed during lock retirement.');
    };
    assertTerminal();
    return await retireLifecycleLock(target.lock, assertTerminal);
  } finally { await namespace.release(); }
}

export async function retireAcceptedReleaseRunLock(root) {
  return retireTerminalRun(releaseLockTarget(root));
}

/** Take the permanent namespace guard before opening the per-run inode. */
export async function withAcceptedReleaseRunLock(root, operation, { mode = 'existing', recoverStale = false, onUnavailable } = {}) {
  const target = { ...releaseLockTarget(root), mode };
  const refuse = state => {
    if (onUnavailable) return onUnavailable(state, unavailableReasons[state]);
    throw new Error(unavailableReasons[state]);
  };
  const namespace = await acquireNamespace(target.storage);
  let ownsNamespace = true;
  try {
    namespace.assertHeld();
    assertLifecycleLockHeld();
    assertLockDirectory(target);
    const state = unavailable(target);
    if (state) return refuse(state);
    const result = await withOwnedRunLock(target.root, async (token, assertHeld) => {
      namespace.assertHeld();
      // An older caller may have released the child after the initial custody check.
      const state = unavailable(target);
      ownsNamespace = false;
      await namespace.release();
      assertHeld();
      return state ? refuse(state) : operation(token, assertHeld);
    }, { recoverStale, deadOwnerGraceMs: 0, lock: target.lock, reacquireLost: !target.lock });
    await retireTerminalRun(target);
    return result;
  } finally {
    if (ownsNamespace) await namespace.release();
  }
}
