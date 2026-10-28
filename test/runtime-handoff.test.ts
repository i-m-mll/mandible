// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { bindingDigest, handoffDirectory, runRuntimeHandoffWorker, readRuntimeHandoff, closeQuiescentRuntimeHandoff, acknowledgeRuntimeHandoff, runtimeHandoffNeedsAcknowledgment, cleanupRuntimeHandoff, scheduleRuntimeHandoffCleanup, withRuntimeObservation } from '../scripts/runtime-handoff.mjs';
import { installedFileIdentity } from '../scripts/installed-release.mjs';
import { waitUntil } from './helpers/wait-until.js';
import { assessRuntimeLogs } from '../scripts/runtime-log-assessment.mjs';
import { RuntimeObservationError } from '../scripts/runtime-observation.mjs';
import { runtimeReceiptAcceptanceMarker } from '../scripts/runtime-observation.mjs';
import { createHash } from 'node:crypto';
import * as childProcess from 'node:child_process';
import SqliteDatabase from '../src/sqlite.js';
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawnSync: vi.fn((await original<typeof import('node:child_process')>()).spawnSync) }));
const originalSpawn = (await vi.importActual<typeof import('node:child_process')>('node:child_process')).spawnSync;
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it('loads the composed helper bundle and refuses an invalid private worker journal before acquiring mutation ownership', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-bundle-'))); roots.push(root);
  const helper = path.join(root, 'helper.mjs');
  childProcess.execFileSync(process.execPath, ['build', path.resolve('scripts/runtime-handoff.mjs'), '--target', 'bun', '--outfile', helper], { timeout: 20_000, stdio: 'pipe' });
  const home = path.join(root, 'home');
  const file = path.join(handoffDirectory(home, 'invalid-request', 'invalid-execution'), 'journal.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schema: 'invalid', bindingDigest: '0'.repeat(64), binding: { home, requestId: 'invalid-request', executionId: 'invalid-execution' } }));
  const result = originalSpawn(process.execPath, [helper, 'worker', file], { env: { ...process.env, MANDIBLE_HOME: home }, encoding: 'utf8', timeout: 5000 });
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr.trim()).toBe('Runtime handoff binding is malformed or changed.');
  expect(fs.existsSync(path.join(home, 'config/local-sessions/.gateway.lock'))).toBe(false);
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
    expect(desktop).toHaveBeenCalledOnce();
    expect(options.until).toBe(journal.attempt.deadline);
    return { schema: 'mandible-runtime-receipt@2', bindingDigest: journal.bindingDigest, services: identities };
  });
  const options = { actor: { provider: 'fixture' }, prepare, install, control, desktop, observe, verifyPublication: vi.fn(async () => {}) };
  const first = await runRuntimeHandoffWorker(f.file, options);
  expect(first.attempt.state, JSON.stringify(first.attempt.lastObservation)).toBe('running');
  expect(effects).toEqual(['prepare', 'drain', 'replace']);
  const resumed = await runRuntimeHandoffWorker(f.file, options);
  expect(resumed.attempt.id).toBe(first.attempt.id);
  expect(resumed).toMatchObject({ phase: 'complete', error: 'original failure', failure: f.journal.failure,
    attempt: { state: 'complete', fence: { reason: 'terminal-completion' }, receipt: { schema: 'mandible-runtime-receipt@2', attemptId: first.attempt.id } } });
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

it('releases an accepted terminal receipt directly without package/native/cleanup work, preserves foreign ownership, and rejects changed receipt bytes', async () => {
  const f = fixture();
  const database = path.join(f.home, 'acceptance.db');
  const db = new SqliteDatabase(database);
  db.exec('CREATE TABLE auth_hook_executions (id TEXT, auth_request_id TEXT, hook_id TEXT, state TEXT, output TEXT, command_digest TEXT)');
  const binding = { ...f.binding, hookId: 'hook', commandDigest: 'command', domain: `gui/${process.getuid!()}` };
  const digest = bindingDigest(binding);
  const receipt = { schema: 'mandible-runtime-receipt@2', bindingDigest: digest, attemptId: 'attempt' };
  const receiptDigest = createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
  const journal = { ...f.journal, binding, bindingDigest: digest, database, helperLabel: 'fixture-historical-helper',
    attempt: { id: 'attempt', state: 'complete', effects: {}, receipt, receiptDigest, fence: { reason: 'terminal-completion' } }, cleanup: { state: 'pending' } };
  db.prepare('INSERT INTO auth_hook_executions VALUES (?,?,?,?,?,?)').run(binding.executionId, binding.requestId, binding.hookId, 'complete', runtimeReceiptAcceptanceMarker(journal), binding.commandDigest);
  db.close();
  const bytes = JSON.stringify(journal); fs.writeFileSync(f.file, bytes);
  const active = path.join(f.home, 'config/local-sessions/handoff-active.json');
  fs.writeFileSync(active, JSON.stringify({ journal: f.file, bindingDigest: digest }));
  fs.rmSync(binding.nativeApp, { recursive: true });
  vi.mocked(childProcess.spawnSync).mockImplementation((program, args, options) => {
    if (program === '/bin/launchctl') throw new Error('Terminal receipt adoption must not control native services.');
    return originalSpawn(program, args, options);
  });
  fs.writeFileSync(f.file, JSON.stringify({ ...journal, attempt: { ...journal.attempt, receiptDigest: '0'.repeat(64) } }));
  await expect(acknowledgeRuntimeHandoff(binding, { acceptedReceiptDigest: receiptDigest })).rejects.toThrow('completion receipt differs');
  expect(fs.existsSync(active)).toBe(true);
  fs.writeFileSync(f.file, bytes);
  expect(await acknowledgeRuntimeHandoff(binding, { acceptedReceiptDigest: receiptDigest })).toEqual({ cleanup: 'pending' });
  expect(runtimeHandoffNeedsAcknowledgment(journal)).toBe(false);
  expect(fs.readFileSync(f.file, 'utf8')).toBe(bytes);
  const foreign = JSON.stringify({ journal: path.join(f.home, 'foreign.json'), bindingDigest: 'f'.repeat(64) });
  fs.writeFileSync(active, foreign);
  expect(await acknowledgeRuntimeHandoff(binding, { acceptedReceiptDigest: receiptDigest })).toEqual({ cleanup: 'pending' });
  expect(fs.readFileSync(active, 'utf8')).toBe(foreign);
  vi.mocked(childProcess.spawnSync).mockImplementation((program, args, options) => {
    if (program === '/bin/launchctl') return { status: 113, stdout: '', stderr: 'Could not find service' } as any;
    return originalSpawn(program, args, options);
  });
  expect(await cleanupRuntimeHandoff(f.file)).toEqual({ cleanup: 'complete' });
  expect(fs.readFileSync(active, 'utf8')).toBe(foreign);
});

