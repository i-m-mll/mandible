import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readImmutableAcceptedRelease, acceptedReleaseDisposition, acceptedReleaseFilesystemReferences, disposeAcceptedRelease } from './accepted-release.mjs';
import { ownedRunReceipt, recoverOwnedRunDisposition, ownedRunIdentityMatches, inspectRunConsumers, saveOwnedMetadata, finalizeOwnedRun, cleanupOwnedRun } from './owned-run.mjs';
import { withInstallationGatewayLock } from './lifecycle-lock.mjs';
import { acceptedReleaseHome, retireAcceptedReleaseRunLock, withAcceptedReleaseRunLock } from './accepted-release-lock.mjs';
import { ACCEPTED_RELEASE_DIRECTORY, VERSIONED_RELEASE_DIRECTORY } from './accepted-release-storage.mjs';
import { generatedOwnerIdle } from './generated-scratch.mjs';
import { runSupervisedCommand } from './process-group-supervisor.mjs';
import { fileURLToPath } from 'node:url';
import { authRequestCanRepeatExecution, authRequestHasRetryableStatus } from '../src/auth-retry.ts';
import { findRuntimeDeliveryIntents, runtimePublicationSelectsRelease } from '../src/runtime-handoff-proof.ts';
import { MANDIBLE_REBUILD_HOOK_ID } from '../src/runtime-build-scope.ts';
import { readRuntimeHandoffRetirement } from './runtime-handoff-lock.mjs';

function producerAuthority(producer) {
  const file = path.join(producer.scratchRoot, 'metadata.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')).ownership;
  const recovery = ownedRunReceipt({ root: producer.scratchRoot, runId: producer.runId })?.generatedRecovery;
  return recovery && { ...recovery, root: producer.scratchRoot };
}

function producerOwners(metadata) {
  const { ownership, pendingAcceptance } = metadata;
  const owners = [];
  if (pendingAcceptance || ownership?.processOwner || ownership?.processes?.length) {
    owners.push({ run: ownership, reason: 'acceptance producer lifetime live or uncertain' });
  }
  // A seal is published only after acceptance's child processes have settled.
  // A missing scratch root supplies no additional consumer to observe.
  if (pendingAcceptance) {
    const root = pendingAcceptance.scratchRoot;
    if (!path.isAbsolute(root ?? '')) throw new Error('Acceptance scratch locator is invalid.');
    const entry = fs.lstatSync(root, { throwIfNoEntry: false });
    if (entry) owners.push({ run: entry.isDirectory() ? producerAuthority(pendingAcceptance) : null,
      reason: 'acceptance consumers live or uncertain' });
  }
  return owners;
}

export function acceptedReleaseProducerReferences(metadata) {
  return producerOwners(metadata).filter(({ run }) => !run || !generatedOwnerIdle(run)).map(({ reason }) => reason);
}

export async function acceptedReleaseProducerReferencesAsync(metadata) {
  const { root, processOwner, processes, outputs } = metadata.ownership;
  const input = { pendingAcceptance: metadata.pendingAcceptance, ownership: { root, processOwner, processes,
    outputs: outputs?.map(output => output.path) } };
  const { stdout, stdoutTruncated } = await runSupervisedCommand(process.execPath, ['--no-install',
    fileURLToPath(new URL('./generated-owner-observation.mjs', import.meta.url)), JSON.stringify(input)], { capture: true, timeout: 5000, graceMs: 100 });
  if (stdoutTruncated) throw new Error('Producer lifetime observation truncated');
  const reasons = JSON.parse(stdout).references;
  if (!Array.isArray(reasons) || reasons.some(reason => typeof reason !== 'string')) throw new Error('Invalid producer reference observation');
  return reasons;
}

