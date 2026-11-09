// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { acceptanceApplicationPolicy, acceptanceSummary, compactAcceptanceResult, acceptanceScope, acceptanceOwnedOutputs, createAcceptanceHome, acceptanceGatewayConfig, acceptanceHealth, acceptanceFailureLogs, assessAcceptanceLogs, awaitAcceptanceGatewayReadiness, awaitReadiness, loopbackListening, observeAcceptanceHealth, stopOwned, finalizeAcceptance, interactionCompletion, verifyPackagedExports } from '../scripts/candidate-acceptance.mjs';
import { acceptanceFailure, describeAcceptanceFailure } from '../scripts/acceptance-failure.mjs';
import { acceptanceBackstop, acceptancePhases, ProgressWatch } from '../scripts/acceptance-progress.mjs';
import { RuntimeHealthObservationError } from '../src/runtime-health-contract.ts';
import { createHash } from 'node:crypto';
import { createOwnedRun, saveOwnedMetadata, withOwnedRunLock } from '../scripts/owned-run.mjs';
import { runSupervisedCommand } from '../scripts/process-group-supervisor.mjs';
import { createAuthCheckRepo, createMigratedDb, insertSiblingMergeRequest } from './helpers/auth-queue-fixtures.js';
import { readCandidateAcceptanceEvidence } from './helpers/candidate-acceptance-evidence.js';
import { CandidateAcceptanceRuns, acceptanceScriptWatch, candidateAcceptanceOutcome, runAcceptanceCommand } from '../src/candidate-acceptance.js';
import { STATE_DEADLINE_MS } from './helpers/wait-until.js';
import { acceptanceResultPath, readAcceptanceFailure } from '../scripts/acceptance-result.mjs';

