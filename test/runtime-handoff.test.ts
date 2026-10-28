// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { bindingDigest, handoffDirectory, runRuntimeHandoffWorker, observeRuntimeHealthWindow, readRuntimeHandoff, closeQuiescentRuntimeHandoff, acknowledgeRuntimeHandoff, withRuntimeObservation } from '../scripts/runtime-handoff.mjs';
import { assessRuntimeLogs } from '../scripts/runtime-log-assessment.mjs';
import { RuntimeObservationError } from '../scripts/runtime-observation.mjs';
import { runtimeReceiptAcceptanceMarker } from '../scripts/runtime-observation.mjs';
import { createHash } from 'node:crypto';
import * as childProcess from 'node:child_process';
import SqliteDatabase from '../src/sqlite.js';
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawnSync: vi.fn((await original<typeof import('node:child_process')>()).spawnSync) }));
const originalSpawn = (await vi.importActual<typeof import('node:child_process')>('node:child_process')).spawnSync;
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
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

it('covers actual activation with a fresh collector turn without waiting for the periodic window', async () => {
  let time = 100;
  let completed: number | null = null;
  const observed = await observeRuntimeHealthWindow({
    now: () => time, observationMs: 0, deadlineMs: 30,
    live: { startedAt: 100, through: () => completed },
    wait: async () => { completed = 105; time = 110; },
    probe: async () => runtimeEvidence({ ...diagnostics(1, 0, 90), current: { observedAt: time, collectorTurnMs: 1,
      eventLoop: { sequence: 1, intervalStartedAt: 90, intervalEndedAt: time, maxMs: 300, warning: false },
      memory: { sequence: 1, intervalStartedAt: 90, intervalEndedAt: time, warning: false, rssFraction: 0.1, warningThresholdFraction: 0.8 } } }),
  });
  expect(observed.observation).toMatchObject({ startedAt: 100, mustCover: 105, completedAt: 110 });
  expect(observed.performance.findings).toContainEqual(expect.objectContaining({ code: 'event_loop_stall', sample: expect.objectContaining({ maxMs: 300 }) }));
});


