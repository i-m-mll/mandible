import fs from 'node:fs';
import path from 'node:path';
import { generatedOwnerIdle, reconcileGeneratedRun } from './generated-scratch.mjs';
import { ownedRunIdentityMatches } from './owned-run.mjs';
import { acceptanceFailure } from './acceptance-failure.mjs';

export function acceptanceScratchPath(cache, recordId) {
  if (!/^[a-zA-Z0-9-]+$/.test(recordId)) throw new Error('Invalid candidate acceptance record ID.');
  return path.join(cache, `candidate-${recordId}`);
}

export async function reclaimAcceptanceScratch(cache, recordId) {
  const result = await reconcileGeneratedRun(acceptanceScratchPath(cache, recordId), { runId: recordId, apply: true });
  if (result.action === 'absent' || (result.action === 'delete-owned' && !result.remaining?.length)) return null;
  return `Could not remove acceptance scratch: ${result.reason}`;
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
