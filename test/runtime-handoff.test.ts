// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createAuthCheckRepo, git } from './helpers/auth-queue-fixtures.js';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { bindingDigest, handoffDirectory, observeFailedRuntimeHandoff, observeRuntimeHealthWindow, persistRuntimeRecoveryObservation, readRuntimeHandoff, readRuntimeRecoveryAttempts, runtimeLogStartupOffset, runtimeHandoffDrainIdentity, verifyRuntimeHandoffReceipt } from '../scripts/runtime-handoff.mjs';
import { assessRuntimeLogs } from '../scripts/runtime-log-assessment.mjs';
import { RuntimeHealthObservationError } from '../src/runtime-health-contract.ts';
import { STATE_DEADLINE_MS } from './helpers/wait-until.js';

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

function diagnostics(sequence: number, intervalStartedAt: number, intervalEndedAt: number, maxMs = 0, warning = false) {
  return {
    eventLoop: { sequence, intervalStartedAt, intervalEndedAt, maxMs, warning },
    memory: { sequence, intervalStartedAt, intervalEndedAt, warning: false },
  };
}

function runtimeEvidence(health: ReturnType<typeof diagnostics>) {
  return {
    process: { pid: 123, startedAt: 'start', startupEpoch: 'epoch' },
    backend: { file: '/backend', digest: 'backend' },
    gateway: { file: '/gateway', digest: 'gateway' },
    daemonLog: { path: '/daemon.log', dev: 1, ino: 2, size: 10 },
    health,
  };
}

it('recovery retains an earlier stall and requires a fresh clean sample covering the window', async () => {
  let time = 100;
  const initial = runtimeEvidence(diagnostics(4, 0, 90, 678.8));
  const fresh = runtimeEvidence(diagnostics(5, 90, 110));
  let probes = 0;
  const result = await observeRuntimeHealthWindow({
    recovery: true,
    observationMs: 10,
    deadlineMs: 20,
    now: () => time,
    wait: async (milliseconds: number) => { time += milliseconds / 100; },
    probe: async () => ++probes === 1 ? initial : fresh,
  });
  expect(result.historicalHealth).toHaveLength(1);
  expect(result.samples.last.eventLoop.sequence).toBe(5);
  expect(result.observation).toMatchObject({ startedAt: 100, mustCover: 110 });
});

it('initial acceptance and current recovery reject maximum-delay stalls', async () => {
  const staleStall = runtimeEvidence(diagnostics(4, 0, 90, 678.8));
  await expect(observeRuntimeHealthWindow({ probe: async () => staleStall, now: () => 100 }))
    .rejects.toMatchObject({ code: 'event_loop_stall' });
  const currentStall = runtimeEvidence(diagnostics(5, 90, 100, 15_102.4));
  await expect(observeRuntimeHealthWindow({ probe: async () => currentStall, recovery: true, now: () => 100 }))
    .rejects.toMatchObject({ code: 'event_loop_stall' });
});

it('refuses stale diagnostics and changed process identity', async () => {
  let time = 100;
  const initial = runtimeEvidence(diagnostics(4, 80, 90));
  await expect(observeRuntimeHealthWindow({
    recovery: true,
    observationMs: 10,
    deadlineMs: 20,
    now: () => time,
    wait: async () => { time += 20; },
    probe: async () => initial,
  })).rejects.toMatchObject({ code: 'stale_diagnostics' });
  time = 100;
  await expect(observeRuntimeHealthWindow({
    recovery: true,
    observationMs: 10,
    deadlineMs: 20,
    now: () => time,
    wait: async () => { time += 10; },
    probe: (() => { let calls = 0; return async () => ++calls === 1 ? initial : ({ ...runtimeEvidence(diagnostics(5, 90, 110)), process: { ...initial.process, pid: 456 } }); })(),
  })).rejects.toMatchObject({ code: 'process_changed' });
});

