import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../src/sse.js', () => ({ broadcast: vi.fn() }));
import { SessionRegistry, normalizePidStart } from '../../src/registry.js';
import { SessionDiscovery, ReaperTimer } from '../../src/session-discovery.js';
import { isSessionAliasLive } from '../../src/session-liveness.js';
import type { WorkScanner } from '../../src/work-scanner.js';
import { createMigratedDb } from '../helpers/ledger-fixtures.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

/** A `ps` on PATH that answers the process snapshot from `processes` and the environment read from `environments`. */
function fakePs(root: string) {
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const files = { processes: path.join(root, 'processes'), environments: path.join(root, 'environments'), calls: path.join(root, 'calls'), failed: path.join(root, 'failed') };
  fs.writeFileSync(files.environments, '');
  fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/sh\necho "$*" >> '${files.calls}'\nif [ -f '${files.failed}' ]; then exit 1; fi\nif [ "$1" = -E ]; then cat '${files.environments}'; exit 0; fi\nif [ "$1" != axo ]; then exit 42; fi\nsleep 0.05\ncat '${files.processes}'\n`, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
  return { ...files, restore: () => { process.env.PATH = previousPath; } };
}

async function spawnSleeper(cwd: string) {
  const child = spawn('/bin/sleep', ['30'], { cwd });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  return { pid: child.pid!, kill: async () => { child.kill('SIGKILL'); await new Promise(resolve => child.once('close', resolve)); } };
}

function fakeScanner(root: string): WorkScanner {
  return {
    getReposAsync: async () => [{ id: 'test', root, exists: true, excluded: true }],
    getWorktreeInventory: async () => ({ known: true, worktrees: [{ path: root, branch: 'topic/slash' }] }),
  } as unknown as WorkScanner;
}

it('uses batched start-time evidence for new and reused PIDs and preserves sessions when process evidence fails', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-identity-'))); roots.push(root);
  const ps = fakePs(root);
  const { processes: evidence, calls, failed } = ps;
  const child = await spawnSleeper(root);
  const pid = child.pid;
  const db = createMigratedDb();
  const registry = new SessionRegistry(db);
  const log = vi.fn();
  const discovery = new SessionDiscovery(registry, fakeScanner(root), log);
  const firstStart = 'Mon Oct  5 10:00:00 2026';
  const secondStart = 'Mon Oct  5 10:01:00 2026';
  try {
    fs.writeFileSync(evidence, `${pid} ${firstStart} /usr/local/bin/codex\n`);
    const first = discovery.discoverSessions();
    expect(discovery.discoverSessions()).toBe(first);
    await expect(first).resolves.toMatchObject({ discovered: 1 });
    expect(registry.getSessionByPid(pid)).toMatchObject({ pid_start: normalizePidStart(firstStart), branch: 'topic/slash' });
    fs.writeFileSync(evidence, `${pid} ${secondStart} /usr/local/bin/codex\n`);
    await expect(discovery.discoverSessions()).resolves.toMatchObject({ discovered: 1, already_tracked: 0 });
    const rows = db.prepare('SELECT pid_start, status FROM sessions ORDER BY pid_start').all();
    expect(rows).toEqual([{ pid_start: normalizePidStart(firstStart), status: 'dead' }, { pid_start: normalizePidStart(secondStart), status: 'active' }]);
    fs.writeFileSync(failed, 'fail');
    await expect(discovery.discoverSessions()).rejects.toThrow();
    expect(db.prepare('SELECT pid_start, status FROM sessions ORDER BY pid_start').all()).toEqual(rows);
    expect(log).toHaveBeenCalledWith('warn', 'session_discovery_ps_failed', expect.any(Object));
    // No hidden per-PID ps calls through registry liveness or registration.
    const snapshot = 'axo pid=,lstart=,comm=';
    const environment = `-E -ww -o pid=,command= -p ${pid}`;
    expect(fs.readFileSync(calls, 'utf8').trim().split('\n')).toEqual([snapshot, environment, snapshot, environment, snapshot]);
  } finally {
    await discovery.stop(); db.close(); ps.restore(); await child.kill();
  }
}, 5000);

it('attaches a live process to the pid-less row its launcher named and retires the duplicate', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-attach-'))); roots.push(root);
  const ps = fakePs(root);
  const child = await spawnSleeper(root);
  const db = createMigratedDb();
  const registry = new SessionRegistry(db);
  const discovery = new SessionDiscovery(registry, fakeScanner(root), () => {});
  const start = 'Mon Oct  5 10:00:00 2026';
  try {
    registry.registerSession({ id: 'managed', app: 'claude', conversation_id: 'provider-session', cwd: root });
    registry.registerSession({ id: 'discovered-duplicate', app: 'claude', pid: child.pid, pid_start: start, cwd: root });
    db.prepare("UPDATE sessions SET status = 'dead' WHERE id = 'managed'").run();
    expect(isSessionAliasLive(db, 'provider-session')).toBe(false);

    fs.writeFileSync(ps.processes, `${child.pid} ${start} /usr/local/bin/claude\n`);
    fs.writeFileSync(ps.environments, `${child.pid} claude HOME=/x MANDIBLE_SESSION_ID=managed TERM=y\n`);
    await expect(discovery.discoverSessions()).resolves.toMatchObject({ discovered: 0, already_tracked: 1 });

    expect(db.prepare('SELECT id, pid, status FROM sessions ORDER BY id').all()).toEqual([
      { id: 'discovered-duplicate', pid: child.pid, status: 'ended' },
      { id: 'managed', pid: child.pid, status: 'active' },
    ]);
    expect(isSessionAliasLive(db, 'provider-session')).toBe(true);
  } finally {
    await discovery.stop(); db.close(); ps.restore(); await child.kill();
  }
}, 5000);

it('aborts and drains an in-flight process scan before the database closes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-drain-')); roots.push(root);
  const marker = path.join(root, 'started');
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/sh\necho $$ > '${marker}'\ntrap '' TERM\nexec sleep 30\n`, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
  const db = createMigratedDb();
  const scanner = { getReposAsync: async () => [] } as unknown as WorkScanner;
  const discovery = new SessionDiscovery(new SessionRegistry(db), scanner, () => {});
  const timer = new ReaperTimer(discovery, () => {});
  try {
    const scanning = discovery.discoverSessions().then(() => null, error => error);
    const deadline = Date.now() + 2000;
    while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(fs.existsSync(marker)).toBe(true);
    await timer.stop();
    db.close();
    expect(await scanning).toBeInstanceOf(Error);
    await expect(discovery.discoverSessions()).rejects.toThrow('stopped');
    expect(discovery.reapDeadSessions()).toBe(0);
    const pid = Number(fs.readFileSync(marker, 'utf8').trim());
    const gone = () => { try { process.kill(pid, 0); return false; } catch { return true; } };
    const exitDeadline = Date.now() + 1000;
    while (!gone() && Date.now() < exitDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(gone()).toBe(true);
  } finally { await discovery.stop(); process.env.PATH = previousPath; if (db.open) db.close(); }
});