async function reconcilePending(db, home, root, apply) {
  const file = path.join(root, 'metadata.json');
  const inspect = () => {
    const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
    const run = metadata.ownership;
    const producer = metadata.pendingAcceptance;
    if (!ownedRunIdentityMatches(root, run) || !producer?.recordId) return { reasons: ['unknown pending custody'] };
    if (!generatedOwnerIdle(run)) return { reasons: ['pending producer live or uncertain'] };
    const scratch = producerAuthority(producer);
    if (!scratch || !generatedOwnerIdle(scratch)) return { reasons: ['producer consumers live or uncertain'] };
    const sealed = path.join(path.dirname(root), '.receipts', `${run.runId}-accepted-release.json`);
    if (fs.existsSync(sealed)) return { reasons: ['sealed package belongs to accepted reconciliation'] };
    const row = db.prepare('SELECT status, auth_request_id FROM auth_candidate_acceptances WHERE id = ?').get(producer.recordId);
    if (!row || row.auth_request_id !== producer.requestId || row.status !== 'failed') return { reasons: ['acceptance outcome unresolved'] };
    const consumers = inspectRunConsumers(root);
    if (!consumers.idle) return { reasons: [consumers.reason] };
    return { metadata, run, producer, sealed, scratch };
  };
  const collect = () => {
    const state = inspect();
    if (state.reasons) return { root, action: 'retain', reasons: state.reasons };
    if (!apply) return { root, action: 'dispose', reason: 'failed pending acceptance; producer and consumers stopped' };
    const { metadata, run, producer, sealed, scratch } = state;
    db.transaction(() => {
      const row = db.prepare('SELECT status FROM auth_candidate_acceptances WHERE id = ?').get(producer.recordId);
      if (row?.status !== 'failed' || fs.existsSync(sealed)) throw new Error('Pending acceptance authority changed.');
      if (run.state !== 'terminal') {
        run.processes = scratch.processes;
        run.disposable = true; run.outputs = run.outputs.map(output => ({ ...output, kind: 'generated' }));
        saveOwnedMetadata(file, metadata);
        finalizeOwnedRun(file, { expectedRevision: run.revision, outcome: 'failed', summary: 'Interrupted pending package; failed acceptance producer and consumers stopped.' });
      }
    }).immediate();
    return { root, ...cleanupOwnedRun(file, { apply: true }) };
  };
  return apply ? withInstallationGatewayLock(home, () => withAcceptedReleaseRunLock(root, collect, { recoverStale: true })) : collect();
}

/** Historical actions and results are evidence. Only the exact usable selection retains a sealed payload. */
export function acceptedReleaseDatabaseReferences(db, reference, receipt) {
  const { record_id: recordId, request_id: requestId } = receipt.acceptance;
  const row = db.prepare("SELECT * FROM auth_candidate_acceptances WHERE id = ? OR json_extract(result_json, '$.receipt') = ?").get(recordId ?? null, reference);
  if (!row || (recordId && row.id !== recordId) || (requestId && row.auth_request_id !== requestId)) return [];
  if (row.status === 'running') return ['acceptance producer running'];
  if (row.status !== 'passed' || JSON.parse(row.result_json ?? 'null')?.receipt !== reference
      || Object.entries(receipt.candidate).some(([field, value]) => row[field] !== value)) return [];

  const request = db.prepare('SELECT * FROM auth_requests WHERE id = ?').get(row.auth_request_id);
  if (!request || row.pin_sha !== request.merge_candidate_pin_sha || row.tree_sha !== request.merge_candidate_tree_sha
      || row.base_sha !== request.merge_preflight_base_sha || row.head_sha !== request.merge_head_sha
      || request.custody_work_unit_id && request.custody_work_unit_id !== receipt.retention.work_unit) return [];
  const actions = db.prepare(`SELECT state, payload FROM auth_request_actions WHERE auth_request_id = ?
    AND kind = 'checkpoint_add' AND json_extract(payload, '$.kind') = 'accepted-release'`).all(request.id);
  if (actions.length !== 1) return [];
  const action = actions[0];
  const selection = JSON.parse(action.payload).payload;
  if (selection?.reference !== reference || selection.acceptanceId !== row.id) return [];

  if (action.state === 'staged' && ['pending', 'approved', 'executing'].includes(request.status)) {
    return [`selected by live request ${request.id}`];
  }

  const retryRequest = action.state === 'staged' && authRequestHasRetryableStatus(request);
  const retryDelivery = request.status === 'completed' && request.exit_code === 0 && ['staged', 'applied'].includes(action.state);
  if (!retryRequest && !retryDelivery) return [];

  const hook = db.prepare('SELECT * FROM auth_hook_executions WHERE auth_request_id = ? AND hook_id = ?').get(request.id, MANDIBLE_REBUILD_HOOK_ID);
  const identity = hook && { requestId: request.id, executionId: hook.id, hookId: hook.hook_id, commandDigest: hook.command_digest };
  const admitted = !!identity && findRuntimeDeliveryIntents(db, [identity]).size > 0;
  if (retryRequest) {
    return authRequestCanRepeatExecution(request, admitted) ? [`selected by live request ${request.id}`] : [];
  }

  if (!hook || !['pending', 'running', 'failed'].includes(hook.state) || admitted) return [];
  const home = acceptedReleaseHome(receipt.package.handle.root);
  const journal = path.join(home, 'config/local-sessions/handoff', `${request.id}-${hook.id}`, 'journal.json');
  const retired = readRuntimeHandoffRetirement(journal);
  if (retired && retired.binding.requestId === request.id && retired.binding.executionId === hook.id
      && retired.binding.hookId === hook.hook_id && retired.binding.commandDigest === hook.command_digest) return [];
  return runtimePublicationSelectsRelease(db, identity, selection) ? [`selected by retryable delivery ${hook.id}`] : [];
}

