import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 1) throw new Error('Invalid owned process PID');
  const result = spawnSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8', timeout: 5000 });
  if (result.status === 1 && !result.stdout.trim()) return null;
  if (result.error || result.status !== 0) throw new Error(`Cannot inspect owned process: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}

export async function withLifecycleLock(root, operation) {
  const base = path.dirname(path.resolve(root));
  fs.mkdirSync(base, { recursive: true });
  const lock = path.join(base, `.${path.basename(root)}.lock`);
  try { fs.mkdirSync(lock); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Preview lifecycle is locked: ${lock}; recover only after verifying its owner identity`);
    throw error;
  }
  const owner = { pid: process.pid, identity: processIdentity(process.pid), token: randomUUID() };
  try {
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    return await operation(owner.token);
  } finally { fs.rmSync(lock, { recursive: true }); }
}

export function recoverLifecycleLock(root) {
  const lock = path.join(path.dirname(path.resolve(root)), `.${path.basename(root)}.lock`);
  const stat = fs.lstatSync(lock);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Lifecycle lock is not an owned directory');
  const owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
  if (!owner.identity || processIdentity(owner.pid) === owner.identity) throw new Error('Lifecycle lock owner is live or uncertain');
  const latest = fs.lstatSync(lock);
  if (latest.dev !== stat.dev || latest.ino !== stat.ino) throw new Error('Lifecycle lock changed during recovery');
  fs.unlinkSync(path.join(lock, 'owner.json'));
  fs.rmdirSync(lock);
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
    return operation(token);
  }
  return withLifecycleLock(root, operation);
}
