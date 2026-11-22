// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { activateStagedRuntime, bindingDigest, COMMITTED_OBSERVATION_WINDOW_MS, handoffDirectory, runRuntimeHandoffWorker, readRuntimeHandoff, closeQuiescentRuntimeHandoff, acknowledgeRuntimeHandoff, runtimeHandoffNeedsAcknowledgment, cleanupRuntimeHandoff, scheduleRuntimeHandoffCleanup, runtimeHandoffCleanupWake, withRuntimeObservation } from '../scripts/runtime-handoff.mjs';
import { acceptedInstallPaths, applicationRootIdentity } from '../scripts/accepted-app-install.mjs';
import { assertInstalledApplicationVerification, installedFileIdentity, verifyApplicationRelease } from '../scripts/installed-release.mjs';
import { stagedInstallPaths, prepareStagedApplication, installStagedApplication } from '../scripts/staged-app-install.mjs';
import { serviceInstallationContext } from '../scripts/service-definitions.mjs';
import { readBundleOwner } from '../scripts/bundle-services.mjs';
import { waitUntil } from './helpers/wait-until.js';
import { assessRuntimeLogs } from '../scripts/runtime-log-assessment.mjs';
import { RuntimeObservationError, withRuntimeCommands } from '../scripts/runtime-observation.mjs';
import { readRuntimeHandoffLock } from '../scripts/runtime-handoff-lock.mjs';
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