it('runs historical cleanup with current installed code and reports only the real child outcome', async () => {
  const f = fixture();
  const receipt = { schema: 'mandible-runtime-receipt@2', bindingDigest: f.journal.bindingDigest, attemptId: 'attempt' };
  const journal = { ...f.journal, attempt: { id: 'attempt', state: 'complete', receipt,
    receiptDigest: createHash('sha256').update(JSON.stringify(receipt)).digest('hex'), fence: { reason: 'terminal-completion' } }, cleanup: { state: 'pending' } };
  fs.writeFileSync(f.file, JSON.stringify(journal));
  fs.rmSync(f.binding.nativeApp, { recursive: true });
  const resources = path.join(f.home, 'current/Contents/Resources');
  fs.mkdirSync(path.join(resources, 'handoff'), { recursive: true });
  const runtime = path.join(resources, 'runtime');
  fs.writeFileSync(runtime, '#!/bin/sh\nexec "$MANDIBLE_TEST_CLEANUP_RUNTIME" "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(resources, 'sqlite'), 'fixture');
  const started = path.join(f.home, 'child-started'); const proceed = path.join(f.home, 'child-proceed');
  fs.writeFileSync(path.join(resources, 'handoff/helper.mjs'), `import fs from 'node:fs';
    fs.writeFileSync(process.env.MANDIBLE_TEST_CLEANUP_STARTED, process.env.MANDIBLE_RELEASE_ROOT);
    while (!fs.existsSync(process.env.MANDIBLE_TEST_CLEANUP_PROCEED)) await new Promise(r => setTimeout(r, 5));
    if (process.env.MANDIBLE_TEST_CLEANUP_OUTCOME === 'fail') process.exit(9);
    if (process.env.MANDIBLE_TEST_CLEANUP_OUTCOME === 'complete') {
      const file = process.argv[3]; const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
      journal.cleanup = { state: 'complete' }; fs.writeFileSync(file, JSON.stringify(journal));
    }`);
  const files = Object.fromEntries(['runtime', 'sqlite', 'handoff/helper.mjs'].map(file => [file, installedFileIdentity(path.join(resources, file))]));
  fs.writeFileSync(path.join(resources, 'release.json'), JSON.stringify({ schema: 'mandible-installed-release@1', version: 'fixture',
    target: `${process.platform}-${process.arch}`, provenance: { commit: 'a'.repeat(40), source_digest: 'b'.repeat(64) },
    layout: { kind: 'macos-app', roots: { resources: '.' } }, entrypoints: {}, native: { bun: 'runtime', sqlite: 'sqlite' }, files }));
  vi.stubEnv('MANDIBLE_RELEASE_ROOT', resources); vi.stubEnv('MANDIBLE_TEST_CLEANUP_RUNTIME', process.execPath);
  vi.stubEnv('MANDIBLE_TEST_CLEANUP_STARTED', started); vi.stubEnv('MANDIBLE_TEST_CLEANUP_PROCEED', proceed);
  let settled = false;
  const pending = scheduleRuntimeHandoffCleanup(journal).then(result => { settled = true; return result; });
  await waitUntil(() => fs.existsSync(started), 'cleanup child entered current helper');
  expect(settled).toBe(false); expect(fs.readFileSync(started, 'utf8')).toBe(resources);
  fs.writeFileSync(proceed, 'continue');
  expect(await pending).toEqual({ cleanup: 'pending' });
  vi.stubEnv('MANDIBLE_TEST_CLEANUP_OUTCOME', 'fail');
  await expect(scheduleRuntimeHandoffCleanup(journal)).rejects.toThrow('failed');
  vi.stubEnv('MANDIBLE_TEST_CLEANUP_OUTCOME', 'complete');
  expect(await scheduleRuntimeHandoffCleanup(journal)).toEqual({ cleanup: 'complete' });
  fs.chmodSync(runtime, 0o644);
  await expect(scheduleRuntimeHandoffCleanup(journal)).rejects.toThrow();
});
