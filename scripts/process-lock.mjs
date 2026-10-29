import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export class ProcessLockBusyError extends Error {
  constructor(message) { super(message); this.code = 'PROCESS_LOCK_BUSY'; }
}
export class ProcessLockLostError extends Error {
  constructor(message) { super(message); this.code = 'PROCESS_LOCK_LOST'; }
}

function ownerDead(file) {
  let pid;
  try { pid = Number(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

async function startLockHolder(lockFile, label) {
  const source = "printf 'LOCKED\\n'; while IFS= read -r line; do :; done";
  // Workload group cancellation must leave the lease alive until its owner closes stdin.
  const holder = spawn('/usr/bin/lockf', ['-t', '0', '-k', lockFile, '/bin/sh', '-c', source], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let diagnostic = '';
  holder.stderr.on('data', chunk => { diagnostic = `${diagnostic}${chunk}`.slice(-4000); });
  const busy = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`${label} did not become ready.`)), 5000);
    holder.stdout.on('data', chunk => { output += chunk; if (output.includes('LOCKED\n')) { clearTimeout(timeout); resolve(false); } });
    holder.once('exit', code => {
      clearTimeout(timeout);
      if (code === 75) resolve(true);
      else reject(new Error(`${label} failed: ${diagnostic.trim()}`));
    });
    holder.once('error', error => { clearTimeout(timeout); reject(error); });
  }).catch(error => { holder.stdin.end(); holder.kill('SIGTERM'); throw error; });
  return { holder, busy, diagnostic: () => diagnostic };
}

/** Kernel ownership follows the holder's stdin lifetime; the stable lock inode is never removed. */
export async function acquireProcessLock(lockFile, { ownerFile = `${lockFile}.owner`, label = 'Process-lifetime lock', deadOwnerGraceMs = 2000, waitMs = 0 } = {}) {
  if (process.platform !== 'darwin') throw new Error(`${label} requires macOS.`);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  try {
    const stat = fs.lstatSync(lockFile);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is not a regular file: ${lockFile}`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const started = Date.now();
  let attempt = await startLockHolder(lockFile, label);
  while (attempt.busy && (Date.now() - started < waitMs || ownerDead(ownerFile) && Date.now() - started < deadOwnerGraceMs)) {
    await new Promise(resolve => setTimeout(resolve, 50));
    attempt = await startLockHolder(lockFile, label);
  }
  if (attempt.busy) throw new ProcessLockBusyError(`${label} is already in progress or the macOS lock failed: ${attempt.diagnostic().trim()}`);
  const { holder, diagnostic } = attempt;
  try {
    fs.writeFileSync(ownerFile, String(process.pid), { mode: 0o600 });
    return {
      holderPid: holder.pid,
      assertHeld: () => { if (holder.exitCode !== null || holder.signalCode !== null) throw new ProcessLockLostError(`${label} was lost; stopping effects.`); },
      release: async () => {
        holder.stdin.end();
        let timer;
        try {
          if (holder.exitCode === null && holder.signalCode === null) await Promise.race([new Promise(resolve => holder.once('exit', resolve)), new Promise(resolve => { timer = setTimeout(resolve, 2000); })]);
        } finally { clearTimeout(timer); }
        if (holder.exitCode === null && holder.signalCode === null) { holder.kill('SIGKILL'); throw new Error(`${label} holder did not exit; it was terminated.`); }
        if (holder.exitCode !== 0) throw new ProcessLockLostError(`${label} holder failed: ${diagnostic().trim()}`);
      },
    };
  } catch (error) { holder.stdin.end(); holder.kill('SIGTERM'); throw error; }
}