it('refuses mutated, future, and gapped diagnostic intervals', async () => {
  const initial = runtimeEvidence(diagnostics(4, 80, 90));
  for (const [expected, next] of [
    ['diagnostics_mutated', runtimeEvidence(diagnostics(4, 80, 91))],
    ['future_diagnostics', runtimeEvidence(diagnostics(5, 90, 111))],
    ['diagnostics_gap', runtimeEvidence(diagnostics(6, 95, 110))],
  ] as const) {
    let time = 100;
    let probes = 0;
    await expect(observeRuntimeHealthWindow({
      recovery: true, observationMs: 10, deadlineMs: 20, now: () => time,
      wait: async () => { time += 10; },
      probe: async () => ++probes === 1 ? initial : next,
    })).rejects.toMatchObject({ code: expected });
  }
});

it('aborts a handoff probe that never answers at the fixed deadline', async () => {
  let aborted = false;
  const started = Date.now();
  await expect(observeRuntimeHealthWindow({
    observationMs: 5,
    deadlineMs: 20,
    probe: async (_deadline, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
    }),
  })).rejects.toMatchObject({ code: 'observation_deadline' });
  expect(aborted).toBe(true);
  expect(Date.now() - started).toBeLessThan(100);
});

it('classifies only timed pre-observation health logs as historical', () => {
  const oldLag = JSON.stringify({ time: '2026-10-23T22:31:15.548Z', level: 'warn', message: 'daemon_event_loop_lag', p95_ms: 199.4, max_ms: 3841.2 });
  const oldError = JSON.stringify({ time: '2026-10-23T22:31:16.000Z', level: 'error', message: 'ingestion_worker_error' });
  const currentStall = JSON.stringify({ time: '2026-10-23T22:32:01.000Z', level: 'warn', message: 'daemon_event_loop_stall', max_ms: 678.8 });
  const cutoff = Date.parse('2026-10-23T22:32:00.000Z');
  expect(assessRuntimeLogs(`${oldLag}\n`, { historicalBefore: cutoff })).toMatchObject({ failures: [], diagnostics: { historical_health: { retained: [{ event: 'daemon_event_loop_lag' }] } } });
  expect(assessRuntimeLogs(`${oldError}\n`, { historicalBefore: cutoff }).failures).toHaveLength(1);
  expect(assessRuntimeLogs(`${currentStall}\n`, { historicalBefore: cutoff }).failures).toHaveLength(1);
  expect(assessRuntimeLogs(`${JSON.stringify({ level: 'warn', message: 'daemon_memory_warning' })}\n`, { historicalBefore: cutoff }).failures[0]).toContain('Untimed');
});

