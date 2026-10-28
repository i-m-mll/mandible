#!/usr/bin/env bun
// A finite convergence worker, owned by one already-applied auth publication.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { runSupervisedCommand } from './process-group-supervisor.mjs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRuntimeLogAssessor } from './runtime-log-assessment.mjs';
import { readStderrLogCoverage, resolveStderrLogCoverage } from '../src/stderr-log-chain.ts';
import { observeRuntimeHealthCoverage, RuntimeHealthObservationError, assessRuntimeHealth } from '../src/runtime-health-contract.ts';
import { runtimeEnvironment } from './runtime-environment.mjs';
import { readRuntimeHandoffLock, runtimeHandoffLockFile, runtimeHandoffLockRefusal, runtimeHandoffBindingDigest } from './runtime-handoff-lock.mjs';
import { RuntimeObservationError, observationPending, decodeObservationError, runtimeObservationAcceptance } from './runtime-observation.mjs';
import { withLifecycleLock, inspectLifecycleLock, assertLifecycleLockHeld, processIdentity as lockProcessIdentity } from './lifecycle-lock.mjs';
import { RUNTIME_HEALTH_PROBE_INTERVAL_MS } from './runtime-probe-cadence.mjs';

const execFileAsync = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fileHash = file => hash(fs.readFileSync(file));
const CONTROLLER_MODULES = ['lifecycle-lock.mjs', 'process-lock.mjs', 'canonical-origin.mjs', 'build-revision.mjs', 'local-ca-trust.mjs',
  'pinned-caddy.mjs', 'gateway-admin.mjs', 'runtime-environment.mjs', 'service-definitions.mjs', 'service-configuration.mjs', 'runtime-probe-cadence.mjs', 'runtime-observation.mjs'];
const STAGED_HANDOFF_FILES = ['sqlite.mjs', 'proof.mjs', 'controller.mjs', 'helper.mjs', ...CONTROLLER_MODULES];

export function stageHandoffController(root, dir) {
  // Preserve CLI module boundaries: bundling guarded entrypoints changes their import.meta.url guards.
  for (const [source, name] of [['local-runtime.mjs', 'controller.mjs'], ...CONTROLLER_MODULES.map(name => [name, name])]) {
    fs.copyFileSync(path.join(root, 'scripts', source), path.join(dir, name));
  }
}

export const bindingDigest = runtimeHandoffBindingDigest;
function atomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  const directory = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
function run(binary, args, { cwd, env = process.env, timeout = 5000, log } = {}) {
  const fd = log ? fs.openSync(log, 'a', 0o600) : null;
  try {
    const result = spawnSync(binary, args, { cwd, env: { ...env, GIT_OPTIONAL_LOCKS: '0' }, encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024,
      ...(fd !== null ? { stdio: ['ignore', fd, fd] } : {}) });
    if (result.error || result.status !== 0) throw new Error(`${binary} ${args[0]} failed: ${result.error?.message || result.stderr || result.status}`);
    return result.stdout?.trim();
  } finally { if (fd !== null) fs.closeSync(fd); }
}
const launchctl = args => run('/bin/launchctl', args);
async function runStage(binary, args, { cwd, env, timeout, log }) {
  const fd = fs.openSync(log, 'a', 0o600);
  try {
    await runSupervisedCommand(binary, args, { cwd, env: { ...env, GIT_OPTIONAL_LOCKS: '0' }, timeout, stdio: ['ignore', fd, fd] });
  } finally { fs.closeSync(fd); }
}
const startedAt = pid => {
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 1500 });
  return result.status === 0 ? result.stdout.trim() || null : null;
};
function desktopIdentities(app) {
  const executable = path.join(app, 'Contents/MacOS/mandible-app');
  const installed = fs.existsSync(executable) ? fs.statSync(executable) : null;
  const pids = spawnSync('/usr/bin/pgrep', ['-x', 'mandible-app'], { encoding: 'utf8', timeout: 1500 }).stdout?.trim().split('\n').filter(Boolean) ?? [];
  return pids.flatMap(pid => {
    const command = spawnSync('/bin/ps', ['-ww', '-p', pid, '-o', 'command='], { encoding: 'utf8', timeout: 1500 }).stdout?.trim();
    if (command !== executable && !command?.startsWith(`${executable} `)) return [];
    const mapped = spawnSync('/usr/sbin/lsof', ['-a', '-p', pid, '-d', 'txt', '-Fni'], { encoding: 'utf8', timeout: 1500 });
    let inode; let installedImage = false;
    for (const line of mapped.stdout?.split('\n') ?? []) {
      if (line.startsWith('i')) inode = Number(line.slice(1));
      if (line === `n${executable}` && inode === installed?.ino) installedImage = true;
    }
    return [{ pid: Number(pid), startedAt: startedAt(Number(pid)), installedImage, imageInode: installedImage ? installed.ino : null }];
  });
}
const desktopRunning = app => desktopIdentities(app).length > 0;
function requireDesktopForObservation(journal) {
  assertObservationLease();
  const b = journal.binding;
  if (!b.desktopWasRunning) return;
  const stage = journal.stages?.desktopRelaunch;
  const identities = desktopIdentities(b.nativeApp);
  if (stage?.identity) {
    if (!identities.some(identity => JSON.stringify(identity) === JSON.stringify(stage.identity))) {
      throw observationFailure('desktop_exited', 'Installed desktop did not remain running after relaunch.');
    }
    return;
  }
  const issuedAt = journal.desktopInstallation?.issuedAt ?? stage?.issuedAt ?? journal.launch?.enteredAt;
  const prior = journal.desktopInstallation?.prior ?? stage?.prior ?? journal.launch?.desktopPrior;
  const exact = issuedAt && prior ? identities.filter(identity => identity.startedAt && identity.installedImage
    && Date.parse(identity.startedAt) >= Math.floor(issuedAt / 1000) * 1000
    && !prior.some(old => old.pid === identity.pid && old.startedAt === identity.startedAt)) : [];
  if (exact.length !== 1) throw new RuntimeObservationError('desktop_unconfirmed',
    'Backend is at the expected build; the updated desktop has not been observed. Quit and reopen the installed Mandible app; verification will resume.', { issuedAt, identities, prior }, 'pending');
  unchangedJournal(journal);
  save(journal, { ...(journal.phase === 'failed' && !journal.failure ? { failure: retainedFailure(journal) } : {}),
    stages: { ...journal.stages, desktopRelaunch: { ...stage,
    identity: exact[0], confirmedAt: Date.now(), ...(!stage?.issuedAt ? { suppliedExternally: true } : {}) } } });
}

async function restoreDesktop(journal) {
  const b = journal.binding;
  if (!b.desktopWasRunning) return;
  try { requireDesktopForObservation(journal); return; }
  catch (error) { if (!observationPending(error)) throw error; }
  if (!journal.stages?.desktopRelaunch?.issuedAt) {
    if (Date.now() > journal.deadline) throw new RuntimeObservationError('execution_budget_exhausted',
      'Desktop launch is outstanding after the initial helper execution budget ended.', null, 'pending');
    unchangedJournal(journal);
    save(journal, { stages: { ...journal.stages, desktopRelaunch: { issuedAt: Date.now(), prior: desktopIdentities(b.nativeApp) } } });
    const log = path.join(path.dirname(journalFile(b)), 'convergence.log');
    try {
      assertObservationLease();
      await runStage('/bin/bash', ['cli/install-desktop-app.sh', '--relaunch', b.nativeApp, 'mandible-app', '0'], {
        cwd: b.root,
        env: { ...journal.environment, MANDIBLE_RUNTIME_HANDOFF_JOURNAL: journalFile(b) },
        timeout: 15000,
        log,
      });
    } catch (error) {
      if (observationPending(error)) throw error;
      fs.appendFileSync(log, `${error.message}\n`);
      if (error.code === 'STAGE_DEADLINE') throw new RuntimeObservationError('desktop_unconfirmed',
        'The issued desktop relaunch did not confirm completion within its wait.', { issuedAt: journal.stages.desktopRelaunch.issuedAt }, 'pending');
      throw new Error('Installed desktop could not be relaunched. The failed handoff and convergence log are retained.', { cause: error });
    }
    exactActiveOwner(journal);
    const current = readRuntimeHandoff(b.home, b.requestId, b.executionId);
    if (!current || current.bindingDigest !== journal.bindingDigest || current.phase !== journal.phase || current.recovery?.digest !== journal.recovery?.digest) throw new Error('Runtime handoff changed during desktop relaunch.');
    save(current, { stages: { ...current.stages, desktopRelaunch: { ...current.stages.desktopRelaunch, completedAt: Date.now() } } });
    Object.assign(journal, current);
  }
  requireDesktopForObservation(journal);
}

