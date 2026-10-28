// @vitest-environment node
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { acceptanceSummary, compactAcceptanceResult, routeCostCheck, createAcceptanceHome, acceptanceGatewayConfig, acceptanceHealth, acceptanceFailureLogs, assessAcceptanceLogs, awaitAcceptanceGatewayReadiness, awaitReadiness, loopbackListening, observeAcceptanceHealth } from '../scripts/candidate-acceptance.mjs';
import { createHash } from 'node:crypto';
import { createAuthCheckRepo, createMigratedDb, insertSiblingMergeRequest } from './helpers/auth-queue-fixtures.js';
import { readBootstrapAcceptanceEvidence } from './helpers/bootstrap-delivery-api.js';
import { CandidateAcceptanceRuns } from '../src/candidate-acceptance.js';
import { STATE_DEADLINE_MS } from './helpers/wait-until.js';
import { acceptanceDeadline } from '../scripts/acceptance-deadline.mjs';

it('inherits the preparation deadline without renewing its cleanup reserve', () => {
  let now = 1000;
  const executor = acceptanceDeadline({}, () => now);
  now += 12_000;
  const script = acceptanceDeadline(executor.env, () => now);
  expect(script.deadline).toBe(executor.deadline);
  expect(script.remaining()).toBe(43_000);
  now = executor.deadline - 5000;
  expect(() => script.remaining()).toThrow('cleanup reserve');
  expect(script.remaining(true)).toBe(5000);
  expect(script.reading().scope).toContain('executor');
  now = executor.deadline;
  expect(() => script.remaining(true)).toThrow('cleanup');
  expect(() => acceptanceDeadline({ MANDIBLE_ACCEPTANCE_DEADLINE: '90000', MANDIBLE_ACCEPTANCE_STARTED_AT: '1' }, () => 1)).toThrow('Invalid acceptance deadline');
});

it('zero-soak acceptance still requires a fresh interval covering the completed interaction', async () => {
  let time = 100;
  const health = (sequence: number, start: number, end: number) => ({ startup_epoch: 'epoch',
    eventLoop: { sequence, intervalStartedAt: start, intervalEndedAt: end, warning: false, maxMs: 0 },
    memory: { sequence, intervalStartedAt: start, intervalEndedAt: end, warning: false },
  });
  let probes = 0;
  await expect(observeAcceptanceHealth({ observationMs: 0, deadlineMs: 20, now: () => time,
    wait: async () => { time += 5; }, probe: async () => ++probes === 1 ? health(1, 80, 90) : health(2, 90, 105),
  })).resolves.toEqual(health(2, 90, 105));
  expect(probes).toBe(2);
  time = 100;
  await expect(observeAcceptanceHealth({ observationMs: 0, deadlineMs: 20, now: () => time,
    wait: async () => { time += 5; }, probe: async () => health(1, 80, 90),
  })).rejects.toMatchObject({ code: 'stale_diagnostics' });
});

it.each(['before', 'during', 'within'] as const)('includes retained-package binding in the acceptance-row deadline (%s)', async stage => {
  const db = createMigratedDb();
  const repo = createAuthCheckRepo();
  let now = 1000;
  let bound = false;
  try {
    insertSiblingMergeRequest(db, repo, 'deadline-request', 'main');
    const original = db.prepare("SELECT title FROM auth_requests WHERE id = 'deadline-request'").get();
    const runs = new CandidateAcceptanceRuns(db, async input => {
      expect(input.env.MANDIBLE_ACCEPTANCE_STARTED_AT).toBe('1000');
      expect(input.env.MANDIBLE_ACCEPTANCE_DEADLINE).toBe('61000');
      now = stage === 'before' ? 61000 : 59000;
      return { status: 'passed', result: { status: 'passed' }, error: null };
    }, () => now, () => {}, () => false, () => () => {
      bound = true;
      db.prepare("UPDATE auth_requests SET title = 'bound' WHERE id = 'deadline-request'").run();
      now = stage === 'during' ? 61000 : 60000;
    });
    runs.enqueue('deadline-request', { pin_sha: 'pin', tree_sha: 'tree', base_sha: 'base', head_sha: 'head' },
      () => ({ repoRoot: repo, pinSha: 'pin', projectId: 'project', workUnitId: 'unit', env: {} }));
    await runs.idle();
    const row = db.prepare("SELECT status, finished_at, error FROM auth_candidate_acceptances WHERE auth_request_id = 'deadline-request'").get() as any;
    expect(row.status).toBe(stage === 'within' ? 'passed' : 'failed');
    expect(row.finished_at).toBe(now);
    expect(bound).toBe(stage !== 'before');
    expect(db.prepare("SELECT title FROM auth_requests WHERE id = 'deadline-request'").get()).toEqual(stage === 'within' ? { title: 'bound' } : original);
  } finally { db.close(); fs.rmSync(repo, { recursive: true, force: true }); }
});

