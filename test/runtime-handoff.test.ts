// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createAuthCheckRepo, git } from './helpers/auth-queue-fixtures.js';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { bindingDigest, handoffDirectory, readRuntimeHandoff, verifyRuntimeHandoffReceipt } from '../scripts/runtime-handoff.mjs';

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