async function exerciseVerifiedActivation(paint?: 'current' | 'wrong-epoch' | 'wrong-token' | 'empty-epoch') {
  const f = fixture();
  const database = path.join(f.home, 'bound-ledger.db');
  const writer = new SqliteDatabase(database);
  try { writer.exec('CREATE TABLE expected_stage_target (version INTEGER); INSERT INTO expected_stage_target VALUES (41)'); }
  finally { writer.close(); }
  const context = serviceInstallationContext({ home: f.home, accountHome: f.home, bundleRoot: f.binding.nativeApp });
  const authority = path.join(f.home, 'config/client-auth');
  fs.mkdirSync(authority, { recursive: true });
  fs.writeFileSync(path.join(authority, 'authority-id'), 'isolated-test');
  const { acceptedRelease, root, runtime, ...installation } = f.binding;
  const desktopPath = 'Contents/MacOS/mandible-app';
  const predecessorImage = path.join(f.binding.nativeApp, desktopPath);
  const predecessor = { pid: 1001, startedAt: 'old-desktop' };
  const successor = { pid: 1002, startedAt: 'new-desktop' };
  if (paint) {
    fs.mkdirSync(path.dirname(predecessorImage), { recursive: true });
    fs.writeFileSync(predecessorImage, 'old desktop');
  }
  const binding = { ...installation, accountHome: f.home, domain: context.domain, backendLabel: context.backendLabel,
    gatewayLabel: context.gatewayLabel, bundleOwner: null, priorAppIdentity: applicationRootIdentity(f.binding.nativeApp),
    predecessorHandoffProtocol: 2, desktopWasRunning: Boolean(paint),
    ...(paint ? { acceptedRelease, priorDesktop: { identities: [
      { ...predecessor, imageInode: fs.statSync(predecessorImage).ino, executionSha256: 'd'.repeat(64) },
    ] } } : {}),
    serviceConfiguration: { configuration: { environment: { MANDIBLE_DB: database } } } };
  const { staging, previous } = stagedInstallPaths(binding);
  const resources = path.join(staging, 'Contents/Resources');
  const programs = path.join(staging, 'Contents/MacOS');
  fs.mkdirSync(resources, { recursive: true });
  fs.mkdirSync(programs, { recursive: true });
  fs.copyFileSync(path.join(binding.nativeApp, 'Contents/Info.plist'), path.join(staging, 'Contents/Info.plist'));
  fs.copyFileSync(process.execPath, path.join(programs, 'bun'), fs.constants.COPYFILE_FICLONE);
  if (paint) fs.writeFileSync(path.join(staging, desktopPath), 'new desktop');
  fs.writeFileSync(path.join(resources, 'preflight.mjs'), `import { Database } from 'bun:sqlite';
if (process.argv[2] !== '--preflight') throw Error('Expected daemon preflight');
const db = new Database(process.argv[3], { readonly: true });
const schemaVersion = db.query('SELECT version FROM expected_stage_target').get().version;
db.close();
console.log(JSON.stringify({ schema: 'mandible-daemon-preflight@1', schemaVersion }));
`);
  const release = { schema: 'mandible-installed-release@1', version: '1', target: `${process.platform}-${process.arch}`,
    layout: { kind: 'macos-app', roots: { resources: '.', programs: '../MacOS' } },
    provenance: { commit: 'a'.repeat(40), source_digest: 'b'.repeat(64) }, entrypoints: { daemon: 'preflight.mjs' },
    native: { bun: '../MacOS/bun', sqlite: '../MacOS/bun', caddy: '../MacOS/bun' }, desktopExecutionSha256: 'c'.repeat(64),
    files: Object.fromEntries(['preflight.mjs', '../MacOS/bun'].map(relative => [relative, installedFileIdentity(path.resolve(resources, relative))])) };
  fs.writeFileSync(path.join(resources, 'release.json'), JSON.stringify(release));
  const { digest, verification } = verifyApplicationRelease(staging);
  const deadline = Date.now() + 15_000;
  const journal = { schema: 'mandible-runtime-handoff@1', binding, bindingDigest: bindingDigest(binding), deadline,
    phase: 'armed', bridgeInstalled: true, admission: { attemptId: 'verified-stage', publication: 'published' },
    attempt: { id: 'verified-stage', deadline, state: 'running',
      effects: { prepare: { stagePath: staging, stageIdentity: verification.identity } } } };
  fs.writeFileSync(f.file, JSON.stringify(journal));
  fs.writeFileSync(path.join(context.runtimeDir, 'handoff-active.json'), JSON.stringify({ journal: f.file, bindingDigest: journal.bindingDigest }));
  const backend = { pid: 43, startedAt: 'new-backend', runs: 1 };
  const effects: string[] = [];
  let draining = true;
  let launchArgument: string | undefined;
  let retired = false;
  const startupEpoch = paint === 'empty-epoch' ? '' : 'new-epoch';
  const options = {
    context,
    prepare: (_binding, options) => prepareStagedApplication(binding, digest, options),
    validateGateway: async () => 'validated-gateway',
    wait: async () => {
      expect(JSON.parse(fs.readFileSync(f.file, 'utf8'))).toMatchObject({
        drainReady: { attemptId: journal.attempt.id },
        attempt: { effects: { prepare: { daemon: { schemaVersion: 41 } } } },
      });
      draining = false;
    },
    control: async (_journal, operation) => {
      effects.push(operation);
      if (operation === 'handoff-remove') return JSON.stringify({ processes: {} });
      if (operation === 'handoff-start') {
        expect(applicationRootIdentity(binding.nativeApp)).toEqual(verification.identity);
        assertInstalledApplicationVerification(path.join(binding.nativeApp, 'Contents/Resources'), readBundleOwner(context)?.verification);
      }
      return JSON.stringify({ processes: { backend }, process: { ...backend, startupEpoch },
        health: { instance: { backend_generation: release.provenance.commit, db_path: database } } });
    },
  };
  const activation = await withRuntimeCommands({ spawn: (binary, args, options) => {
    if (path.basename(binary) === 'git') throw new Error('Activation called Git');
    if (binary === '/bin/launchctl') return { status: 113, stderr: 'Could not find service' };
    if (binary === '/bin/ps' && args[1] === String(binding.oldProcess.pid)) {
      return draining ? { status: 0, stdout: binding.oldProcess.startedAt } : { status: 1 };
    }
    if (paint && binary === '/usr/bin/pgrep') {
      expect(args).toEqual(['-x', 'mandible-app']);
      return { status: 0, stdout: [!retired && predecessor.pid, launchArgument && successor.pid].filter(Boolean).join('\n') };
    }
    if (paint && binary === '/bin/ps' && args.at(-1) === 'command=') {
      const pid = Number(args[2]);
      if (pid === predecessor.pid) return { status: 0, stdout: predecessorImage };
      if (pid === successor.pid) return { status: 0, stdout: `${predecessorImage} --mandible-update-paint ${launchArgument}` };
    }
    if (paint && binary === '/bin/ps' && args.at(-1) === 'lstart=') {
      const process = [predecessor, successor].find(process => process.pid === Number(args[1]));
      if (process) return { status: 0, stdout: process.startedAt };
    }
    if (paint && binary === '/usr/sbin/lsof') {
      const image = Number(args[2]) === predecessor.pid ? path.join(previous, desktopPath) : predecessorImage;
      return { status: 0, stdout: `i${fs.statSync(image).ino}\nn${image}\n` };
    }
    if (paint && binary === '/usr/bin/open') {
      expect(args.slice(-3, -1)).toEqual(['--args', '--mandible-update-paint']);
      const argument = args.at(-1);
      if (typeof argument !== 'string') throw new Error('Successor launch has no scope and token.');
      launchArgument = argument;
      const [scope, token] = launchArgument.split(':');
      expect(scope).toBe(path.basename(path.dirname(f.file)));
      fs.writeFileSync(path.join(path.dirname(f.file), `desktop-paint-${token}.json`), JSON.stringify({
        schema: 'mandible-desktop-paint@1',
        token: paint === 'wrong-token' ? (token[0] === '0' ? '1' : '0') + token.slice(1) : token,
        pid: successor.pid,
        startup_epoch: paint === 'wrong-epoch' ? 'old-epoch' : startupEpoch,
      }));
      effects.push('desktop-open');
      return { status: 0 };
    }
    if (paint && binary === '/bin/kill') {
      expect(args).toEqual(['-TERM', String(predecessor.pid)]);
      expect(JSON.parse(fs.readFileSync(f.file, 'utf8')).attempt.effects.desktop.identity.pid).toBe(successor.pid);
      retired = true;
      effects.push('desktop-retire');
      return { status: 0 };
    }
    return originalSpawn(binary, args, options);
  } }, () => paint
    ? runRuntimeHandoffWorker(f.file, { ...options, install: installStagedApplication, verifyPublication: async () => {} })
    : withRuntimeObservation(journal, () => activateStagedRuntime(journal, options)));
  return { activation, effects, binding, previous, context, digest, verification, backend, database, release, successor };
}

