// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { WorkScanner, type SqliteDatabase } from '../../src/work-scanner.js';

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
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(fs.existsSync(marker)).toBe(true);
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
}, 10000);