const cursors = new Map();
export function claimAcceptedReleaseDisposal(db, reference, receipt, mark) {
  return db.transaction(() => {
    const live = acceptedReleaseDatabaseReferences(db, reference, receipt);
    if (live.length) throw new Error(`Reference acquired before disposal claim: ${live.join(', ')}`);
    mark();
  }).immediate();
}
export const releaseCursors = () => Object.fromEntries(cursors);
export const restoreReleaseCursors = state => { for (const [key, value] of Object.entries(state ?? {})) if (Number.isSafeInteger(value) && value >= 0) cursors.set(key, value); };

function releaseEntries(storage) {
  const directory = path.join(storage, '.receipts');
  const files = fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => name.endsWith('-accepted-release.json')).sort().map(name => ({ file: path.join(directory, name) })) : [];
  if (fs.existsSync(directory)) for (const name of fs.readdirSync(directory)) {
    const runId = name.endsWith('.json') ? name.slice(0, -5) : '';
    if (/^[a-zA-Z0-9-]+$/.test(runId) && !name.endsWith('-accepted-release.json')
        && !fs.lstatSync(path.join(directory, `${runId}-accepted-release.json`), { throwIfNoEntry: false })) {
      files.push({ recovery: path.join(storage, runId) });
    }
  }
  for (const entry of fs.readdirSync(storage, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || fs.existsSync(path.join(directory, `${entry.name}-accepted-release.json`))) continue;
    if (!fs.lstatSync(path.join(directory, `${entry.name}.json`), { throwIfNoEntry: false })) files.push({ root: path.join(storage, entry.name) });
  }
  return files.map(entry => ({ ...entry, storage }));
}