const homeDirectory = home => path.join(home, 'config', 'local-sessions');
export function handoffDirectory(home, requestId, executionId) {
  for (const id of [requestId, executionId]) if (!/^[a-zA-Z0-9_-]{8,128}$/.test(id)) throw new Error('Invalid runtime handoff owner.');
  return path.join(homeDirectory(home), 'handoff', `${requestId}-${executionId}`);
}
function journalFile(binding) { return path.join(handoffDirectory(binding.home, binding.requestId, binding.executionId), 'journal.json'); }
function validateJournal(journal) {
  if (journal?.schema !== 'mandible-runtime-handoff@1' || bindingDigest(journal.binding) !== journal.bindingDigest) throw new Error('Runtime handoff binding is malformed or changed.');
  if (fileHash(journal.binding.runtime.path) !== journal.binding.runtime.sha256) throw new Error('Pinned handoff runtime bytes changed.');
  return journal;
}
function readJournalFile(home, requestId, executionId) {
  const file = path.join(handoffDirectory(home, requestId, executionId), 'journal.json');
  if (!fs.existsSync(file)) return null;
  const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
  const retirementFile = path.join(path.dirname(file), 'retirement.json');
  if (fs.existsSync(retirementFile)) {
    const retirement = JSON.parse(fs.readFileSync(retirementFile, 'utf8'));
    if (retirement.bindingDigest !== journal.bindingDigest || retirement.journalSha256 !== fileHash(file)) throw new Error('Retired handoff evidence changed.');
    return { ...journal, phase: 'retired', retirement };
  }
  return journal;
}
export function readRuntimeHandoff(home, requestId, executionId) {
  const journal = readJournalFile(home, requestId, executionId);
  return journal && validateJournal(journal);
}
/**
 * The recorded phase without validation, which re-hashes the pinned runtime.
 * It only decides that a handoff needs no action; acting requires readRuntimeHandoff.
 */
export function readRuntimeHandoffPhase(home, requestId, executionId) {
  return readJournalFile(home, requestId, executionId)?.phase;
}
function save(journal, changes) {
  assertObservationLease();
  Object.assign(journal, changes, { updatedAt: Date.now() });
  atomic(journalFile(journal.binding), journal);
}
const OBSERVATION_MS = 31000;
const OBSERVATION_DEADLINE_MS = 62000;

function observationFailure(code, message, evidence) {
  return new RuntimeHealthObservationError(code, message, evidence);
}
/**
 * How long a verification waits for the daemon's actual answer: the handoff
 * deadline, or one observation window for a recovery that outlived it.
 */
function handoffAnswerDeadline(journal, now = Date.now()) {
  return Math.max(journal.deadline ?? 0, now + OBSERVATION_MS);
}
async function controller(journal, command, currentVerifier = false, { until = handoffAnswerDeadline(journal), awaitReady = false, signal } = {}) {
  assertObservationLease();
  const binding = journal.binding;
  const env = { ...journal.environment, MANDIBLE_RUNTIME_HANDOFF_JOURNAL: journalFile(binding), GIT_OPTIONAL_LOCKS: '0' };
  const installedController = journal.phase === 'acknowledged' || !!journal.cleanupStartedAt;
  const script = currentVerifier ? path.join(path.dirname(fileURLToPath(import.meta.url)), 'local-runtime.mjs') : installedController ? path.join(binding.root, 'scripts/local-runtime.mjs') : path.join(path.dirname(journalFile(binding)), 'controller.mjs');
  if (installedController) delete env.MANDIBLE_RUNTIME_HANDOFF_STORAGE;
  const args = [script, command, '--root', binding.root, ...(command === 'handoff-verify' ? ['--until', String(until), ...(awaitReady ? ['--await-ready'] : [])] : [])];
  // Recovery runs inside the daemon that answers these health requests.
  // Keep its event loop available while the bounded controller probes it.
  try {
    const result = await execFileAsync(binding.runtime.path, args, {
      cwd: binding.root, env, timeout: Math.max(1, until - Date.now()), signal, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8',
    });
    assertObservationLease();
    return result.stdout.trim();
  } catch (error) {
    if (error instanceof RuntimeObservationError) throw error;
    const structured = decodeObservationError(String(error.stderr ?? '').trim());
    if (structured) throw structured;
    if ((error.killed || signal?.aborted) && ['handoff-verify', 'handoff-evidence', 'handoff-start'].includes(command)) throw new RuntimeObservationError('observation_deadline',
      `Runtime handoff ${command} did not answer within this observation.`, { until }, 'pending');
    throw new RuntimeObservationError('controller_failed', `Runtime handoff ${command} failed: ${String(error.stderr || error.message).trim()}`);
  }
}