it('runs real recovery observation through complete log and journal evidence', async () => {
  const { home, dir, binding } = fixture();
  const repo = createAuthCheckRepo(); roots.push(repo);
  const nativeApp = path.join(home, 'Mandible.app');
  const resources = path.join(nativeApp, 'Contents/Resources');
  const executable = path.join(nativeApp, 'Contents/MacOS/mandible-app');
  const backend = path.join(home, 'backend.plist');
  const gateway = path.join(home, 'gateway.plist');
  fs.mkdirSync(path.join(repo, 'dist'), { recursive: true });
  fs.mkdirSync(resources, { recursive: true });
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  const revision = JSON.stringify({ commit: git(repo, ['rev-parse', 'HEAD']) });
  for (const file of [path.join(repo, 'dist/build-revision.json'), path.join(resources, 'build-revision.json')]) fs.writeFileSync(file, revision);
  for (const file of [path.join(repo, 'dist/index.js'), executable, backend, gateway]) fs.writeFileSync(file, file);
  const processStartedAt = execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
  const fakeStart = Date.now();
  const log = path.join(home, 'daemon.log');
  fs.writeFileSync(log, [
    JSON.stringify({ message: 'server_started', time: new Date(Date.parse(processStartedAt) + 1000).toISOString() }),
    JSON.stringify({ level: 'warn', message: 'daemon_event_loop_lag', time: new Date(fakeStart - 1000).toISOString(), p95_ms: 199.4, max_ms: 3841.2 }),
  ].join('\n') + '\n');
  const completedBinding = { ...binding, root: repo, nativeApp, mergeCommit: git(repo, ['rev-parse', 'HEAD']) };
  const failed = { schema: 'mandible-runtime-handoff@1', binding: completedBinding, bindingDigest: bindingDigest(completedBinding), phase: 'failed', attempts: 1, error: 'Candidate runtime changed or became unhealthy.', updatedAt: fakeStart - 500, database: path.join(home, 'mandible.db') };
  fs.writeFileSync(path.join(dir, 'journal.json'), JSON.stringify(failed));
  const active = path.join(home, 'config/local-sessions/handoff-active.json'); fs.mkdirSync(path.dirname(active), { recursive: true });
  fs.writeFileSync(active, JSON.stringify({ journal: path.join(dir, 'journal.json'), bindingDigest: failed.bindingDigest }));
  const evidence = (sample: ReturnType<typeof diagnostics>) => {
    const stat = fs.statSync(log);
    return { process: { pid: process.pid, startedAt: processStartedAt, startupEpoch: 'epoch' }, backend: { file: backend }, gateway: { file: gateway }, daemonLog: { path: log, dev: stat.dev, ino: stat.ino, size: stat.size }, health: { instance: { db_path: failed.database }, ...sample } };
  };
  let time = fakeStart;
  let probes = 0;
  await expect(observeFailedRuntimeHandoff(failed, { user_id: 'agent' }, {
    observationMs: 10, deadlineMs: 20, now: () => time,
    probe: async () => evidence(diagnostics(1, fakeStart - 10, fakeStart, 678.8)),
  })).rejects.toMatchObject({ code: 'event_loop_stall' });
  const legacyFailure = { phase: 'failed', error: failed.error, attempts: 1, updatedAt: fakeStart - 500 };
  expect(readRuntimeRecoveryAttempts(home, binding.requestId, binding.executionId)).toMatchObject([
    { actor: { user_id: 'agent' }, failedPhase: 'failed', failure: legacyFailure, code: 'event_loop_stall' },
  ]);
  expect(readRuntimeHandoff(home, binding.requestId, binding.executionId)).toEqual(failed);

  time = fakeStart;
  probes = 0;
  const recovered = await observeFailedRuntimeHandoff(failed, { user_id: 'agent' }, {
    observationMs: 10, deadlineMs: 20, now: () => time, wait: async () => { time += 10; },
    probe: async () => ++probes === 1 ? evidence(diagnostics(1, fakeStart - 30, fakeStart - 10, 678.8)) : evidence(diagnostics(2, fakeStart - 10, fakeStart + 10)),
  });
  expect(recovered.recovery).toMatchObject({ failure: legacyFailure, receipt: { daemonLogOffset: 0, historicalDiagnostics: { logEvents: { retained: [{ event: 'daemon_event_loop_lag' }] } } } });
  expect(readRuntimeHandoff(home, binding.requestId, binding.executionId)?.phase).toBe('failed');

  time = fakeStart; probes = 0;
  await expect(observeFailedRuntimeHandoff(failed, { user_id: 'agent' }, {
    observationMs: 10, deadlineMs: 20, now: () => time, wait: async () => { time += 10; },
    probe: async () => {
      if (++probes === 2) fs.writeFileSync(executable, 'changed during observation');
      return probes === 1 ? evidence(diagnostics(1, fakeStart - 30, fakeStart - 10, 678.8)) : evidence(diagnostics(2, fakeStart - 10, fakeStart + 10));
    },
  })).rejects.toThrow(`Observed installation changed: ${executable}`);
  expect(readRuntimeRecoveryAttempts(home, binding.requestId, binding.executionId).at(-1)).toMatchObject({ code: 'recovery_observation_failed', message: expect.stringContaining('Observed installation changed') });
  fs.writeFileSync(executable, executable);

  fs.appendFileSync(log, JSON.stringify({ level: 'error', message: 'ingestion_worker_error', time: new Date(fakeStart - 100).toISOString() }) + '\n');
  time = fakeStart; probes = 0;
  await expect(observeFailedRuntimeHandoff(failed, { user_id: 'agent' }, {
    observationMs: 10, deadlineMs: 20, now: () => time, wait: async () => { time += 10; },
    probe: async () => ++probes === 1 ? evidence(diagnostics(1, fakeStart - 30, fakeStart - 10)) : evidence(diagnostics(2, fakeStart - 10, fakeStart + 10)),
  })).rejects.toMatchObject({ code: 'log_assessment_failed' });
  expect(readRuntimeHandoff(home, binding.requestId, binding.executionId)).toEqual(failed);
  expect(readRuntimeRecoveryAttempts(home, binding.requestId, binding.executionId).at(-1)).toMatchObject({ code: 'log_assessment_failed', evidence: { failures: [expect.stringContaining('ingestion_worker_error')] } });
  time = fakeStart;
  await expect(observeFailedRuntimeHandoff(readRuntimeHandoff(home, binding.requestId, binding.executionId)!, { user_id: 'agent' }, {
    observationMs: 10, deadlineMs: 20, now: () => time,
    probe: async () => evidence(diagnostics(3, fakeStart - 10, fakeStart, 678.8)),
  })).rejects.toMatchObject({ code: 'event_loop_stall' });
  expect(readRuntimeRecoveryAttempts(home, binding.requestId, binding.executionId).at(-1)).toMatchObject({ code: 'event_loop_stall', evidence: { lastSample: { eventLoop: { maxMs: 678.8 } } } });
});

