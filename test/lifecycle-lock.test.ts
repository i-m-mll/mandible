// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectLifecycleLock, recoverLifecycleLock, withLifecycleLock, withInstallationGatewayLock, assertLifecycleLockHeld } from '../scripts/lifecycle-lock.mjs';
import { saveOwnedMetadata } from '../scripts/owned-run.mjs';
import { testRuntimeRoot } from './helpers/runtime-isolation';
import { STATE_DEADLINE_MS, waitUntil } from './helpers/wait-until';

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await waitUntil(() => child.exitCode !== null || child.signalCode !== null, 'owned lifecycle child to exit');
  }
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(testRuntimeRoot, 'lifecycle-lock-'));
  roots.push(directory);
  const root = path.join(directory, 'preview'); fs.mkdirSync(root);
  const lock = path.join(directory, '.preview.lock');
  return { root, lock, ownerFile: path.join(lock, 'owner.json'), guardFile: `${lock}.process` };
}

async function ownInBun(root: string, cancelCleanup = false) {
  const runtime = spawnSync('/bin/sh', [path.resolve('scripts/bun-runtime.sh')], { encoding: 'utf8', timeout: 5000 });
  if (runtime.error || runtime.status !== 0) throw new Error(runtime.error?.message ?? runtime.stderr);
  const source = `import { withLifecycleLock } from ${JSON.stringify(pathToFileURL(path.resolve('scripts/lifecycle-lock.mjs')).href)};
    import { saveOwnedMetadata } from ${JSON.stringify(pathToFileURL(path.resolve('scripts/owned-run.mjs')).href)};
    if (${cancelCleanup}) process.on('SIGTERM', () => process.stdout.write('CANCELLED\\n'));
    await withLifecycleLock(${JSON.stringify(root)}, async () => {
      process.stdout.write('OWNED\\n'); process.stdin.resume();
      await new Promise(resolve => process.stdin.once('end', resolve));
      if (${cancelCleanup}) saveOwnedMetadata(${JSON.stringify(path.join(root, 'failure.json'))}, { error: 'primary desktop failure', cleanupOwned: true });
    }, { recoverStale: true });`;
  const child = spawn(runtime.stdout.trim(), ['--eval', source], { detached: cancelCleanup, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Owned child did not publish its lock: ${stderr}`)), STATE_DEADLINE_MS);
    const finish = (error?: Error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
    child.once('error', finish);
    child.once('exit', () => finish(new Error(`Owned child exited before lock publication: ${stderr}`)));
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('OWNED\n')) finish(); });
  });
  return child;
}

const inode = (file: string) => { const stat = fs.statSync(file); return { dev: stat.dev, ino: stat.ino }; };

describe.skipIf(process.platform !== 'darwin')('lifecycle lock ownership', () => {
  it('keeps owned failure recording and cleanup leased after protected process-group cancellation', async () => {
    const f = fixture(); const owner = await ownInBun(f.root, true);
    let cancelled = false;
    owner.stdout.on('data', chunk => { if (String(chunk).includes('CANCELLED')) cancelled = true; });
    process.kill(-owner.pid!, 'SIGTERM');
    await waitUntil(() => cancelled, 'the protected owner to observe cancellation');
    expect(await inspectLifecycleLock(f.root)).toMatchObject({ state: 'held' });
    owner.stdin.end();
    await waitUntil(() => owner.exitCode !== null, 'the cancelled owner to finish leased cleanup');
    expect(owner.exitCode).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(f.root, 'failure.json'), 'utf8'))).toEqual({ error: 'primary desktop failure', cleanupOwned: true });
    expect(await inspectLifecycleLock(f.root)).toEqual({ state: 'free' });
  });

  it('refuses live contenders and recovers no live ownership even when requested', async () => {
    const f = fixture(); const owner = await ownInBun(f.root);
    const before = fs.readFileSync(f.ownerFile, 'utf8');
    expect(JSON.parse(before).pid).toBe(owner.pid);
    expect(await inspectLifecycleLock(f.root)).toMatchObject({ state: 'held' });
    const operation = vi.fn();
    await expect(withLifecycleLock(f.root, operation, { recoverStale: true })).rejects.toMatchObject({ code: 'PROCESS_LOCK_BUSY' });
    await expect(recoverLifecycleLock(f.root)).rejects.toMatchObject({ code: 'PROCESS_LOCK_BUSY' });
    expect(operation).not.toHaveBeenCalled();
    expect(fs.readFileSync(f.ownerFile, 'utf8')).toBe(before);
    owner.stdin.end();
    await waitUntil(() => owner.exitCode !== null, 'live owner to release its lifecycle lock');
    expect(owner.exitCode).toBe(0);
    expect(await inspectLifecycleLock(f.root)).toEqual({ state: 'free' });
  });

  it.each(['automatic', 'explicit'] as const)('releases a killed owner kernel guard and permits %s proven-stale recovery', async recovery => {
    const f = fixture(); const owner = await ownInBun(f.root);
    const previous = JSON.parse(fs.readFileSync(f.ownerFile, 'utf8'));
    const guardInode = inode(f.guardFile);
    const dataFile = path.join(f.root, 'user-state'); fs.writeFileSync(dataFile, 'preserved');
    owner.kill('SIGKILL');
    await waitUntil(() => owner.signalCode === 'SIGKILL', 'owned Bun child SIGKILL completion');
    expect(await inspectLifecycleLock(f.root)).toMatchObject({ state: 'stale', owner: previous });
    if (recovery === 'explicit') {
      expect(await recoverLifecycleLock(f.root)).toBe(true);
      expect(await recoverLifecycleLock(f.root)).toBe(false);
    }
    const operation = vi.fn(() => {
      const current = JSON.parse(fs.readFileSync(f.ownerFile, 'utf8'));
      expect(current.pid).toBe(process.pid);
      expect(current.token).not.toBe(previous.token);
      expect(inode(f.guardFile)).toEqual(guardInode);
    });
    await withLifecycleLock(f.root, operation, { recoverStale: true });
    expect(operation).toHaveBeenCalledOnce();
    expect(await inspectLifecycleLock(f.root)).toEqual({ state: 'free' });
    await withLifecycleLock(f.root, () => expect(inode(f.guardFile)).toEqual(guardInode), { recoverStale: true });
    expect(inode(f.guardFile)).toEqual(guardInode);
    expect(fs.readFileSync(dataFile, 'utf8')).toBe('preserved');
  });

  it.each([undefined, '{"pid":', JSON.stringify({ pid: process.pid })])('never steals old ownership without complete evidence: %s', async bytes => {
    const f = fixture(); fs.mkdirSync(f.lock);
    if (bytes !== undefined) fs.writeFileSync(f.ownerFile, bytes);
    fs.utimesSync(f.lock, new Date(0), new Date(0));
    const directoryInode = inode(f.lock);
    expect(await inspectLifecycleLock(f.root)).toMatchObject({ state: 'uncertain' });
    const operation = vi.fn();
    await expect(withLifecycleLock(f.root, operation, { recoverStale: true })).rejects.toMatchObject({ code: 'PROCESS_LOCK_BUSY' });
    await expect(recoverLifecycleLock(f.root)).rejects.toMatchObject({ code: 'PROCESS_LOCK_BUSY' });
    expect(operation).not.toHaveBeenCalled();
    expect(inode(f.lock)).toEqual(directoryInode);
    if (bytes !== undefined) expect(fs.readFileSync(f.ownerFile, 'utf8')).toBe(bytes);
    else expect(fs.readdirSync(f.lock)).toEqual([]);
  });

  it('stops guarded metadata writes after its exact kernel holder dies and cleans only its own ownership', async () => {
    const f = fixture(); const metadata = path.join(f.root, 'metadata.json');
    await expect(withLifecycleLock(f.root, async (_token: string, assertHeld: () => void) => {
      const owner = JSON.parse(fs.readFileSync(f.ownerFile, 'utf8'));
      expect(Number.isInteger(owner.guardPid)).toBe(true);
      process.kill(owner.guardPid, 'SIGKILL');
      await waitUntil(() => {
        try { assertHeld(); return false; }
        catch (error) { if ((error as { code?: string }).code === 'PROCESS_LOCK_LOST') return true; throw error; }
      }, 'kernel holder loss to become observable');
      expect(() => saveOwnedMetadata(metadata, { mutated: true })).toThrow(expect.objectContaining({ code: 'PROCESS_LOCK_LOST' }));
      expect(fs.readdirSync(f.root)).toEqual([]);
    }, { recoverStale: true })).rejects.toMatchObject({ code: 'PROCESS_LOCK_LOST' });
    expect(await inspectLifecycleLock(f.root)).toEqual({ state: 'free' });
    expect(fs.existsSync(metadata)).toBe(false);
    await withLifecycleLock(f.root, () => saveOwnedMetadata(metadata, { recovered: true }), { recoverStale: true });
    expect(JSON.parse(fs.readFileSync(metadata, 'utf8'))).toEqual({ recovered: true });
  });

  it('keeps an inner observation lease bound to its installation lease lifetime', async () => {
    const f = fixture();
    await expect(withLifecycleLock(f.root, async () => {
      const gateway = JSON.parse(fs.readFileSync(f.ownerFile, 'utf8'));
      await withLifecycleLock(path.join(f.root, 'observation'), async () => {
        process.kill(gateway.guardPid, 'SIGKILL');
        await waitUntil(() => {
          try { assertLifecycleLockHeld(); return false; }
          catch (error) { if ((error as { code?: string }).code === 'PROCESS_LOCK_LOST') return true; throw error; }
        }, 'ancestor installation loss to stop the observation');
        expect(() => saveOwnedMetadata(path.join(f.root, 'forbidden.json'), { mutated: true })).toThrow(expect.objectContaining({ code: 'PROCESS_LOCK_LOST' }));
      });
    }, { recoverStale: true })).rejects.toMatchObject({ code: 'PROCESS_LOCK_LOST' });
    expect(fs.existsSync(path.join(f.root, 'forbidden.json'))).toBe(false);
    expect(await inspectLifecycleLock(f.root)).toEqual({ state: 'free' });
  });

  it('keeps delegated gateway effects bound to the exact kernel holder lifetime', async () => {
    const f = fixture(); const home = path.dirname(f.root);
    const root = path.join(home, 'config/local-sessions/gateway');
    const ownerFile = path.join(path.dirname(root), '.gateway.lock/owner.json');
    const metadata = path.join(f.root, 'delegated.json');
    try {
      await expect(withLifecycleLock(root, async (token: string, assertParentHeld: () => void) => {
        vi.stubEnv('MANDIBLE_GATEWAY_LOCK_TOKEN', token);
        await expect(withInstallationGatewayLock(home, async () => {
          const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
          process.kill(owner.guardPid, 'SIGKILL');
          await waitUntil(() => {
            try { assertParentHeld(); return false; }
            catch (error) { if ((error as { code?: string }).code === 'PROCESS_LOCK_LOST') return true; throw error; }
          }, 'delegated kernel holder loss');
          expect(() => saveOwnedMetadata(metadata, { mutated: true })).toThrow(expect.objectContaining({ code: 'PROCESS_LOCK_LOST' }));
        })).rejects.toMatchObject({ code: 'PROCESS_LOCK_LOST' });
      })).rejects.toMatchObject({ code: 'PROCESS_LOCK_LOST' });
      expect(fs.existsSync(metadata)).toBe(false);
      expect(await inspectLifecycleLock(root)).toEqual({ state: 'free' });
    } finally { vi.unstubAllEnvs(); }
  });
});