describe('production acceptance evidence', () => {
  it('retains known route evidence without claiming unperformed acceptance phases', () => {
    const initial = { trial: 0, pass: 1, status: 200, worst_turn_ms: 6.6 };
    const route = routeCostCheck(JSON.stringify({ complete: false, counts: { measured: 173 },
      measured: [{ method: 'GET', path: '/api/auth/queue', trials: [{ trial: 0, first_call_turn_ms: 6.6, warm_turn_ms: 3.2 }], requests: [initial] }],
      offenders: [], excepted: [], exception_problems: [], unclassified: [], failed_requests: [] }));
    const result = { candidate: 'candidate', status: 'failed', error: 'Route-cost sweep timed out',
      checks: { route_cost: route, log_digest: 'retained-log-digest' }, provenance: {} };
    expect(route.measured[0].initial_readings).toEqual([initial]);
    const summary = acceptanceSummary(result);
    expect(summary).toContain('failed — Route-cost sweep timed out');
    expect(summary).toContain('173 routes measured');
    expect(summary).toContain('retained-log-digest');
    expect(summary).toContain('package verification not completed');
    expect(summary).toContain('daemon readiness not completed');
    expect(summary).toContain('packaged Settings edit not completed');
    expect(summary).not.toContain('daemon readiness checked');
    expect(summary).not.toContain('packaged Settings edit checked');
    const output = compactAcceptanceResult({ ...result, receipt: 'retained-receipt', provenance: { details: 'large manifest'.repeat(10_000) } });
    expect(JSON.stringify(output).length).toBeLessThan(64 * 1024);
    expect(output).toMatchObject({ receipt: 'retained-receipt', checks: { route_cost: { complete: false, counts: { measured: 173 } } } });
  });

  it('rejects closed-database shutdown errors and event storms', () => {
    const stopped = JSON.stringify({ level: 'info', message: 'server_stopped' });
    const closedDb = JSON.stringify({ level: 'error', message: 'work_scanner_repo_scan_failed', error: 'The database connection is not open' });
    expect(assessAcceptanceLogs(`${stopped}\n${closedDb}`).failures).toEqual([closedDb]);
    expect(assessAcceptanceLogs(Array(101).fill(JSON.stringify({ level: 'info', message: 'work:scan:completed' })).join('\n')).failures).toContain('Repeated event storm: work:scan:completed (101 in 10000ms)');
    expect(assessAcceptanceLogs(`${stopped}\n${JSON.stringify({ level: 'info', message: 'daemon_ready' })}`).failures).toEqual([]);
    for (const event of ['ingestion_worker_error', 'ingestion_worker_exit', 'ingestion_reconcile_error']) {
      const warning = JSON.stringify({ level: 'warn', message: event, error: 'SQLite already loaded' });
      expect(assessAcceptanceLogs(warning).failures).toEqual([warning]);
    }
    expect(assessAcceptanceLogs(JSON.stringify({ level: 'warn', message: 'optional_provider_unavailable' })).failures).toEqual([]);
    expect(assessAcceptanceLogs(JSON.stringify({ level: 'warn', message: 'daemon_event_loop_stall', max_ms: 3700 })).failures)
      .toEqual([expect.stringContaining('daemon_event_loop_stall')]);
  });
});

