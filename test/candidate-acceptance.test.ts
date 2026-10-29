// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { acceptanceApplicationPolicy, acceptanceSummary, compactAcceptanceResult, acceptanceScope, acceptanceOwnedOutputs, createAcceptanceHome, acceptanceGatewayConfig, acceptanceHealth, acceptanceFailureLogs, assessAcceptanceLogs, awaitAcceptanceGatewayReadiness, awaitReadiness, loopbackListening, observeAcceptanceHealth, stopOwned, finalizeAcceptance } from '../scripts/candidate-acceptance.mjs';
import { createHash } from 'node:crypto';
import { createOwnedRun, saveOwnedMetadata, withOwnedRunLock } from '../scripts/owned-run.mjs';
import { runSupervisedCommand } from '../scripts/process-group-supervisor.mjs';
import { createAuthCheckRepo, createMigratedDb, insertSiblingMergeRequest } from './helpers/auth-queue-fixtures.js';
import { readCandidateAcceptanceEvidence } from './helpers/candidate-acceptance-evidence.js';
import { CandidateAcceptanceRuns, candidateAcceptanceOutcome } from '../src/candidate-acceptance.js';
import { STATE_DEADLINE_MS } from './helpers/wait-until.js';
import { acceptanceDeadline } from '../scripts/acceptance-deadline.mjs';
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
    const record = (event, budget) => {
      const group = spawnSync('/bin/ps', ['-o', 'pgid=', '-p', String(process.pid)], {encoding:'utf8',timeout:1000});
      if (group.status !== 0) throw Error(group.stderr);
      fs.appendFileSync(process.argv[2], JSON.stringify({event,pid:process.pid,pgid:group.stdout.trim(),
        execArgv:process.execArgv,argv:process.argv.slice(2),sentinel:process.env.ENTRY_FIXTURE_VALUE,
        marker:process.env.MANDIBLE_ACCEPTANCE_APPLICATION_POLICY_PID,
        started:process.env.MANDIBLE_ACCEPTANCE_STARTED_AT,deadline:process.env.MANDIBLE_ACCEPTANCE_DEADLINE,
        budget:budget?.reading()})+'\\n');
    };
    record('entry');
    const budget = acceptanceApplicationPolicy();
    record('ready', budget);
    if (process.argv[3] === 'parent') {
      const child = spawnSync(process.execPath, [...process.execArgv, import.meta.path, process.argv[2], 'child', ...process.argv.slice(4)],
        {env:process.env,encoding:'utf8',timeout:5000});
      if (child.status !== 0) throw Error(child.stderr);
    }
  `);
  const env = { ...process.env, ENTRY_FIXTURE_VALUE: 'spaces and $literal', MANDIBLE_ACCEPTANCE_APPLICATION_POLICY_PID: 'stale-parent' };
  delete env.MANDIBLE_ACCEPTANCE_STARTED_AT;
  delete env.MANDIBLE_ACCEPTANCE_DEADLINE;
  delete env.MANDIBLE_ACCEPTANCE_CLOCK_SCOPE;
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
    expect(ready[0].budget.deadline - ready[0].budget.started_at).toBe(60_000);
    expect(ready[1].budget).toMatchObject({ started_at: ready[0].budget.started_at, deadline: ready[0].budget.deadline,
      scope: 'candidate-script; installed executor preparation excluded' });
    expect(ready[0].budget.scope).toBe(ready[1].budget.scope);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('rejects malformed or expired entry clocks before attempting resource normalization', () => {
  const exec = vi.spyOn(process, 'execve');
  try {
    vi.stubEnv('MANDIBLE_ACCEPTANCE_STARTED_AT', 'invalid');
    vi.stubEnv('MANDIBLE_ACCEPTANCE_DEADLINE', 'invalid');
    expect(() => acceptanceApplicationPolicy()).toThrow('Invalid acceptance deadline');
    vi.stubEnv('MANDIBLE_ACCEPTANCE_STARTED_AT', String(Date.now() - 60_000));
    vi.stubEnv('MANDIBLE_ACCEPTANCE_DEADLINE', String(Date.now() - 1));
    expect(() => acceptanceApplicationPolicy()).toThrow('Acceptance total budget');
    expect(exec).not.toHaveBeenCalled();
  } finally { exec.mockRestore(); vi.unstubAllEnvs(); }
});

it('inherits the preparation deadline without renewing its cleanup reserve', () => {
  let now = 1000;
  const executor = acceptanceDeadline({}, () => now);
  now += 12_000;
  const script = acceptanceDeadline(executor.env, () => now);
  expect(script.deadline).toBe(executor.deadline);
  expect(script.remaining()).toBe(43_000);
  now = executor.deadline - 5000;
  expect(() => script.remaining()).toThrow('work budget');
  expect(script.remaining('report')).toBe(3000);
  expect(script.remaining('total')).toBe(5000);
  expect(script.reading().scope).toContain('executor');
  expect(script.cutoffs).toEqual({ preparation: 46_000, readiness: 51_000, work: 56_000, report: 59_000, total: 61_000 });
  now = script.cutoffs.preparation;
  expect(() => script.remaining('preparation')).toThrow('readiness and desktop time is reserved');
  expect(script.remaining('readiness')).toBe(5000);
  expect(script.remaining()).toBe(10_000);
  now = executor.deadline;
  expect(() => script.remaining('total')).toThrow('total budget');
  expect(() => acceptanceDeadline({ MANDIBLE_ACCEPTANCE_DEADLINE: '90000', MANDIBLE_ACCEPTANCE_STARTED_AT: '1' }, () => 1)).toThrow('Invalid acceptance deadline');
});

it('retains an exact recorded primary failure through response loss without accepting stale or passing checkpoints', () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-primary-'));
  const binding = { recordId: 'exact-run', requestId: 'request', projectId: 'project', workUnitId: 'unit',
    pin_sha: 'p'.repeat(40), tree_sha: 't'.repeat(40), base_sha: 'b'.repeat(40), head_sha: 'h'.repeat(40), started_at: 1000, deadline: 61_000 };
  const file = acceptanceResultPath(cache, binding.recordId);
  const primary = { schema: 'mandible-candidate-acceptance@1', status: 'failed', candidate: binding.pin_sha,
    binding: { ...binding, runId: binding.recordId }, error: 'Preparation consumed the reserved desktop budget.',
    phases: { package_verification: { status: 'failed' } } };
  const completion = { code: 1, stdout: '', stderr: JSON.stringify({ status: 'unavailable', error: 'Lifecycle ownership lock was lost; stopping effects.' }),
    failure: 'Candidate exceeded its stage deadline.', diagnostics: { code: 'STAGE_DEADLINE', timed_out: true, process_group_settled: true } };
  try {
    fs.mkdirSync(path.dirname(file)); saveOwnedMetadata(file, primary);
    const result = candidateAcceptanceOutcome(binding.pin_sha, completion, readAcceptanceFailure(cache, binding), true);
    expect(result).toMatchObject({ status: 'failed', error: primary.error, result: { error: primary.error, phases: primary.phases,
      subprocess: completion.diagnostics, secondary_errors: expect.arrayContaining([completion.failure, 'Lifecycle ownership lock was lost; stopping effects.']) } });
    const stale = readAcceptanceFailure(cache, { ...binding, tree_sha: 'another-tree' });
    expect(stale.result).toBeNull();
    expect(candidateAcceptanceOutcome(binding.pin_sha, completion, stale, false)).toMatchObject({ status: 'failed',
      error: 'Acceptance was unavailable: Lifecycle ownership lock was lost; stopping effects.' });
    expect(candidateAcceptanceOutcome(binding.pin_sha, { ...completion, failure: null, stderr: '{"incomplete":true}' }, readAcceptanceFailure(cache, binding), false).error).toBe(primary.error);
    saveOwnedMetadata(file, { ...primary, error: { message: primary.error } });
    expect(readAcceptanceFailure(cache, binding).result).toBeNull();
    saveOwnedMetadata(file, { ...primary, status: 'passed', error: null });
    expect(readAcceptanceFailure(cache, binding).result).toBeNull();
    expect(candidateAcceptanceOutcome(binding.pin_sha, completion, readAcceptanceFailure(cache, binding), false).status).toBe('failed');
  } finally { fs.rmSync(cache, { recursive: true, force: true }); }
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
    }, () => now, () => {}, () => () => {
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

  it('lets owned children finish beyond one second within the cleanup budget and force-stops an unresponsive child', async () => {
    await Promise.all([1100, null].map(async finishAfter => {
      const child = spawn(process.execPath, ['--eval',
        `process.on('SIGTERM', () => ${finishAfter === null ? '{}' : `setTimeout(() => process.exit(0), ${finishAfter})`}); process.stdout.write('ready'); setInterval(() => {}, 1000);`],
      { stdio: ['ignore', 'pipe', 'pipe'] });
      const safety = setTimeout(() => child.kill('SIGKILL'), 3000);
      try {
        await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject); child.once('exit', () => reject(new Error('Child exited before readiness'))); });
        const deadline = Date.now() + (finishAfter === null ? 1000 : 3000);
        const remaining = () => Math.max(1, deadline - Date.now());
        if (finishAfter === null) {
          await expect(stopOwned(child, remaining)).rejects.toThrow('Owned process shutdown');
          expect(child.signalCode).toBe('SIGKILL');
        } else expect(await stopOwned(child, remaining)).toMatchObject({ pid: child.pid, signal: 'SIGTERM', exitCode: 0, exitSignal: null });
      } finally { clearTimeout(safety); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
    }));
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
    const runs = new CandidateAcceptanceRuns(db, async () => ({ status: 'failed', result, error: result.error }), Date.now, () => {});
    runs.enqueue('outer-request', { pin_sha: 'pin', tree_sha: 'tree', base_sha: 'base', head_sha: 'head' },
      () => ({ repoRoot: repo, pinSha: 'pin', projectId: 'private-project', workUnitId: 'private-unit', env: {} }));
    await runs.idle();
    const packet = path.join(scratch, 'outer-failure.json');
    fs.writeFileSync(packet, JSON.stringify({ candidateAcceptance: readCandidateAcceptanceEvidence(db, 'outer-request') }));
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

it("keeps large shipped inventories in the full receipt and returns bounded finalization JSON after cleanup", async () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "acceptance-finalization-"));
  const run = path.join(cache, "run");
  fs.mkdirSync(run);
  fs.mkdirSync(path.join(run, "home"));
  fs.writeFileSync(path.join(run, "home", "fixture"), "generated fixture");
  const ownership = createOwnedRun({ root: run, instanceId: "finalization-test", project: "project", workUnit: "unit", disposable: true, outputs: acceptanceOwnedOutputs });
  const metadataFile = path.join(run, "metadata.json");
  saveOwnedMetadata(metadataFile, { ownership });
  const budget = acceptanceDeadline({});
  const provenance = { shipped: { files: Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [
    `dist/module-${index}.js`, { sha256: "a".repeat(64), size: 42 },
  ])) } };
  expect(Buffer.byteLength(JSON.stringify(provenance))).toBeGreaterThan(1024 * 1024);
  try {
    const finalized = await withOwnedRunLock(run, () => finalizeAcceptance({ metadataFile, run, cache, ownership, deadlineEnv: budget.env,
      result: { status: "failed", candidate: "candidate", scope: acceptanceScope, error: "request failed", provenance, checks: { health_coverage: { mode: "live production collectors" } }, phases: { finalization: { status: "running", started_at: Date.now() } }, budget: { ...budget.reading(), scope: "candidate-script" } },
    }));
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
    expect(receipt.acceptance).toMatchObject({ status: "failed", budget: { scope: "candidate-script" }, phases: { finalization: { status: "passed" } } });
    expect(Object.keys(receipt.acceptance.provenance.shipped.files)).toHaveLength(10_000);
  } finally { fs.rmSync(cache, { recursive: true, force: true }); }
});
