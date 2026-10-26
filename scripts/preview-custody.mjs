import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { withOwnedRunLock, validateOwnedRunFinalization, ownedRunIdentityMatches, saveOwnedMetadata, ownedRunReceipt, processIdentity } from './owned-run.mjs';

export async function withPreviewRun(handle, operation) {
  if (!handle?.root || !handle.runId) throw new Error('Exact preview run handle required');
  return withOwnedRunLock(handle.root, async () => {
    const file = path.join(handle.root, 'metadata.json');
    const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!ownedRunIdentityMatches(handle.root, metadata.ownership) || metadata.ownership.runId !== handle.runId
      || (handle.revision !== undefined && metadata.ownership.revision !== handle.revision)) throw new Error('Preview run identity or revision changed');
    const save = () => { metadata.ownership.revision++; saveOwnedMetadata(file, metadata); };
    return operation(metadata, save);
  });
}

export function acquirePreviewConsumer(handle, child) {
  return withPreviewRun(handle, (metadata, save) => {
    const run = metadata.ownership;
    if (run.state !== 'active' || run.lifecycle?.teardown || run.lifecycle?.phase !== 'ready') throw new Error('Preview is not accepting consumers');
    if (child.expectedGeneration !== metadata.instanceEnv.MANDIBLE_BACKEND_GENERATION
      || JSON.stringify(child.expectedSource) !== JSON.stringify(run.source)) throw new Error('Preview generation changed before native acquisition');
    if (!child.runId || child.consumerId !== child.runId || path.resolve(child.metadataFile) !== path.join(path.resolve(child.root), 'metadata.json')) throw new Error('Native consumer requires its exact owned run ID and receipt path');
    run.consumers ??= [];
    if (!child.newInstance && run.consumers.some(entry => entry.state !== 'released')) throw new Error('Preview already has a native consumer; reuse it or request a new instance');
    const childStat = fs.lstatSync(child.root);
    if (!childStat.isDirectory() || childStat.isSymbolicLink() || !child.rootIdentity
      || childStat.dev !== child.rootIdentity.dev || childStat.ino !== child.rootIdentity.ino) throw new Error('Native consumer root identity changed');
    const receipt = JSON.parse(fs.readFileSync(child.metadataFile, 'utf8'));
    if (!child.attemptId || receipt.attemptId !== child.attemptId || receipt.ownership?.runId !== child.runId) throw new Error('Native consumer acquisition attempt changed');
    const previous = run.consumers.find(entry => entry.consumerId === child.consumerId);
    if (previous) throw new Error('Native consumer already acquired');
    const association = { ...child, parent: { root: run.root, runId: run.runId }, state: 'pending',
      generation: metadata.instanceEnv.MANDIBLE_BACKEND_GENERATION, source: run.source };
    run.consumers.push(association);
    save();
    return association;
  });
}

export function publishPreviewConsumer(reservation, identity) {
  return withPreviewRun(reservation.parent, (metadata, save) => {
    const run = metadata.ownership;
    const consumer = run.consumers?.find(entry => entry.consumerId === reservation.consumerId);
    if (!consumer || consumer.state !== 'pending' || run.lifecycle?.teardown
      || consumer.generation !== metadata.instanceEnv.MANDIBLE_BACKEND_GENERATION
      || JSON.stringify(consumer.source) !== JSON.stringify(run.source)) throw new Error('Preview consumer reservation or generation changed');
    const child = JSON.parse(fs.readFileSync(consumer.metadataFile, 'utf8'));
    if (child.ownership?.runId !== consumer.runId || !ownedRunIdentityMatches(consumer.root, child.ownership)
      || child.parent?.runId !== run.runId || path.resolve(child.parent?.root ?? '') !== run.root) throw new Error('Native child receipt does not belong to reserved preview run');
    if (consumer.attemptId !== reservation.attemptId || child.attemptId !== reservation.attemptId) throw new Error('Native publish attempt changed');
    if (JSON.stringify(identity.build) !== JSON.stringify(child.build)
      || JSON.stringify(child.build) !== JSON.stringify(run.source)) throw new Error('Native child build differs from selected source identity');
    consumer.state = 'attached'; consumer.identity = identity;
    consumer.rootIdentity = child.ownership.rootIdentity;
    save();
    return consumer;
  });
}

export function verifyPreviewConsumerStopped(consumer) {
  const child = JSON.parse(fs.readFileSync(consumer.metadataFile, 'utf8'));
  if (child.ownership?.runId !== consumer.runId || !ownedRunIdentityMatches(consumer.root, child.ownership)
    || child.ownership.rootIdentity.dev !== consumer.rootIdentity.dev || child.ownership.rootIdentity.ino !== consumer.rootIdentity.ino) throw new Error('Native consumer root identity changed');
  if (child.pid && processIdentity(child.pid) !== null) throw new Error('Native consumer still has a live process');
  if (child.buildProcess?.pid && processIdentity(child.buildProcess.pid) !== null) throw new Error('Native consumer still has a live build process');
  if (child.status !== 'stopped') {
    if (!['visible', 'loading', 'failed', 'launched', 'launching'].includes(child.status)) throw new Error('Native consumer must be reconciled stopped before backend refresh or reacquisition');
    child.status = 'stopped'; child.stoppedAt = new Date().toISOString(); child.ownership.revision++;
    saveOwnedMetadata(consumer.metadataFile, child);
  }
  return child;
}

