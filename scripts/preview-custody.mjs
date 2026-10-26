import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { withOwnedRunLock, validateOwnedRunFinalization } from './owned-run.mjs';

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
