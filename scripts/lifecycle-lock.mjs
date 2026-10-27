import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { acquireProcessLock, ProcessLockBusyError, ProcessLockLostError } from './process-lock.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';

const ownershipScope = new AsyncLocalStorage();
export function assertLifecycleLockHeld() { ownershipScope.getStore()?.assertHeld(); }

export function processIdentity(pid) {
  assertLifecycleLockHeld();
  return readProcessIdentity(pid);
}
function readProcessIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 1) throw new Error('Invalid owned process PID');
  const result = spawnSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8', timeout: 5000 });
  if (result.status === 1 && !result.stdout.trim()) return null;
  if (result.error || result.status !== 0) throw new Error(`Cannot inspect owned process: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}

const lockPath = root => path.join(path.dirname(path.resolve(root)), `.${path.basename(root)}.lock`);
const busy = lock => new ProcessLockBusyError(`Preview lifecycle is locked: ${lock}; owner is live or uncertain`);

function inspectOwnership(lock) {
  let stat;
  try { stat = fs.lstatSync(lock); }
  catch (error) { if (error.code === 'ENOENT') return { state: 'free' }; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Lifecycle lock is not an owned directory');
  let owner; let bytes;
  try { bytes = fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'); owner = JSON.parse(bytes); }
  catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return { state: 'uncertain', stat };
    throw error;
  }
  if (!owner.identity || !Number.isInteger(owner.pid) || owner.pid <= 1) return { state: 'uncertain', stat };
  let current;
  try { current = processIdentity(owner.pid); }
  catch { return { state: 'uncertain', stat }; }
  return { state: current === owner.identity ? 'held' : 'stale', owner, bytes, stat };
}

function removeOwnership(lock, observation) {
  const current = fs.lstatSync(lock);
  if (current.dev !== observation.stat.dev || current.ino !== observation.stat.ino
      || fs.readFileSync(path.join(lock, 'owner.json'), 'utf8') !== observation.bytes) throw busy(lock);
  fs.unlinkSync(path.join(lock, 'owner.json'));
  fs.rmdirSync(lock);
}

async function acquireOwnershipGuard(root, waitMs = 0) {
  return acquireProcessLock(`${lockPath(root)}.process`, { label: 'Lifecycle ownership lock', waitMs });
}

export async function inspectLifecycleLock(root) {
  let guard;
  try { guard = await acquireOwnershipGuard(root); }
  catch (error) { if (error.code === 'PROCESS_LOCK_BUSY') return { state: 'held' }; throw error; }
  try { guard.assertHeld(); return inspectOwnership(lockPath(root)); }
  finally { await guard.release(); }
}

export async function withLifecycleLock(root, operation, { recoverStale = false } = {}) {
  const lock = lockPath(root);
  const guard = await acquireOwnershipGuard(root);
  let published;
  let temporary;
  try {
    guard.assertHeld();
    const prior = inspectOwnership(lock);
    if (prior.state === 'stale' && recoverStale) removeOwnership(lock, prior);
    else if (prior.state !== 'free') throw busy(lock);
    const owner = { pid: process.pid, identity: processIdentity(process.pid), token: randomUUID(),
      guardPid: guard.holderPid, guardIdentity: processIdentity(guard.holderPid) };
    if (!owner.identity || !owner.guardIdentity) throw busy(lock);
    temporary = fs.mkdtempSync(`${lock}.publish-`);
    fs.writeFileSync(path.join(temporary, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    guard.assertHeld();
    fs.renameSync(temporary, lock);
    temporary = null;
    published = { stat: fs.lstatSync(lock), bytes: JSON.stringify(owner) };
    return await ownershipScope.run({ assertHeld: guard.assertHeld }, () => operation(owner.token, guard.assertHeld));
  } finally {
    let lost;
    try {
      try { guard.assertHeld(); } catch (error) { lost = error; }
      if (lost && published) {
        const cleanup = await acquireOwnershipGuard(root, 5000);
        try { cleanup.assertHeld(); removeOwnership(lock, published); }
        finally { await cleanup.release(); }
      } else if (published) removeOwnership(lock, published);
      if (temporary) fs.rmSync(temporary, { recursive: true });
      if (lost) throw lost;
    } finally { try { await guard.release(); } catch (error) { if (!lost) throw error; } }
  }
}

export async function recoverLifecycleLock(root) {
  const guard = await acquireOwnershipGuard(root);
  try {
    guard.assertHeld();
    const lock = lockPath(root);
    const prior = inspectOwnership(lock);
    if (prior.state === 'free') return false;
    if (prior.state !== 'stale') throw busy(lock);
    removeOwnership(lock, prior);
    return true;
  } finally { await guard.release(); }
}

export async function withInstallationGatewayLock(home, operation) {
  const root = path.join(home, 'config', 'local-sessions', 'gateway');
  const token = process.env.MANDIBLE_GATEWAY_LOCK_TOKEN;
  if (token) {
    const lock = path.join(path.dirname(root), '.gateway.lock', 'owner.json');
    const owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
    let ancestor = process.pid;
    for (let depth = 0; ancestor !== owner.pid && ancestor > 1 && depth < 16; depth++) {
      const parent = spawnSync('/bin/ps', ['-p', String(ancestor), '-o', 'ppid='], { encoding: 'utf8', timeout: 5000 });
      if (parent.error || parent.status !== 0) throw new Error('Gateway lock delegation ancestry cannot be inspected');
      ancestor = Number(parent.stdout.trim());
    }
    if (owner.token !== token || ancestor !== owner.pid || processIdentity(owner.pid) !== owner.identity) throw new Error('Gateway lock delegation does not match its live owner');
    const assertHeld = () => {
      const current = JSON.parse(fs.readFileSync(lock, 'utf8'));
      if (current.token !== token || !owner.guardPid || !owner.guardIdentity
          || readProcessIdentity(owner.guardPid) !== owner.guardIdentity || readProcessIdentity(owner.pid) !== owner.identity) {
        throw new ProcessLockLostError('Delegated gateway ownership was lost; stopping effects.');
      }
    };
    assertHeld();
    const result = await ownershipScope.run({ assertHeld }, () => operation(token, assertHeld));
    assertHeld();
    return result;
  }
  return withLifecycleLock(root, operation);
}