export function reacquirePreviewConsumer(handle, child) {
  return withPreviewRun(handle, (metadata, save) => withOwnedRunLock(child.root, () => {
    const run = metadata.ownership;
    const previous = run.consumers?.find(entry => entry.consumerId === child.consumerId);
    if (!previous || previous.state === 'released' || previous.runId !== child.runId || previous.root !== child.root
      || previous.metadataFile !== child.metadataFile || previous.generation !== child.expectedPriorGeneration
      || JSON.stringify(previous.source) !== JSON.stringify(child.expectedPriorSource)
      || previous.attemptId !== child.expectedPriorAttemptId) throw new Error('Native reacquisition association changed');
    const receipt = verifyPreviewConsumerStopped(previous);
    if (!child.attemptId || receipt.attemptId !== child.expectedPriorAttemptId) throw new Error('Native reacquisition attempt changed');
    if (run.state !== 'active' || run.lifecycle.teardown || run.lifecycle.phase !== 'ready'
      || child.expectedGeneration !== metadata.instanceEnv.MANDIBLE_BACKEND_GENERATION
      || JSON.stringify(child.expectedSource) !== JSON.stringify(run.source)) throw new Error('Parent preview changed before native reacquisition');
    previous.state = 'pending'; previous.generation = child.expectedGeneration; previous.source = child.expectedSource;
    previous.attemptId = child.attemptId;
    receipt.attemptId = child.attemptId; receipt.status = 'preparing'; receipt.ownership.revision++;
    saveOwnedMetadata(child.metadataFile, receipt);
    save();
    return previous;
  }));
}

export function releasePreviewConsumer(reservation) {
  const retainedParent = ownedRunReceipt(reservation.parent);
  if (retainedParent?.cleanup === 'completed') {
    const released = retainedParent.consumers?.find(entry => entry.consumerId === reservation.consumerId);
    if (released?.state === 'released') return Promise.resolve(released);
    return Promise.reject(new Error('Retired preview receipt does not prove released native consumer'));
  }
  if (!fs.existsSync(path.join(reservation.parent.root, 'metadata.json'))) {
    const parent = ownedRunReceipt(reservation.parent);
    const consumer = parent?.consumers?.find(entry => entry.consumerId === reservation.consumerId);
    if (consumer?.state === 'released') return Promise.resolve(consumer);
    return Promise.reject(new Error('Parent preview receipt does not prove released native consumer'));
  }
  return withPreviewRun(reservation.parent, (metadata, save) => {
    const consumer = metadata.ownership.consumers?.find(entry => entry.consumerId === reservation.consumerId);
    if (!consumer) throw new Error('Native consumer reservation missing');
    if (consumer.attemptId !== reservation.attemptId) throw new Error('Native release attempt changed');
    if (consumer.state === 'released') return consumer;
    const receipt = ownedRunReceipt({ root: consumer.root, runId: consumer.runId });
    if (!receipt || receipt.cleanup !== 'completed') throw new Error('Native child cleanup is not completed');
    consumer.state = 'released'; consumer.receipt = receipt.receipt;
    save();
    return consumer;
  });
}

export function previewBaseDir(override = null) {
  const selected = override ?? process.env.MANDIBLE_PREVIEW_BASE_DIR ?? path.join(os.homedir(), '.cache', 'mandible', 'previews');
  return path.resolve(selected.replace(/^~(?=$|\/)/, os.homedir()));
}

export function previewPaths(branch) {
  const slug = branch.trim().replace(/^refs\/heads\//, '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
  const root = path.join(previewBaseDir(), slug);
  return { root, metadata: path.join(root, 'metadata.json') };
}

export function withPreviewLifecycle(branch, operation) {
  return withOwnedRunLock(previewPaths(branch).root, operation);
}

function canonical(candidate) {
  try { return fs.realpathSync(candidate); } catch { return path.resolve(candidate); }
}

export async function previewWorktreeCustodyReason(branch, worktree) {
  const { root, metadata: file } = previewPaths(branch);
  if (!fs.existsSync(file)) return null;
  let metadata;
  try { metadata = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return 'preview custody metadata is unreadable'; }
  if (metadata.branch !== branch || !metadata.worktree
      || (worktree && canonical(metadata.worktree) !== canonical(worktree))) return null;
  const owner = metadata.ownership;
  if (owner?.consumers?.some(consumer => consumer.state !== 'released')) return 'preview has attached or pending native/build consumers';
  if (owner?.lifecycle && owner.lifecycle.phase !== 'retired') return 'preview runtime or gateway retirement is pending';
  let finalization;
  try { finalization = validateOwnedRunFinalization(root, owner); }
  catch { return 'preview finalization receipt cannot be verified'; }
  if (!finalization.ok) return finalization.reason;
  if (!owner.outputs.every(output => output.disposition === 'disposable')) return 'preview has unresolved owned outputs';
  for (const file of new Set([metadata.pidFile, path.join(root, 'mandible.pid')].filter(Boolean))) {
    let pid;
    try { pid = Number(fs.readFileSync(file, 'utf8').trim()); } catch { continue; }
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try { process.kill(pid, 0); return 'preview still has a live recorded process'; }
    catch (error) { if (error.code !== 'ESRCH') return 'preview process ownership cannot be verified'; }
  }
  if (Number.isInteger(metadata.port) && await new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port: metadata.port });
    socket.setTimeout(500);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('timeout', () => { socket.destroy(); resolve(true); });
    socket.on('error', error => resolve(error.code !== 'ECONNREFUSED'));
  })) return 'preview still has a port consumer';
  return null;
}