it('requires a fresh clean diagnostics interval covering acceptance', async () => {
  let time = 100;
  const health = (sequence: number, intervalStartedAt: number, intervalEndedAt: number, maxMs = 0) => ({
    startup_epoch: 'epoch',
    eventLoop: { sequence, intervalStartedAt, intervalEndedAt, warning: false, maxMs },
    memory: { sequence, intervalStartedAt, intervalEndedAt, warning: false },
  });
  const initial = health(1, 80, 90);
  const fresh = health(2, 90, 110);
  let probes = 0;
  await expect(observeAcceptanceHealth({
    observationMs: 10,
    deadlineMs: 20,
    now: () => time,
    wait: async () => { time += 10; },
    probe: async () => ++probes === 1 ? initial : fresh,
  })).resolves.toEqual(fresh);
  time = 100;
  probes = 0;
  await expect(observeAcceptanceHealth({
    observationMs: 10, deadlineMs: 20, now: () => time,
    wait: async () => { time += 10; },
    probe: async () => ++probes === 1 ? initial : health(2, 90, 110, 250),
  })).rejects.toMatchObject({ code: 'event_loop_stall' });

  time = 100;
  probes = 0;
  await expect(observeAcceptanceHealth({
    observationMs: 10, deadlineMs: 20, now: () => time,
    wait: async () => { time += 15; },
    probe: async () => ++probes === 1 ? initial : health(3, 105, 115),
  })).rejects.toMatchObject({ code: 'diagnostics_gap' });

  time = 100;
  probes = 0;
  await expect(observeAcceptanceHealth({
    observationMs: 10, deadlineMs: 20, now: () => time,
    wait: async () => { time += 25; },
    probe: async () => ++probes === 1 ? initial : health(2, 90, 125),
  })).rejects.toMatchObject({ code: 'observation_deadline' });
});