it.skipIf(process.platform !== 'darwin')('self-execs once per PID while preserving argv, process group and the original candidate clock', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-policy-entry-'));
  const program = path.join(root, 'entry fixture.mjs');
  const trace = path.join(root, 'trace.jsonl');
  const policyModule = new URL('../scripts/candidate-acceptance.mjs', import.meta.url).href;
  fs.writeFileSync(program, `
    import fs from 'node:fs';
    import { spawnSync } from 'node:child_process';
    import { acceptanceApplicationPolicy } from ${JSON.stringify(policyModule)};
    const record = (event, startedAt) => {
      const group = spawnSync('/bin/ps', ['-o', 'pgid=', '-p', String(process.pid)], {encoding:'utf8',timeout:1000});
      if (group.status !== 0) throw Error(group.stderr);
      fs.appendFileSync(process.argv[2], JSON.stringify({event,pid:process.pid,pgid:group.stdout.trim(),
        execArgv:process.execArgv,argv:process.argv.slice(2),sentinel:process.env.ENTRY_FIXTURE_VALUE,
        marker:process.env.MANDIBLE_ACCEPTANCE_APPLICATION_POLICY_PID,
        started:process.env.MANDIBLE_ACCEPTANCE_STARTED_AT,startedAt})+'\\n');
    };
    record('entry');
    record('ready', acceptanceApplicationPolicy());
    if (process.argv[3] === 'parent') {
      const child = spawnSync(process.execPath, [...process.execArgv, import.meta.path, process.argv[2], 'child', ...process.argv.slice(4)],
        {env:process.env,encoding:'utf8',timeout:5000});
      if (child.status !== 0) throw Error(child.stderr);
    }
  `);
  const env = { ...process.env, ENTRY_FIXTURE_VALUE: 'spaces and $literal', MANDIBLE_ACCEPTANCE_APPLICATION_POLICY_PID: 'stale-parent' };
  delete env.MANDIBLE_ACCEPTANCE_STARTED_AT;
  try {
    const runtime = process.env.MANDIBLE_RUNTIME;
    if (!runtime) throw new Error('Candidate entry fixture requires the qualified Bun runtime');
    const result = spawnSync(runtime, ['--smol', '--no-install', program, trace, 'parent', 'argument with spaces', '--literal=$value'],
      { env, encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stderr).toBe(0);
    const rows = fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const pids = [...new Set(rows.map(row => row.pid))];
    expect(pids).toHaveLength(2);
    const ready = rows.filter(row => row.event === 'ready');
    for (const pid of pids) {
      const entries = rows.filter(row => row.pid === pid);
      expect(entries.map(row => row.event)).toEqual(['entry', 'entry', 'ready']);
      expect(new Set(entries.map(row => row.pgid)).size).toBe(1);
      expect(entries[0].marker).not.toBe(String(pid));
      expect(entries[1].marker).toBe(String(pid));
      expect(entries[1].argv).toEqual(entries[0].argv);
      expect(entries[1].execArgv).toEqual(entries[0].execArgv);
      expect(entries[1].execArgv).toEqual(['--smol', '--no-install']);
      expect(entries[1].sentinel).toBe('spaces and $literal');
    }
    expect(ready[1].startedAt).toBe(ready[0].startedAt);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('accepts an app completion written in the same millisecond as the check, and records the compared values when outside', () => {
  expect(interactionCompletion(2000.4, 1000, 2000)).toBe(2000);
  let failure: unknown;
  try { interactionCompletion(2002.5, 1000, 2000); } catch (error) { failure = error; }
  expect(describeAcceptanceFailure(failure, 'desktop_interaction')).toMatchObject({ fault: 'environment',
    values: { daemon_ready_at: 1000, interaction_completed_at: 2002.5, checked_at: 2000 } });
  expect(() => interactionCompletion(999.9, 1000, 2000)).toThrow(expect.objectContaining({ acceptanceFault: 'environment' }));
});

it('attributes every acceptance failure to the branch, the environment, or either', () => {
  const branch = acceptanceFailure('candidate', 'The packaged updater accepted an invalid journal');
  const verdicts = new Map([['candidate', 'points at the branch'], ['environment', 'not the branch'], ['either', 'can come from the branch or from the acceptance environment']]);
  for (const [error, stage, fault] of [
    [branch, 'package_verification', 'candidate'],
    [Object.assign(new Error('bun run was stopped because it made no progress'), { code: 'HUNG' }), 'package_build', 'either'],
    [new Error('rm failed'), 'finalization', 'environment'],
    [new Error('git failed'), 'startup', 'environment'],
    [Object.assign(new Error('lock lost'), { code: 'PROCESS_LOCK_LOST' }), 'readiness', 'environment'],
    [Object.assign(new RuntimeHealthObservationError('probe_failed', 'Runtime health probe failed: x', {}), { cause: branch }), 'health_coverage', 'candidate'],
  ] as const) {
    const described = describeAcceptanceFailure(error, stage);
    expect(described.fault).toBe(fault);
    expect(described.text).toContain(verdicts.get(fault));
  }
  expect(describeAcceptanceFailure(new Error('HTTP 502'), 'readiness').text).toContain('HTTP 502');
});

it('retains an exact recorded primary failure through response loss without accepting stale or passing checkpoints', () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-primary-'));
  const binding = { recordId: 'exact-run', requestId: 'request', projectId: 'project', workUnitId: 'unit',
    pin_sha: 'p'.repeat(40), tree_sha: 't'.repeat(40), base_sha: 'b'.repeat(40), head_sha: 'h'.repeat(40), started_at: 1000 };
  const file = acceptanceResultPath(cache, binding.recordId);
  const primary = { schema: 'mandible-candidate-acceptance@1', status: 'failed', candidate: binding.pin_sha,
    binding: { ...binding, runId: binding.recordId }, error: 'Preparation consumed the reserved desktop budget.',
    phases: { package_verification: { status: 'failed' } } };
  const completion = { code: 1, stdout: '', stderr: JSON.stringify({ status: 'unavailable', error: 'Lifecycle ownership lock was lost; stopping effects.' }),
    failure: 'Candidate exceeded its stage deadline.', diagnostics: { code: 'STAGE_DEADLINE', timed_out: true, process_group_settled: true } };
  try {
    fs.mkdirSync(path.dirname(file)); saveOwnedMetadata(file, primary);
    const result = candidateAcceptanceOutcome(binding.pin_sha, completion, readAcceptanceFailure(cache, binding));
    expect(result).toMatchObject({ status: 'failed', error: primary.error, result: { error: primary.error, phases: primary.phases,
      subprocess: completion.diagnostics, secondary_errors: expect.arrayContaining([completion.failure, 'Lifecycle ownership lock was lost; stopping effects.']) } });
    const stale = readAcceptanceFailure(cache, { ...binding, tree_sha: 'another-tree' });
    expect(stale.result).toBeNull();
    expect(candidateAcceptanceOutcome(binding.pin_sha, completion, stale)).toMatchObject({ status: 'failed',
      error: 'Lifecycle ownership lock was lost; stopping effects.' });
    expect(candidateAcceptanceOutcome(binding.pin_sha, { ...completion, failure: null, stderr: '{"incomplete":true}' }, readAcceptanceFailure(cache, binding)).error).toBe(primary.error);
    saveOwnedMetadata(file, { ...primary, error: { message: primary.error } });
    expect(readAcceptanceFailure(cache, binding).result).toBeNull();
    saveOwnedMetadata(file, { ...primary, status: 'passed', error: null });
    expect(readAcceptanceFailure(cache, binding).result).toBeNull();
    expect(candidateAcceptanceOutcome(binding.pin_sha, completion, readAcceptanceFailure(cache, binding)).status).toBe('failed');
  } finally { fs.rmSync(cache, { recursive: true, force: true }); }
});

it('watches live health until the interaction is covered, and fails on stale, stalled or skipped diagnostics', async () => {
  const sample = (sequence: number, start: number, end: number, observedAt: number, maxMs = 0) => ({ startup_epoch: 'epoch',
    eventLoop: { sequence, intervalStartedAt: start, intervalEndedAt: end, warning: false, maxMs },
    memory: { sequence, intervalStartedAt: start, intervalEndedAt: end, warning: false },
    current: { observedAt, collectorTurnMs: 1,
      eventLoop: { sequence, intervalStartedAt: end, intervalEndedAt: observedAt, warning: false, maxMs: 0 },
      memory: { sequence, intervalStartedAt: end, intervalEndedAt: observedAt, warning: false, rssFraction: 0.1, warningThresholdFraction: 0.9 } } });
  const observe = (second: ReturnType<typeof sample>) => {
    let time = 100;
    let probes = 0;
    return observeAcceptanceHealth({ live: { startedAt: 100, through: () => 105 }, now: () => time,
      wait: async () => { time += 10; }, probe: async () => ++probes === 1 ? sample(1, 80, 90, 100) : second });
  };
  await expect(observe(sample(1, 80, 90, 110))).resolves.toEqual(sample(1, 80, 90, 110));
  await expect(observe(sample(1, 80, 90, 100))).rejects.toMatchObject({ code: 'stale_diagnostics' });
  await expect(observe(sample(2, 90, 105, 110, 300))).rejects.toMatchObject({ code: 'event_loop_stall' });
  await expect(observe(sample(3, 105, 108, 110))).rejects.toMatchObject({ code: 'diagnostics_gap' });
});

describe('production acceptance evidence', () => {
  it('preserves historical failed evidence without adding route claims to bundle acceptance', () => {
    const initial = { trial: 0, pass: 1, status: 200, worst_turn_ms: 6.6 };
    const route = { complete: false, counts: { measured: 173 },
      measured: [{ route: 'GET /api/auth/queue', initial_readings: [initial] }] };
    const result = { candidate: 'candidate', status: 'failed', error: 'Route-cost sweep timed out',
      checks: { route_cost: route, log_digest: 'retained-log-digest' }, provenance: {} };
    expect(route.measured[0].initial_readings).toEqual([initial]);
    const summary = acceptanceSummary(result);
    expect(summary).toContain('failed — Route-cost sweep timed out');
    expect(summary).not.toContain('routes measured');
    expect(summary).toContain('retained-log-digest');
    expect(summary).toContain('package verification not completed');
    expect(summary).toContain('daemon readiness not completed');
    expect(summary).toContain('packaged Settings edit not completed');
    expect(summary).not.toContain('daemon readiness checked');
    expect(summary).not.toContain('packaged Settings edit checked');
    const failure = { fault: 'environment', detail: 'outside', values: { checked_at: 2000 }, evidence: { samples: 'large'.repeat(10_000) } };
    const output = compactAcceptanceResult({ ...result, failure, receipt: 'retained-receipt', provenance: { details: 'large manifest'.repeat(10_000) } });
    expect(JSON.stringify(output).length).toBeLessThan(64 * 1024);
    expect(output).toMatchObject({ receipt: 'retained-receipt', failure: { fault: 'environment', values: failure.values }, checks: { route_cost: { complete: false, counts: { measured: 173 } } } });
    expect(output.failure).not.toHaveProperty('evidence');
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

  it('retains real Caddy cutoff evidence only for the matching owned successful SIGTERM shutdown', () => {
    const saved = JSON.parse(fs.readFileSync('test/fixtures/caddy-bounded-shutdown.json', 'utf8'));
    const rows = saved.shutdown as Array<Record<string, any>>;
    const text = rows.map(row => JSON.stringify(row)).join('\n');
    const cutoffs = rows.filter(row => row.level === 'error');
    const context = { process: { owned: true, role: 'gateway', pid: 42 },
      shutdown: { pid: 42, signal: 'SIGTERM', requestedAt: Math.floor(rows[0]!.ts * 1000) - 1,
        exitedAt: Math.ceil(rows.at(-1)!.ts * 1000) + 1, exitCode: 0, exitSignal: null, graceSeconds: 1 } };
    const assessed = assessAcceptanceLogs(text, context);
    expect(assessed.failures).toEqual([]);
    expect(assessed.diagnostics.gateway_shutdown.cutoff_errors).toEqual(cutoffs);
    for (const invalid of [
      undefined,
      { ...context, process: { ...context.process, owned: false } },
      { ...context, process: { ...context.process, pid: 43 } },
      { ...context, shutdown: { ...context.shutdown, signal: 'SIGINT' } },
      { ...context, shutdown: { ...context.shutdown, exitCode: 1 } },
    ]) expect(assessAcceptanceLogs(text, invalid).failures).toEqual(cutoffs.map(row => JSON.stringify(row)));
    expect(assessAcceptanceLogs(rows.slice(0, -1).map(row => JSON.stringify(row)).join('\n'), context).failures).toHaveLength(2);
    expect(assessAcceptanceLogs(JSON.stringify(cutoffs[0]), context).failures).toHaveLength(1);
    const runningError = JSON.stringify({ level: 'error', logger: 'http', msg: 'upstream failed' });
    const closedDatabase = JSON.stringify({ level: 'error', message: 'database connection is not open' });
    expect(assessAcceptanceLogs([runningError, text, closedDatabase].join('\n'), context).failures).toEqual([runningError, closedDatabase]);
  });

  it('lets owned children finish beyond one second and force-stops an unresponsive child', async () => {
    await Promise.all([1100, null].map(async finishAfter => {
      const child = spawn(process.execPath, ['--eval',
        `process.on('SIGTERM', () => ${finishAfter === null ? '{}' : `setTimeout(() => process.exit(0), ${finishAfter})`}); process.stdout.write('ready'); setInterval(() => {}, 1000);`],
      { stdio: ['ignore', 'pipe', 'pipe'] });
      const safety = setTimeout(() => child.kill('SIGKILL'), 6000);
      try {
        await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject); child.once('exit', () => reject(new Error('Child exited before readiness'))); });
        if (finishAfter === null) {
          await expect(stopOwned(child)).rejects.toMatchObject({ acceptanceFault: 'either' });
          expect(child.signalCode).toBe('SIGKILL');
        } else expect(await stopOwned(child)).toMatchObject({ pid: child.pid, signal: 'SIGTERM', exitCode: 0, exitSignal: null });
      } finally { clearTimeout(safety); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
    }));
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


it('waits for a late bind, and fails at once on a gateway status', async () => {
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
    }, () => true, { watch: new ProgressWatch({ stage: 'Bind', idleMs: STATE_DEADLINE_MS }), description: 'Bind', interval: 5 });
    await expect(bound).resolves.toBe(true);
    expect(probes).toBeGreaterThanOrEqual(3);

    // The gateway: any non-200 answer, 502 included, ends the wait at once.
    let statuses: number[] = [];
    server = https.createServer({ key: fs.readFileSync(path.join(home, 'root.key')), cert: fs.readFileSync(path.join(home, 'root.crt')) }, (_request, response) => {
      response.statusCode = statuses.shift() ?? 200;
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ ready: true }));
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const origin = `https://app.mandible.localhost:${(server.address() as net.AddressInfo).port}`;
    const health = () => awaitReadiness(() => acceptanceHealth(origin, path.join(home, 'root.crt')), (value: { ready?: boolean }) => value.ready === true,
      { watch: new ProgressWatch({ stage: 'Readiness', idleMs: STATE_DEADLINE_MS }), description: 'Readiness', interval: 1 });
    await expect(health()).resolves.toEqual({ ready: true });
    statuses = [502];
    await expect(health()).rejects.toThrow('answered HTTP 502');
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
  }, value => value.ready, { watch: new ProgressWatch({ stage: 'Gateway', idleMs: STATE_DEADLINE_MS }), interval: 1, description: 'Gateway',
    onInitialTlsError: error => initialErrors.push(error) })).resolves.toEqual({ ready: true });
  expect(initialErrors).toEqual([{ code: alert.code, message: alert.message }]);
  probes = 0;
  await expect(awaitAcceptanceGatewayReadiness(async () => {
    if (++probes === 1) return { ready: false };
    throw alert;
  }, value => value.ready, { watch: new ProgressWatch({ stage: 'Gateway', idleMs: STATE_DEADLINE_MS }), interval: 1, description: 'Gateway' })).rejects.toBe(alert);
  expect(probes).toBe(2);
});

