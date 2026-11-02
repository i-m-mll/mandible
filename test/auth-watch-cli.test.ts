import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
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
    const response = (status: string) => ({ request_id: 'watch123', status, outcome: ['pending', 'approved', 'executing'].includes(status) ? null : status === 'completed' ? 'succeeded' : status,
      exit_code: status === 'failed' ? 42 : status === 'completed' ? 0 : null, failure_reason: 'reviewed head changed',
      error: null, error_output: null, resolved_at: ['pending', 'approved', 'executing'].includes(status) ? null : 1, title: 'Watch fixture', head_branch: null,
      target_session_id: null, conversation_id: null });
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

it.each(['bash', 'zsh'])('%s reports delivery outcomes through the shared shell function', shell => {
  const cases = [
    { status: 'completed', code: 0 },
    { status: 'needs_rebase', code: 1 },
    { status: 'failed', code: 1 },
    { status: 'rejected', code: 1 },
    { status: 'pending', code: 2 },
    { status: 'future_status', code: 3 },
  ];
  const result = spawnSync(shell, ['-c', `
    source "$MANDIBLE_CLI_DIR/auth-status.sh" || exit 10
    for response in "$@"; do
      result=0
      output=$(mandible_auth_report watch123 "$response" 2>&1) || result=$?
      printf '%s\\t%s\\n' "$result" "$output"
    done
  `, 'auth-report-fixture', ...cases.map(({ status }) => JSON.stringify({
    status, exit_code: status === 'failed' ? 42 : status === 'completed' ? 0 : null, failure_reason: 'reviewed head changed',
  }))], { cwd: root, env: { ...process.env, MANDIBLE_CLI_DIR: path.join(process.cwd(), 'cli') }, encoding: 'utf8', timeout: 15_000 });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const reports = result.stdout.trimEnd().split('\n');
  expect(reports).toHaveLength(cases.length);
  cases.forEach(({ status, code }, index) => {
    const [classification, ...detail] = reports[index].split('\t');
    const output = detail.join('\t');
    expect(Number(classification), output).toBe(code);
    if (code === 2) {
      expect(output).toBe('');
      return;
    }
    expect(output).toContain('watch123');
    expect(output).toContain(status);
    if (code === 1) expect(output).toContain('reviewed head changed');
    if (status === 'needs_rebase') expect(output).toMatch(/\brebase\b/);
    if (status === 'failed') expect(output).toMatch(/\b42\b/);
    if (code === 3) expect(output).toMatch(/unknown/i);
  });
});

it.each(['sse', 'poll', 'inbox'] as const)('%s propagates terminal delivery results', async mode => {
  const statuses = mode === 'sse' ? ['completed', 'failed', 'needs_rebase'] : ['completed', 'failed', 'future_status'];
  for (const status of statuses) {
    const result = await watch(mode, [status]);
    expect(result.code, result.output).toBe(status === 'completed' ? 0 : 1);
    expect(result.output).toContain('watch123');
    expect(result.output).toContain(status);
    if (status === 'failed') {
      expect(result.output).toContain('reviewed head changed');
      expect(result.output).toMatch(/\b42\b/);
    }
  }
});

it('inbox waits through every in-flight state until delivery', async () => {
  const result = await watch('inbox', ['pending', 'approved', 'executing', 'completed']);
  expect(result.code, result.output).toBe(0);
  expect(result.output).toContain('completed');
  expect(result.reads).toBe(4);
});

it.each(['pending', 'approved', 'executing'])('final poll reports %s as in flight without claiming delivery', async status => {
  const result = await watch('poll', [status]);
  expect(result.code, result.output).toBe(1);
  expect(result.reads).toBe(1);
  expect(result.output).toContain('watch123');
  expect(result.output).toContain(status);
});