it('activates a verified native stage against its bound ledger without developer authority or acquisition', async () => {
  const { activation, effects, binding, previous, context, digest, verification, backend, database, release } = await exerciseVerifiedActivation();
  expect(activation).toMatchObject({ packageSha256: digest, installed: { root: binding.nativeApp, identity: verification.identity },
    services: { backend }, startup: { epoch: 'new-epoch', database, generation: release.provenance.commit } });
  expect(effects).toEqual(['handoff-remove', 'handoff-start', 'handoff-verify', 'handoff-evidence', 'handoff-probe']);
  expect(readBundleOwner(context)?.acceptedRelease).toBeUndefined();
  expect(applicationRootIdentity(previous)).toEqual(binding.priorAppIdentity);
  expect(fs.existsSync(path.join(binding.home, 'accepted-releases'))).toBe(false);
});

it('the activation worker accepts painted successor evidence before retiring the predecessor', async () => {
  const { activation, effects, successor, digest } = await exerciseVerifiedActivation('current');
  expect(activation.attempt.state, JSON.stringify(activation.attempt.lastObservation)).toBe('complete');
  expect(activation.attempt.receipt).toMatchObject({
    approved: { packageSha256: digest }, startup: { epoch: 'new-epoch' },
    desktop: { kind: 'replaced', identity: { ...successor, installedImage: true }, completedAt: expect.any(Number) },
  });
  expect(effects).toEqual(['handoff-remove', 'handoff-start', 'handoff-verify', 'desktop-open', 'desktop-retire', 'handoff-evidence', 'handoff-probe']);
});

