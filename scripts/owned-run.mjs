import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const OWNED_RUN_SCHEMA = 'mandible-owned-run@1';

export async function withOwnedRunLock(root, operation) {
  const base = path.dirname(path.resolve(root));
  fs.mkdirSync(base, { recursive: true });
  const lock = path.join(base, `.${path.basename(root)}.lock`);
  try { fs.mkdirSync(lock); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Preview lifecycle is locked: ${lock}; inspect its owner before recovery`);
    throw error;
  }
  try {
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    return await operation();
  } finally { fs.rmSync(lock, { recursive: true }); }
}

export function createOwnedRun({ root, instanceId, project, workUnit, outputs, disposable = false }) {
  if (!project || !workUnit || !instanceId) throw new Error('Owned run requires canonical project, work-unit and instance identities');
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Owned run root must be a canonical directory');
  for (const output of outputs) contained(root, output.path);
  return {
    schema: OWNED_RUN_SCHEMA, runId: randomUUID(), revision: 1,
    root: fs.realpathSync(root), rootIdentity: { dev: stat.dev, ino: stat.ino },
    instanceId, project, workUnit, state: 'creating', disposable,
    outputs: outputs.map(output => ({ ...output, disposition: 'pending' })),
    cleanup: { state: 'pending', remaining: [] },
  };
}

export function saveOwnedMetadata(file, metadata) {
  const temp = `${file}.partial-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function inspectRunConsumers(root) {
  const result = spawnSync('lsof', ['-F', 'n', '+D', root], { encoding: 'utf8' });
  if (result.error || ![0, 1].includes(result.status) || result.stderr.trim()) {
    return { idle: false, reason: `open-file inspection failed: ${result.error?.message ?? result.stderr ?? result.status}` };
  }
  return result.stdout.trim()
    ? { idle: false, reason: 'owned files have active consumers' }
    : { idle: true };
}

function contained(root, relative) {
  if (!relative || path.isAbsolute(relative) || relative.split(path.sep).some(part => part === '..' || part === '.')) throw new Error(`Invalid owned path: ${relative}`);
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error(`Owned path escapes root: ${relative}`);
  let ancestor = root;
  for (const part of relative.split(path.sep)) {
    ancestor = path.join(ancestor, part);
    if (fs.existsSync(ancestor) && fs.lstatSync(ancestor).isSymbolicLink()) throw new Error(`Owned path is a symlink: ${ancestor}`);
  }
  return resolved;
}

function identityMatches(root, run) {
  const stat = fs.lstatSync(root);
  return run.schema === OWNED_RUN_SCHEMA && run.root === fs.realpathSync(root)
    && !stat.isSymbolicLink() && fs.realpathSync(root) === run.root
    && stat.dev === run.rootIdentity?.dev && stat.ino === run.rootIdentity?.ino;
}

function inventory(root, relative, hashBytes = true) {
  const target = contained(root, relative);
  if (!fs.existsSync(target)) return [];
  const stat = fs.lstatSync(target);
  if (stat.isDirectory()) return [
    ...fs.readdirSync(target).flatMap(child => inventory(root, path.join(relative, child), hashBytes)),
    { path: relative, kind: 'directory', dev: stat.dev, ino: stat.ino },
  ];
  if (!stat.isFile()) throw new Error(`Unclassified owned entry: ${target}`);
  return [{ path: relative, kind: 'file', size: stat.size, dev: stat.dev, ino: stat.ino,
    ...(hashBytes ? { sha256: createHash('sha256').update(fs.readFileSync(target)).digest('hex') } : {}) }];
}

export function finalizeOwnedRun(metadataFile, { expectedRevision, outcome, converged = false, disposition, destination, summary }, { inspect = inspectRunConsumers } = {}) {
  const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
  const run = metadata.ownership;
  const root = path.dirname(metadataFile);
  if (!run || !identityMatches(root, run) || run.revision !== expectedRevision) throw new Error('Owned run identity or revision changed');
  if (!['accepted', 'assessed', 'failed', 'abandoned'].includes(outcome) || !summary?.trim()) throw new Error('Finalization requires a terminal outcome and compact summary');
  if (outcome === 'accepted' && !converged) throw new Error('Accepted cleanup requires completed convergence');
  if (run.state === 'terminal') throw new Error('Run already finalized; retry cleanup instead');
  const consumers = inspect(root);
  if (!consumers.idle) throw new Error(consumers.reason);
  const outputs = run.outputs.map(output => {
    const manifest = inventory(root, output.path, output.kind === 'interactive');
    if (output.kind === 'interactive' && manifest.length) {
      if (disposition === 'transferred') {
        if (!destination || path.resolve(destination).startsWith(`${root}${path.sep}`) || path.resolve(destination) === root) throw new Error('Transfer destination must be outside the cleanup root');
        for (const file of manifest.filter(file => file.kind === 'file')) {
          const target = contained(path.resolve(destination), file.path);
          if (!fs.existsSync(target) || (file.sha256 && createHash('sha256').update(fs.readFileSync(target)).digest('hex') !== file.sha256)) throw new Error(`Transferred bytes not verified: ${file.path}`);
        }
      } else if (disposition !== 'discard' && !run.disposable) {
        throw new Error('cleanup blocked: unresolved preview material; transfer exact bytes or explicitly discard');
      }
    }
    return { ...output, disposition: 'disposable', manifest };
  });
  const receiptDir = path.join(path.dirname(root), '.receipts');
  fs.mkdirSync(receiptDir, { recursive: true });
  const receipt = path.join(receiptDir, `${run.runId}.json`);
  const result = { schema: OWNED_RUN_SCHEMA, runId: run.runId, instanceId: run.instanceId,
    project: run.project, workUnit: run.workUnit, outcome, converged, disposition: disposition ?? 'disposable-fixture',
    destination: destination ? path.resolve(destination) : null, summary, finalizedAt: new Date().toISOString(),
    cleanup: 'pending', apparentBytes: outputs.flatMap(output => output.manifest).reduce((total, file) => total + (file.size ?? 0), 0) };
  saveOwnedMetadata(receipt, result);
  metadata.ownership = { ...run, revision: run.revision + 1, state: 'terminal', outcome, converged, outputs, receipt,
    cleanup: { state: 'pending', remaining: outputs.flatMap(output => output.manifest.map(file => file.path)) } };
  saveOwnedMetadata(metadataFile, metadata);
  return metadata;
}

export function cleanupOwnedRun(metadataFile, { apply = false, inspect = inspectRunConsumers } = {}) {
  const root = path.dirname(metadataFile);
  const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
  const run = metadata.ownership;
  const blocked = reason => ({ action: 'skip', reason, bytes: 0, reclaimedBytes: 0 });
  if (!run || !identityMatches(root, run)) return blocked('missing or invalid ownership; manual inspection required');
  if (run.state !== 'terminal' || !run.receipt || !fs.existsSync(run.receipt)
      || (run.outcome === 'accepted' && !run.converged)) return blocked('cleanup blocked: unresolved preview material');
  const receipt = JSON.parse(fs.readFileSync(run.receipt, 'utf8'));
  if (receipt.runId !== run.runId || receipt.outcome !== run.outcome) return blocked('compact outcome does not match owner');
  const consumers = inspect(root);
  if (!consumers.idle) return blocked(consumers.reason);
  const files = run.outputs.flatMap(output => {
    if (output.disposition !== 'disposable' || !Array.isArray(output.manifest)) throw new Error('Output disposition is not proven');
    return output.manifest;
  });
  let bytes = 0;
  const remaining = [];
  for (const file of files) {
    const target = contained(root, file.path);
    if (!fs.existsSync(target)) continue;
    const stat = fs.lstatSync(target);
    if (stat.dev !== file.dev || stat.ino !== file.ino
      || (file.kind === 'file' && (!stat.isFile() || stat.size !== file.size || (file.sha256 && createHash('sha256').update(fs.readFileSync(target)).digest('hex') !== file.sha256)))) {
      return blocked(`owned bytes changed after disposition: ${file.path}`);
    }
    remaining.push(file);
    bytes += file.size ?? 0;
  }
  if (!apply) return { action: 'delete-owned', reason: 'terminal bytes have verified disposition and saved outcome', bytes, reclaimedBytes: 0 };
  if (JSON.parse(fs.readFileSync(metadataFile, 'utf8')).ownership.revision !== run.revision) return blocked('metadata revision changed');
  let reclaimedBytes = 0;
  try {
    for (const file of remaining) {
      const target = contained(root, file.path);
      if (file.kind === 'directory') {
        if (fs.readdirSync(target).length === 0) fs.rmdirSync(target);
      } else { fs.unlinkSync(target); reclaimedBytes += file.size; }
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