it('records a refused recovery without overwriting a concurrently accepted receipt', async () => {
  const { home, dir, binding } = fixture();
  const nativeApp = path.join(home, 'Mandible.app');
  const resources = path.join(nativeApp, 'Contents/Resources');
  fs.mkdirSync(path.join(home, 'dist'), { recursive: true });
  fs.mkdirSync(resources, { recursive: true });
  fs.mkdirSync(path.join(nativeApp, 'Contents/MacOS'), { recursive: true });
  for (const file of [path.join(home, 'dist/build-revision.json'), path.join(resources, 'build-revision.json')]) fs.writeFileSync(file, '{}');
  for (const file of [path.join(home, 'dist/index.js'), path.join(nativeApp, 'Contents/MacOS/mandible-app')]) fs.writeFileSync(file, file);
  const completedBinding = { ...binding, nativeApp };
  const failure = { phase: 'observing', code: 'event_loop_lag', message: 'lag', failedAt: 10 };
  const failed = { schema: 'mandible-runtime-handoff@1', binding: completedBinding, bindingDigest: bindingDigest(completedBinding), phase: 'failed', attempts: 1, updatedAt: 10, failure };
  fs.writeFileSync(path.join(dir, 'journal.json'), JSON.stringify(failed));
  const active = path.join(home, 'config/local-sessions/handoff-active.json');
  fs.mkdirSync(path.dirname(active), { recursive: true });
  fs.writeFileSync(active, JSON.stringify({ journal: path.join(dir, 'journal.json'), bindingDigest: failed.bindingDigest }));
  const recovery = { failure, failureDigest: createHash('sha256').update(JSON.stringify(failure)).digest('hex'), digest: 'accepted-recovery' };
  const accepted = { ...failed, recovery };
  const refusal = new RuntimeHealthObservationError('event_loop_stall', 'stall', { maxMs: 678.8 });
  let persisted = false;
  Object.defineProperty(refusal, 'message', { configurable: true, get() {
    if (!persisted) { persisted = true; persistRuntimeRecoveryObservation(accepted); }
    return 'stall';
  } });
  await expect(observeFailedRuntimeHandoff(failed, { user_id: 'agent' }, {
    probe: async () => { throw refusal; },
  })).rejects.toBe(refusal);
  expect(persisted).toBe(true);
  expect(readRuntimeHandoff(home, binding.requestId, binding.executionId)?.recovery).toEqual(recovery);
  expect(readRuntimeRecoveryAttempts(home, binding.requestId, binding.executionId)).toMatchObject([
    { actor: { user_id: 'agent' }, failedPhase: 'failed', code: 'event_loop_stall' },
  ]);
});
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
  expect(execFileSync(runtime, [helper, 'worker', path.join(dir, 'journal.json')], { encoding: 'utf8', timeout: STATE_DEADLINE_MS })).toBe('');
  expect(readRuntimeHandoff(journal.binding.home, journal.binding.requestId, journal.binding.executionId)?.phase).toBe('failed');
});


