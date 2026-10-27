// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import * as childProcess from 'node:child_process';
import * as supervisor from '../scripts/process-group-supervisor.mjs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createAuthCheckRepo, git } from './helpers/auth-queue-fixtures.js';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { bindingDigest, handoffDirectory, observeFailedRuntimeHandoff, observeRuntimeHealthWindow, persistRuntimeRecoveryObservation, readRuntimeHandoff, readRuntimeRecoveryAttempts, runtimeHandoffDrainIdentity, stageHandoffController, verifyRuntimeHandoffReceipt } from '../scripts/runtime-handoff.mjs';
import { assessRuntimeLogs } from '../scripts/runtime-log-assessment.mjs';
import { RuntimeHealthObservationError } from '../src/runtime-health-contract.ts';
import { rotateStderrLogSegments } from '../src/daemon-log.ts';
import { resolveStderrLogCoverage } from '../src/stderr-log-chain.ts';
import { STATE_DEADLINE_MS } from './helpers/wait-until.js';

vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});
vi.mock('../scripts/process-group-supervisor.mjs', async original => {
  const actual = await original<typeof import('../scripts/process-group-supervisor.mjs')>();
  return { ...actual, runSupervisedCommand: vi.fn(actual.runSupervisedCommand) };
});

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.mocked(childProcess.spawnSync).mockReset(); vi.mocked(supervisor.runSupervisedCommand).mockReset(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
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

it('records stalls and lag inside the window once per interval, and completes once fresh samples cover it', async () => {
  let time = 100;
  const samples = [
    runtimeEvidence(diagnostics(4, 0, 90, 678.8)),
    runtimeEvidence(diagnostics(5, 90, 110, 3_700, true)),
    runtimeEvidence(diagnostics(5, 90, 110, 3_700, true)),
    runtimeEvidence(diagnostics(6, 110, 130)),
  ];
  let probes = 0;
  const result = await observeRuntimeHealthWindow({
    observationMs: 20,
    deadlineMs: 40,
    now: () => time,
    wait: async (milliseconds: number) => { time += milliseconds / 100; },
    probe: async () => samples[Math.min(probes++, samples.length - 1)],
  });
  expect(result.performance).toEqual({ omitted: 0, findings: [
    expect.objectContaining({ code: 'event_loop_stall', sample: expect.objectContaining({ sequence: 4, maxMs: 678.8 }) }),
    expect.objectContaining({ code: 'event_loop_lag', sample: expect.objectContaining({ sequence: 5 }) }),
    expect.objectContaining({ code: 'event_loop_stall', sample: expect.objectContaining({ sequence: 5, maxMs: 3_700 }) }),
  ] });
  expect(result.samples.last.eventLoop.sequence).toBe(6);
  expect(result.observation).toMatchObject({ startedAt: 100, mustCover: 120 });
});

it('refuses stale diagnostics and changed process identity', async () => {
  let time = 100;
  const initial = runtimeEvidence(diagnostics(4, 80, 90));
  await expect(observeRuntimeHealthWindow({
    observationMs: 10,
    deadlineMs: 20,
    now: () => time,
    wait: async () => { time += 20; },
    probe: async () => initial,
  })).rejects.toMatchObject({ code: 'stale_diagnostics' });
  time = 100;
  await expect(observeRuntimeHealthWindow({
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
      observationMs: 10, deadlineMs: 20, now: () => time,
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

it('records health log events without failing, while error rows stay fatal', () => {
  const lag = JSON.stringify({ time: '2026-10-23T22:31:15.548Z', level: 'warn', message: 'daemon_event_loop_lag', p95_ms: 199.4, max_ms: 3841.2 });
  const stall = JSON.stringify({ time: '2026-10-23T22:32:01.000Z', level: 'warn', message: 'daemon_event_loop_stall', max_ms: 3700 });
  const memory = JSON.stringify({ level: 'warn', message: 'daemon_memory_warning' });
  const error = JSON.stringify({ time: '2026-10-23T22:31:16.000Z', level: 'error', message: 'ingestion_worker_error' });
  expect(assessRuntimeLogs([lag, stall, memory].join('\n'))).toMatchObject({ failures: [], diagnostics: { health_events: { omitted: 0, retained: [
    { event: 'daemon_event_loop_lag', max_ms: 3841.2 }, { event: 'daemon_event_loop_stall', max_ms: 3700 }, { event: 'daemon_memory_warning', time: null },
  ] } } });
  expect(assessRuntimeLogs([stall, error].join('\n')).failures).toEqual([error]);
});

function recoveryFixture(logLines: (processStartedAt: string, fakeStart: number) => string[], processStart?: string) {
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
  const processStartedAt = processStart ?? execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
  const fakeStart = Date.now();
  const log = path.join(home, 'daemon.log');
  fs.writeFileSync(log, logLines(processStartedAt, fakeStart).join('\n') + '\n');
  const completedBinding = { ...binding, root: repo, nativeApp, mergeCommit: git(repo, ['rev-parse', 'HEAD']) };
  const failed = { schema: 'mandible-runtime-handoff@1', binding: completedBinding, bindingDigest: bindingDigest(completedBinding), phase: 'failed', attempts: 1, error: 'Candidate runtime changed or became unhealthy.', updatedAt: fakeStart - 500, database: path.join(home, 'mandible.db') };
  fs.writeFileSync(path.join(dir, 'journal.json'), JSON.stringify(failed));
  const active = path.join(home, 'config/local-sessions/handoff-active.json'); fs.mkdirSync(path.dirname(active), { recursive: true });
  fs.writeFileSync(active, JSON.stringify({ journal: path.join(dir, 'journal.json'), bindingDigest: failed.bindingDigest }));
  const evidence = (sample: ReturnType<typeof diagnostics>) => {
    const stat = fs.statSync(log);
    return { process: { pid: process.pid, startedAt: processStartedAt, startupEpoch: 'epoch' }, backend: { file: backend }, gateway: { file: gateway }, daemonLog: { path: log, dev: stat.dev, ino: stat.ino, size: stat.size }, health: { instance: { db_path: failed.database }, ...sample } };
  };
  return { home, binding, executable, processStartedAt, fakeStart, log, failed, evidence };
}

const startupLine = (processStartedAt: string) => JSON.stringify({ message: 'server_started', time: new Date(Date.parse(processStartedAt) + 1000).toISOString() });

it('runs real recovery observation through complete log and journal evidence', async () => {
  const { home, binding, executable, fakeStart, log, failed, evidence } = recoveryFixture((processStartedAt, fakeStart) => [
    startupLine(processStartedAt),
    JSON.stringify({ level: 'warn', message: 'daemon_event_loop_stall', time: new Date(fakeStart - 1000).toISOString(), p95_ms: 199.4, max_ms: 3700 }),
  ]);
  const legacyFailure = { phase: 'failed', error: failed.error, attempts: 1, updatedAt: fakeStart - 500 };
  let time = fakeStart;
  let probes = 0;
  const recovered = await observeFailedRuntimeHandoff(failed, { user_id: 'agent' }, {
    observationMs: 10, deadlineMs: 20, now: () => time, wait: async () => { time += 10; },
    probe: async () => ++probes === 1 ? evidence(diagnostics(1, fakeStart - 30, fakeStart - 10)) : evidence(diagnostics(2, fakeStart - 10, fakeStart + 10, 3_700)),
  });
  expect(recovered.recovery).toMatchObject({ failure: legacyFailure, receipt: { daemonLogOffset: 0, performance: {
    healthFindings: { findings: [{ code: 'event_loop_stall', sample: { sequence: 2, maxMs: 3_700 } }], omitted: 0 },
    logEvents: { retained: [{ event: 'daemon_event_loop_stall', max_ms: 3700 }], omitted: 0 },
  } } });
  expect(readRuntimeRecoveryAttempts(home, binding.requestId, binding.executionId)).toEqual([]);
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
  expect(readRuntimeRecoveryAttempts(home, binding.requestId, binding.executionId)).toMatchObject([
    { actor: { user_id: 'agent' }, failedPhase: 'failed', failure: legacyFailure, code: 'recovery_observation_failed' },
    { code: 'log_assessment_failed', evidence: { failures: [expect.stringContaining('ingestion_worker_error')] } },
  ]);
});

it.each(['running', 'running-unreplaced', 'closed', 'relaunch-fails', 'exits-after-relaunch'] as const)('requires the desktop before accepting recovery: %s', async state => {
  const processStart = new Date(Date.now() - 2000).toISOString();
  const f = recoveryFixture(startedAt => [startupLine(startedAt)], processStart);
  const binding = { ...f.failed.binding, desktopWasRunning: true };
  const failed = { ...f.failed, binding, bindingDigest: bindingDigest(binding), stages: state === 'running-unreplaced' ? {} : { desktopRelaunch: { completedAt: 1 } } };
  const dir = handoffDirectory(binding.home, binding.requestId, binding.executionId);
  fs.writeFileSync(path.join(dir, 'journal.json'), JSON.stringify(failed));
  fs.writeFileSync(path.join(binding.home, 'config/local-sessions/handoff-active.json'), JSON.stringify({ journal: path.join(dir, 'journal.json'), bindingDigest: failed.bindingDigest }));
  let running = state === 'running' || state === 'running-unreplaced';
  const spawnSync = vi.mocked(childProcess.spawnSync).getMockImplementation()!;
  vi.mocked(childProcess.spawnSync).mockImplementation(((binary: string, args: string[], options: any) => {
    if (binary === '/bin/ps' && args.includes(String(process.pid))) return { status: 0, stdout: processStart };
    if (binary === '/usr/bin/pgrep') return { status: running ? 0 : 1, stdout: running ? '987654\n' : '' };
    if (binary === '/bin/ps' && args.includes('987654')) return { status: 0, stdout: `${binding.nativeApp}/Contents/MacOS/mandible-app` };
    return spawnSync(binary, args, options);
  }) as typeof spawnSync);
  const relaunch = vi.mocked(supervisor.runSupervisedCommand).mockImplementation(async () => {
    if (state === 'relaunch-fails') throw new Error('fixture relaunch failed');
    running = state !== 'exits-after-relaunch';
  });
  let time = f.fakeStart;
  let probes = 0;
  const observe = () => observeFailedRuntimeHandoff(failed, { kind: 'daemon_reconciliation' }, {
    observationMs: 10, deadlineMs: 20, now: () => time, wait: async () => { time += 10; },
    probe: async () => {
      expect(running).toBe(true);
      return ++probes === 1 ? f.evidence(diagnostics(1, f.fakeStart - 30, f.fakeStart - 10)) : f.evidence(diagnostics(2, f.fakeStart - 10, f.fakeStart + 10));
    },
  });
  if (state === 'relaunch-fails' || state === 'exits-after-relaunch') {
    await expect(observe()).rejects.toThrow(state === 'relaunch-fails' ? 'Installed desktop could not be relaunched' : 'Installed desktop did not remain running');
    expect(readRuntimeHandoff(binding.home, binding.requestId, binding.executionId)?.phase).toBe('failed');
    expect(readRuntimeRecoveryAttempts(binding.home, binding.requestId, binding.executionId)).toHaveLength(1);
  } else {
    const recovered = await observe();
    expect(recovered.recovery.receipt).toBeDefined();
    expect(readRuntimeHandoff(binding.home, binding.requestId, binding.executionId)?.stages.desktopRelaunch.completedAt).toEqual(state === 'running' ? 1 : expect.any(Number));
    // Receipt verification is the acknowledgment gate, including after acceptance.
    const complete = { ...recovered, phase: 'complete', receipt: recovered.recovery.receipt };
    running = false;
    await expect(verifyRuntimeHandoffReceipt(complete, { probe: false })).rejects.toThrow('Installed desktop did not remain running');
  }
  expect(relaunch).toHaveBeenCalledTimes(state === 'running' ? 0 : 1);
  if (state !== 'running') expect(relaunch).toHaveBeenCalledWith('/bin/bash', ['cli/install-desktop-app.sh', '--relaunch', binding.nativeApp, 'mandible-app', '0'], expect.objectContaining({ cwd: binding.root, timeout: 15000 }));
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
  const refusal = new RuntimeHealthObservationError('diagnostics_gap', 'gap', { priorSequence: 4 });
  let persisted = false;
  Object.defineProperty(refusal, 'message', { configurable: true, get() {
    if (!persisted) { persisted = true; persistRuntimeRecoveryObservation(accepted); }
    return 'gap';
  } });
  await expect(observeFailedRuntimeHandoff(failed, { user_id: 'agent' }, {
    probe: async () => { throw refusal; },
  })).rejects.toBe(refusal);
  expect(persisted).toBe(true);
  expect(readRuntimeHandoff(home, binding.requestId, binding.executionId)?.recovery).toEqual(recovery);
  expect(readRuntimeRecoveryAttempts(home, binding.requestId, binding.executionId)).toMatchObject([
    { actor: { user_id: 'agent' }, failedPhase: 'failed', code: 'diagnostics_gap' },
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

const rotate = (log: string) => rotateStderrLogSegments({ filePath: log, maxBytes: 1, keepSegments: 3 });
const info = (message: string, time: number) => JSON.stringify({ level: 'info', message, time: new Date(time).toISOString() }) + '\n';
const freshProbe = (evidence: (sample: ReturnType<typeof diagnostics>) => unknown, fakeStart: number, onProbe: (probe: number) => void = () => {}) => {
  let probes = 0;
  return async () => {
    onProbe(++probes);
    return probes === 1 ? evidence(diagnostics(1, fakeStart - 30, fakeStart - 10)) : evidence(diagnostics(2, fakeStart - 10, fakeStart + 10));
  };
};

it('recovers a live generation whose startup has rotated out of the current log', async () => {
  const { fakeStart, log, failed, evidence } = recoveryFixture((processStartedAt, fakeStart) => [
    startupLine(processStartedAt),
    JSON.stringify({ level: 'warn', message: 'daemon_event_loop_lag', time: new Date(fakeStart - 5000).toISOString(), p95_ms: 199.4, max_ms: 3841.2 }),
  ]);
  rotate(log);
  fs.appendFileSync(log, info('between_rotations', fakeStart - 4000));
  rotate(log);
  fs.appendFileSync(log, info('after_rotation', fakeStart - 3000));
  const covered = [`${log}.2`, `${log}.1`, log].reduce((total, file) => total + fs.statSync(file).size, 0);
  let time = fakeStart;
  const recovered = await observeFailedRuntimeHandoff(failed, { user_id: 'agent' }, {
    observationMs: 10, deadlineMs: 20, now: () => time, wait: async () => { time += 10; },
    probe: freshProbe(evidence, fakeStart),
  });
  expect(recovered.recovery.receipt).toMatchObject({
    daemonLogOffset: 0,
    daemonLogBytes: covered,
    daemonLogSegments: [{ path: `${log}.2` }, { path: `${log}.1` }],
    performance: { logEvents: { retained: [{ event: 'daemon_event_loop_lag' }] } },
  });
});

it('still assesses every rotated segment back to startup', async () => {
  const { fakeStart, log, failed, evidence } = recoveryFixture(processStartedAt => [startupLine(processStartedAt)]);
  fs.appendFileSync(log, JSON.stringify({ level: 'error', message: 'ingestion_worker_error', time: new Date(fakeStart - 5000).toISOString() }) + '\n');
  rotate(log);
  fs.appendFileSync(log, info('after_rotation', fakeStart - 3000));
  let time = fakeStart;
  await expect(observeFailedRuntimeHandoff(failed, { user_id: 'agent' }, {
    observationMs: 10, deadlineMs: 20, now: () => time, wait: async () => { time += 10; },
    probe: freshProbe(evidence, fakeStart),
  })).rejects.toMatchObject({ code: 'log_assessment_failed', evidence: { failures: [expect.stringContaining('ingestion_worker_error')] } });
});

it('refuses a rotation during observation, even one the samples do not see', async () => {
  const filler = (fakeStart: number) => Array.from({ length: 20 }, (_, index) => info(`filler_${index}`, fakeStart - 2000).trimEnd());
  for (const regrow of [false, true]) {
    const { fakeStart, log, failed, evidence } = recoveryFixture((processStartedAt, fakeStart) => [startupLine(processStartedAt), ...filler(fakeStart)]);
    const before = fs.statSync(log).size;
    let time = fakeStart;
    await expect(observeFailedRuntimeHandoff(failed, { user_id: 'agent' }, {
      observationMs: 10, deadlineMs: 20, now: () => time, wait: async () => { time += 10; },
      probe: freshProbe(evidence, fakeStart, probe => {
        if (probe !== 2) return;
        rotate(log);
        while (regrow && fs.statSync(log).size <= before) fs.appendFileSync(log, info('regrown', fakeStart));
      }),
    })).rejects.toMatchObject({ code: 'log_changed', message: regrow ? 'Daemon log rotated or truncated during observation.' : 'Candidate runtime log rotated or truncated during observation.' });
  }
});

it('requires an unbroken, retained rotation chain to the current startup', async () => {
  const { home } = fixture();
  const log = path.join(home, 'daemon.log');
  const startedAt = '2026-10-24T01:00:00Z';
  const live = () => { const stat = fs.statSync(log); return { path: log, dev: stat.dev, ino: stat.ino, size: stat.size }; };
  const stale = JSON.stringify({ message: 'server_started', time: '2020-01-01T00:00:00Z' }) + '\n';
  const startup = JSON.stringify({ message: 'server_started', time: '2026-10-24T01:00:01Z' }) + '\n';
  fs.writeFileSync(log, stale + startup + info('healthy', Date.parse(startedAt)));
  await expect(resolveStderrLogCoverage(live(), startedAt)).resolves.toMatchObject({ segments: [], offset: Buffer.byteLength(stale) });
  await expect(resolveStderrLogCoverage(live(), '2026-10-25T00:00:00Z')).rejects.toMatchObject({ code: 'log_startup_mismatch' });
  await expect(resolveStderrLogCoverage(live(), startedAt, { limit: 10 })).rejects.toMatchObject({ code: 'log_coverage_limit' });
  const truncated = live();
  fs.truncateSync(log, 0);
  await expect(resolveStderrLogCoverage(truncated, startedAt)).rejects.toMatchObject({ code: 'log_changed' });

  fs.writeFileSync(log, startup);
  rotate(log);
  fs.appendFileSync(log, info('after_first', Date.parse(startedAt)));
  rotate(log);
  await expect(resolveStderrLogCoverage(live(), startedAt)).resolves.toMatchObject({ segments: [{ path: `${log}.2` }, { path: `${log}.1` }], offset: 0 });
  const original = fs.readFileSync(`${log}.2`);
  fs.writeFileSync(`${log}.2`, Buffer.from(original.toString('utf8').replace('01:00:01', '01:00:02')));
  await expect(resolveStderrLogCoverage(live(), startedAt)).rejects.toMatchObject({ code: 'log_coverage_broken' });
  fs.rmSync(`${log}.2`);
  await expect(resolveStderrLogCoverage(live(), startedAt)).rejects.toMatchObject({ code: 'log_coverage_expired' });

  // A rotation that predates rotation records leaves no verifiable link.
  fs.writeFileSync(log, info('after_legacy_rotation', Date.parse(startedAt)));
  await expect(resolveStderrLogCoverage(live(), startedAt)).rejects.toMatchObject({ code: 'log_startup_absent', message: 'Current daemon startup is absent from its actual log.' });
});

it('never requests a drain from failed, completed or unacknowledged journals', () => {
  const { journal } = fixture();
  for (const phase of ['failed', 'complete', 'acknowledged', 'armed']) expect(runtimeHandoffDrainIdentity({ ...journal, phase })).toBeNull();
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


/** Copy the handoff controller and the daemon modules it imports, as a qualified installation lays them out. */
function installQualifiedController(home: string): string {
  const qualified = path.join(home, 'qualified'); fs.mkdirSync(qualified);
  for (const name of ['runtime-handoff.mjs', 'runtime-handoff-lock.mjs', 'process-group-supervisor.mjs', 'runtime-log-assessment.mjs', 'runtime-environment.mjs']) {
    fs.copyFileSync(path.join(process.cwd(), 'scripts', name), path.join(qualified, name));
  }
  fs.mkdirSync(path.join(home, 'src'));
  for (const name of ['runtime-health-contract.ts', 'stderr-log-chain.ts']) fs.copyFileSync(path.join(process.cwd(), 'src', name), path.join(home, 'src', name));
  fs.mkdirSync(path.join(home, 'scripts'));
  fs.copyFileSync(path.join(process.cwd(), 'scripts/runtime-probe-cadence.mjs'), path.join(home, 'scripts/runtime-probe-cadence.mjs'));
  return qualified;
}

it('loads a frozen handoff controller with its complete probe-cadence import closure', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-controller-closure-')); roots.push(home);
  stageHandoffController(process.cwd(), home);
  const runtime = execFileSync('/bin/sh', ['scripts/bun-runtime.sh'], { encoding: 'utf8' }).trim();
  const program = `const {awaitHandoffReadiness}=await import(${JSON.stringify(pathToFileURL(path.join(home, 'controller.mjs')).href)}); console.log(typeof awaitHandoffReadiness);`;
  expect(execFileSync(runtime, ['--eval', program], { encoding: 'utf8', timeout: STATE_DEADLINE_MS,
    cwd: home, env: { ...process.env, MANDIBLE_HOME: path.join(home, 'private-home') } })).toBe('function\n');
});

it('replays accepted recovery with the qualified controller and still rejects a changed process', async () => {
  const { home, dir, binding, journal } = fixture();
  const repo = createAuthCheckRepo(); roots.push(repo);
  const qualified = installQualifiedController(home);
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
  const qualified = installQualifiedController(home);
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