it('bounds persistent certificate startup and keeps unrelated gateway failures fatal', async () => {
  let probes = 0;
  await expect(awaitAcceptanceGatewayReadiness(async () => {
    probes++;
    throw Object.assign(new Error('still missing the leaf'), { code: 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR' });
  }, () => true, { watch: new ProgressWatch({ stage: 'Gateway', idleMs: 15 }), interval: 1, description: 'Gateway' }))
    .rejects.toMatchObject({ code: 'HUNG' });
  expect(probes).toBeGreaterThan(1);
  for (const error of [
    Object.assign(new Error('untrusted certificate'), { code: 'CERT_HAS_EXPIRED' }),
    Object.assign(new Error('wrong hostname'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }),
    Object.assign(new Error('wrong TLS version'), { code: 'ERR_SSL_WRONG_VERSION_NUMBER' }),
    new Error('Health HTTPS 502'), new Error('Owned HTTPS gateway exited'), new Error('Wrong generation'),
  ]) {
    probes = 0;
    await expect(awaitAcceptanceGatewayReadiness(async () => { probes++; throw error; }, () => true,
      { watch: new ProgressWatch({ stage: 'Gateway', idleMs: STATE_DEADLINE_MS }), interval: 1, description: 'Gateway' })).rejects.toBe(error);
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
    const result = { status: 'failed', candidate: 'exact-candidate', error: 'TLS alert', failure: { fault: 'either', values: { checked_at: 2000 } }, ...(oversized ? { routeReport: 'route diagnostics'.repeat(5000) } : {}), checks: {
      initial_transport_error: { code: 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR', message: 'TLS alert' },
      failure_logs: acceptanceFailureLogs(home),
    } };
    insertSiblingMergeRequest(db, repo, 'outer-request', 'main');
    const runs = new CandidateAcceptanceRuns(db, async () => ({ status: 'failed', result, error: result.error }), Date.now, () => {});
    runs.enqueue('outer-request', { pin_sha: 'pin', tree_sha: 'tree', base_sha: 'base', head_sha: 'head' },
      () => ({ repoRoot: repo, pinSha: 'pin', projectId: 'private-project', workUnitId: 'private-unit', env: {} }));
    await runs.idle();
    const packet = path.join(scratch, 'outer-failure.json');
    fs.writeFileSync(packet, JSON.stringify({ candidateAcceptance: readCandidateAcceptanceEvidence(db, 'outer-request') }));
    fs.rmSync(home, { recursive: true });
    const retained = JSON.parse(fs.readFileSync(packet, 'utf8')).candidateAcceptance;
    expect(JSON.stringify(retained.result).length).toBeLessThanOrEqual(64 * 1024);
    expect(retained).toMatchObject({ status: 'failed', result: { status: 'failed', candidate: result.candidate, error: result.error, failure: result.failure,
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

it("keeps large shipped inventories in the full receipt and returns bounded finalization JSON after cleanup", async () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "acceptance-finalization-"));
  const run = path.join(cache, "run");
  fs.mkdirSync(run);
  fs.mkdirSync(path.join(run, "home"));
  fs.writeFileSync(path.join(run, "home", "fixture"), "generated fixture");
  const ownership = createOwnedRun({ root: run, instanceId: "finalization-test", project: "project", workUnit: "unit", disposable: true, outputs: acceptanceOwnedOutputs });
  const metadataFile = path.join(run, "metadata.json");
  saveOwnedMetadata(metadataFile, { ownership });
  const provenance = { shipped: { files: Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [
    `dist/module-${index}.js`, { sha256: "a".repeat(64), size: 42 },
  ])) } };
  expect(Buffer.byteLength(JSON.stringify(provenance))).toBeGreaterThan(1024 * 1024);
  try {
    const acceptance = { status: "failed", candidate: "candidate", scope: acceptanceScope, error: "request failed", provenance, checks: { health_coverage: { mode: "live production collectors" } } };
    const finalized = await withOwnedRunLock(run, () => finalizeAcceptance({ metadataFile, run, cache, ownership,
      result: acceptance, phases: acceptancePhases(acceptance, { write: () => {} }) }));
    const result = compactAcceptanceResult(finalized);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(60 * 1024);
    expect(result.truncated).toBe(true);
    expect(result.scope).toBe(acceptanceScope);
    expect(result.checks.health_coverage.mode).toBe("live production collectors");
    expect(acceptanceSummary(result)).not.toContain("route sweep");
    expect(result.status).toBe("failed");
    expect(result.checks.cleanup).toMatchObject({ action: "delete-owned", remaining: [] });
    expect(fs.existsSync(path.join(run, "home", "fixture"))).toBe(false);
    const receipt = JSON.parse(fs.readFileSync(result.receipt, "utf8"));
    expect(receipt.acceptance).toMatchObject({ status: "failed", phases: { finalization: { status: "passed" } } });
    expect(Object.keys(receipt.acceptance.provenance.shipped.files)).toHaveLength(10_000);
  } finally { fs.rmSync(cache, { recursive: true, force: true }); }
});


it('requires a passing exact-package export receipt and keeps every proof fixture inside owned cleanup', async () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-exports-'));
  const run = path.join(cache, 'run');
  const home = path.join(run, 'home');
  fs.mkdirSync(home, { recursive: true });
  const ownership = createOwnedRun({ root: run, instanceId: 'exports-test', project: 'project', workUnit: 'unit', disposable: true, outputs: acceptanceOwnedOutputs });
  const metadataFile = path.join(run, 'metadata.json');
  saveOwnedMetadata(metadataFile, { ownership });
  const runtime = path.join(cache, 'packaged-runtime');
  fs.writeFileSync(runtime, `#!${process.env.MANDIBLE_RUNTIME}
import fs from 'node:fs';
fs.writeFileSync('fixture-evidence', 'private proof data');
const mode = process.env.PROOF_FIXTURE_MODE;
if (mode === 'failed') { process.stderr.write('hook execution failed'); process.exit(1); }
process.stdout.write(mode === 'malformed' ? 'bad JSON' : JSON.stringify({passed:mode !== 'not-passed',commit:mode === 'mismatch' ? 'other' : 'candidate',source_digest:'source'}));
`, { mode: 0o755 });
  try {
    for (const mode of ['passed', 'failed', 'malformed', 'not-passed', 'mismatch']) {
      const fixtureHome = path.join(home, mode);
      fs.mkdirSync(fixtureHome, { mode: 0o700 });
      const proof = verifyPackagedExports({ resources: path.join(cache, 'verified-resources'), runtime,
        environment: { ...process.env, PROOF_FIXTURE_MODE: mode }, home: fixtureHome,
        provenance: { commit: 'candidate', source_digest: 'source' } });
      if (mode === 'passed') await expect(proof).resolves.toMatchObject({ passed: true, commit: 'candidate', source_digest: 'source' });
      else await expect(proof).rejects.toMatchObject({ acceptanceFault: 'candidate' });
      expect(fs.existsSync(path.join(fixtureHome, 'exports', 'fixture-evidence'))).toBe(true);
      expect(fs.statSync(path.join(fixtureHome, 'exports')).mode & 0o777).toBe(0o700);
    }
    const acceptance = { status: 'failed', candidate: 'candidate', scope: acceptanceScope, checks: {} };
    const finalized = await withOwnedRunLock(run, () => finalizeAcceptance({ metadataFile, run, cache, ownership,
      result: acceptance, phases: acceptancePhases(acceptance, { write: () => {} }) }));
    expect(finalized.checks.cleanup).toMatchObject({ action: 'delete-owned', remaining: [] });
    expect(fs.existsSync(home)).toBe(false);
  } finally { fs.rmSync(cache, { recursive: true, force: true }); }
});

it('lets the acceptance script stay quiet for as long as its current phase may', () => {
  let now = 0;
  const { watch, onOutput } = acceptanceScriptWatch(() => {}, () => now);
  const line = (text: string) => { const chunk = Buffer.from(`${text}\n`); watch.output(chunk.length); onOutput(chunk, 'stderr'); };
  line('[acceptance] package_build started');
  now += 90_000;
  expect(() => watch.assert()).not.toThrow();
  line('[acceptance] package_build passed in 90000 ms (expected 36000 ms)');
  line('[acceptance] package_verification started');
  now += 90_000;
  expect(() => watch.assert()).toThrow(expect.objectContaining({ code: 'HUNG' }));
  watch.close();
});

it('fails a run that is still printing at the backstop, and reaps its command', async () => {
  const backstop = acceptanceBackstop(new AbortController().signal, { backstopMs: 500, stage: 'package_build' });
  let pid = 0;
  try {
    await expect(runAcceptanceCommand(backstop, signal => runSupervisedCommand(process.execPath, ['-e', "setInterval(() => process.stdout.write('.'), 50)"],
      { capture: true, idleMs: 300, graceMs: 100, signal, onSpawn: child => { pid = child.pid!; } })))
      .rejects.toMatchObject({ code: 'BACKSTOP', acceptanceFault: 'either' });
  } finally { backstop.close(); }
  expect(() => process.kill(-pid, 0)).toThrow();
});

it('passes a stage that runs past its expected duration, with a warning', async () => {
  let now = 0;
  const result: { phases?: Record<string, { status: string }>; warnings?: string[] } = {};
  const phases = acceptancePhases(result, { startedAt: 0, now: () => now, write: () => {} });
  await phases.run('readiness', watch => { for (let step = 0; step < 10; step++) { now += 1_000; watch.advance(`step ${step}`); watch.assert(); } });
  phases.timing();
  expect(result.phases!.readiness!.status).toBe('passed');
  expect(result.warnings).toHaveLength(1);
});