it.each(['wrong-epoch', 'wrong-token', 'empty-epoch'] as const)('the activation worker preserves the predecessor when successor paint has %s', async paint => {
  const { activation, effects } = await exerciseVerifiedActivation(paint);
  expect(activation.attempt).toMatchObject({ state: 'failed', lastObservation: { code: 'desktop_evidence_mismatch' } });
  expect(activation.attempt.receipt).toBeUndefined();
  expect(effects).toEqual(['handoff-remove', 'handoff-start', 'handoff-verify', 'desktop-open']);
});

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
    expect(options.until).toBeLessThanOrEqual(Date.now() + 2 * COMMITTED_OBSERVATION_WINDOW_MS);
    return { schema: 'mandible-runtime-receipt@2', bindingDigest: journal.bindingDigest, services: identities };
  });
  const validateDaemon = vi.fn(async () => { effects.push('daemon-preflight'); return { schema: 'mandible-daemon-preflight@1', schemaVersion: 242 }; });
  const options = { actor: { provider: 'fixture' }, prepare, install, control, desktop, observe, verifyPublication: vi.fn(async () => {}), validateGateway: async () => null, validateDaemon };
  const first = await runRuntimeHandoffWorker(f.file, options);
  expect(first.attempt.state, JSON.stringify(first.attempt.lastObservation)).toBe('running');
  expect(effects).toEqual(['prepare', 'daemon-preflight', 'drain', 'replace']);
  const resumed = await runRuntimeHandoffWorker(f.file, options);
  expect(resumed.attempt.id).toBe(first.attempt.id);
  expect(resumed).toMatchObject({ phase: 'complete', error: 'original failure', failure: f.journal.failure,
    attempt: { state: 'complete', fence: { reason: 'terminal-completion' }, receipt: { schema: 'mandible-runtime-receipt@2', attemptId: first.attempt.id } } });
  expect(effects).toEqual(['prepare', 'daemon-preflight', 'drain', 'replace', 'prepare', 'services', 'desktop']);
  await runRuntimeHandoffWorker(f.file, options);
  expect(desktop).toHaveBeenCalledOnce(); expect(observe).toHaveBeenCalledOnce();
  expect(readRuntimeHandoff(f.home, f.binding.requestId, f.binding.executionId)?.attempt.receiptDigest).toMatch(/^[a-f0-9]{64}$/);
});

it('does not authorize drain when the staged daemon cannot open the ledger', async () => {
  const f = fixture();
  const control = vi.fn();
  const install = vi.fn();
  const current = await runRuntimeHandoffWorker(f.file, {
    actor: { provider: 'fixture' }, verifyPublication: async () => {},
    prepare: async () => ({ installed: false, packageSha256: 'exact' }),
    validateGateway: async () => null,
    validateDaemon: async () => { throw new Error('The ledger schema is newer than this daemon.'); },
    control, install,
  });
  expect(current).toMatchObject({ phase: 'failed', drainReady: null, attempt: { lastObservation: { reason: 'The ledger schema is newer than this daemon.' } } });
  expect(current.attempt.effects.drain).toBeUndefined();
  expect(control).not.toHaveBeenCalled();
  expect(install).not.toHaveBeenCalled();
});