it('aborts an acceptance probe that never answers at the fixed deadline', async () => {
  let aborted = false;
  const started = Date.now();
  await expect(observeAcceptanceHealth({
    observationMs: 5,
    deadlineMs: 20,
    probe: async (_deadline, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
    }),
  })).rejects.toMatchObject({ code: 'observation_deadline' });
  expect(aborted).toBe(true);
  expect(Date.now() - started).toBeLessThan(100);
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
    const config = acceptanceGatewayConfig({ origin, backendPort: 12345, storageRoot: home });
    expect(config).toContain(`${origin} {`);
    expect(config).toContain('skip_install_trust');
    expect(config).toContain('tls internal');
    expect(config).toContain('reverse_proxy http://127.0.0.1:12345');
    expect(config).toContain('header_up -X-Mandible-Session-Context');
    await expect(acceptanceHealth(origin, path.join(home, 'root.crt'))).resolves.toEqual({ ready: true });
    await expect(acceptanceHealth(origin, path.join(home, 'unrelated.crt'))).rejects.toThrow();
    for (const denied of ['http://127.0.0.1:12347', 'https://other.mandible.localhost:12347', `${origin}/path`, 'https://app.mandible.localhost']) {
      expect(() => acceptanceGatewayConfig({ origin: denied, backendPort: 12345, storageRoot: home })).toThrow('exact Mandible HTTPS');
    }
    expect(() => acceptanceGatewayConfig({ origin, backendPort: port, storageRoot: home })).toThrow('distinct valid ports');
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

it('retains bounded aggregate route diagnostics without treating caller volume as failure', async () => {
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
  const aggregate = Array.from({ length: 101 }, (_, i) => request('/api/projects', i * 50)).join('\n');
  expect(assessRuntimeLogs(aggregate)).toMatchObject({ failures: [], diagnostics: { hard_failure_count: 0,
    http_requests: { total: 101, routes: [{ pathname: '/api/projects', count: 101, peak_window_count: 101, statuses: { '200': 101 } }] } } });
  expect(assessAcceptanceLogs(aggregate).failures).toEqual([]);
  const cadence = Array.from({ length: 101 }, (_, i) => request('/api/projects', i * 1000)).join('\n');
  expect(assessRuntimeLogs(cadence).failures).toEqual([]);
  const untimed = Array.from({ length: 101 }, () => JSON.stringify({ level: 'info', message: 'http_request', method: 'GET', pathname: '/api/projects' })).join('\n');
  expect(assessRuntimeLogs(untimed)).toMatchObject({ failures: [], diagnostics: { hard_failure_count: 0,
    http_requests: { routes: [{ count: 101, untimed: 101, peak_window_count: 101 }] } } });
  const error = JSON.stringify({ level: 'error', message: 'http_request', method: 'GET', pathname: '/api/projects', status: 500 });
  expect(assessRuntimeLogs(`${aggregate}\n${error}`).failures).toEqual([error]);
});

it('waits through the initial certificate alert but rejects the same alert after validated HTTPS', async () => {
  const alert = Object.assign(new Error('leaf certificate is not available yet'), { code: 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR' });
  const initialErrors: unknown[] = [];
  let probes = 0;
  await expect(awaitAcceptanceGatewayReadiness(async () => {
    if (++probes === 1) throw alert;
    return { ready: true };
  }, value => value.ready, { timeout: STATE_DEADLINE_MS, interval: 1, description: 'Gateway',
    onInitialTlsError: error => initialErrors.push(error) })).resolves.toEqual({ ready: true });
  expect(initialErrors).toEqual([{ code: alert.code, message: alert.message }]);
  probes = 0;
  await expect(awaitAcceptanceGatewayReadiness(async () => {
    if (++probes === 1) return { ready: false };
    throw alert;
  }, value => value.ready, { timeout: STATE_DEADLINE_MS, interval: 1, description: 'Gateway' })).rejects.toBe(alert);
  expect(probes).toBe(2);
});

it('bounds persistent certificate startup and keeps unrelated gateway failures fatal', async () => {
  let probes = 0;
  await expect(awaitAcceptanceGatewayReadiness(async () => {
    probes++;
    throw Object.assign(new Error('still missing the leaf'), { code: 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR' });
  }, () => true, { timeout: 15, interval: 1, description: 'Gateway' }))
    .rejects.toThrow('last observation: still missing the leaf');
  expect(probes).toBeGreaterThan(1);
  for (const error of [
    Object.assign(new Error('untrusted certificate'), { code: 'CERT_HAS_EXPIRED' }),
    Object.assign(new Error('wrong hostname'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }),
    Object.assign(new Error('wrong TLS version'), { code: 'ERR_SSL_WRONG_VERSION_NUMBER' }),
    new Error('Health HTTPS 502'), new Error('Owned HTTPS gateway exited'), new Error('Wrong generation'),
  ]) {
    probes = 0;
    await expect(awaitAcceptanceGatewayReadiness(async () => { probes++; throw error; }, () => true,
      { timeout: STATE_DEADLINE_MS, interval: 1, description: 'Gateway' })).rejects.toBe(error);
    expect(probes).toBe(1);
  }
});

it.each([false, true])('records nested acceptance diagnostics through private cleanup (oversized=%s)', async oversized => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-acceptance-evidence-'));
  const home = path.join(scratch, 'private'); fs.mkdirSync(home);
  const db = createMigratedDb();
  const repo = createAuthCheckRepo();
  try {
    const daemonLog = `${(oversized ? '\u001b' : 'startup detail\n').repeat(1000)}daemon failed startup`;
    const gatewayLog = `${oversized ? '\u001b'.repeat(9000) : ''}no certificate available for app.mandible.localhost`;
    const routeLog = 'measured 173 routes; confirmation incomplete';
    const previewLog = 'source preview startup incomplete';
    fs.writeFileSync(path.join(home, 'daemon.log'), daemonLog);
    fs.writeFileSync(path.join(home, 'gateway.log'), gatewayLog);
    fs.writeFileSync(path.join(home, 'route-cost.log'), routeLog);
    fs.mkdirSync(path.join(home, 'route-cost-work'));
    fs.writeFileSync(path.join(home, 'route-cost-work/source-preview.log'), previewLog);
    const result = { status: 'failed', candidate: 'exact-candidate', error: 'TLS alert', ...(oversized ? { routeReport: 'route diagnostics'.repeat(5000) } : {}), checks: {
      initial_transport_error: { code: 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR', message: 'TLS alert' },
      failure_logs: acceptanceFailureLogs(home),
    } };
    insertSiblingMergeRequest(db, repo, 'outer-request', 'main');
    const runs = new CandidateAcceptanceRuns(db, async () => ({ status: 'failed', result, error: result.error }), Date.now, () => {}, () => false);
    runs.enqueue('outer-request', { pin_sha: 'pin', tree_sha: 'tree', base_sha: 'base', head_sha: 'head' },
      () => ({ repoRoot: repo, pinSha: 'pin', projectId: 'private-project', workUnitId: 'private-unit', env: {} }));
    await runs.idle();
    const packet = path.join(scratch, 'outer-failure.json');
    fs.writeFileSync(packet, JSON.stringify({ candidateAcceptance: readBootstrapAcceptanceEvidence(db, 'outer-request') }));
    fs.rmSync(home, { recursive: true });
    const retained = JSON.parse(fs.readFileSync(packet, 'utf8')).candidateAcceptance;
    expect(JSON.stringify(retained.result).length).toBeLessThanOrEqual(64 * 1024);
    expect(retained).toMatchObject({ status: 'failed', result: { status: 'failed', candidate: result.candidate, error: result.error,
      checks: { initial_transport_error: result.checks.initial_transport_error } } });
    if (oversized) expect(retained.result.truncated).toBe(true);
    for (const [name, content, diagnostic] of [
      ['daemon', daemonLog, 'daemon failed startup'],
      ['gateway', gatewayLog, 'no certificate available for app.mandible.localhost'],
      ['route-cost', routeLog, 'confirmation incomplete'],
      ['source-preview', previewLog, 'startup incomplete'],
    ]) {
      const log = retained.result.checks.failure_logs.find(entry => entry.name === name);
      expect(log).toMatchObject({ name, sha256: createHash('sha256').update(content).digest('hex'), bytes: Buffer.byteLength(content) });
      expect(content.endsWith(log.excerpt)).toBe(true);
      expect(log.excerpt.endsWith(diagnostic)).toBe(true);
    }
  } finally { db.close(); fs.rmSync(scratch, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); }
});


it('assesses periodic events by rate while retaining complete lifetime error evidence', () => {
  const start = Date.parse('2026-10-05T05:00:00Z');
  const event = (offset: number) => JSON.stringify({ level: 'info', message: 'operational_log_copy_forward', time: new Date(start + offset).toISOString() });
  const cadence = Array.from({ length: 148 }, (_, i) => event(i * 30_000));
  expect(assessAcceptanceLogs(cadence.join('\n')).failures).toEqual([]);
  expect(assessAcceptanceLogs(Array.from({ length: 101 }, (_, i) => event(i * 50)).join('\n')).failures).toEqual(['Repeated event storm: operational_log_copy_forward (101 in 10000ms)']);
  const untimed = JSON.stringify({ level: 'info', message: 'operational_log_copy_forward' });
  expect(assessAcceptanceLogs([event(0), ...Array(100).fill(untimed)].join('\n')).failures).toEqual(['Repeated event storm: operational_log_copy_forward (101 in 10000ms)']);
  const error = JSON.stringify({ level: 'error', message: 'database_closed', time: new Date(start).toISOString() });
  expect(assessAcceptanceLogs([error, ...cadence].join('\n')).failures).toEqual([error]);
  expect(assessAcceptanceLogs([JSON.stringify({ message: 'server_started' }), ...cadence, JSON.stringify({ message: 'server_started' })].join('\n')).failures).toEqual(['Daemon restarted during acceptance']);
});
