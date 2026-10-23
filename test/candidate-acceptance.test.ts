// @vitest-environment node
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { createAcceptanceHome, acceptanceGatewayConfig, acceptanceHealth, assessLogs, awaitReadiness, loopbackListening } from '../scripts/candidate-acceptance.mjs';
import { STATE_DEADLINE_MS } from './helpers/wait-until.js';

describe('production acceptance evidence', () => {
  it('rejects closed-database shutdown errors and event storms', () => {
    const stopped = JSON.stringify({ level: 'info', message: 'server_stopped' });
    const closedDb = JSON.stringify({ level: 'error', message: 'work_scanner_repo_scan_failed', error: 'The database connection is not open' });
    expect(assessLogs(`${stopped}\n${closedDb}`)).toEqual([closedDb]);
    expect(assessLogs(Array(101).fill(JSON.stringify({ level: 'info', message: 'work:scan:completed' })).join('\n'))).toContain('Repeated event storm: work:scan:completed (101 in 10000ms)');
    expect(assessLogs(`${stopped}\n${JSON.stringify({ level: 'info', message: 'daemon_ready' })}`)).toEqual([]);
    for (const event of ['ingestion_worker_error', 'ingestion_worker_exit', 'ingestion_reconcile_error']) {
      const warning = JSON.stringify({ level: 'warn', message: event, error: 'SQLite already loaded' });
      expect(assessLogs(warning)).toEqual([warning]);
    }
    expect(assessLogs(JSON.stringify({ level: 'warn', message: 'optional_provider_unavailable' }))).toEqual([]);
  });
});


it('routes only the exact private HTTPS dashboard and retains certificate validation', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-acceptance-tls-'));
  let server: https.Server | undefined;
  try {
    const privateHome = path.join(home, 'private-home');
    createAcceptanceHome(privateHome);
    expect(fs.statSync(privateHome).mode & 0o777).toBe(0o700);
    for (const name of ['root', 'unrelated']) {
      const result = spawnSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=app.mandible.localhost', '-addext', 'subjectAltName=DNS:app.mandible.localhost',
        '-keyout', path.join(home, `${name}.key`), '-out', path.join(home, `${name}.crt`)], { encoding: 'utf8', timeout: STATE_DEADLINE_MS });
      expect(result.status, result.stderr).toBe(0);
    }
    server = https.createServer({ key: fs.readFileSync(path.join(home, 'root.key')), cert: fs.readFileSync(path.join(home, 'root.crt')) }, (request, response) => {
      expect(request.url).toBe('/api/health');
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ ready: true }));
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as import('node:net').AddressInfo).port;
    const origin = `https://app.mandible.localhost:${port}`;
    const config = acceptanceGatewayConfig({ origin, backendPort: 12345, adminPort: 12346, storageRoot: home });
    expect(config).toContain(`${origin} {`);
    expect(config).toContain('skip_install_trust');
    expect(config).toContain('tls internal');
    expect(config).toContain('reverse_proxy http://127.0.0.1:12345');
    expect(config).toContain('header_up -X-Mandible-Session-Context');
    await expect(acceptanceHealth(origin, path.join(home, 'root.crt'))).resolves.toEqual({ ready: true });
    await expect(acceptanceHealth(origin, path.join(home, 'unrelated.crt'))).rejects.toThrow();
    for (const denied of ['http://127.0.0.1:12347', 'https://other.mandible.localhost:12347', `${origin}/path`, 'https://app.mandible.localhost']) {
      expect(() => acceptanceGatewayConfig({ origin: denied, backendPort: 12345, adminPort: 12346, storageRoot: home })).toThrow('exact Mandible HTTPS');
    }
    expect(() => acceptanceGatewayConfig({ origin, backendPort: port, adminPort: 12346, storageRoot: home })).toThrow('distinct valid ports');
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});