export async function reconcileAcceptedReleases(db, home, { apply = false, limit = 8, until = Date.now() + 5000 } = {}) {
  const location = path.join(home, ACCEPTED_RELEASE_DIRECTORY);
  if (!fs.existsSync(location)) return [];
  const storage = fs.realpathSync(location);
  const versioned = path.join(storage, VERSIONED_RELEASE_DIRECTORY);
  const versionedEntry = fs.lstatSync(versioned, { throwIfNoEntry: false });
  if (versionedEntry && !versionedEntry.isDirectory()) throw new Error('Versioned accepted release storage is not canonical.');
  const files = [...releaseEntries(storage), ...(versionedEntry ? releaseEntries(versioned) : [])];
  const directory = path.join(storage, '.receipts');
  const start = cursors.get(directory) ?? 0;
  const results = [];
  for (let index = 0; index < files.length && results.length < limit && Date.now() < until; index++) {
    const { file, root: pendingRoot, recovery, storage: entryStorage } = files[(start + index) % files.length];
    cursors.set(directory, (start + index + 1) % files.length);
    try {
      if (recovery) {
        const runId = path.basename(recovery);
        const hasRoot = () => !!fs.lstatSync(recovery, { throwIfNoEntry: false });
        const outcome = ownedRunReceipt({ root: recovery, runId });
        if (!outcome) continue;
        if (outcome.cleanup === 'completed' && !hasRoot()) {
          if (apply && await retireAcceptedReleaseRunLock(recovery)) results.push({ root: recovery, action: 'retired-lock' });
          continue;
        }
        const recover = () => {
          if (fs.lstatSync(path.join(entryStorage, '.receipts', `${runId}-accepted-release.json`), { throwIfNoEntry: false })) {
            return { root: recovery, action: 'retain', reasons: ['sealed package belongs to accepted reconciliation'] };
          }
          if (hasRoot() && outcome.generatedRecovery?.processOwner && !generatedOwnerIdle(outcome.generatedRecovery, recovery)) {
            return { root: recovery, action: 'retain', reasons: ['acceptance producer lifetime live or uncertain'] };
          }
          return { root: recovery, ...recoverOwnedRunDisposition(outcome.receipt, { apply }) };
        };
        results.push(apply ? await withInstallationGatewayLock(home, () => withAcceptedReleaseRunLock(recovery, recover, {
          mode: 'recover', recoverStale: true, onUnavailable: (state, reason) => ({
            root: recovery, action: state === 'completed' ? 'disposed' : 'skip', reason,
          }),
        })) : recover());
        continue;
      }
      if (pendingRoot) {
        results.push(await reconcilePending(db, home, pendingRoot, apply)); continue;
      }
      const bytes = fs.readFileSync(file);
      const reference = `accepted-release:${createHash('sha256').update(bytes).digest('hex')}:${Buffer.from(file).toString('base64url')}`;
      const receipt = readImmutableAcceptedRelease(reference);
      const root = receipt.package.handle.root;
      const outcome = acceptedReleaseDisposition(receipt);
      const hasRoot = !!fs.lstatSync(root, { throwIfNoEntry: false });
      if (!hasRoot && outcome?.cleanup === 'completed') {
        if (apply) await retireAcceptedReleaseRunLock(root);
        results.push({ reference, action: 'disposed', reason: 'payload removed; cleanup completed' });
        continue;
      }
      if (!hasRoot && !outcome) { results.push({ reference, action: 'skip', reason: 'missing payload without cleanup evidence' }); continue; }
      if (outcome) {
        const reasons = [...acceptedReleaseFilesystemReferences(home, reference), ...acceptedReleaseDatabaseReferences(db, reference, receipt)];
        if (reasons.length) { results.push({ reference, action: 'retain', reasons }); continue; }
        const claim = mark => claimAcceptedReleaseDisposal(db, reference, receipt, mark);
        const result = apply ? await disposeAcceptedRelease(reference, receipt.candidate, 'Resume recorded disposition.', { home, claim })
          : recoverOwnedRunDisposition(outcome.receipt);
        results.push({ reference, ...result });
        continue;
      }
      const metadata = JSON.parse(fs.readFileSync(path.join(root, 'metadata.json'), 'utf8'));
      const run = metadata.ownership;
      const reasons = [...acceptedReleaseFilesystemReferences(home, reference), ...acceptedReleaseDatabaseReferences(db, reference, receipt)];
      if (run.state !== 'terminal') reasons.push(...acceptedReleaseProducerReferences(metadata));
      if (reasons.length) { results.push({ reference, action: 'retain', reasons }); continue; }
      if (!apply) { results.push({ reference, action: 'dispose', reason: 'no operational references' }); continue; }
      const claim = mark => claimAcceptedReleaseDisposal(db, reference, receipt, mark);
      results.push({ reference, ...await disposeAcceptedRelease(reference, receipt.candidate, 'Operational references released.', { home, claim }) });
    } catch (error) { results.push({ file, action: 'cleanup-pending', reason: String(error) }); }
  }
  return results;
}