it('refuses a developer publication bound to a different database before preparing or draining', async () => {
  const f = fixture();
  const binding = { ...f.binding, delivery: 'accepted-release',
    serviceConfiguration: { configuration: { environment: { MANDIBLE_DB: path.join(f.home, 'service.db') } } } };
  const journal = { ...f.journal, binding, bindingDigest: bindingDigest(binding), database: path.join(f.home, 'other-publication.db') };
  fs.writeFileSync(f.file, JSON.stringify(journal));
  fs.writeFileSync(path.join(f.home, 'config/local-sessions/handoff-active.json'), JSON.stringify({ journal: f.file, bindingDigest: journal.bindingDigest }));
  const verifyPublication = vi.fn();
  const prepare = vi.fn();
  const result = await runRuntimeHandoffWorker(f.file, { actor: { provider: 'fixture' }, verifyPublication, prepare });
  expect(result.attempt.lastObservation.reason).toBe('The signed publication and native service target different ledger databases.');
  expect(result.attempt.effects.drain).toBeUndefined();
  expect(verifyPublication).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
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

it('releases the lock at the terminal fence without acknowledgment, and cleanup removes only its own lock file', async () => {
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
  // The lock file still names the journal, yet the fenced terminal receipt has released the lock.
  expect(readRuntimeHandoffLock(f.home)).toBeNull();
  expect(runtimeHandoffNeedsAcknowledgment(journal)).toBe(false);
  fs.writeFileSync(f.file, JSON.stringify({ ...journal, phase: 'armed', attempt: { ...journal.attempt, state: 'running', fence: undefined } }));
  expect(readRuntimeHandoffLock(f.home)).toMatchObject({ state: 'installing', bindingDigest: digest });
  vi.mocked(childProcess.spawnSync).mockImplementation((program, args, options) => {
    if (program === '/bin/launchctl') return { status: 113, stdout: '', stderr: 'Could not find service' } as any;
    return originalSpawn(program, args, options);
  });
  fs.writeFileSync(f.file, JSON.stringify({ ...journal, attempt: { ...journal.attempt, receiptDigest: '0'.repeat(64) } }));
  await expect(cleanupRuntimeHandoff(f.file)).rejects.toThrow('completion receipt differs');
  expect(fs.existsSync(active)).toBe(true);
  const foreign = JSON.stringify({ journal: path.join(f.home, 'foreign.json'), bindingDigest: 'f'.repeat(64) });
  fs.writeFileSync(active, foreign);
  fs.writeFileSync(f.file, bytes);
  expect(await cleanupRuntimeHandoff(f.file)).toEqual({ cleanup: 'complete' });
  expect(fs.readFileSync(active, 'utf8')).toBe(foreign);
  fs.writeFileSync(active, JSON.stringify({ journal: f.file, bindingDigest: digest }));
  fs.writeFileSync(f.file, bytes);
  expect(await cleanupRuntimeHandoff(f.file)).toEqual({ cleanup: 'complete' });
  expect(fs.existsSync(active)).toBe(false);
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
  expect(await pending).toEqual({ cleanup: 'pending', reason: 'Runtime delivery cleanup remains pending.', wake: runtimeHandoffCleanupWake(journal) });
  vi.stubEnv('MANDIBLE_TEST_CLEANUP_OUTCOME', 'fail');
  await expect(scheduleRuntimeHandoffCleanup(journal)).rejects.toThrow('failed');
  vi.stubEnv('MANDIBLE_TEST_CLEANUP_OUTCOME', 'complete');
  expect(await scheduleRuntimeHandoffCleanup(journal)).toEqual({ cleanup: 'complete' });
  fs.chmodSync(runtime, 0o644);
  await expect(scheduleRuntimeHandoffCleanup(journal)).rejects.toThrow();
});

it.each([false, true])('settles cleanup independently while a process holds the previous app (retained desktop: %s)', async retained => {
  const f = fixture();
  const database = path.join(f.home, 'acceptance.db');
  const db = new SqliteDatabase(database);
  db.exec('CREATE TABLE auth_hook_executions (id TEXT, auth_request_id TEXT, hook_id TEXT, state TEXT, output TEXT, command_digest TEXT)');
  const previous = acceptedInstallPaths(f.binding).previous;
  fs.mkdirSync(path.join(previous, 'Contents'), { recursive: true });
  const bridge = path.join(f.home, 'bridge.mjs'); fs.writeFileSync(bridge, 'bridge');
  const binding = { ...f.binding, hookId: 'hook', commandDigest: 'command', domain: `gui/${process.getuid!()}`, priorAppIdentity: applicationRootIdentity(previous),
    priorBackend: { argv: ['/runtime', bridge] }, legacyBridgeSha256: createHash('sha256').update('bridge').digest('hex') };
  const digest = bindingDigest(binding);
  const holder = childProcess.spawn('/bin/sleep', ['30'], { cwd: previous, stdio: 'ignore' });
  try {
    await waitUntil(() => originalSpawn('lsof', ['-F', 'p', '+D', previous], { encoding: 'utf8' }).stdout.includes(`p${holder.pid}`), 'holder opened the previous app');
    const startedAt = originalSpawn('/bin/ps', ['-p', String(holder.pid), '-o', 'lstart='], { encoding: 'utf8' }).stdout.trim();
    const receipt = { schema: 'mandible-runtime-receipt@2', bindingDigest: digest, attemptId: 'attempt',
      ...(retained ? { desktop: { kind: 'retained', identity: { pid: holder.pid, startedAt } } } : {}) };
    const journal = { ...f.journal, binding, bindingDigest: digest, database, helperLabel: 'fixture-helper',
      attempt: { id: 'attempt', state: 'complete', effects: {}, receipt, receiptDigest: createHash('sha256').update(JSON.stringify(receipt)).digest('hex'),
        fence: { reason: 'terminal-completion' } }, cleanup: { state: 'pending' } };
    db.prepare('INSERT INTO auth_hook_executions VALUES (?,?,?,?,?,?)').run(binding.executionId, binding.requestId, binding.hookId, 'complete', runtimeReceiptAcceptanceMarker(journal), binding.commandDigest);
    db.close();
    fs.writeFileSync(f.file, JSON.stringify(journal));
    vi.mocked(childProcess.spawnSync).mockImplementation((program, args, options) => {
      if (program === '/bin/launchctl') return { status: 113, stdout: '', stderr: 'Could not find service' } as any;
      return originalSpawn(program, args, options);
    });
    expect(await cleanupRuntimeHandoff(f.file)).toEqual({ cleanup: 'pending' });
    const blocked = readRuntimeHandoff(f.home, binding.requestId, binding.executionId)!;
    expect(fs.existsSync(bridge)).toBe(false);
    expect(blocked.helperFencedAt).toEqual(expect.any(Number));
    expect(blocked.cleanup).toMatchObject({ state: 'pending', blockers: [{ obligation: 'previous-app',
      processes: [{ pid: holder.pid, command: expect.stringContaining('sleep 30'), owner: { pid: process.pid } }] }] });
    if (retained) {
      expect(blocked.cleanup.blockers[0]).toMatchObject({ expected: true });
      expect(blocked.cleanup.reason).toContain('after the retained Mandible window closes');
    } else {
      expect(blocked.cleanup.reason).toContain(`Quit or restart: ${blocked.cleanup.blockers[0].processes[0].owner.command.slice(0, 40)}`);
    }
    const waiting = runtimeHandoffCleanupWake(blocked);
    expect(runtimeHandoffCleanupWake(blocked)).toBe(waiting);
    const exited = new Promise(resolve => holder.once('exit', resolve));
    holder.kill(); await exited;
    expect(runtimeHandoffCleanupWake(blocked)).not.toBe(waiting);
    expect(await cleanupRuntimeHandoff(f.file)).toEqual({ cleanup: 'complete' });
    expect(fs.existsSync(previous)).toBe(false);
  } finally { holder.kill(); }
});

it('preserves obsolete caches when historical completion lacks current trusted runtime proof', async () => {
  const f = fixture();
  const database = path.join(f.home, 'cache-acceptance.db');
  const db = new SqliteDatabase(database);
  db.exec('CREATE TABLE auth_hook_executions(id TEXT,auth_request_id TEXT,hook_id TEXT,state TEXT,output TEXT,command_digest TEXT)');
  const binding = { ...f.binding, hookId: 'hook', commandDigest: 'command', domain: `gui/${process.getuid!()}` };
  const digest = bindingDigest(binding);
  const receipt = { schema: 'mandible-runtime-receipt@2', bindingDigest: digest, attemptId: 'attempt' };
  const journal = { ...f.journal, binding, bindingDigest: digest, database,
    attempt: { id: 'attempt', state: 'complete', effects: { drain: { completedAt: 1, processes: {} } }, receipt,
      receiptDigest: createHash('sha256').update(JSON.stringify(receipt)).digest('hex'), fence: { reason: 'terminal-completion' } },
    cleanup: { state: 'pending' } };
  db.prepare('INSERT INTO auth_hook_executions VALUES(?,?,?,?,?,?)').run(binding.executionId, binding.requestId,
    binding.hookId, 'complete', runtimeReceiptAcceptanceMarker(journal), binding.commandDigest);
  db.close();
  const obsolete = `${database}.conversation-structure.db.v18`;
  const old = new SqliteDatabase(obsolete);
  old.exec(fs.readFileSync(new URL('./fixtures/conversation-cache-v18.sql', import.meta.url), 'utf8')); old.close();
  const { ConversationStructureCache } = await import('../src/conversations/structure-cache.js');
  const cache = new ConversationStructureCache(undefined, { cachePath: `${database}.conversation-structure.db` });
  const current = cache.cachePath; cache.close();
  fs.writeFileSync(f.file, JSON.stringify(journal));
  fs.rmSync(binding.nativeApp, { recursive: true });
  expect(await cleanupRuntimeHandoff(f.file)).toEqual({ cleanup: 'pending' });
  const blocked = readRuntimeHandoff(f.home, binding.requestId, binding.executionId)!;
  expect(blocked.cleanup.blockers.some((blocker: { obligation: string }) => blocker.obligation === 'conversation-cache')).toBe(true);
  expect(fs.existsSync(obsolete)).toBe(true);
  expect(fs.existsSync(current)).toBe(true);
});