it('waits for a late bind, and fails at once on a gateway status or at the deadline naming the last observation', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-acceptance-ready-'));
  let server: https.Server | undefined;
  let late: import('node:net').Server | undefined;
  try {
    const generated = spawnSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=app.mandible.localhost', '-addext', 'subjectAltName=DNS:app.mandible.localhost',
      '-keyout', path.join(home, 'root.key'), '-out', path.join(home, 'root.crt')], { encoding: 'utf8', timeout: STATE_DEADLINE_MS });
    expect(generated.status, generated.stderr).toBe(0);
    const freePort = async () => {
      const probe = net.createServer();
      await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
      const port = (probe.address() as net.AddressInfo).port;
      await new Promise(resolve => probe.close(resolve));
      return port;
    };

    // The daemon port: refused until it binds, then ready.
    const port = await freePort();
    let probes = 0;
    const bound = awaitReadiness(async () => {
      if (++probes === 3) { late = net.createServer(); late.listen(port, '127.0.0.1'); }
      return loopbackListening(port);
    }, () => true, { timeout: STATE_DEADLINE_MS, description: 'Bind', interval: 5 });
    await expect(bound).resolves.toBe(true);
    expect(probes).toBeGreaterThanOrEqual(3);
    const unbound = await freePort();
    await expect(awaitReadiness(() => loopbackListening(unbound), () => true, { timeout: 100, description: 'Bind', interval: 5 }))
      .rejects.toThrow(/^Bind did not complete within 100ms; last observation: .*ECONNREFUSED/);

    // The gateway: any non-200 answer, 502 included, ends the wait at once.
    let statuses: number[] = [];
    server = https.createServer({ key: fs.readFileSync(path.join(home, 'root.key')), cert: fs.readFileSync(path.join(home, 'root.crt')) }, (_request, response) => {
      response.statusCode = statuses.shift() ?? 200;
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ ready: true }));
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const origin = `https://app.mandible.localhost:${(server.address() as net.AddressInfo).port}`;
    const health = () => awaitReadiness(() => acceptanceHealth(origin, path.join(home, 'root.crt')), (value: { ready?: boolean }) => value.ready === true,
      { timeout: STATE_DEADLINE_MS, description: 'Readiness', interval: 1 });
    await expect(health()).resolves.toEqual({ ready: true });
    statuses = [502];
    await expect(health()).rejects.toThrow('Health HTTPS 502');
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    if (late) await new Promise<void>(resolve => late!.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

it('separates startup traffic and health cadence from a repeated same-route request loop', async () => {
  const { assessRuntimeLogs } = await import('../scripts/runtime-log-assessment.mjs');
  const start = Date.parse('2026-10-05T05:00:00Z');
  const request = (pathname: string, offset: number) => JSON.stringify({ level: 'info', message: 'http_request', method: 'GET', pathname, status: 200, time: new Date(start + offset).toISOString() });
  const normal = [
    ...Array.from({ length: 75 }, (_, i) => request('/api/health', i * 500)),
    ...Array.from({ length: 128 }, (_, i) => request(`/api/startup/${i}`, i * 5)),
  ].join('\n');
  const assessment = assessRuntimeLogs(normal);
  expect(assessment.failures).toEqual([]);
  expect(assessment.diagnostics.http_requests).toMatchObject({ total: 203, route_count: 129, omitted_routes: 109 });
  expect(assessment.diagnostics.http_requests.routes[0]).toMatchObject({ pathname: '/api/health', count: 75, peak_window_count: 21, statuses: { '200': 75 } });
  expect(assessment.diagnostics.http_requests.routes).toHaveLength(20);
  const loop = Array.from({ length: 101 }, (_, i) => request('/api/projects', i * 50)).join('\n');
  expect(assessRuntimeLogs(loop).failures).toEqual(['Repeated request storm: GET /api/projects (101 in 10000ms)']);
  const cadence = Array.from({ length: 101 }, (_, i) => request('/api/projects', i * 1000)).join('\n');
  expect(assessRuntimeLogs(cadence).failures).toEqual([]);
  const untimed = Array.from({ length: 101 }, () => JSON.stringify({ level: 'info', message: 'http_request', method: 'GET', pathname: '/api/projects' })).join('\n');
  expect(assessRuntimeLogs(untimed).failures).toEqual(['Repeated request storm: GET /api/projects (101 in 10000ms)']);
});


it('assesses periodic events by rate while retaining complete lifetime error evidence', () => {
  const start = Date.parse('2026-10-05T05:00:00Z');
  const event = (offset: number) => JSON.stringify({ level: 'info', message: 'operational_log_copy_forward', time: new Date(start + offset).toISOString() });
  const cadence = Array.from({ length: 148 }, (_, i) => event(i * 30_000));
  expect(assessLogs(cadence.join('\n'))).toEqual([]);
  expect(assessLogs(Array.from({ length: 101 }, (_, i) => event(i * 50)).join('\n'))).toEqual(['Repeated event storm: operational_log_copy_forward (101 in 10000ms)']);
  const untimed = JSON.stringify({ level: 'info', message: 'operational_log_copy_forward' });
  expect(assessLogs([event(0), ...Array(100).fill(untimed)].join('\n'))).toEqual(['Repeated event storm: operational_log_copy_forward (101 in 10000ms)']);
  const error = JSON.stringify({ level: 'error', message: 'database_closed', time: new Date(start).toISOString() });
  expect(assessLogs([error, ...cadence].join('\n'))).toEqual([error]);
  expect(assessLogs([JSON.stringify({ message: 'server_started' }), ...cadence, JSON.stringify({ message: 'server_started' })].join('\n'))).toEqual(['Daemon restarted during acceptance']);
});