function fixture() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-attempt-'))); roots.push(home);
  const binding = { home, requestId: 'request-fixture', executionId: 'execution-fixture', root: path.join(home, 'removed-checkout'),
    runtime: { path: '/retained/bun', sha256: 'historical' }, acceptedRelease: { reference: 'accepted-fixture' },
    nativeApp: path.join(home, 'Mandible.app'), oldProcess: { pid: 999999, startedAt: 'gone' }, desktopWasRunning: true };
  const dir = handoffDirectory(home, binding.requestId, binding.executionId); fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(binding.nativeApp, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(binding.nativeApp, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>bio.mll.mandible.fixture</string></dict></plist>');
  const journal = { schema: 'mandible-runtime-handoff@1', binding, bindingDigest: bindingDigest(binding), phase: 'failed',
    error: 'original failure', failure: { message: 'original failure' }, deadline: 1, bridgeInstalled: true };
  const file = path.join(dir, 'journal.json'); fs.writeFileSync(file, JSON.stringify(journal));
  fs.writeFileSync(path.join(home, 'config/local-sessions/handoff-active.json'), JSON.stringify({ journal: file, bindingDigest: journal.bindingDigest }));
  return { home, file, binding, journal };
}

it('resumes an installed-before-launch interruption through the same recorded attempt and restores desktop intent', async () => {
  const f = fixture();
  let installed = false;
  let interrupted = false;
  const effects: string[] = [];
  const identities = { backend: { pid: 42, startedAt: 'backend', runs: 1 }, gateway: { pid: 43, startedAt: 'gateway', runs: 1 } };
  const prepare = vi.fn(async () => { effects.push('prepare'); return { installed, packageSha256: 'exact' }; });
  const install = vi.fn(async () => { if (!installed) effects.push('replace'); installed = true; return { packageSha256: 'exact' }; });
  const control = vi.fn(async (journal, command) => {
    const stored = JSON.parse(fs.readFileSync(f.file, 'utf8'));
    if (command === 'handoff-remove') { expect(stored.attempt.effects.prepare.completedAt).toBeDefined(); expect(stored.attempt.effects.drain.issuedAt).toBeDefined(); effects.push('drain'); return '{}'; }
    if (command === 'handoff-start') {
      expect(stored.attempt.effects.replace.completedAt).toBeDefined(); expect(stored.attempt.effects.services.issuedAt).toBeDefined();
      if (!interrupted) { interrupted = true; throw new RuntimeObservationError('interrupted', 'Installed before launch.', null, 'pending'); }
      effects.push('services');
    }
    return JSON.stringify({ processes: identities });
  });
  const desktop = vi.fn(async () => { effects.push('desktop'); });
  const observe = vi.fn(async (journal, options) => {
    expect(options.observationMs).toBe(0);
    while (options.live.through() === null) await Promise.resolve();
    return { bindingDigest: journal.bindingDigest, evidence: { processes: identities }, files: {} };
  });
  const options = { actor: { provider: 'fixture' }, prepare, install, control, desktop, observe, verifyPublication: vi.fn(async () => {}) };
  const first = await runRuntimeHandoffWorker(f.file, options);
  expect(first.attempt.state, JSON.stringify(first.attempt.lastObservation)).toBe('running');
  expect(effects).toEqual(['prepare', 'drain', 'replace']);
  const resumed = await runRuntimeHandoffWorker(f.file, options);
  expect(resumed.attempt.id).toBe(first.attempt.id);
  expect(resumed).toMatchObject({ phase: 'complete', error: 'original failure', failure: f.journal.failure,
    attempt: { state: 'complete', receipt: { schema: 'mandible-runtime-receipt@1', attemptId: first.attempt.id } } });
  expect(effects).toEqual(['prepare', 'drain', 'replace', 'prepare', 'services', 'desktop']);
  await runRuntimeHandoffWorker(f.file, options);
  expect(desktop).toHaveBeenCalledOnce(); expect(observe).toHaveBeenCalledOnce();
  expect(readRuntimeHandoff(f.home, f.binding.requestId, f.binding.executionId)?.attempt.receiptDigest).toMatch(/^[a-f0-9]{64}$/);
});

it('does not drain or replace when preparation fails and preserves the previous failure', async () => {
  const f = fixture(); const control = vi.fn(); const install = vi.fn();
  const current = await runRuntimeHandoffWorker(f.file, { actor: { provider: 'fixture' }, verifyPublication: async () => {},
    prepare: async () => { throw new Error('Changed accepted package.'); }, control, install });
  expect(current).toMatchObject({ phase: 'failed', error: 'original failure', attempt: { state: 'failed', lastObservation: { reason: 'Changed accepted package.' } } });
  expect(control).not.toHaveBeenCalled(); expect(install).not.toHaveBeenCalled();
});

it('reads terminal evidence after its runtime or source checkout has been removed', () => {
  const f = fixture(); expect(readRuntimeHandoff(f.home, f.binding.requestId, f.binding.executionId)).toMatchObject(f.journal);
});

it('preserves unknown installation ownership instead of treating a failed phase as permission to release it', async () => {
  const f = fixture();
  fs.writeFileSync(f.file, JSON.stringify({ ...f.journal, bindingDigest: 'tampered' }));
  expect(await closeQuiescentRuntimeHandoff(f.home, { actor: { provider: 'fixture' } })).toMatchObject({ outcome: 'blocked' });
  expect(fs.existsSync(path.join(f.home, 'config/local-sessions/handoff-active.json'))).toBe(true);
});

it('consumes durable acceptance without probing a removed package, fences the helper, and retries cleanup separately', async () => {
  const f = fixture();
  const database = path.join(f.home, 'acceptance.db');
  const db = new SqliteDatabase(database);
  db.exec('CREATE TABLE auth_hook_executions (id TEXT, auth_request_id TEXT, hook_id TEXT, state TEXT, output TEXT, command_digest TEXT)');
  const bridge = path.join(f.home, 'bridge.mjs'); fs.writeFileSync(bridge, 'foreign');
  const binding = { ...f.binding, hookId: 'hook', commandDigest: 'command', acceptedRelease: undefined, domain: `gui/${process.getuid!()}`,
    priorBackend: { argv: ['/runtime', bridge] }, legacyBridgeSha256: createHash('sha256').update('bridge').digest('hex') };
  const digest = bindingDigest(binding);
  const receipt = { schema: 'mandible-runtime-receipt@1', bindingDigest: digest, attemptId: 'attempt', files: {} };
  const receiptDigest = createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
  const journal = { ...f.journal, binding, bindingDigest: digest, database, helperLabel: 'fixture-helper',
    attempt: { id: 'attempt', state: 'complete', effects: {}, receipt, receiptDigest }, cleanup: { state: 'pending' } };
  db.prepare('INSERT INTO auth_hook_executions VALUES (?,?,?,?,?,?)').run(binding.executionId, binding.requestId, binding.hookId, 'complete', runtimeReceiptAcceptanceMarker(journal), binding.commandDigest);
  db.close();
  fs.writeFileSync(f.file, JSON.stringify(journal));
  const active = path.join(f.home, 'config/local-sessions/handoff-active.json');
  fs.writeFileSync(active, JSON.stringify({ journal: f.file, bindingDigest: digest }));
  const mock = vi.mocked(childProcess.spawnSync);
  const calls: string[] = [];
  mock.mockImplementation((program, args, options) => {
    if (program === '/bin/launchctl') { calls.push(String(args[0])); return { status: 113, stdout: '', stderr: 'Could not find service' } as any; }
    return originalSpawn(program, args, options);
  });
  await withRuntimeObservation(journal, async () => {
    expect(await acknowledgeRuntimeHandoff(binding, { acceptedReceiptDigest: receiptDigest })).toEqual({ cleanup: 'pending' });
  });
  expect(fs.existsSync(active)).toBe(false);
  const completed = readRuntimeHandoff(f.home, binding.requestId, binding.executionId);
  expect(completed).toMatchObject({ phase: 'complete', error: 'original failure', attempt: { state: 'complete', fence: { reason: 'receipt-accepted' } }, cleanup: { state: 'pending' } });
  fs.writeFileSync(bridge, 'bridge');
  await withRuntimeObservation(completed, () => acknowledgeRuntimeHandoff(binding, { acceptedReceiptDigest: receiptDigest }));
  expect(readRuntimeHandoff(f.home, binding.requestId, binding.executionId)?.cleanup.state).toBe('complete');
  expect(calls).toEqual(['print']);
});
