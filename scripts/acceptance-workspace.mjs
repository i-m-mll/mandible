import fs from 'node:fs';
import path from 'node:path';
import { generatedOwnerIdle, reconcileGeneratedRun } from './generated-scratch.mjs';
import { ownedRunIdentityMatches, recoverOwnedRunDisposition } from './owned-run.mjs';
import { acceptanceFailure } from './acceptance-failure.mjs';
import { acceptanceResultPath } from './acceptance-result.mjs';
import { ACCEPTED_RELEASE_DIRECTORY, VERSIONED_RELEASE_DIRECTORY } from './accepted-release-storage.mjs';
import { assertLifecycleLockHeld } from './lifecycle-lock.mjs';

export function acceptanceScratchPath(cache, recordId) {
  if (!/^[a-zA-Z0-9-]+$/.test(recordId)) throw new Error('Invalid candidate acceptance record ID.');
  return path.join(cache, `candidate-${recordId}`);
}

export function clearAcceptanceScratchRecords(cache, recordId, home) {
  const root = acceptanceScratchPath(cache, recordId);
  if (fs.lstatSync(root, { throwIfNoEntry: false })) throw new Error('Acceptance scratch remains.');
  const directory = path.join(cache, '.receipts');
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isDirectory() || fs.realpathSync(directory) !== directory) throw new Error('Acceptance cache receipt directory changed.');
  const disposition = path.join(directory, `${recordId}.json`);
  const storage = path.join(home, ACCEPTED_RELEASE_DIRECTORY);
  const pending = [storage, path.join(storage, VERSIONED_RELEASE_DIRECTORY)].some(location =>
    fs.lstatSync(path.join(location, recordId), { throwIfNoEntry: false })
    && !fs.lstatSync(path.join(location, '.receipts', `${recordId}-accepted-release.json`), { throwIfNoEntry: false }));
  const outcome = !pending && fs.lstatSync(disposition, { throwIfNoEntry: false });
  if (outcome) {
    if (!outcome.isFile() || outcome.nlink !== 1) throw new Error('Acceptance scratch outcome changed.');
    const receipt = JSON.parse(fs.readFileSync(disposition, 'utf8'));
    if (receipt.runId !== recordId || receipt.root !== root
        || recoverOwnedRunDisposition(disposition, { apply: true }).action !== 'disposed') {
      throw new Error('Acceptance scratch outcome does not record complete removal.');
    }
  }
  for (const file of [acceptanceResultPath(cache, recordId), ...(!pending ? [disposition] : [])]) {
    const entry = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!entry) continue;
    if (!entry.isFile() || entry.nlink !== 1) throw new Error('Acceptance cache receipt changed.');
    assertLifecycleLockHeld();
    fs.unlinkSync(file);
  }
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export async function reclaimAcceptanceScratch(cache, recordId, home) {
  try {
    const result = await reconcileGeneratedRun(acceptanceScratchPath(cache, recordId), { runId: recordId, apply: true });
    if (result.action !== 'absent' && (result.action !== 'delete-owned' || result.remaining?.length)) throw new Error(result.reason);
    clearAcceptanceScratchRecords(cache, recordId, home);
    return null;
  } catch (error) {
    if (error.code === 'PROCESS_LOCK_LOST') throw error;
    return `Could not remove acceptance scratch: ${error.message}`;
  }
}

export function requireIdleAcceptanceWorkspace(cache) {
  for (const entry of fs.readdirSync(cache, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('candidate-')) continue;
    const root = path.join(cache, entry.name);
    const file = path.join(root, 'metadata.json');
    if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) continue;
    const { ownership } = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (ownedRunIdentityMatches(root, ownership) && ownership.outputs.every(output => output.kind === 'generated') && !generatedOwnerIdle(ownership)) {
      throw acceptanceFailure('environment', 'The previous candidate acceptance has an active or uncertain producer lifetime. The checkout is waiting for its processes to settle');
    }
  }
}
