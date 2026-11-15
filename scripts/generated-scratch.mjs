import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { withOwnedRunLock, ownedRunIdentityMatches, finalizeOwnedRun, cleanupOwnedRun, inspectRunConsumers, processIdentity, saveOwnedMetadata, recoverOwnedRunDisposition } from './owned-run.mjs';

export function recordScratchProcess(metadataFile, child, group = false, pendingReleaseMetadata) {
  if (!child.pid) return;
  const record = { pid: child.pid, identity: processIdentity(child.pid), group };
  if (pendingReleaseMetadata) {
    const release = JSON.parse(fs.readFileSync(pendingReleaseMetadata, 'utf8'));
    if (release.pendingAcceptance) {
      release.pendingAcceptance.processes.push(record);
      saveOwnedMetadata(pendingReleaseMetadata, release);
    }
  }
  const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
  metadata.ownership.processes ??= [];
  metadata.ownership.processes.push(record);
  saveOwnedMetadata(metadataFile, metadata);
}

const cursors = new Map();
export const scratchCursors = () => Object.fromEntries(cursors);
export const restoreScratchCursors = state => { for (const [key, value] of Object.entries(state ?? {})) if (Number.isSafeInteger(value) && value >= 0) cursors.set(key, value); };

function processesIdle(records) {
  for (const record of records) {
    if (!Number.isSafeInteger(record.pid) || record.pid <= 1) return false;
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

export const generatedProcessLog = 'process-groups.jsonl';

export function recordScratchProcessGroup(file, child) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW);
  try { fs.writeSync(fd, `${JSON.stringify({ pid: child.pid, identity: processIdentity(child.pid), group: true })}\n`); }
  finally { fs.closeSync(fd); }
}

export function generatedChildrenIdle(run, root = run.root) {
  if (!Array.isArray(run.outputs)) return false;
  const groups = [];
  if (run.outputs.some(output => (typeof output === 'string' ? output : output.path) === generatedProcessLog)) {
    if (!path.isAbsolute(root ?? '')) return false;
    const file = path.join(root, generatedProcessLog);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat && !stat.isFile()) return false;
    if (stat) groups.push(...fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)));
  }
  return processesIdle([...(run.processes ?? []), ...groups]);
}

export function generatedOwnerIdle(run, root = run.root) {
  return Boolean(run.processOwner?.identity) && processesIdle([run.processOwner]) && generatedChildrenIdle(run, root);
}
const ownerIdle = generatedOwnerIdle;

/** Reclaim one exact generated run after its producer has exited. */
export async function reconcileGeneratedRun(root, { runId, apply = false, inspect = inspectRunConsumers } = {}) {
  const file = path.join(root, 'metadata.json');
  const reconcile = () => {
    if (!fs.existsSync(root)) return { root, action: 'absent' };
    if (!fs.lstatSync(root).isDirectory() || !fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) {
      return { root, action: 'skip', reason: 'unmarked entry' };
    }
    const run = JSON.parse(fs.readFileSync(file, 'utf8')).ownership;
    if ((runId && run?.runId !== runId) || !ownedRunIdentityMatches(root, run) || !run.disposable
        || !run.outputs.every(output => output.kind === 'generated') || run.state === 'investigating') {
      return { root, action: 'skip', reason: 'retained or unknown ownership' };
    }
    if (!ownerIdle(run)) return { root, action: 'skip', reason: 'live or uncertain process lifetime' };
    const consumers = inspect(root);
    if (!consumers.idle) return { root, action: 'skip', reason: consumers.reason };
    if (!apply) return { root, action: 'delete-owned', reason: 'dead disposable process owner' };
    if (run.state !== 'terminal') finalizeOwnedRun(file, { expectedRevision: run.revision, outcome: 'failed', summary: 'Interrupted generated run; owner lifetime ended before finalization.' }, { inspect });
    return { root, ...cleanupOwnedRun(file, { apply: true, inspect }) };
  };
  if (!fs.existsSync(root)) return { root, action: 'absent' };
  if (!fs.existsSync(file)) return { root, action: 'skip', reason: 'unmarked entry' };
  try { return apply ? await withOwnedRunLock(root, reconcile, { recoverStale: true }) : reconcile(); }
  catch (error) { return { root, action: 'skip', reason: String(error) }; }
}

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
        if (typeof receipt.root !== 'string' || path.dirname(receipt.root) !== fs.realpathSync(parent)) {
          results.push({ file: job.file, action: 'skip', reason: 'disposition root is outside generated scratch storage' });
          continue;
        }
        const exists = !!fs.lstatSync(receipt.root, { throwIfNoEntry: false });
        if (receipt.cleanup === 'completed' && !exists
            || exists && (!receipt.generatedRecovery || !ownerIdle(receipt.generatedRecovery, receipt.root))) continue;
        const reconcile = () => recoverOwnedRunDisposition(job.file, { apply, inspect });
        results.push(apply ? await withOwnedRunLock(receipt.root, reconcile, { recoverStale: true }) : reconcile());
      } catch (error) { results.push({ file: job.file, action: 'cleanup-pending', reason: String(error) }); }
      continue;
    }
    results.push(await reconcileGeneratedRun(job.root, { apply, inspect }));
  }
  return results;
}
