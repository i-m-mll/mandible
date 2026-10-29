import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readAcceptedReleaseReceipt, acceptedReleaseFilesystemReferences, disposeAcceptedRelease } from './accepted-release.mjs';
import { ownedRunReceipt, recoverGeneratedReceipt, withOwnedRunLock, ownedRunIdentityMatches, inspectRunConsumers, saveOwnedMetadata, finalizeOwnedRun, cleanupOwnedRun } from './owned-run.mjs';
import { withInstallationGatewayLock } from './lifecycle-lock.mjs';
import { generatedOwnerIdle } from './generated-scratch.mjs';
import { runSupervisedCommand } from './process-group-supervisor.mjs';
import { fileURLToPath } from 'node:url';

function producerAuthority(producer) {
  const file = path.join(producer.scratchRoot, 'metadata.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).ownership
    : ownedRunReceipt({ root: producer.scratchRoot, runId: producer.runId })?.generatedRecovery;
}

function producerOwners(metadata) {
  return metadata.pendingAcceptance ? [
    { run: metadata.ownership, reason: 'acceptance producer lifetime live or uncertain' },
    { run: producerAuthority(metadata.pendingAcceptance), reason: 'acceptance consumers live or uncertain' },
  ] : [];
}

export function acceptedReleaseProducerReferences(metadata) {
  return producerOwners(metadata).filter(({ run }) => !run || !generatedOwnerIdle(run)).map(({ reason }) => reason);
}

export async function acceptedReleaseProducerReferencesAsync(metadata) {
  const input = { pendingAcceptance: metadata.pendingAcceptance, ownership: { processOwner: metadata.ownership.processOwner, processes: metadata.ownership.processes } };
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
    if (!ownedRunIdentityMatches(root, run) || !producer?.recordId || run.state === 'investigating') return { reasons: ['unknown pending custody or explicit investigation'] };
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
  return apply ? withInstallationGatewayLock(home, () => withOwnedRunLock(root, collect, { recoverStale: true })) : collect();
}

/** Historical actions/receipts are evidence; only current operational roots retain payloads. */
export function acceptedReleaseDatabaseReferences(db, reference, receipt) {
  const reasons = [];
  const selections = db.prepare(`SELECT r.id FROM auth_request_actions action JOIN auth_requests r ON r.id = action.auth_request_id
    WHERE action.kind = 'checkpoint_add' AND action.state = 'staged' AND json_extract(action.payload, '$.kind') = 'accepted-release'
    AND json_extract(action.payload, '$.payload.reference') = ? AND r.status IN ('pending', 'approved', 'executing', 'failed')`).all(reference);
  for (const selection of selections) reasons.push(`selected by live request ${selection.id}`);
  const running = db.prepare("SELECT id FROM auth_candidate_acceptances WHERE id = ? AND status = 'running'").get(receipt.acceptance.record_id);
  if (running) reasons.push('acceptance producer running');
  const rows = db.prepare(`SELECT a.*, r.status AS request_status, r.merge_candidate_pin_sha, r.merge_candidate_tree_sha,
    r.merge_preflight_base_sha, r.merge_head_sha, r.last_executed_at, r.merge_finalized_at
    FROM auth_candidate_acceptances a JOIN auth_requests r ON r.id = a.auth_request_id
    WHERE a.id = ? OR json_extract(a.result_json, '$.receipt') = ?`).all(receipt.acceptance.record_id, reference);
  for (const row of rows) {
    const current = row.pin_sha === row.merge_candidate_pin_sha && row.tree_sha === row.merge_candidate_tree_sha
      && row.base_sha === row.merge_preflight_base_sha && row.head_sha === row.merge_head_sha;
    const selected = db.prepare("SELECT id FROM auth_request_actions WHERE auth_request_id = ? AND kind = 'checkpoint_add' AND state = 'staged' AND json_extract(payload, '$.kind') = 'accepted-release' AND json_extract(payload, '$.payload.reference') = ? LIMIT 1").get(row.auth_request_id, reference);
    const latest = db.prepare('SELECT id FROM auth_candidate_acceptances WHERE auth_request_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1').get(row.auth_request_id);
    if (row.status === 'running' || current && (selected || latest?.id === row.id && row.status === 'passed') && ['pending', 'approved', 'executing', 'failed'].includes(row.request_status)) reasons.push(`current request ${row.auth_request_id}`);
    if (row.last_executed_at && !row.merge_finalized_at) reasons.push('unresolved publication');
    const hook = db.prepare("SELECT id FROM auth_hook_executions WHERE auth_request_id = ? AND required = 1 AND state NOT IN ('complete', 'retired') LIMIT 1").get(row.auth_request_id);
    if (hook) reasons.push('unresolved delivery hook');
  }
  return reasons;
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
export async function reconcileAcceptedReleases(db, home, { apply = false, limit = 8, until = Date.now() + 5000 } = {}) {
  const storage = path.join(home, 'accepted-releases');
  const directory = path.join(storage, '.receipts');
  if (!fs.existsSync(storage)) return [];
  const files = fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => name.endsWith('-accepted-release.json')).sort().map(name => ({ file: path.join(directory, name) })) : [];
  if (fs.existsSync(directory)) for (const name of fs.readdirSync(directory)) {
    if (name.endsWith('.json') && !name.endsWith('-accepted-release.json')) files.push({ recovery: path.join(directory, name) });
  }
  for (const entry of fs.readdirSync(storage, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || fs.existsSync(path.join(directory, `${entry.name}-accepted-release.json`))) continue;
    files.push({ root: path.join(storage, entry.name) });
  }
  const start = cursors.get(directory) ?? 0;
  const results = [];
  for (let index = 0; index < files.length && results.length < limit && Date.now() < until; index++) {
    const { file, root: pendingRoot, recovery } = files[(start + index) % files.length];
    cursors.set(directory, (start + index + 1) % files.length);
    try {
      if (recovery) {
        const outcome = JSON.parse(fs.readFileSync(recovery, 'utf8'));
        if (!outcome.generatedRecovery || outcome.cleanup === 'completed' && !fs.existsSync(outcome.root) || !generatedOwnerIdle(outcome.generatedRecovery)) continue;
        const recover = () => recoverGeneratedReceipt(recovery, { apply });
        results.push(apply ? await withOwnedRunLock(outcome.root, recover, { recoverStale: true }) : recover()); continue;
      }
      if (pendingRoot) {
        if (!fs.existsSync(path.join(pendingRoot, 'metadata.json'))) {
          const outcome = ownedRunReceipt({ root: pendingRoot, runId: path.basename(pendingRoot) });
          if (outcome?.generatedRecovery && generatedOwnerIdle(outcome.generatedRecovery)) {
            const recover = () => recoverGeneratedReceipt(outcome.receipt, { apply });
            results.push(apply ? await withOwnedRunLock(pendingRoot, recover, { recoverStale: true }) : recover()); continue;
          }
        }
        results.push(await reconcilePending(db, home, pendingRoot, apply)); continue;
      }
      const bytes = fs.readFileSync(file);
      const reference = `accepted-release:${createHash('sha256').update(bytes).digest('hex')}:${Buffer.from(file).toString('base64url')}`;
      const receipt = readAcceptedReleaseReceipt(reference);
      const root = receipt.package.handle.root;
      const outcome = ownedRunReceipt(receipt.package.handle);
      if (outcome?.generatedRecovery && (!fs.existsSync(root) || !fs.existsSync(path.join(root, 'metadata.json')))) {
        const reconcile = () => recoverGeneratedReceipt(outcome.receipt, { apply });
        results.push({ reference, ...(apply ? await withOwnedRunLock(root, reconcile, { recoverStale: true }) : reconcile()) }); continue;
      }
      if (!fs.existsSync(root)) { results.push({ reference, action: outcome ? 'disposed' : 'skip', reason: outcome ? `payload removed; cleanup ${outcome.cleanup}` : 'missing payload without cleanup evidence' }); continue; }
      const metadata = JSON.parse(fs.readFileSync(path.join(root, 'metadata.json'), 'utf8'));
      const run = metadata.ownership;
      const reasons = [...acceptedReleaseFilesystemReferences(home, reference), ...acceptedReleaseDatabaseReferences(db, reference, receipt)];
      if (run.state !== 'terminal') {
        if (!run.processOwner?.identity) reasons.push('legacy ownership requires explicit disposition');
        else if (!generatedOwnerIdle(run)) reasons.push('acceptance producer lifetime active');
        reasons.push(...acceptedReleaseProducerReferences(metadata));
      }
      if (run.state === 'investigating') reasons.push('explicit investigation');
      if (reasons.length) { results.push({ reference, action: 'retain', reasons }); continue; }
      if (!apply) { results.push({ reference, action: 'dispose', reason: 'no operational references' }); continue; }
      const claim = mark => claimAcceptedReleaseDisposal(db, reference, receipt, mark);
      results.push({ reference, ...await disposeAcceptedRelease(reference, receipt.candidate, 'Operational references released.', { home, claim }) });
    } catch (error) { results.push({ file, action: 'cleanup-pending', reason: String(error) }); }
  }
  return results;
}