async function publication(journal) {
  const module = await import(pathToFileURL(path.join(path.dirname(journalFile(journal.binding)), 'proof.mjs')).href);
  const { default: SqliteDatabase } = await import(pathToFileURL(path.join(path.dirname(journalFile(journal.binding)), 'sqlite.mjs')).href);
  const db = new SqliteDatabase(journal.database, { readonly: true, fileMustExist: true });
  try { return await module.verifyRuntimeHandoffPublication(db, journal.binding); } finally { db.close(); }
}
export function legacyHandoffBridge(file, target, deadline) {
  return `// Temporary dependency-free runtime handoff bridge.\nimport fs from 'node:fs';\nimport {spawnSync} from 'node:child_process';\nimport path from 'node:path';\nconst file=${JSON.stringify(file)};\nconst target=${JSON.stringify(target)};\nconst marker=path.join(path.dirname(file),'bridge-process.json');\nconst startedAt=spawnSync('/bin/ps',['-p',String(process.pid),'-o','lstart='],{encoding:'utf8',timeout:1500}).stdout.trim();\nconst temporary=marker+'.'+process.pid+'.tmp';\nfs.writeFileSync(temporary,JSON.stringify({pid:process.pid,startedAt}),{mode:0o600});fs.renameSync(temporary,marker);\nfunction wake(){spawnSync('/bin/launchctl',['kickstart',target],{timeout:1500,stdio:'ignore'});}\nwake();\nconst timer=setInterval(()=>{try{const j=JSON.parse(fs.readFileSync(file,'utf8'));if(j.phase==='acknowledged'){clearInterval(timer);process.exit(0);}if(Date.now()>${deadline}){clearInterval(timer);console.error('Runtime handoff deadline exceeded; preserve convergence evidence.');process.exit(1);}}catch(e){console.error(e.message);}},2000);\n`;
}
function plist(journal, helper) {
  const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const binding = journal.binding;
  const dir = path.dirname(journalFile(binding));
  const environment = ['HOME', 'MANDIBLE_HOME', 'MANDIBLE_SQLITE_LIBRARY', 'MANDIBLE_SQLITE_LIBRARY_ARCHIVE'].filter(key => journal.environment[key]).map(key => `<key>${esc(key)}</key><string>${esc(journal.environment[key])}</string>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${esc(journal.helperLabel)}</string><key>ProgramArguments</key><array>${[binding.runtime.path, helper, 'worker', journalFile(binding)].map(v => `<string>${esc(v)}</string>`).join('')}</array><key>EnvironmentVariables</key><dict>${environment}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>10</integer><key>WorkingDirectory</key><string>${esc(dir)}</string><key>StandardOutPath</key><string>${esc(path.join(dir, 'helper.log'))}</string><key>StandardErrorPath</key><string>${esc(path.join(dir, 'helper.log'))}</string></dict></plist>`;
}
export async function armRuntimeHandoff(root) {
  if (process.platform !== 'darwin') throw new Error('Production runtime handoff requires macOS launchd.');
  const home = path.resolve(process.env.MANDIBLE_HOME || path.join(os.userInfo().homedir, '.mandible'));
  const requestId = process.env.MANDIBLE_AUTH_REQUEST_ID;
  const executionId = process.env.MANDIBLE_HOOK_EXECUTION_ID;
  const existing = readRuntimeHandoff(home, requestId, executionId);
  if (existing) {
    if (existing.binding.commandDigest !== process.env.MANDIBLE_HOOK_COMMAND_DIGEST || existing.binding.root !== root) throw new Error('Repeated hook differs from the armed handoff.');
    if (existing.phase === 'armed' && !existing.bridgeInstalled) return finishAdmission(existing);
    return existing;
  }
  const activeFile = runtimeHandoffLockFile(home);
  const lock = readRuntimeHandoffLock(home);
  if (lock) throw new Error(`Another handoff owns this installation; preserving it. ${runtimeHandoffLockRefusal(lock)}`);
  const runtime = run('/bin/sh', [path.join(root, 'scripts/bun-runtime.sh')]);
  const dir = handoffDirectory(home, requestId, executionId);
  fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
  const preparation = { requestId, executionId, root, runtime, runtimeHash: fileHash(runtime) };
  if (fs.existsSync(dir)) {
    const prior = JSON.parse(fs.readFileSync(path.join(dir, 'preparation.json'), 'utf8'));
    if (JSON.stringify(prior) !== JSON.stringify(preparation)) throw new Error('Existing preparation belongs to different handoff bytes.');
    for (const name of fs.readdirSync(dir)) if (!['preparation.json', ...STAGED_HANDOFF_FILES].includes(name) || fs.lstatSync(path.join(dir, name)).isSymbolicLink()) throw new Error('Unknown handoff preparation material; preserving it.');
  } else {
    fs.mkdirSync(dir, { mode: 0o700 });
    atomic(path.join(dir, 'preparation.json'), preparation);
  }
  const storage = path.join(dir, 'sqlite.mjs');
  run(runtime, ['build', path.join(root, 'src/sqlite.ts'), '--target', 'bun', '--outfile', storage], { cwd: root });
  const environment = { ...runtimeEnvironment({ runtime, root }), MANDIBLE_RUNTIME_HANDOFF_STORAGE: storage };
  for (const key of Object.keys(environment)) if (/TOKEN|SECRET|KEYCHAIN|API_KEY/.test(key)) delete environment[key];
  const binding = { ...JSON.parse(run(runtime, [path.join(root, 'scripts/local-runtime.mjs'), 'handoff-snapshot', '--root', root], { env: environment, timeout: 30000 })),
    requestId, executionId, hookId: process.env.MANDIBLE_HOOK_ID, commandDigest: process.env.MANDIBLE_HOOK_COMMAND_DIGEST,
    mergeBase: process.env.MANDIBLE_AUTH_MERGE_BASE_SHA || undefined, mergeHead: process.env.MANDIBLE_AUTH_MERGE_HEAD_SHA || undefined,
    mergeCommit: process.env.MANDIBLE_AUTH_MERGE_COMMIT_SHA || undefined,
    nativeApp: path.resolve(process.env.MANDIBLE_DESKTOP_INSTALL_PATH || '/Applications/Mandible.app'), desktopWasRunning: desktopRunning(path.resolve(process.env.MANDIBLE_DESKTOP_INSTALL_PATH || '/Applications/Mandible.app')),
    runtime: { path: runtime, version: run(runtime, ['--version']), sha256: fileHash(runtime) } };
  const journal = { schema: 'mandible-runtime-handoff@1', binding, bindingDigest: '', phase: 'preparing', attempts: 0,
    deadline: Date.now() + 30 * 60 * 1000, stages: {}, environment,
    database: process.env.MANDIBLE_DB || path.join(home, 'mandible.db'),
    helperLabel: `bio.mll.mandible.runtime-handoff.${hash(`${home}:${requestId}:${executionId}`).slice(0, 16)}` };
  for (const [source, name] of [['src/runtime-handoff-proof.ts', 'proof.mjs'], ['scripts/runtime-handoff.mjs', 'helper.mjs']]) {
    run(runtime, ['build', path.join(root, source), '--target', 'bun', '--outfile', path.join(dir, name)], { cwd: root });
  }
  stageHandoffController(root, dir);
  // Initial publication validation is read-only and precedes every mutation.
  Object.assign(binding, await publication(journal));
  binding.stagedFiles = Object.fromEntries(STAGED_HANDOFF_FILES.map(name => [name, fileHash(path.join(dir, name))]));
  journal.bindingDigest = bindingDigest(binding);
  const helper = path.join(dir, 'helper.mjs');
  const service = path.join(homeDirectory(home), 'launch-agents', `${journal.helperLabel}.plist`);
  fs.mkdirSync(path.dirname(service), { recursive: true, mode: 0o700 });
  fs.writeFileSync(service, plist(journal, helper), { mode: 0o600 });
  journal.helperPlist = service;
  save(journal, { phase: 'armed' });
  const activeFd = fs.openSync(activeFile, 'wx', 0o600);
  try { fs.writeFileSync(activeFd, JSON.stringify({ journal: journalFile(binding), bindingDigest: journal.bindingDigest })); fs.fsyncSync(activeFd); } finally { fs.closeSync(activeFd); }
  return finishAdmission(journal);
}
async function finishAdmission(journal) {
  const binding = journal.binding;
  const { home, requestId, executionId } = binding;
  const dir = path.dirname(journalFile(binding));
  const active = runtimeHandoffLockFile(home);
  if (!fs.existsSync(active)) atomic(active, { journal: journalFile(binding), bindingDigest: journal.bindingDigest });
  if (JSON.parse(fs.readFileSync(active, 'utf8')).bindingDigest !== journal.bindingDigest) throw new Error('Another handoff owns this installation.');
  for (const [name, expected] of Object.entries(binding.stagedFiles)) if (fileHash(path.join(dir, name)) !== expected) throw new Error(`Staged handoff bytes changed: ${name}`);
  const target = `${binding.domain}/${journal.helperLabel}`;
  const loaded = spawnSync('/bin/launchctl', ['print', target], { encoding: 'utf8', timeout: 2500 });
  if (loaded.status === 0) {
    if (!loaded.stdout.includes(path.join(dir, 'helper.mjs'))) throw new Error('The helper job has different loaded arguments; preserving it.');
    launchctl(['kickstart', target]);
  } else launchctl(['bootstrap', binding.domain, journal.helperPlist]);
  const end = Date.now() + 5000;
  while (Date.now() < end && !readRuntimeHandoff(home, requestId, executionId)?.acknowledgedAt) await sleep(100);
  if (!readRuntimeHandoff(home, requestId, executionId)?.acknowledgedAt) throw new Error('Independent handoff helper did not acknowledge its journal.');
  const runner = binding.priorBackend.argv[1];
  if (path.resolve(runner) !== path.join(homeDirectory(home), 'production-runner.mjs')) throw new Error('Legacy runner does not belong to this installation.');
  const bridgeBytes = legacyHandoffBridge(journalFile(binding), `${binding.domain}/${journal.helperLabel}`, journal.deadline);
  const runnerHash = fileHash(runner);
  if (runnerHash !== binding.priorBackend.runnerSha256 && runnerHash !== hash(bridgeBytes)) throw new Error('Legacy runner changed after admission; preserving it.');
  if (!fs.existsSync(path.join(dir, 'original-runner.mjs'))) {
    if (runnerHash !== binding.priorBackend.runnerSha256) throw new Error('Original runner custody is missing; preserving the bridge.');
    fs.copyFileSync(runner, path.join(dir, 'original-runner.mjs'));
  }
  if (fileHash(path.join(dir, 'original-runner.mjs')) !== binding.priorBackend.runnerSha256) throw new Error('Preserved original runner changed; refusing replacement.');
  const originalJournal = readRuntimeHandoff(home, requestId, executionId);
  save(originalJournal, { originalRunnerHash: binding.priorBackend.runnerSha256 });
  const bridge = `${runner}.${process.pid}.tmp`;
  fs.writeFileSync(bridge, bridgeBytes, { mode: 0o700 });
  fs.renameSync(bridge, runner);
  const current = readRuntimeHandoff(home, requestId, executionId);
  save(current, { bridgeInstalled: true });
  return current;
}

export function runtimeHandoffDrainIdentity(journal) {
  validateJournal(journal);
  const active = runtimeHandoffLockFile(journal.binding.home);
  if (journal.phase !== 'armed' || !journal.acknowledgedAt || !journal.bridgeInstalled || !fs.existsSync(active)) return null;
  const owner = JSON.parse(fs.readFileSync(active, 'utf8'));
  const old = journal.binding.oldProcess;
  if (owner.journal !== journalFile(journal.binding) || owner.bindingDigest !== journal.bindingDigest
      || old.pid !== process.pid || old.startedAt !== startedAt(process.pid)) return null;
  return `${journal.binding.executionId}:${old.pid}:${old.startedAt}`;
}

function exactActiveOwner(journal) {
  assertObservationLease();
  const active = JSON.parse(fs.readFileSync(runtimeHandoffLockFile(journal.binding.home), 'utf8'));
  if (active.journal !== journalFile(journal.binding) || active.bindingDigest !== journal.bindingDigest) throw new Error('Active runtime handoff owner changed.');
}

export function assertRuntimeHandoffOwner(journal) {
  assertObservationLease();
  if (journal.phase === 'acknowledged') return;
  if (journal.phase === 'complete' && journal.cleanupStartedAt && !fs.existsSync(runtimeHandoffLockFile(journal.binding.home))) return;
  exactActiveOwner(journal);
}

function observationLockRoot(journal) { return path.join(path.dirname(journalFile(journal.binding)), 'verification'); }
function assertObservationLease() {
  try { assertLifecycleLockHeld(); }
  catch (error) {
    if (error.code === 'PROCESS_LOCK_LOST') throw new RuntimeObservationError('observer_lost', 'Runtime verification ownership was lost; observation remains unconfirmed.', null, 'pending');
    throw error;
  }
}
async function observationLockHeld(journal) {
  return ['held', 'uncertain'].includes((await inspectLifecycleLock(observationLockRoot(journal))).state);
}
export async function withRuntimeObservation(journal, operation, token) {
  assertObservationLease();
  if (token) {
    const owner = JSON.parse(fs.readFileSync(path.join(path.dirname(observationLockRoot(journal)), '.verification.lock/owner.json'), 'utf8'));
    if (owner.token !== token || owner.pid !== process.pid || lockProcessIdentity(owner.pid) !== owner.identity) throw new Error('Runtime observation lease changed.');
    return operation(token);
  }
  try { return await withLifecycleLock(observationLockRoot(journal), operation, { recoverStale: true }); }
  catch (error) {
    if (error.code === 'PROCESS_LOCK_BUSY') throw new RuntimeObservationError('observer_busy', 'Runtime verification is already in progress.', null, 'pending');
    if (error.code === 'PROCESS_LOCK_LOST') throw new RuntimeObservationError('observer_lost', 'Runtime verification ownership was lost; observation remains unconfirmed.', null, 'pending');
    throw error;
  }
}

const journalState = journal => hash(JSON.stringify(journal));
function unchangedJournal(journal) {
  exactActiveOwner(journal);
  const current = readRuntimeHandoff(journal.binding.home, journal.binding.requestId, journal.binding.executionId);
  if (!current || journalState(current) !== journalState(journal)) throw observationFailure('observation_changed', 'Runtime verification owner or journal changed.');
  return current;
}
function pendingMetadata(error) {
  const encoded = JSON.stringify(error.evidence ?? null);
  return { outcome: 'pending', code: error.code, reason: error.message.slice(0, 2000), observedAt: Date.now(),
    evidence: encoded.length <= 16_384 ? JSON.parse(encoded) : { summary: encoded.slice(0, 16_384), truncated: true } };
}
export function recordVerificationPending(journal, error) {
  unchangedJournal(journal);
  if (journal.phase === 'failed') return journal;
  delete journal.error;
  save(journal, { phase: 'verification-pending', lastObservation: pendingMetadata(error) });
  return journal;
}
function recordVerificationFailure(journal, error) {
  unchangedJournal(journal);
  save(journal, { phase: 'failed', error: error.message,
    failure: { phase: journal.phase, code: error instanceof RuntimeObservationError ? error.code : 'handoff_failed',
      message: error.message, evidence: error instanceof RuntimeObservationError ? error.evidence : null, failedAt: Date.now() } });
  return journal;
}
function bindLaunchedProcesses(journal, evidence) {
  if (!journal.launch || journal.phase === 'failed') return;
  if (!evidence.processes) return;
  for (const [name, identity] of Object.entries(evidence.processes)) {
    if (journal.launch.processes?.[name] && JSON.stringify(journal.launch.processes[name]) !== JSON.stringify(identity)) {
      throw observationFailure('process_changed', 'Launched service process identity changed.', { expected: journal.launch.processes, current: evidence.processes });
    }
  }
  const processes = { ...journal.launch.processes, ...evidence.processes };
  if (JSON.stringify(processes) !== JSON.stringify(journal.launch.processes)) {
    unchangedJournal(journal);
    save(journal, { launch: { ...journal.launch, processes } });
  }
}

async function checkIncompleteEvidence(journal, available, files = {}) {
  assertObservationLease();
  const b = journal.binding;
  if (run('git', ['rev-parse', 'HEAD'], { cwd: b.root }) !== b.mergeCommit) throw observationFailure('installation_changed', 'Observed approved checkout changed.');
  for (const [file, expected] of Object.entries(files)) if (fileHash(file) !== expected) throw observationFailure('installation_changed', `Observed installation changed: ${file}`);
  for (const marker of [path.join(b.root, 'dist/build-revision.json'), path.join(b.nativeApp, 'Contents/Resources/build-revision.json')]) {
    if (JSON.parse(fs.readFileSync(marker, 'utf8')).commit !== b.mergeCommit) throw observationFailure('installation_changed', 'Installed build differs from the handoff generation.');
  }
  if (available) bindLaunchedProcesses(journal, available);
  if (!available?.process?.pid || !available.daemonLog) return;
  if (startedAt(available.process.pid) !== available.process.startedAt) throw observationFailure('process_changed', 'Observed daemon process changed.');
  bindLaunchedProcesses(journal, available);
  const stat = fs.statSync(available.daemonLog.path);
  const currentLog = { ...available.daemonLog, size: stat.size };
  const covered = await resolveStderrLogCoverage(currentLog, available.process.startedAt);
  const assessor = createRuntimeLogAssessor();
  await readStderrLogCoverage(covered, currentLog, assessor.add);
  const assessment = assessor.finish();
  if (assessment.failures.length) throw observationFailure('log_assessment_failed', `Convergence logs failed assessment: ${assessment.failures.join('; ')}`, { failures: assessment.failures });
}

export function recheckRuntimeObservation(journal, receipt) {
  validateJournal(journal);
  exactActiveOwner(journal);
  if (journal.recovery) {
    const { digest, ...observation } = journal.recovery;
    if (hash(JSON.stringify(observation)) !== digest) throw new Error('Recovery observation digest differs.');
  }
  const retained = readRuntimeHandoff(journal.binding.home, journal.binding.requestId, journal.binding.executionId);
  if (!retained || retained.bindingDigest !== journal.bindingDigest || (journal.recovery && retained.recovery?.digest !== journal.recovery.digest)) throw new Error('Retained runtime observation changed.');
  if (startedAt(receipt.evidence.process.pid) !== receipt.evidence.process.startedAt) throw new Error('Observed daemon process changed.');
  if (run('git', ['rev-parse', 'HEAD'], { cwd: journal.binding.root }) !== journal.binding.mergeCommit) throw new Error('Observed approved checkout changed.');
  for (const [file, expected] of Object.entries(receipt.files)) if (fileHash(file) !== expected) throw new Error(`Observed installation changed: ${file}`);
  requireDesktopForObservation(journal);
  const log = fs.statSync(receipt.evidence.daemonLog.path);
  if (log.dev !== receipt.evidence.daemonLog.dev || log.ino !== receipt.evidence.daemonLog.ino || log.size < receipt.evidence.daemonLog.size) throw new Error('Observed daemon log rotated or truncated.');
}

export async function observeRuntimeHealthWindow({
  probe,
  now = Date.now,
  wait = sleep,
  observationMs = OBSERVATION_MS,
  deadlineMs = OBSERVATION_DEADLINE_MS,
  validateEvidence,
}) {
  let lastLogSize = null;
  const result = await observeRuntimeHealthCoverage({
    probe,
    healthOf: value => value.health ?? {},
    validate: (value, initial) => {
      if (JSON.stringify(value.process) !== JSON.stringify(initial.process)) throw observationFailure('process_changed', 'Candidate runtime process changed during observation.', { initial: initial.process, current: value.process });
      if (JSON.stringify([value.backend, value.gateway]) !== JSON.stringify([initial.backend, initial.gateway])) throw observationFailure('definition_changed', 'Candidate runtime service definitions changed during observation.', { initial: [initial.backend, initial.gateway], current: [value.backend, value.gateway] });
      if (value.daemonLog.dev !== initial.daemonLog.dev || value.daemonLog.ino !== initial.daemonLog.ino || (lastLogSize !== null && value.daemonLog.size < lastLogSize)) throw observationFailure('log_changed', 'Candidate runtime log rotated or truncated during observation.', { initial: initial.daemonLog, current: value.daemonLog });
      lastLogSize = value.daemonLog.size;
      validateEvidence?.(value);
    },
    now,
    wait,
    observationMs,
    deadlineMs,
  });
  return { evidence: result.value, observation: result.observation, samples: result.samples, performance: result.performance };
}

export async function observeRuntimeHandoff(journal, options = {}) {
  return withRuntimeObservation(journal, () => observeRuntimeHandoffOnce(journal, options), options.observerToken);
}

async function observeRuntimeHandoffOnce(journal, {
  currentVerifier = false,
  now = Date.now,
  wait = sleep,
  probe,
  observationMs = OBSERVATION_MS,
  deadlineMs = OBSERVATION_DEADLINE_MS,
  readEvidence,
} = {}) {
  validateJournal(journal);
  exactActiveOwner(journal);
  const b = journal.binding;
  const probeRuntime = probe ?? (async (until, signal) => JSON.parse(await controller(journal, 'handoff-verify', currentVerifier, { until, signal })));
  const inspectEvidence = readEvidence ?? (probe ? null : async () => JSON.parse(await controller(journal, 'handoff-evidence', currentVerifier, { until: Date.now() + 5000 })));
  let initialEvidence;
  let coverage;
  const resources = path.join(b.nativeApp, 'Contents/Resources');
  const marker = path.join(b.root, 'dist/build-revision.json');
  const installedMarker = path.join(resources, 'build-revision.json');
  if (JSON.stringify(JSON.parse(fs.readFileSync(marker))) !== JSON.stringify(JSON.parse(fs.readFileSync(installedMarker)))) throw new Error('Installed desktop differs from the handoff build.');
  const fixedFiles = [marker, installedMarker, path.join(b.root, 'dist/index.js'), path.join(b.nativeApp, 'Contents/MacOS/mandible-app')];
  let files = Object.fromEntries(fixedFiles.map(file => [file, fileHash(file)]));
  let observed;
  try {
    if (journal.launch && inspectEvidence) bindLaunchedProcesses(journal, await inspectEvidence());
    observed = await observeRuntimeHealthWindow({
    probe: async (until, signal) => {
      const value = await probeRuntime(until, signal);
      if (!value.process?.startupEpoch || !value.daemonLog) throw observationFailure('process_unavailable', 'Current-process observation is unavailable.', value);
      if (path.resolve(value.health.instance.db_path) !== path.resolve(journal.database)) throw observationFailure('process_changed', 'Observed production database identity differs.', { expected: journal.database, actual: value.health.instance.db_path });
      if (!initialEvidence) {
        initialEvidence = value;
        coverage = await resolveStderrLogCoverage(value.daemonLog, value.process.startedAt);
        files = { ...files, ...Object.fromEntries([value.backend.file, value.gateway.file].map(file => [file, fileHash(file)])) };
      }
      if (journal.launch && journal.phase !== 'failed' && !journal.launch.readyAt) {
        unchangedJournal(journal);
        save(journal, { launch: { ...journal.launch, readyAt: now() } });
      }
      return value;
    },
    now,
    wait,
    observationMs,
    deadlineMs,
    validateEvidence: () => requireDesktopForObservation(journal),
  }); } catch (error) {
    if (!observationPending(error)) throw error;
    let available = initialEvidence ?? error.evidence;
    if (inspectEvidence) {
      try { available = await inspectEvidence(); }
      catch (inspectionError) { if (!observationPending(inspectionError)) throw inspectionError; available = inspectionError.evidence ?? available; }
    }
    await checkIncompleteEvidence(journal, available, files);
    throw error;
  }
  const evidence = observed.evidence;
  const assessor = createRuntimeLogAssessor();
  const daemonLog = await readStderrLogCoverage(coverage, evidence.daemonLog, assessor.add);
  const assessment = assessor.finish();
  if (assessment.failures.length) throw observationFailure('log_assessment_failed', `Convergence logs failed assessment: ${assessment.failures.join('; ')}`, {
    observation: observed.observation,
    failures: assessment.failures,
    initialSample: observed.samples.initial,
    lastSample: observed.samples.last,
  });
  const log = path.join(path.dirname(journalFile(b)), 'convergence.log');
  const receipt = { bindingDigest: journal.bindingDigest, evidence, files, completedAt: now(), observation: observed.observation,
    samples: observed.samples,
    performance: {
      healthFindings: observed.performance,
      logEvents: assessment.diagnostics.health_events,
      httpRequests: assessment.diagnostics.http_requests,
    },
    logDigest: fs.existsSync(log) ? fileHash(log) : null, daemonLogDigest: daemonLog.sha256, daemonLogBytes: daemonLog.bytes, daemonLogOffset: coverage.offset, daemonLogSegments: coverage.segments };
  recheckRuntimeObservation(journal, receipt);
  return receipt;
}

/** A bounded current-generation probe gates the expensive recovery health window. */
export async function runtimeRecoveryEvidenceKey(journal) {
  try { return await withRuntimeObservation(journal, () => runtimeRecoveryEvidenceKeyOnce(journal)); }
  catch (error) { if (error.code === 'observer_busy') return null; throw error; }
}

async function runtimeRecoveryEvidenceKeyOnce(journal) {
  const current = readRuntimeHandoff(journal.binding.home, journal.binding.requestId, journal.binding.executionId);
  if (!current || current.bindingDigest !== journal.bindingDigest) throw new Error('Runtime handoff binding changed before evidence ownership was acquired.');
  Object.assign(journal, current);
  if (journal.phase === 'retired') return null;
  if (['complete', 'acknowledged'].includes(journal.phase)) return { outcome: 'confirmed', key: hash(JSON.stringify({ phase: journal.phase, receipt: journal.receipt, recovery: journal.recovery })) };
  exactActiveOwner(journal);
  let evidence;
  try {
    evidence = JSON.parse(await controller(journal, 'handoff-verify', true, { until: Date.now() + 5000 }));
    const defects = assessRuntimeHealth(evidence.health).defects;
    if (defects.length) throw observationFailure('invalid_diagnostics', defects[0].message, { defects });
    if ([evidence.health.eventLoop, evidence.health.memory].some(interval => interval.intervalEndedAt > Date.now())) {
      throw observationFailure('future_diagnostics', 'Runtime diagnostics end in the future.', { health: evidence.health });
    }
  } catch (error) {
    if (observationPending(error)) {
      try {
        let available = error.evidence;
        try { available = JSON.parse(await controller(journal, 'handoff-evidence', true, { until: Date.now() + 5000 })); }
        catch (inspectionError) { if (!observationPending(inspectionError)) throw inspectionError; available = inspectionError.evidence ?? available; }
        await checkIncompleteEvidence(journal, available);
        if (journal.phase !== 'failed') recordVerificationPending(journal, error);
      } catch (concrete) {
        if (journal.phase !== 'failed') recordVerificationFailure(journal, concrete);
        throw concrete;
      }
      const inspection = error.evidence?.inspection;
      const key = hash(JSON.stringify({ code: error.code, launch: journal.launch?.processes,
        state: inspection && { status: inspection.status.state, generation: inspection.main.backend_generation,
          backend: inspection.backendJob, gateway: inspection.gatewayJob,
          backendCode: inspection.backend.code, gatewayCode: inspection.gateway.code } }));
      return { outcome: 'pending', key, reason: error.message };
    }
    if (journal.phase !== 'failed') recordVerificationFailure(journal, error);
    throw error;
  }
  const resources = path.join(journal.binding.nativeApp, 'Contents/Resources');
  const files = [path.join(journal.binding.root, 'dist/build-revision.json'),
    path.join(resources, 'build-revision.json'), path.join(journal.binding.root, 'dist/index.js'),
    path.join(journal.binding.nativeApp, 'Contents/MacOS/mandible-app'), evidence.backend.file, evidence.gateway.file];
  return { outcome: 'confirmed', key: hash(JSON.stringify({ process: evidence.process, backend: evidence.backend, gateway: evidence.gateway,
    daemonLog: { path: evidence.daemonLog.path, dev: evidence.daemonLog.dev, ino: evidence.daemonLog.ino },
    files: files.map(file => [file, fileHash(file)]) })) };
}

export async function observeFailedRuntimeHandoff(journal, actor, observationOptions = {}) {
  if (!['failed', 'verification-pending', 'starting', 'observing'].includes(journal.phase)) throw new Error('Current-runtime verification requires a retained pending or failed handoff.');
  if (journal.phase !== 'failed' && !journal.launch) throw new Error('Pending verification has no durable launch boundary.');
  const wasFailed = journal.phase === 'failed';
  const failure = wasFailed ? retainedFailure(journal) : null;
  let receipt;
  try {
    receipt = await observeRuntimeHandoff(journal, { ...observationOptions, currentVerifier: true });
  } catch (error) {
    const current = readRuntimeHandoff(journal.binding.home, journal.binding.requestId, journal.binding.executionId);
    if (error.code !== 'observer_busy' && current?.bindingDigest === journal.bindingDigest) {
      if (wasFailed && current.phase === 'failed' && hash(JSON.stringify(retainedFailure(current))) === hash(JSON.stringify(failure))) {
        recordRecoveryAttempt(current, actor, failure, error);
      } else if (!wasFailed && journalState(current) === journalState(journal)) {
        if (observationPending(error)) recordVerificationPending(current, error);
        else recordVerificationFailure(current, error);
      }
    }
    throw error;
  }
  const current = readRuntimeHandoff(journal.binding.home, journal.binding.requestId, journal.binding.executionId);
  if (!current || current.bindingDigest !== journal.bindingDigest
    || (wasFailed ? current.phase !== 'failed' || hash(JSON.stringify(retainedFailure(current))) !== hash(JSON.stringify(failure))
      : journalState(current) !== journalState(journal))) throw new Error('Retained handoff changed during verification observation.');
  const recovery = { actor, observedAt: Date.now(), failure, failureDigest: hash(JSON.stringify(failure)), receipt,
    priorPhase: current.phase, ...(!wasFailed ? { baseState: journalState(current) } : {}) };
  recovery.digest = hash(JSON.stringify(recovery));
  return { ...current, recovery };
}

// The caller holds the hook acceptance SQLite transaction while persisting this
// receipt. The recovery receipt itself is persisted only in this transaction.
export function persistRuntimeRecoveryObservation(journal) {
  const current = readRuntimeHandoff(journal.binding.home, journal.binding.requestId, journal.binding.executionId);
  if (!current || current.bindingDigest !== journal.bindingDigest
    || (journal.recovery.baseState ? journalState(current) !== journal.recovery.baseState
      : current.phase !== 'failed' || hash(JSON.stringify(retainedFailure(current))) !== journal.recovery.failureDigest)) throw new Error('Retained handoff changed before observation persistence.');
  save(current, { recovery: journal.recovery });
}

function retainedFailure(journal) {
  return journal?.recovery?.failure ?? journal?.failure ?? { phase: journal?.phase, error: journal?.error, attempts: journal?.attempts, updatedAt: journal?.updatedAt };
}

function recordRecoveryAttempt(journal, actor, failure, error) {
  assertObservationLease();
  const directory = path.join(handoffDirectory(journal.binding.home, journal.binding.requestId, journal.binding.executionId), 'recovery-attempts');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const attemptedAt = Date.now();
  const attempt = {
    attemptedAt,
    actor,
    failedPhase: journal.phase,
    failure,
    outcome: observationPending(error) ? 'pending' : 'failed',
    code: error instanceof RuntimeObservationError ? error.code : 'recovery_observation_failed',
    message: error instanceof Error ? error.message : String(error),
    evidence: error instanceof RuntimeObservationError ? error.evidence : null,
  };
  const file = path.join(directory, `${String(attemptedAt).padStart(16, '0')}-${randomBytes(8).toString('hex')}.json`);
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(attempt)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const files = fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort();
  for (const expired of files.slice(0, -10)) fs.rmSync(path.join(directory, expired));
  return attempt;
}

export function readRuntimeRecoveryAttempts(home, requestId, executionId) {
  const directory = path.join(handoffDirectory(home, requestId, executionId), 'recovery-attempts');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort().map(name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')));
}

async function readRuntimeObservationAcceptance(journal) {
  const { default: Database } = await import(pathToFileURL(path.join(path.dirname(journalFile(journal.binding)), 'sqlite.mjs')).href);
  const db = new Database(journal.database, { readonly: true, fileMustExist: true });
  try {
    const run = db.prepare('SELECT id, auth_request_id, hook_id, state, output, command_digest FROM auth_hook_executions WHERE id = ? AND auth_request_id = ?').get(journal.binding.executionId, journal.binding.requestId);
    const state = runtimeObservationAcceptance(run, journal);
    if (state === 'inconsistent') throw new Error('Runtime observation acceptance is unresolved or inconsistent; preserving its evidence and owner.');
    return state;
  } finally { db.close(); }
}

export async function completeRuntimeHandoffRecovery(journal) {
  const current = readRuntimeHandoff(journal.binding.home, journal.binding.requestId, journal.binding.executionId);
  if (current?.phase === 'complete' || current?.phase === 'acknowledged') return current;
  if (!current?.recovery || !['failed', 'verification-pending', 'starting', 'observing'].includes(current.phase)
    || current.recovery.digest !== journal.recovery.digest) throw new Error('Verification observation changed before acceptance.');
  if (await readRuntimeObservationAcceptance(current) !== 'accepted') throw new Error('Recovery hook acceptance has not committed.');
  await publication(current);
  recheckRuntimeObservation(current, current.recovery.receipt);
  save(current, { phase: 'complete', receipt: current.recovery.receipt });
  return current;
}

export async function verifyRuntimeHandoffReceipt(journal, { probe = true } = {}) {
  validateJournal(journal);
  if (!['complete', 'acknowledged'].includes(journal.phase) || journal.receipt?.bindingDigest !== journal.bindingDigest) throw new Error('Runtime handoff has no exact successful receipt.');
  const b = journal.binding;
  if (run('git', ['rev-parse', 'HEAD'], { cwd: b.root }) !== b.mergeCommit) throw new Error('Production checkout moved beyond the handoff candidate.');
  for (const [file, expected] of Object.entries(journal.receipt.files)) if (fileHash(file) !== expected) throw new Error(`Converged file changed: ${file}`);
  // Recovery receipts were observed by this qualified verifier; old staged or
  // installed controllers may predate their process identity evidence.
  const evidence = probe ? JSON.parse(await controller(journal, 'handoff-verify', !!journal.recovery)) : journal.receipt.evidence;
  if (journal.receipt.evidence?.process && JSON.stringify(evidence.process) !== JSON.stringify(journal.receipt.evidence.process)) throw new Error('Converged daemon process changed after observation.');
  requireDesktopForObservation(journal);
  return { bindingDigest: journal.bindingDigest, evidence };
}

export async function acknowledgeRuntimeHandoff(binding) {
  const read = () => {
    assertObservationLease();
    const current = readRuntimeHandoff(binding.home, binding.requestId, binding.executionId);
    if (!current || current.bindingDigest !== bindingDigest(binding)) throw new Error('Runtime handoff acknowledgment binding differs.');
    return current;
  };
  await verifyRuntimeHandoffReceipt(read(), { probe: true });
  // Another acknowledger may have advanced the journal during the probe.
  const journal = read();
  if (journal.phase === 'acknowledged') return;
  if (journal.phase !== 'complete') throw new Error('Runtime handoff changed during acknowledgment.');
  if (!journal.cleanupStartedAt) save(journal, { cleanupStartedAt: Date.now() });
  // The helper is an exact independently owned job; never bootout a domain.
  const target = `${binding.domain}/${journal.helperLabel}`;
  const loaded = spawnSync('/bin/launchctl', ['print', target], { encoding: 'utf8', timeout: 2500 });
  if (loaded.status === 0) {
    if (!loaded.stdout.includes(path.join(path.dirname(journalFile(binding)), 'helper.mjs'))) throw new Error('Helper service definition changed; preserving it.');
    launchctl(['bootout', target]);
  }
  if (fs.existsSync(journal.helperPlist)) fs.unlinkSync(journal.helperPlist);
  // Compact accepted evidence remains; regenerated scripts and logs expire now.
  for (const name of [...Object.keys(binding.stagedFiles), 'helper.log', 'convergence.log', 'original-runner.mjs', 'preparation.json', 'bridge-process.json']) {
    const file = path.join(path.dirname(journalFile(binding)), name);
    if (fs.existsSync(file)) {
      if (!fs.lstatSync(file).isFile()) throw new Error(`Handoff generated material changed type; preserving ${name}.`);
      const expected = binding.stagedFiles[name] ?? (name === 'original-runner.mjs' ? journal.originalRunnerHash : name === 'convergence.log' ? journal.receipt.logDigest : null);
      if (expected && fileHash(file) !== expected) throw new Error(`Handoff generated material changed; preserving ${name}.`);
      fs.unlinkSync(file);
    }
  }
  const active = runtimeHandoffLockFile(binding.home);
  if (fs.existsSync(active)) {
    if (JSON.parse(fs.readFileSync(active, 'utf8')).bindingDigest !== journal.bindingDigest) throw new Error('Active handoff changed during acknowledgment.');
    fs.unlinkSync(active);
  }
  save(journal, { phase: 'acknowledged', acceptedAt: Date.now() });
}

/**
 * Operator retirement of a failed handoff lock. Only the exact failed owner is
 * released; its journal, staged material and logs stay in place as evidence,
 * and the lock itself moves beside them with a retirement record.
 */
export async function retireFailedRuntimeHandoff(home, { bindingDigest: expected, actor, reason }) {
  if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) throw new Error('Retirement requires the exact lock binding digest.');
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('Retirement requires a reason.');
  home = path.resolve(home);
  const file = runtimeHandoffLockFile(home);
  const lock = readRuntimeHandoffLock(home);
  if (!lock) throw new Error('No runtime handoff lock is held.');
  if (lock.bindingDigest !== expected) throw new Error('The held lock has a different binding digest; preserving it.');
  const handoffs = path.join(homeDirectory(home), 'handoff');
  const journalPath = lock.journalPath ? path.resolve(lock.journalPath) : null;
  if (!journalPath || path.dirname(path.dirname(journalPath)) !== handoffs || path.basename(journalPath) !== 'journal.json') throw new Error('The lock does not name a journal of this installation; preserving it.');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  if (journal?.schema !== 'mandible-runtime-handoff@1' || bindingDigest(journal.binding) !== journal.bindingDigest || journal.bindingDigest !== expected
      || path.resolve(journalFile(journal.binding)) !== journalPath) throw new Error('The owning journal is malformed or differs from the lock; preserving it.');
  if (!['failed', 'verification-pending'].includes(journal.phase)) throw new Error(`Only a failed or idle verification-pending handoff can be retired; this handoff is in phase ${journal.phase}.`);
  if (await observationLockHeld(journal)) throw new Error('Runtime handoff verification is still running; preserving the lock.');
  return withRuntimeObservation(journal, async () => {
    exactActiveOwner(journal);
    if (journalState(JSON.parse(fs.readFileSync(journalPath, 'utf8'))) !== journalState(journal)) throw new Error('Owning journal changed before retirement; preserving it.');
    if (journal.phase === 'verification-pending' || journal.recovery) {
      if (await readRuntimeObservationAcceptance(journal) === 'accepted') throw new Error('Runtime observation acceptance already committed; finish acknowledgment instead of retiring it.');
      exactActiveOwner(journal);
      if (journalState(JSON.parse(fs.readFileSync(journalPath, 'utf8'))) !== journalState(journal)) throw new Error('Owning journal changed during retirement inspection; preserving it.');
    }
    const dir = path.dirname(journalPath);
    const retirementFile = path.join(dir, 'retirement.json');
    const archivedLock = path.join(dir, 'retired-active.json');
    if (fs.existsSync(archivedLock)) throw new Error('Retirement lock archive already exists; preserving it.');
    const finishRetirement = retirement => {
      assertObservationLease();
      fs.renameSync(file, archivedLock);
      for (const directory of [path.dirname(file), dir]) {
        const fd = fs.openSync(directory, 'r');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      }
      return retirement;
    };
    if (fs.existsSync(retirementFile)) {
      const prior = JSON.parse(fs.readFileSync(retirementFile, 'utf8'));
      if (prior.schema !== 'mandible-runtime-handoff-retirement@1' || prior.bindingDigest !== expected
          || prior.requestId !== journal.binding.requestId || prior.executionId !== journal.binding.executionId
          || prior.journalSha256 !== fileHash(journalPath)) throw new Error('Retirement evidence differs; preserving it.');
      return finishRetirement(prior);
    }
    // The helper is an exact independently owned job; never bootout a domain.
    const target = `${journal.binding.domain}/${journal.helperLabel}`;
    const loaded = journal.binding.domain && journal.helperLabel ? spawnSync('/bin/launchctl', ['print', target], { encoding: 'utf8', timeout: 2500 }) : { status: 1 };
    if (loaded.status === 0) {
      if (!loaded.stdout.includes(path.join(dir, 'helper.mjs'))) throw new Error('Helper service definition changed; preserving it.');
      if (/\bpid = \d+/.test(loaded.stdout)) throw new Error('The handoff helper is still running; preserving the lock.');
      launchctl(['bootout', target]);
    }
    const retirement = { schema: 'mandible-runtime-handoff-retirement@1', bindingDigest: expected,
      requestId: journal.binding.requestId, executionId: journal.binding.executionId,
      failure: journal.failure ?? { phase: journal.phase, error: journal.error ?? null, attempts: journal.attempts, updatedAt: journal.updatedAt },
      journalSha256: fileHash(journalPath), helperBootedOut: loaded.status === 0, actor, reason: reason.trim(), retiredAt: Date.now() };
    assertObservationLease();
    atomic(retirementFile, retirement);
    return finishRetirement(retirement);
  });
}

export async function runRuntimeHandoffWorker(file, {
  now = Date.now, wait = sleep, control = controller, verifyPublication = publication,
  stage: executeStage = runStage, observe = observeRuntimeHandoff, desktop = restoreDesktop,
  waitMs = OBSERVATION_DEADLINE_MS,
} = {}) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  let journal = readJournalFile(raw.binding.home, raw.binding.requestId, raw.binding.executionId);
  if (journal?.phase === 'retired') return journal;
  journal = validateJournal(journal);
  if (['complete', 'acknowledged', 'failed', 'retired'].includes(journal.phase)) return journal;
  const b = journal.binding;
  const possibleLaunch = !!journal.launch || ['starting', 'observing', 'verification-pending'].includes(journal.phase);
  if (!possibleLaunch && (journal.attempts >= 6 || now() > journal.deadline)) {
    recordVerificationFailure(journal, new Error('Initial handoff execution budget exhausted before launch.'));
    return journal;
  }
  const inspectEvidence = async () => JSON.parse(await control(journal, 'handoff-evidence', false, { until: now() + 5000 }));
  const verify = async initial => {
    await withRuntimeObservation(journal, async token => {
      await verifyPublication(journal);
      const until = now() + waitMs;
      if (initial) {
        if (now() >= journal.deadline) throw new Error('Initial handoff execution budget exhausted before launch.');
        unchangedJournal(journal);
        save(journal, { phase: 'starting', launch: { id: randomBytes(12).toString('hex'), enteredAt: now() } });
        await control(journal, 'handoff-start', false, { until: journal.deadline });
      }
      try { bindLaunchedProcesses(journal, await inspectEvidence()); }
      catch (error) {
        if (!observationPending(error)) throw error;
        if (error.evidence) bindLaunchedProcesses(journal, error.evidence);
      }
      await control(journal, 'handoff-verify', false, { until, awaitReady: true });
      save(journal, { phase: 'observing', launch: { ...journal.launch, readyAt: journal.launch.readyAt ?? now() } });
      if (initial) await desktop(journal);
      const receipt = await observe(journal, { observerToken: token, deadlineMs: Math.max(0, until - now()), readEvidence: inspectEvidence });
      unchangedJournal(journal);
      save(journal, { phase: 'complete', receipt });
    });
  };
  try {
    if (possibleLaunch) {
      if (!journal.launch) save(journal, { launch: { id: randomBytes(12).toString('hex'), enteredAt: journal.updatedAt } });
      await verify(false);
      return journal;
    }
    save(journal, { attempts: journal.attempts + 1, acknowledgedAt: now() });
    while (startedAt(b.oldProcess.pid) === b.oldProcess.startedAt || !journal.bridgeInstalled) {
      if (now() > journal.deadline) throw new Error('Old daemon did not finish its bounded drain.');
      await wait(200);
      journal = readRuntimeHandoff(b.home, b.requestId, b.executionId);
    }
    await verifyPublication(journal);
    if (now() > journal.deadline) throw new Error('Initial handoff execution budget exhausted before unload.');
    save(journal, { phase: 'unloading' });
    await control(journal, 'handoff-remove');
    const log = path.join(path.dirname(file), 'convergence.log');
    const env = { ...journal.environment, MANDIBLE_RUNTIME_HANDOFF_JOURNAL: file };
    for (const [stage, binary, args, timeout] of [
      ['dependencies', b.runtime.path, ['install', '--frozen-lockfile', '--force'], 180000],
      ['build', b.runtime.path, ['run', 'build'], 180000],
      ['desktop', '/bin/bash', ['cli/install-desktop-app.sh'], 600000],
      ['instructions', '/bin/bash', ['cli/instructions.sh', 'install'], 60000],
    ]) {
      if (journal.stages[stage]) continue;
      await verifyPublication(journal);
      if (now() > journal.deadline) throw new Error('Initial handoff execution budget exhausted before installation.');
      if (stage === 'desktop' && !journal.desktopInstallation) {
        save(journal, { desktopInstallation: { issuedAt: now(), prior: b.desktopWasRunning ? desktopIdentities(b.nativeApp) : [] } });
      }
      save(journal, { phase: stage });
      await executeStage(binary, args, { cwd: b.root, env, timeout, log });
      save(journal, { stages: { ...journal.stages, [stage]: { completedAt: Date.now(), logDigest: fileHash(log) } } });
    }
    for (;;) {
      try { await verify(true); break; }
      catch (error) {
        if (journal.launch || !['observer_busy', 'observer_lost'].includes(error.code)) throw error;
        if (now() >= journal.deadline) throw new Error('Initial handoff execution budget exhausted before acquiring launch ownership.');
        await wait(Math.min(RUNTIME_HEALTH_PROBE_INTERVAL_MS, journal.deadline - now()));
      }
    }
  } catch (error) {
    const latest = readRuntimeHandoff(b.home, b.requestId, b.executionId);
    if (['complete', 'acknowledged', 'retired'].includes(latest?.phase)) return latest;
    if (!journal.launch) { recordVerificationFailure(journal, error); return journal; }
    if (error.code === 'observer_busy') return latest;
    try { return await withRuntimeObservation(journal, async () => {
      const current = readRuntimeHandoff(b.home, b.requestId, b.executionId);
      if (journalState(current) !== journalState(journal)) return current;
      if (observationPending(error) && journal.launch) {
        try {
          let available;
          try { available = await inspectEvidence(); } catch (inspectionError) { if (!observationPending(inspectionError)) throw inspectionError; available = inspectionError.evidence; }
          await checkIncompleteEvidence(journal, available);
          recordVerificationPending(journal, error);
        } catch (concrete) { recordVerificationFailure(journal, concrete); }
      } else recordVerificationFailure(journal, error);
      return journal;
    }); } catch (leaseError) {
      if (leaseError.code === 'observer_busy') return readRuntimeHandoff(b.home, b.requestId, b.executionId);
      throw leaseError;
    }
  }
  return journal;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, file] = process.argv.slice(2);
  (command === 'worker' ? runRuntimeHandoffWorker(file) : command === 'arm' ? armRuntimeHandoff(path.resolve(file || process.cwd())).then(j => {
    if (j) { process.stderr.write(`MANDIBLE_RUNTIME_HANDOFF_PENDING:${j.bindingDigest}\n`); process.exitCode = 75; }
  }) : Promise.reject(new Error('Usage: runtime-handoff.mjs arm <root>|worker <journal>'))).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
