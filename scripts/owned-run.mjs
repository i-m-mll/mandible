import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { withLifecycleLock, processIdentity, assertLifecycleLockHeld } from './lifecycle-lock.mjs';
export { processIdentity, recoverLifecycleLock } from './lifecycle-lock.mjs';

export const OWNED_RUN_SCHEMA = 'mandible-owned-run@1';

export function processLifetimeMatches(record, observed) {
  const recorded = record.birth ?? record.processIdentity ?? record.identity;
  if (typeof recorded !== 'string' || recorded.length < 24) return null;
  return record.birth ? observed.slice(0, 24) === record.birth : observed === recorded;
}

/** A stopped record can outlive its PID; missing lifetime evidence remains busy. */
export function processReleaseBlocked(record, stopped = false) {
  if (!record?.pid) return false;
  const observed = processIdentity(record.pid);
  return observed !== null && !(stopped && processLifetimeMatches(record, observed) === false);
}

export async function withOwnedRunLock(root, operation) {
  return withLifecycleLock(root, operation);
}

export function createOwnedRun({ root, instanceId, project, workUnit, outputs, disposable = false, runId = randomUUID() }) {
  if (!project || !workUnit || !instanceId) throw new Error('Owned run requires canonical project, work-unit and instance identities');
  if (!/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error('Invalid owned run ID');
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Owned run root must be a canonical directory');
  for (const output of outputs) contained(root, output.path);
  const paths = outputs.map(output => output.path);
  if (new Set(paths).size !== paths.length || paths.some(a => paths.some(b => a !== b && a.startsWith(`${b}${path.sep}`)))) throw new Error('Owned outputs must not overlap');
  return {
    schema: OWNED_RUN_SCHEMA, runId, revision: 1,
    root: fs.realpathSync(root), rootIdentity: { dev: stat.dev, ino: stat.ino },
    instanceId, project, workUnit, state: 'creating', disposable,
    outputs: outputs.map(output => ({ ...output, disposition: 'pending' })),
    cleanup: { state: 'pending', remaining: [] },
  };
}

export function saveOwnedMetadata(file, metadata) {
  assertLifecycleLockHeld();
  const temp = `${file}.partial-${process.pid}`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(metadata, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  const directoryFd = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
}

function readOwnedMetadata(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Owner metadata must be an exact regular file: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function receiptDirectory(root) {
  const directory = path.join(path.dirname(root), '.receipts');
  fs.mkdirSync(directory, { recursive: true });
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Compact receipt directory is a symlink');
  return directory;
}

export function inspectRunConsumers(root) {
  const result = spawnSync('lsof', ['-F', 'n', '+D', root], { encoding: 'utf8', timeout: 5_000 });
  if (result.error || ![0, 1].includes(result.status) || result.stderr.trim()) {
    return { idle: false, reason: `open-file inspection failed: ${result.error?.message ?? result.stderr ?? result.status}` };
  }
  return result.stdout.trim()
    ? { idle: false, reason: `owned files have active consumers: ${result.stdout.trim().slice(0, 2000)}` }
    : { idle: true };
}

function contained(root, relative, allowLeafLink = false) {
  if (!relative || path.isAbsolute(relative) || relative.split(path.sep).some(part => part === '..' || part === '.')) throw new Error(`Invalid owned path: ${relative}`);
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error(`Owned path escapes root: ${relative}`);
  let ancestor = root;
  for (const part of relative.split(path.sep)) {
    ancestor = path.join(ancestor, part);
    if (fs.existsSync(ancestor) && fs.lstatSync(ancestor).isSymbolicLink() && !(allowLeafLink && ancestor === resolved)) throw new Error(`Owned path is a symlink: ${ancestor}`);
  }
  return resolved;
}

export function ownedRunIdentityMatches(root, run) {
  if (!run) return false;
  const stat = fs.lstatSync(root);
  return run.schema === OWNED_RUN_SCHEMA && run.root === fs.realpathSync(root)
    && !stat.isSymbolicLink() && fs.realpathSync(root) === run.root
    && stat.dev === run.rootIdentity?.dev && stat.ino === run.rootIdentity?.ino;
}

const identityMatches = ownedRunIdentityMatches;

export function ownedRunHandle(metadata) {
  return { root: metadata.ownership.root, runId: metadata.ownership.runId };
}

export function ownedRunReceipt(handle) {
  if (!handle?.runId || !/^[a-zA-Z0-9-]+$/.test(handle.runId)) throw new Error('Exact owned run handle required');
  const file = path.join(path.dirname(path.resolve(handle.root)), '.receipts', `${handle.runId}.json`);
  if (!fs.existsSync(file)) return null;
  const receipt = readOwnedMetadata(file);
  if (receipt.runId !== handle.runId || receipt.root !== path.resolve(handle.root)) throw new Error('Compact receipt identity changed');
  return { ...receipt, receipt: file };
}

function inventory(root, relative, hashBytes = true) {
  const target = contained(root, relative, true);
  let stat;
  try { stat = fs.lstatSync(target); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (stat.isSymbolicLink()) return [{ path: relative, kind: 'symlink', link: fs.readlinkSync(target), dev: stat.dev, ino: stat.ino }];
  if (stat.isDirectory()) return [
    ...fs.readdirSync(target).flatMap(child => inventory(root, path.join(relative, child), hashBytes)),
    { path: relative, kind: 'directory', dev: stat.dev, ino: stat.ino },
  ];
  if (!stat.isFile()) throw new Error(`Unclassified owned entry: ${target}`);
  return [{ path: relative, kind: 'file', size: stat.size, dev: stat.dev, ino: stat.ino,
    ...(hashBytes ? { sha256: createHash('sha256').update(fs.readFileSync(target)).digest('hex') } : {}) }];
}

function outputDigest(outputs) {
  return createHash('sha256').update(JSON.stringify(outputs)).digest('hex');
}

export function validateOwnedRunFinalization(root, run) {
  if (!run || !identityMatches(root, run)) return { ok: false, reason: 'missing or invalid ownership; manual inspection required' };
  if (run.state !== 'terminal' || !run.receipt || !fs.existsSync(run.receipt)
      || (run.outcome === 'accepted' && !run.converged)) return { ok: false, reason: 'cleanup blocked: unresolved preview material' };
  if (path.resolve(run.receipt) !== path.join(path.dirname(path.resolve(root)), '.receipts', `${run.runId}.json`)) {
    return { ok: false, reason: 'compact outcome path is outside owner receipts' };
  }
  const receipt = readOwnedMetadata(run.receipt);
  if (receipt.runId !== run.runId || receipt.outcome !== run.outcome || receipt.manifestDigest !== outputDigest(run.outputs)) {
    return { ok: false, reason: 'compact outcome does not match owner' };
  }
  return { ok: true, receipt };
}

function verifyTransfer(root, manifest, destination) {
  if (!destination || fs.realpathSync(destination) === fs.realpathSync(root) || fs.realpathSync(destination).startsWith(`${fs.realpathSync(root)}${path.sep}`)) throw new Error('Transfer destination must be outside the cleanup root');
  for (const file of manifest.filter(file => file.kind !== 'directory')) {
    const target = contained(path.resolve(destination), file.path, file.kind === 'symlink');
    if (file.kind === 'symlink') {
      if (!fs.lstatSync(target).isSymbolicLink() || fs.readlinkSync(target) !== file.link) throw new Error(`Transferred link not verified: ${file.path}`);
    } else if (!fs.existsSync(target) || createHash('sha256').update(fs.readFileSync(target)).digest('hex') !== file.sha256) throw new Error(`Transferred bytes not verified: ${file.path}`);
  }
}

export function finalizeOwnedRun(metadataFile, { expectedRevision, outcome, converged = false, disposition, destination, summary, reviewBy, transferReference }, { inspect = inspectRunConsumers } = {}) {
  const metadata = readOwnedMetadata(metadataFile);
  const run = metadata.ownership;
  const root = path.dirname(metadataFile);
  if (!run || !identityMatches(root, run) || run.revision !== expectedRevision) throw new Error('Owned run identity or revision changed');
  if (outcome === 'investigating') {
    const deadline = Date.parse(reviewBy);
    if (!summary?.trim() || !Number.isFinite(deadline) || deadline <= Date.now() || deadline > Date.now() + 7 * 86400000 || run.state === 'terminal') throw new Error('Investigation requires a named need and review within seven days before acceptance');
    run.state = 'investigating';
    run.investigation = { owner: run.workUnit, reviewBy: deadline, summary };
    run.revision += 1;
    saveOwnedMetadata(metadataFile, metadata);
    return metadata;
  }
  if (!['accepted', 'assessed', 'failed', 'abandoned'].includes(outcome) || !summary?.trim()) throw new Error('Finalization requires a terminal outcome and compact summary');
  if (outcome === 'accepted' && !converged) throw new Error('Accepted cleanup requires completed convergence');
  if (run.state === 'terminal' && run.outputs.every(output => output.disposition === 'disposable')) throw new Error('Run already finalized; retry cleanup instead');
  const disposableGenerated = run.disposable && run.outputs.every(output => output.kind === 'generated');
  if (!disposableGenerated) {
    const consumers = inspect(root);
    if (!consumers.idle) throw new Error(consumers.reason);
  }
  const outputs = run.outputs.map(output => {
    const manifest = disposableGenerated ? [] : inventory(root, output.path, output.kind === 'interactive');
    if (output.kind === 'interactive' && manifest.length) {
      if (disposition === 'transferred') {
        if (!transferReference?.trim()) throw new Error('Transfer requires the established accepted output reference');
        verifyTransfer(root, manifest, destination);
      } else if (disposition !== 'discard' && !run.disposable) {
        throw new Error('cleanup blocked: unresolved preview material; transfer exact bytes or explicitly discard');
      }
    }
    return { ...output, disposition: 'disposable', manifest };
  });
  const receiptDir = receiptDirectory(root);
  const receipt = path.join(receiptDir, `${run.runId}.json`);
  const result = { schema: OWNED_RUN_SCHEMA, runId: run.runId, instanceId: run.instanceId,
    root: run.root, rootIdentity: run.rootIdentity, branch: metadata.branch, worktree: metadata.worktree,
    lifecycle: run.lifecycle, consumers: run.consumers, acquisition: run.acquisition, source: run.source,
    project: run.project, workUnit: run.workUnit, outcome, converged, disposition: disposition ?? 'disposable-fixture',
    destination: destination ? path.resolve(destination) : null, transferReference: transferReference ?? null, summary, finalizedAt: new Date().toISOString(),
    cleanup: 'pending', manifestDigest: outputDigest(outputs), apparentBytes: outputs.flatMap(output => output.manifest).reduce((total, file) => total + (file.size ?? 0), 0) };
  saveOwnedMetadata(receipt, result);
  metadata.ownership = { ...run, revision: run.revision + 1, state: 'terminal', outcome, converged, outputs, receipt,
    cleanup: { state: 'pending', remaining: outputs.flatMap(output => output.manifest.map(file => file.path)) } };
  saveOwnedMetadata(metadataFile, metadata);
  return metadata;
}

export function cleanupOwnedRun(metadataFile, { apply = false, inspect = inspectRunConsumers } = {}) {
  const root = path.dirname(metadataFile);
  let metadata = readOwnedMetadata(metadataFile);
  let run = metadata.ownership;
  const blocked = reason => ({ action: 'skip', reason, bytes: 0, reclaimedBytes: 0 });
  if (!run || !identityMatches(root, run)) return blocked('missing or invalid ownership; manual inspection required');
  if (run.state === 'investigating') {
    if (run.investigation.reviewBy > Date.now()) return blocked(`investigation owned by ${run.investigation.owner}; review by ${new Date(run.investigation.reviewBy).toISOString()}`);
    if (!apply) return blocked(`investigation expired for ${run.workUnit}; generated intermediates eligible, interactive material preserved`);
    const consumers = inspect(root);
    if (!consumers.idle) return blocked(consumers.reason);
    const receiptDir = receiptDirectory(root);
    run.receipt = path.join(receiptDir, `${run.runId}.json`);
    run.outputs = run.outputs.map(output => output.kind === 'generated'
      ? { ...output, disposition: 'disposable', manifest: inventory(root, output.path, false) } : output);
    saveOwnedMetadata(run.receipt, { schema: OWNED_RUN_SCHEMA, runId: run.runId, project: run.project, workUnit: run.workUnit, outcome: 'failed', summary: `Investigation review expired: ${run.investigation.summary}`, cleanup: 'pending', manifestDigest: outputDigest(run.outputs) });
    run.state = 'terminal'; run.outcome = 'failed'; run.revision += 1;
    saveOwnedMetadata(metadataFile, metadata);
  }
  const finalization = validateOwnedRunFinalization(root, run);
  if (!finalization.ok) return blocked(finalization.reason);
  const { receipt } = finalization;
  const consumers = inspect(root);
  if (!consumers.idle) return blocked(consumers.reason);
  if (run.disposable && run.outputs.every(output => output.kind === 'generated' && output.disposition === 'disposable')) {
    if (!apply) return { action: 'delete-owned', reason: 'terminal disposable generated run may be removed', bytes: null, reclaimedBytes: null };
    if (!identityMatches(root, run) || readOwnedMetadata(metadataFile).ownership.revision !== run.revision) return blocked('owned root or metadata revision changed');
    fs.rmSync(root, { recursive: true });
    saveOwnedMetadata(run.receipt, { ...receipt, cleanup: 'completed', remaining: [], physicalRecovery: 'not measured' });
    return { action: 'delete-owned', reason: 'terminal disposable generated run removed', bytes: null, reclaimedBytes: null, remaining: [], receipt: run.receipt };
  }
  if (receipt.disposition === 'transferred') {
    for (const output of run.outputs.filter(output => output.kind === 'interactive')) verifyTransfer(root, output.manifest, receipt.destination);
  }
  const files = run.outputs.flatMap(output => {
    if (output.disposition === 'pending' && output.kind === 'interactive') return [];
    if (output.disposition !== 'disposable' || !Array.isArray(output.manifest)) throw new Error('Output disposition is not proven');
    return output.manifest;
  });
  let bytes = 0;
  const remaining = [];
  for (const file of files) {
    const target = contained(root, file.path, file.kind === 'symlink');
    let stat;
    try { stat = fs.lstatSync(target); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.dev !== file.dev || stat.ino !== file.ino
      || (file.kind === 'symlink' && (!stat.isSymbolicLink() || fs.readlinkSync(target) !== file.link))
      || (file.kind === 'file' && (!stat.isFile() || stat.size !== file.size || (file.sha256 && createHash('sha256').update(fs.readFileSync(target)).digest('hex') !== file.sha256)))) {
      return blocked(`owned bytes changed after disposition: ${file.path}`);
    }
    remaining.push(file);
    bytes += file.size ?? 0;
  }
  if (!apply) return { action: 'delete-owned', reason: 'terminal bytes have verified disposition and saved outcome', bytes, reclaimedBytes: 0 };
  if (readOwnedMetadata(metadataFile).ownership.revision !== run.revision) return blocked('metadata revision changed');
  let reclaimedBytes = 0;
  try {
    for (const file of remaining) {
      const target = contained(root, file.path, file.kind === 'symlink');
      if (file.kind === 'directory') {
        if (fs.readdirSync(target).length === 0) fs.rmdirSync(target);
      } else { fs.unlinkSync(target); reclaimedBytes += file.size ?? 0; }
    }
    const extras = fs.readdirSync(root).filter(name => name !== path.basename(metadataFile));
    run.cleanup = { state: extras.length ? 'pending' : 'completed', remaining: extras };
    run.revision += 1;
    saveOwnedMetadata(metadataFile, metadata);
    saveOwnedMetadata(run.receipt, { ...receipt, cleanup: run.cleanup.state, remaining: extras, unlinkedApparentBytes: reclaimedBytes, physicalRecovery: 'not measured' });
    if (!extras.length) { fs.unlinkSync(metadataFile); fs.rmdirSync(root); }
    return { action: 'delete-owned', reason: extras.length ? 'unknown entries preserved; owner action required' : 'owned intermediates removed; compact receipt retained', bytes, reclaimedBytes, remaining: extras, receipt: run.receipt };
  } catch (error) {
    run.cleanup = { state: 'pending', reason: String(error), remaining: files.filter(file => fs.existsSync(path.join(root, file.path))).map(file => file.path) };
    run.revision += 1;
    saveOwnedMetadata(metadataFile, metadata);
    return { action: 'cleanup-pending', reason: String(error), bytes, reclaimedBytes, remaining: run.cleanup.remaining };
  }
}