it('replays accepted recovery with the qualified controller and still rejects a changed process', async () => {
  const { home, dir, binding, journal } = fixture();
  const repo = createAuthCheckRepo(); roots.push(repo);
  const qualified = path.join(home, 'qualified'); fs.mkdirSync(qualified);
  for (const name of ['runtime-handoff.mjs', 'runtime-handoff-lock.mjs', 'process-group-supervisor.mjs', 'runtime-log-assessment.mjs', 'runtime-environment.mjs']) {
    fs.copyFileSync(path.join(process.cwd(), 'scripts', name), path.join(qualified, name));
  }
  fs.mkdirSync(path.join(home, 'src'));
  fs.copyFileSync(path.join(process.cwd(), 'src/runtime-health-contract.ts'), path.join(home, 'src/runtime-health-contract.ts'));
  const legacyMarker = path.join(home, 'legacy-controller-used');
  const legacy = `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(legacyMarker)}, 'used'); console.log(JSON.stringify({ health: { ready: true } }));`;
  fs.writeFileSync(path.join(dir, 'controller.mjs'), legacy);
  fs.mkdirSync(path.join(repo, 'scripts'));
  fs.writeFileSync(path.join(repo, 'scripts/local-runtime.mjs'), legacy);
  const identity = { pid: 123, startedAt: 'retained exact start', startupEpoch: 'retained epoch' };
  const current = path.join(qualified, 'local-runtime.mjs');
  fs.writeFileSync(current, `console.log(${JSON.stringify(JSON.stringify({ process: identity }))});`);
  const completedBinding = { ...binding, root: repo, mergeCommit: git(repo, ['rev-parse', 'HEAD']) };
  const completed = { ...journal, binding: completedBinding, bindingDigest: bindingDigest(completedBinding), environment: {},
    phase: 'complete', recovery: { digest: 'accepted-recovery' },
    receipt: { bindingDigest: bindingDigest(completedBinding), evidence: { process: identity }, files: {} } };
  const runtime = await import(pathToFileURL(path.join(qualified, 'runtime-handoff.mjs')).href);
  await expect(runtime.verifyRuntimeHandoffReceipt(completed)).resolves.toMatchObject({ evidence: { process: identity } });
  fs.unlinkSync(path.join(dir, 'controller.mjs')); // acknowledgment already retired staged material
  const acknowledged = { ...completed, phase: 'acknowledged' };
  fs.writeFileSync(path.join(dir, 'journal.json'), JSON.stringify(acknowledged));
  await expect(runtime.acknowledgeRuntimeHandoff(completedBinding)).resolves.toBeUndefined();
  expect(fs.existsSync(legacyMarker)).toBe(false);
  const before = fs.readFileSync(path.join(dir, 'journal.json'), 'utf8');
  fs.writeFileSync(current, `console.log(${JSON.stringify(JSON.stringify({ process: { ...identity, pid: 456 } }))});`);
  await expect(runtime.acknowledgeRuntimeHandoff(completedBinding)).rejects.toThrow('process changed');
  expect(fs.readFileSync(path.join(dir, 'journal.json'), 'utf8')).toBe(before);
});

