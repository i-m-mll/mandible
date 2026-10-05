// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createAuthCheckRepo, git } from './helpers/auth-queue-fixtures.js';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { bindingDigest, handoffDirectory, readRuntimeHandoff, runtimeLogStartupOffset, runtimeHandoffDrainIdentity, verifyRuntimeHandoffReceipt } from '../scripts/runtime-handoff.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-handoff-binding-')); roots.push(home);
  const binding = { home, requestId: 'test-request-owner', executionId: 'test-execution-owner', root: home, runtime: { path: process.execPath, sha256: createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex') } };
  const dir = handoffDirectory(home, binding.requestId, binding.executionId); fs.mkdirSync(dir, { recursive: true });
  const journal = { schema: 'mandible-runtime-handoff@1', binding, bindingDigest: bindingDigest(binding), phase: 'armed' };
  fs.writeFileSync(path.join(dir, 'journal.json'), JSON.stringify(journal));
  return { home, dir, binding, journal };
}
it('refuses changed nested binding bytes and ambiguous owner paths', () => {
  const { home, dir, binding, journal } = fixture();
  expect(readRuntimeHandoff(home, binding.requestId, binding.executionId)?.bindingDigest).toBe(journal.bindingDigest);
  fs.writeFileSync(path.join(dir, 'journal.json'), JSON.stringify({ ...journal, binding: { ...binding, runtime: { ...binding.runtime, path: '/foreign/runtime' } } }));
  expect(() => readRuntimeHandoff(home, binding.requestId, binding.executionId)).toThrow('binding');
  expect(() => handoffDirectory(home, '../other', binding.executionId)).toThrow('owner');
});
it('never treats a pending or differently bound terminal journal as convergence', async () => {
  const { journal } = fixture();
  await expect(verifyRuntimeHandoffReceipt(journal, { probe: false })).rejects.toThrow('successful receipt');
  await expect(verifyRuntimeHandoffReceipt({ ...journal, phase: 'complete', receipt: { bindingDigest: 'different' } }, { probe: false })).rejects.toThrow('successful receipt');
});

it('lets the acknowledging daemon answer its own controller health probe', async () => {
  const { dir, binding, journal } = fixture();
  const repo = createAuthCheckRepo(); roots.push(repo);
  binding.root = repo;
  const server = http.createServer((_request, response) => response.end(JSON.stringify({ ready: true })));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  fs.writeFileSync(path.join(dir, 'controller.mjs'), `import http from 'node:http';
import { execFileSync } from 'node:child_process';
const request = http.get('http://127.0.0.1:${port}/health', response => { let body = ''; response.on('data', chunk => body += chunk); response.on('end', () => console.log(body)); });
request.setTimeout(500, () => request.destroy(new Error('health probe timed out')));
request.on('error', error => { console.error(error.message); process.exitCode = 1; });
`);
  const completedBinding = { ...binding, mergeCommit: git(repo, ['rev-parse', 'HEAD']) };
  const completedDigest = bindingDigest(completedBinding);
  try {
    await expect(verifyRuntimeHandoffReceipt({ ...journal, binding: completedBinding, bindingDigest: completedDigest,
      environment: { ...process.env }, phase: 'complete', receipt: { bindingDigest: completedDigest, files: {} } }, { probe: true }))
      .resolves.toMatchObject({ evidence: { ready: true } });
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it('requires the current process startup boundary and refuses rotated or truncated log coverage', () => {
  const { home } = fixture();
  const file = path.join(home, 'daemon.log');
  const stale = JSON.stringify({ message: 'server_started', time: '2020-01-01T00:00:00Z' }) + '\n';
  const startup = JSON.stringify({ message: 'server_started', time: '2026-10-05T19:55:06Z' }) + '\n';
  fs.writeFileSync(file, stale + startup + JSON.stringify({ message: 'healthy' }) + '\n');
  const stat = fs.statSync(file);
  const provenance = { path: file, dev: stat.dev, ino: stat.ino, size: stat.size };
  expect(runtimeLogStartupOffset(provenance, { startedAt: '2026-10-05T19:55:06Z' })).toBe(Buffer.byteLength(stale));
  expect(() => runtimeLogStartupOffset(provenance, { startedAt: '2026-10-06T00:00:00Z' })).toThrow('current process');
  fs.truncateSync(file, 0);
  expect(() => runtimeLogStartupOffset(provenance, { startedAt: '2026-10-05T19:55:06Z' })).toThrow('truncated');
});

it('never requests a drain from failed, completed or unacknowledged journals', () => {
  const { journal } = fixture();
  for (const phase of ['failed', 'complete', 'acknowledged', 'armed']) expect(runtimeHandoffDrainIdentity({ ...journal, phase })).toBeNull();
});

it('refuses startup discovery outside bounded log coverage', () => {
  const { home } = fixture();
  const file = path.join(home, 'large.log');
  fs.writeFileSync(file, JSON.stringify({ message: 'server_started', time: '2026-10-05T19:55:06Z' }) + '\n');
  fs.appendFileSync(file, Buffer.alloc(16 * 1024 * 1024 + 1, 32));
  const stat = fs.statSync(file);
  expect(() => runtimeLogStartupOffset({ path: file, dev: stat.dev, ino: stat.ino, size: stat.size }, { startedAt: '2026-10-05T19:55:06Z' })).toThrow('coverage limit');
});

it('admits a drain only for the active armed helper and exact current process start', () => {
  const { home, dir, binding, journal } = fixture();
  const startedAt = execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
  const ownedBinding = { ...binding, oldProcess: { pid: process.pid, startedAt } };
  const owned = { ...journal, binding: ownedBinding, bindingDigest: bindingDigest(ownedBinding), acknowledgedAt: Date.now(), bridgeInstalled: true };
  const activeFile = path.join(home, 'config/local-sessions/handoff-active.json');
  fs.writeFileSync(activeFile, JSON.stringify({ journal: path.join(dir, 'journal.json'), bindingDigest: owned.bindingDigest }));
  expect(runtimeHandoffDrainIdentity(owned)).toBe(`${binding.executionId}:${process.pid}:${startedAt}`);
  const foreignBinding = { ...ownedBinding, oldProcess: { ...ownedBinding.oldProcess, startedAt: 'foreign process start' } };
  const foreign = { ...owned, binding: foreignBinding, bindingDigest: bindingDigest(foreignBinding) };
  fs.writeFileSync(activeFile, JSON.stringify({ journal: path.join(dir, 'journal.json'), bindingDigest: foreign.bindingDigest }));
  expect(runtimeHandoffDrainIdentity(foreign)).toBeNull();
});


it('runs the staged bundled helper without activating imported command-line entrypoints', () => {
  const { dir, journal } = fixture();
  fs.writeFileSync(path.join(dir, 'journal.json'), JSON.stringify({ ...journal, phase: 'failed' }));
  const runtime = execFileSync('/bin/sh', ['scripts/bun-runtime.sh'], { encoding: 'utf8' }).trim();
  const helper = path.join(dir, 'helper.mjs');
  execFileSync(runtime, ['build', 'scripts/runtime-handoff.mjs', '--target', 'bun', '--outfile', helper], { stdio: 'pipe' });
  // A terminal journal must exit without admission, rebuild or service changes.
  expect(execFileSync(runtime, [helper, 'worker', path.join(dir, 'journal.json')], { encoding: 'utf8', timeout: 5000 })).toBe('');
  expect(readRuntimeHandoff(journal.binding.home, journal.binding.requestId, journal.binding.executionId)?.phase).toBe('failed');
});
