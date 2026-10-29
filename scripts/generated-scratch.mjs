import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { withOwnedRunLock, ownedRunIdentityMatches, finalizeOwnedRun, cleanupOwnedRun, inspectRunConsumers, processIdentity, saveOwnedMetadata, recoverGeneratedReceipt } from './owned-run.mjs';

export function recordScratchProcess(metadataFile, child, group = false) {
  if (!child.pid) return;
  const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
  metadata.ownership.processes ??= [];
  metadata.ownership.processes.push({ pid: child.pid, identity: processIdentity(child.pid), group });
  saveOwnedMetadata(metadataFile, metadata);
}

const cursors = new Map();
export const scratchCursors = () => Object.fromEntries(cursors);
export const restoreScratchCursors = state => { for (const [key, value] of Object.entries(state ?? {})) if (Number.isSafeInteger(value) && value >= 0) cursors.set(key, value); };

export function generatedOwnerIdle(run) {
  if (!run.processOwner?.identity) return false;
  for (const record of [run.processOwner, ...(run.processes ?? [])]) {
    const observed = processIdentity(record.pid);
    if (observed !== null && (!record.identity || observed === record.identity)) return false;
    if (record.group) {
      const result = spawnSync('/bin/ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8', timeout: 1000 });
      if (result.error || result.status !== 0) return false;
      if (result.stdout.split('\n').some(line => { const [pgid, state] = line.trim().split(/\s+/); return Number(pgid) === record.pid && !state?.startsWith('Z'); })) return false;
    }
  }
  return true;
}
const ownerIdle = generatedOwnerIdle;

/** Only explicitly disposable generated runs with a proven dead lifetime can be recovered. */
export async function reconcileGeneratedScratch(parent, { apply = false, limit = 8, until = Date.now() + 5000, inspect = inspectRunConsumers } = {}) {
  if (!fs.existsSync(parent)) return [];
  const results = [];
  const entries = fs.readdirSync(parent, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.name.startsWith('.'));
  const receipts = path.join(parent, '.receipts');
  const recoveryFiles = fs.existsSync(receipts) ? fs.readdirSync(receipts).filter(name => name.endsWith('.json')).map(name => path.join(receipts, name)) : [];
  const jobs = [...entries.map(entry => ({ root: path.join(parent, entry.name) })), ...recoveryFiles.map(file => ({ file }))];
  const start = cursors.get(parent) ?? 0;
  for (let index = 0; index < jobs.length; index++) {
    if (results.length >= limit || Date.now() >= until) break;
    const job = jobs[(start + index) % jobs.length];
    cursors.set(parent, (start + index + 1) % jobs.length);
    if (job.file) {
      try {
        const receipt = JSON.parse(fs.readFileSync(job.file, 'utf8'));
        if (!receipt.generatedRecovery || !ownerIdle(receipt.generatedRecovery) || receipt.cleanup === 'completed' && !fs.existsSync(receipt.root)) continue;
        const reconcile = () => recoverGeneratedReceipt(job.file, { apply, inspect });
        results.push(apply ? await withOwnedRunLock(receipt.root, reconcile, { recoverStale: true }) : reconcile());
      } catch (error) { results.push({ file: job.file, action: 'cleanup-pending', reason: String(error) }); }
      continue;
    }
    const root = job.root;
    const file = path.join(root, 'metadata.json');
    if (!fs.existsSync(file)) { results.push({ root, action: 'skip', reason: 'unmarked entry' }); continue; }
    const reconcile = () => {
      const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
      const run = metadata.ownership;
      if (!ownedRunIdentityMatches(root, run) || !run.disposable || !run.outputs.every(output => output.kind === 'generated')
          || run.state === 'investigating') return { root, action: 'skip', reason: 'retained or unknown ownership' };
      if (!ownerIdle(run)) return { root, action: 'skip', reason: 'live or uncertain process lifetime' };
      const consumers = inspect(root);
      if (!consumers.idle) return { root, action: 'skip', reason: consumers.reason };
      if (!apply) return { root, action: 'delete-owned', reason: 'dead disposable process owner' };
      if (run.state !== 'terminal') finalizeOwnedRun(file, { expectedRevision: run.revision, outcome: 'failed', summary: 'Interrupted generated run; owner lifetime ended before finalization.' }, { inspect });
      return { root, ...cleanupOwnedRun(file, { apply: true, inspect }) };
    };
    try { results.push(apply ? await withOwnedRunLock(root, reconcile, { recoverStale: true }) : reconcile()); }
    catch (error) { results.push({ root, action: 'skip', reason: String(error) }); }
  }
  return results;
}
