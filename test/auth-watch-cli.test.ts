import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { testRuntimeRoot } from './helpers/runtime-isolation.js';
import { MAIN_CLI_INSTANCE_RESPONSE } from './helpers/cli-instance-response.js';
import { authCliRepo } from './helpers/prepared-git-fixture.js';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(testRuntimeRoot, 'auth-watch-'));
  authCliRepo.copyInto(root);
  fs.mkdirSync(path.join(root, 'adapters'));
  fs.writeFileSync(path.join(root, 'adapters/sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

async function watch(mode: 'sse' | 'poll' | 'inbox', statuses: string[]) {
  let reads = 0;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/instance') return res.end(JSON.stringify(MAIN_CLI_INSTANCE_RESPONSE));
    if (req.url === '/api/auth/v2/request') { res.statusCode = 201; return res.end('{"request_id":"watch123"}'); }
    const response = (status: string) => ({ id: 'watch123', request_id: 'watch123', status, exit_code: status === 'failed' ? 42 : 0, failure_reason: 'reviewed head changed' });
    if (req.url === '/api/events/subscribe') {
      res.setHeader('Content-Type', 'text/event-stream');
      if (mode === 'sse') for (const status of statuses) res.write(`data: ${JSON.stringify({ type: 'auth:resolved', data: response(status) })}\n\n`);
      return res.end();
    }
    if (req.url === '/api/auth/request/watch123') return res.end(JSON.stringify(response(statuses[Math.min(reads++, statuses.length - 1)])));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const args = mode === 'inbox' ? ['inbox', 'watch', 'watch123'] : ['auth', 'request', '--type', 'config-change', '--command', 'true', '--cwd', root, '--repo', path.basename(root), '--title', 'Watch fixture', '--issue', 'fixture', '--message', 'Apply fixture settings.'];
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(path.join(process.cwd(), 'bin/mandible'), args, {
        cwd: root, env: { ...process.env, MANDIBLE_BASE: `http://127.0.0.1:${port}`, PATH: `${root}/adapters:${process.env.PATH}`, MANDIBLE_HTTP_RETRIES: '0' },
      });
      let output = '';
      child.stdout.on('data', chunk => output += chunk);
      child.stderr.on('data', chunk => output += chunk);
      child.on('error', reject);
      child.on('close', code => resolve({ code, output }));
      child.stdin.end();
    });
    return { ...result, reads };
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

it.each(['sse', 'poll', 'inbox'] as const)('%s reports only completed as successful delivery', async mode => {
  for (const status of ['completed', 'needs_rebase', 'failed', 'rejected', 'withdrawn', 'superseded', 'expired', 'dismissed', 'future_status']) {
    const result = await watch(mode, [status]);
    expect(result.code, result.output).toBe(status === 'completed' ? 0 : 1);
    expect(result.output).toContain(status === 'future_status' ? "unknown status 'future_status'" : status);
    if (status === 'needs_rebase') expect(result.output).toContain('rebase the source branch');
    if (status === 'failed') expect(result.output).toContain('failed (exit 42) -- reviewed head changed');
  }
});

it.each(['sse', 'inbox'] as const)('%s waits through every in-flight state until delivery', async mode => {
  const result = await watch(mode, ['pending', 'approved', 'executing', 'completed']);
  expect(result.code, result.output).toBe(0);
  expect(result.output).toContain('completed');
  if (mode === 'inbox') expect(result.reads).toBe(4);
});

it.each(['pending', 'approved', 'executing'])('final poll reports %s as in flight without claiming delivery', async status => {
  const result = await watch('poll', [status]);
  expect(result.code, result.output).toBe(1);
  expect(result.output).toContain(`still in progress (${status})`);
});
