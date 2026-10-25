// @vitest-environment node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { WorkScanner, type SqliteDatabase } from '../src/work-scanner.js';

import { createMigratedDb } from './helpers/ledger-fixtures.js';
import { waitUntil } from './helpers/wait-until.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

it('cancels an in-flight repository probe and drains before the database closes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-shutdown-')); roots.push(root);
  fs.mkdirSync(path.join(root, '.git'));
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const marker = path.join(root, 'probe-started');
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\n: > "$SCANNER_PROBE_MARKER"\nexec sleep 30\n', { mode: 0o755 });
  let closed = false;
  const db: SqliteDatabase = {
    exec() { if (closed) throw new Error('database closed'); },
    transaction: (callback) => callback,
    prepare(sql) {
      if (closed) throw new Error('database closed');
      return { run: () => ({ changes: 0 }), get: () => undefined, all: () => sql.includes('FROM work_repos') ? [{ id: 'test', root, name: 'test', default_branch: 'main', dir_exists: 1, excluded: 0, user_modified: 0, last_scanned_at: null }] : [] };
    },
  };
  const scanner = new WorkScanner({ db, repo_roots: [root], config_path: path.join(root, 'repos.json'), on_event() {} });
  const previousPath = process.env.PATH;
  const previousMarker = process.env.SCANNER_PROBE_MARKER;
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
  process.env.SCANNER_PROBE_MARKER = marker;
  try {
    const scanning = scanner.scanAllAsync();
    await waitUntil(() => fs.existsSync(marker), 'the repository probe to start');
    const stopping = scanner.stop();
    await stopping;
    closed = true;
    await expect(scanning).resolves.toMatchObject({ scanned_repos: 0 });
    await expect(scanner.scanAllAsync()).resolves.toMatchObject({ scanned_repos: 0 });
    await expect(scanner.refreshRepoAsync(root)).rejects.toThrow('stopped');
  } finally {
    await scanner.stop();
    process.env.PATH = previousPath;
    if (previousMarker === undefined) delete process.env.SCANNER_PROBE_MARKER;
    else process.env.SCANNER_PROBE_MARKER = previousMarker;
  }
});

it('keeps timers responsive during slow Git and preserves the snapshot after a stuck branch probe', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-bounded-')); roots.push(root);
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const git = (args: string[]) => execFileSync(realGit, args, { cwd: repo, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, encoding: 'utf8' });
  git(['init', '-b', 'main']);
  git(['-c', 'user.name=Scanner Test', '-c', 'user.email=scanner@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'initial']);
  git(['branch', 'topic/slash']);
  const db = createMigratedDb();
  const scanner = new WorkScanner({ db, repo_roots: [repo], config_path: path.join(root, 'repos.json'), on_event() {} });
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const marker = path.join(root, 'status-pid');
  const wrapper = path.join(bin, 'git');
  fs.writeFileSync(wrapper, '#!/bin/sh\nif [ "$1" = status ]; then sleep 0.3; fi\nexec "$SCANNER_REAL_GIT" "$@"\n', { mode: 0o755 });
  const previous = { PATH: process.env.PATH, SCANNER_REAL_GIT: process.env.SCANNER_REAL_GIT, SCANNER_PROBE_MARKER: process.env.SCANNER_PROBE_MARKER };
  process.env.PATH = `${bin}${path.delimiter}${previous.PATH}`;
  process.env.SCANNER_REAL_GIT = realGit;
  process.env.SCANNER_PROBE_MARKER = marker;
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 20);
  try {
    // Empty-cache startup must also reach its first Git probe without blocking.
    await scanner.scanAllAsync();
    expect(ticks).toBeGreaterThan(5);
    expect(scanner.getBranch(repo, 'topic/slash')).not.toBeNull();
    const snapshot = db.prepare('SELECT * FROM branches WHERE repo_root = ? ORDER BY branch').all(repo);
    const freshness = scanner.getRepoById(repo)?.last_scanned_at;
    git(['branch', 'new-branch']);
    // Ignore TERM: the configured deadline must still kill the actual process.
    fs.writeFileSync(wrapper, '#!/bin/sh\nif [ "$1" = status ]; then echo $$ > "$SCANNER_PROBE_MARKER"; trap "" TERM; exec sleep 30; fi\nexec "$SCANNER_REAL_GIT" "$@"\n', { mode: 0o755 });
    const started = Date.now();
    await expect(scanner.refreshRepoAsync(repo)).rejects.toThrow('git status');
    expect(Date.now() - started).toBeLessThan(7000);
    expect(ticks).toBeGreaterThan(100);
    const pid = Number(fs.readFileSync(marker, 'utf8').trim());
    expect(() => process.kill(pid, 0)).toThrow();
    expect(db.prepare('SELECT * FROM branches WHERE repo_root = ? ORDER BY branch').all(repo)).toEqual(snapshot);
    expect(scanner.getRepoById(repo)?.last_scanned_at).toBe(freshness);

    // An ordinary inventory command failure is also not an empty successful scan.
    fs.writeFileSync(wrapper, '#!/bin/sh\nif [ "$1" = for-each-ref ]; then exit 1; fi\nexec "$SCANNER_REAL_GIT" "$@"\n', { mode: 0o755 });
    await expect(scanner.refreshRepoAsync(repo)).rejects.toThrow('git for-each-ref');
    expect(db.prepare('SELECT * FROM branches WHERE repo_root = ? ORDER BY branch').all(repo)).toEqual(snapshot);
    expect(scanner.getRepoById(repo)?.last_scanned_at).toBe(freshness);
  } finally {
    clearInterval(timer);
    await scanner.stop();
    db.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