/** A copy of the handoff scripts whose current verifier runs `controller`, plus a completed journal on disk. */
async function completedHandoff(controller: string) {
  const { home, dir, binding, journal } = fixture();
  const repo = createAuthCheckRepo(); roots.push(repo);
  const qualified = path.join(home, 'qualified'); fs.mkdirSync(qualified);
  for (const name of ['runtime-handoff.mjs', 'runtime-handoff-lock.mjs', 'process-group-supervisor.mjs', 'runtime-log-assessment.mjs', 'runtime-environment.mjs']) {
    fs.copyFileSync(path.join(process.cwd(), 'scripts', name), path.join(qualified, name));
  }
  fs.mkdirSync(path.join(home, 'src'));
  fs.copyFileSync(path.join(process.cwd(), 'src/runtime-health-contract.ts'), path.join(home, 'src/runtime-health-contract.ts'));
  fs.writeFileSync(path.join(qualified, 'local-runtime.mjs'), controller);
  const completedBinding = { ...binding, root: repo, mergeCommit: git(repo, ['rev-parse', 'HEAD']), domain: `gui/${process.getuid!()}`, stagedFiles: {} };
  const completed = { ...journal, binding: completedBinding, bindingDigest: bindingDigest(completedBinding), environment: {},
    phase: 'complete', recovery: { digest: 'accepted-recovery' }, helperLabel: 'bio.mll.mandible.test.absent-helper', helperPlist: path.join(home, 'absent.plist'),
    receipt: { bindingDigest: bindingDigest(completedBinding), evidence: { process: HANDOFF_PROCESS }, files: {} } };
  fs.writeFileSync(path.join(dir, 'journal.json'), JSON.stringify(completed));
  const runtime = await import(pathToFileURL(path.join(qualified, 'runtime-handoff.mjs')).href);
  return { dir, binding: completedBinding, runtime, journalFile: path.join(dir, 'journal.json') };
}
const HANDOFF_PROCESS = { pid: 123, startedAt: 'retained exact start', startupEpoch: 'retained epoch' };
const answerProcess = `console.log(${JSON.stringify(JSON.stringify({ process: HANDOFF_PROCESS }))});`;

it('records the start of acknowledgment cleanup once, however often a failed cleanup is retried', async () => {
  const { dir, binding, runtime, journalFile } = await completedHandoff(answerProcess);
  // Generated material that changed type blocks cleanup on every attempt.
  fs.mkdirSync(path.join(dir, 'helper.log'));

  await expect(runtime.acknowledgeRuntimeHandoff(binding)).rejects.toThrow('changed type');
  const first = fs.readFileSync(journalFile, 'utf8');
  expect(JSON.parse(first).cleanupStartedAt).toEqual(expect.any(Number));
  await expect(runtime.acknowledgeRuntimeHandoff(binding)).rejects.toThrow('changed type');
  expect(fs.readFileSync(journalFile, 'utf8')).toBe(first);
});

it('leaves a journal another acknowledger advanced during the probe as that acknowledger wrote it', async () => {
  // The probe stands in for the concurrent acknowledger finishing first.
  const { binding, runtime, journalFile } = await completedHandoff(`import fs from 'node:fs';
const file = process.env.MANDIBLE_RUNTIME_HANDOFF_JOURNAL;
const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
if (journal.phase === 'complete') fs.writeFileSync(file, JSON.stringify({ ...journal, phase: 'acknowledged', cleanupStartedAt: 1, acceptedAt: 2 }));
${answerProcess}`);

  await expect(runtime.acknowledgeRuntimeHandoff(binding)).resolves.toBeUndefined();
  expect(JSON.parse(fs.readFileSync(journalFile, 'utf8'))).toMatchObject({ phase: 'acknowledged', cleanupStartedAt: 1, acceptedAt: 2 });
});
