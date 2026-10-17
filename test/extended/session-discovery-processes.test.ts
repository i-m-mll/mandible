import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../src/sse.js', () => ({ broadcast: vi.fn() }));
import { SessionRegistry, normalizePidStart } from '../../src/registry.js';
import { SessionDiscovery, ReaperTimer } from '../../src/session-discovery.js';
import type { WorkScanner } from '../../src/work-scanner.js';
import { createMigratedDb } from '../helpers/ledger-fixtures.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

it('uses batched start-time evidence for new and reused PIDs and preserves sessions when process evidence fails', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-identity-'))); roots.push(root);
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const evidence = path.join(root, 'processes');
  const calls = path.join(root, 'calls');
  const failed = path.join(root, 'failed');
  fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/sh\necho "$*" >> '${calls}'\nif [ -f '${failed}' ]; then exit 1; fi\nif [ "$1" != axo ]; then exit 42; fi\nsleep 0.05\ncat '${evidence}'\n`, { mode: 0o755 });
  const child = spawn('/bin/sleep', ['30'], { cwd: root });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const pid = child.pid!;
  const db = createMigratedDb();
  const registry = new SessionRegistry(db);
  const scanner = {
    getReposAsync: async () => [{ id: 'test', root, exists: true, excluded: true }],
    getWorktreeInventory: async () => ({ known: true, worktrees: [{ path: root, branch: 'topic/slash' }] }),
  } as unknown as WorkScanner;
  const log = vi.fn();
  const discovery = new SessionDiscovery(registry, scanner, log);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
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
    expect(fs.readFileSync(calls, 'utf8').trim().split('\n')).toEqual(Array(3).fill('axo pid=,lstart=,comm='));
  } finally {
    await discovery.stop(); db.close(); process.env.PATH = previousPath;
    child.kill('SIGKILL'); await new Promise(resolve => child.once('close', resolve));
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
