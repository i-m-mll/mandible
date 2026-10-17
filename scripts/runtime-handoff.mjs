#!/usr/bin/env bun
// A finite convergence worker, owned by one already-applied auth publication.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { runSupervisedCommand } from './process-group-supervisor.mjs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { assessLogs } from './runtime-log-assessment.mjs';
import { runtimeEnvironment } from './runtime-environment.mjs';
import { readRuntimeHandoffLock, runtimeHandoffLockFile, runtimeHandoffLockRefusal } from './runtime-handoff-lock.mjs';

const execFileAsync = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fileHash = file => hash(fs.readFileSync(file));
export const bindingDigest = binding => hash(JSON.stringify(binding));
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
function desktopRunning(app) {
  const pids = spawnSync('/usr/bin/pgrep', ['-x', 'mandible-app'], { encoding: 'utf8', timeout: 1500 }).stdout?.trim().split('\n').filter(Boolean) ?? [];
  return pids.some(pid => {
    const command = spawnSync('/bin/ps', ['-ww', '-p', pid, '-o', 'command='], { encoding: 'utf8', timeout: 1500 }).stdout?.trim();
    return command === `${app}/Contents/MacOS/mandible-app` || command?.startsWith(`${app}/Contents/MacOS/mandible-app `);
  });
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
export function readRuntimeHandoff(home, requestId, executionId) {
  const file = path.join(handoffDirectory(home, requestId, executionId), 'journal.json');
  return fs.existsSync(file) ? validateJournal(JSON.parse(fs.readFileSync(file, 'utf8'))) : null;
}
function save(journal, changes) {
  Object.assign(journal, changes, { updatedAt: Date.now() });
  atomic(journalFile(journal.binding), journal);
}
async function controller(journal, command, currentVerifier = false) {
  const binding = journal.binding;
  const env = { ...journal.environment, MANDIBLE_RUNTIME_HANDOFF_JOURNAL: journalFile(binding), GIT_OPTIONAL_LOCKS: '0' };
  const installedController = journal.phase === 'acknowledged' || !!journal.cleanupStartedAt;
  const script = currentVerifier ? path.join(path.dirname(fileURLToPath(import.meta.url)), 'local-runtime.mjs') : installedController ? path.join(binding.root, 'scripts/local-runtime.mjs') : path.join(path.dirname(journalFile(binding)), 'controller.mjs');
  if (installedController) delete env.MANDIBLE_RUNTIME_HANDOFF_STORAGE;
  // Recovery runs inside the daemon that answers these health requests.
  // Keep its event loop available while the bounded controller probes it.
  try {
    const result = await execFileAsync(binding.runtime.path, [script, command, '--root', binding.root], {
      cwd: binding.root, env, timeout: 30000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8',
    });
    return result.stdout.trim();
  } catch (error) {
    throw new Error(`${binding.runtime.path} ${script} failed: ${error.stderr || error.message}`);
  }
}

async function publication(journal) {
  const module = await import(pathToFileURL(path.join(path.dirname(journalFile(journal.binding)), 'proof.mjs')).href);
  const { default: SqliteDatabase } = await import(pathToFileURL(path.join(path.dirname(journalFile(journal.binding)), 'sqlite.mjs')).href);
  const db = new SqliteDatabase(journal.database, { readonly: true, fileMustExist: true });
  try { return module.verifyRuntimeHandoffPublication(db, journal.binding); } finally { db.close(); }
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
  const home = path.resolve(process.env.MANDIBLE_HOME || path.join(os.homedir(), '.mandible'));
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
    for (const name of fs.readdirSync(dir)) if (!['preparation.json', 'sqlite.mjs', 'proof.mjs', 'controller.mjs', 'helper.mjs', 'canonical-origin.mjs', 'build-revision.mjs', 'local-ca-trust.mjs', 'pinned-caddy.mjs', 'runtime-environment.mjs'].includes(name) || fs.lstatSync(path.join(dir, name)).isSymbolicLink()) throw new Error('Unknown handoff preparation material; preserving it.');
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
  // Preserve CLI module boundaries: bundling several guarded CLI entrypoints
  // would make their import.meta.url guards all refer to the same entry file.
  for (const [source, name] of [['local-runtime.mjs', 'controller.mjs'], ...['canonical-origin.mjs', 'build-revision.mjs', 'local-ca-trust.mjs', 'pinned-caddy.mjs', 'runtime-environment.mjs'].map(name => [name, name])]) fs.copyFileSync(path.join(root, 'scripts', source), path.join(dir, name));
  // Initial publication validation is read-only and precedes every mutation.
  Object.assign(binding, await publication(journal));
  binding.stagedFiles = Object.fromEntries(['sqlite.mjs', 'proof.mjs', 'controller.mjs', 'helper.mjs', 'canonical-origin.mjs', 'build-revision.mjs', 'local-ca-trust.mjs', 'pinned-caddy.mjs', 'runtime-environment.mjs'].map(name => [name, fileHash(path.join(dir, name))]));
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
  const active = JSON.parse(fs.readFileSync(runtimeHandoffLockFile(journal.binding.home), 'utf8'));
  if (active.journal !== journalFile(journal.binding) || active.bindingDigest !== journal.bindingDigest) throw new Error('Active runtime handoff owner changed.');
}

export function runtimeLogStartupOffset(log, processIdentity) {
  const fd = fs.openSync(log.path, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (stat.dev !== log.dev || stat.ino !== log.ino || stat.size < log.size) throw new Error('Daemon log rotated or truncated.');
    const limit = 16 * 1024 * 1024;
    const begin = Math.max(0, stat.size - limit);
    const bytes = Buffer.alloc(stat.size - begin);
    fs.readSync(fd, bytes, 0, bytes.length, begin);
    const lines = bytes.toString('utf8').split('\n');
    let relative = bytes.length;
    for (let index = lines.length - 1; index >= (begin ? 1 : 0); index--) {
      relative -= Buffer.byteLength(lines[index]) + (index === lines.length - 1 ? 0 : 1);
      let row;
      try { row = JSON.parse(lines[index]); } catch { continue; }
      if ((row.message || row.event) !== 'server_started') continue;
      const time = Date.parse(row.time);
      const processTime = Date.parse(processIdentity.startedAt);
      if (!Number.isFinite(time) || !Number.isFinite(processTime) || time < processTime - 1000 || time > processTime + 60000) throw new Error('Daemon log startup does not identify the current process.');
      return begin + relative;
    }
    if (begin) throw new Error('Current daemon startup exceeds the 16 MiB observation coverage limit; preserve the log and arrange an explicitly authorized fresh runtime launch.');
    throw new Error('Current daemon startup is absent from its actual log.');
  } finally { fs.closeSync(fd); }
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
  const log = fs.statSync(receipt.evidence.daemonLog.path);
  if (log.dev !== receipt.evidence.daemonLog.dev || log.ino !== receipt.evidence.daemonLog.ino || log.size < receipt.evidence.daemonLog.size) throw new Error('Observed daemon log rotated or truncated.');
}

export async function observeRuntimeHandoff(journal, { currentVerifier = false } = {}) {
  validateJournal(journal);
  exactActiveOwner(journal);
  const b = journal.binding;
  let evidence = JSON.parse(await controller(journal, 'handoff-verify', currentVerifier));
  if (!evidence.process?.startupEpoch || !evidence.daemonLog) throw new Error('Current-process observation is unavailable.');
  if (path.resolve(evidence.health.instance.db_path) !== path.resolve(journal.database)) throw new Error('Observed production database identity differs.');
  const identity = JSON.stringify(evidence.process);
  const definitions = JSON.stringify([evidence.backend, evidence.gateway]);
  const offset = runtimeLogStartupOffset(evidence.daemonLog, evidence.process);
  const resources = path.join(b.nativeApp, 'Contents/Resources');
  const marker = path.join(b.root, 'dist/build-revision.json');
  if (JSON.stringify(JSON.parse(fs.readFileSync(marker))) !== JSON.stringify(JSON.parse(fs.readFileSync(path.join(resources, 'build-revision.json'))))) throw new Error('Installed desktop differs from the handoff build.');
  const files = Object.fromEntries([marker, path.join(b.root, 'dist/index.js'), path.join(b.nativeApp, 'Contents/MacOS/mandible-app'), evidence.backend.file, evidence.gateway.file].map(file => [file, fileHash(file)]));
  const initialLog = evidence.daemonLog;
  const observedUntil = Date.now() + 31000;
  while (Date.now() < observedUntil) {
    await sleep(1000);
    evidence = JSON.parse(await controller(journal, 'handoff-verify', currentVerifier));
    if (JSON.stringify(evidence.process) !== identity || JSON.stringify([evidence.backend, evidence.gateway]) !== definitions
      || evidence.daemonLog.dev !== initialLog.dev || evidence.daemonLog.ino !== initialLog.ino || evidence.daemonLog.size < initialLog.size
      || evidence.health.eventLoop?.warning || evidence.health.memory?.warning) throw new Error('Candidate runtime changed or became unhealthy during observation.');
    initialLog.size = evidence.daemonLog.size;
  }
  const fd = fs.openSync(evidence.daemonLog.path, 'r');
  let daemonLog;
  try {
    const stat = fs.fstatSync(fd);
    if (stat.dev !== initialLog.dev || stat.ino !== initialLog.ino || stat.size < initialLog.size) throw new Error('Daemon log coverage changed.');
    if (stat.size - offset > 16 * 1024 * 1024) throw new Error('Current-process log exceeds the 16 MiB observation coverage limit; preserve the log and arrange an explicitly authorized fresh runtime launch.');
    const bytes = Buffer.alloc(stat.size - offset); fs.readSync(fd, bytes, 0, bytes.length, offset); daemonLog = bytes.toString('utf8');
  } finally { fs.closeSync(fd); }
  const failures = assessLogs(daemonLog);
  if (failures.length) throw new Error(`Convergence logs failed assessment: ${failures.join('; ')}`);
  const log = path.join(path.dirname(journalFile(b)), 'convergence.log');
  const receipt = { bindingDigest: journal.bindingDigest, evidence, files, completedAt: Date.now(),
    logDigest: fs.existsSync(log) ? fileHash(log) : null, daemonLogDigest: hash(daemonLog), daemonLogBytes: Buffer.byteLength(daemonLog), daemonLogOffset: offset };
  recheckRuntimeObservation(journal, receipt);
  return receipt;
}

export async function observeFailedRuntimeHandoff(journal, actor) {
  if (journal.phase !== 'failed') throw new Error('Verification-only recovery requires a retained failed handoff.');
  const failure = journal.recovery?.failure ?? { phase: journal.phase, error: journal.error, attempts: journal.attempts, updatedAt: journal.updatedAt };
  const receipt = await observeRuntimeHandoff(journal, { currentVerifier: true });
  const current = readRuntimeHandoff(journal.binding.home, journal.binding.requestId, journal.binding.executionId);
  if (!current || current.phase !== 'failed' || current.bindingDigest !== journal.bindingDigest || (current.recovery?.failure ? hash(JSON.stringify(current.recovery.failure)) : hash(JSON.stringify({ phase: current.phase, error: current.error, attempts: current.attempts, updatedAt: current.updatedAt }))) !== hash(JSON.stringify(failure))) throw new Error('Failed handoff changed during recovery observation.');
  const recovery = { actor, observedAt: Date.now(), failure, failureDigest: hash(JSON.stringify(failure)), receipt };
  recovery.digest = hash(JSON.stringify(recovery));
  return { ...current, recovery };
}

// The caller holds the hook acceptance SQLite transaction while persisting this
// receipt. Observation itself never writes, so another observer cannot overwrite
// bytes after the corresponding hook acceptance commits.
export function persistRuntimeRecoveryObservation(journal) {
  const current = readRuntimeHandoff(journal.binding.home, journal.binding.requestId, journal.binding.executionId);
  const failure = current?.recovery?.failure ?? { phase: current?.phase, error: current?.error, attempts: current?.attempts, updatedAt: current?.updatedAt };
  if (!current || current.phase !== 'failed' || current.bindingDigest !== journal.bindingDigest || hash(JSON.stringify(failure)) !== journal.recovery.failureDigest) throw new Error('Failed handoff changed before observation persistence.');
  save(current, { recovery: journal.recovery });
}

export async function completeRuntimeHandoffRecovery(journal) {
  const current = readRuntimeHandoff(journal.binding.home, journal.binding.requestId, journal.binding.executionId);
  if (current?.phase === 'complete' || current?.phase === 'acknowledged') return current;
  if (!current?.recovery || current.phase !== 'failed' || current.recovery.digest !== journal.recovery.digest) throw new Error('Recovery observation changed before acceptance.');
  const { default: Database } = await import(pathToFileURL(path.join(path.dirname(journalFile(current.binding)), 'sqlite.mjs')).href);
  const db = new Database(current.database, { readonly: true, fileMustExist: true });
  try {
    const run = db.prepare('SELECT state, output, command_digest FROM auth_hook_executions WHERE id = ? AND auth_request_id = ?').get(current.binding.executionId, current.binding.requestId);
    if (run?.state !== 'complete' || run.command_digest !== current.binding.commandDigest || !run.output.includes(`MANDIBLE_RUNTIME_RECOVERY_ACCEPTED:${current.recovery.digest}`)) throw new Error('Recovery hook acceptance has not committed.');
  } finally { db.close(); }
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
  return { bindingDigest: journal.bindingDigest, evidence };
}

export async function acknowledgeRuntimeHandoff(binding) {
  const journal = readRuntimeHandoff(binding.home, binding.requestId, binding.executionId);
  if (!journal || journal.bindingDigest !== bindingDigest(binding)) throw new Error('Runtime handoff acknowledgment binding differs.');
  await verifyRuntimeHandoffReceipt(journal, { probe: true });
  if (journal.phase === 'acknowledged') return;
  save(journal, { cleanupStartedAt: Date.now() });
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
export function retireFailedRuntimeHandoff(home, { bindingDigest: expected, actor, reason }) {
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
  if (journal.phase !== 'failed') throw new Error(`Only a failed handoff can be retired; this handoff is in phase ${journal.phase}.`);
  const dir = path.dirname(journalPath);
  for (const name of ['retirement.json', 'retired-active.json']) if (fs.existsSync(path.join(dir, name))) throw new Error(`Retirement evidence already exists: ${name}; preserving it.`);
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
    failure: { phase: journal.phase, error: journal.error ?? null, attempts: journal.attempts, updatedAt: journal.updatedAt },
    journalSha256: fileHash(journalPath), helperBootedOut: loaded.status === 0, actor, reason: reason.trim(), retiredAt: Date.now() };
  atomic(path.join(dir, 'retirement.json'), retirement);
  fs.renameSync(file, path.join(dir, 'retired-active.json'));
  for (const directory of [path.dirname(file), dir]) {
    const fd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  return retirement;
}

async function worker(file) {
  let journal = validateJournal(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (['complete', 'acknowledged', 'failed'].includes(journal.phase)) return;
  if (journal.attempts >= 6 || Date.now() > journal.deadline) { save(journal, { phase: 'failed', error: 'Finite handoff recovery budget exhausted.' }); return; }
  save(journal, { attempts: journal.attempts + 1, acknowledgedAt: Date.now() });
  const b = journal.binding;
  try {
    while (startedAt(b.oldProcess.pid) === b.oldProcess.startedAt || !journal.bridgeInstalled) {
      if (Date.now() > journal.deadline) throw new Error('Old daemon did not finish its bounded drain.');
      await sleep(200);
      journal = readRuntimeHandoff(b.home, b.requestId, b.executionId);
    }
    await publication(journal);
    save(journal, { phase: 'unloading' });
    await controller(journal, 'handoff-remove');
    const log = path.join(path.dirname(file), 'convergence.log');
    const env = { ...journal.environment, MANDIBLE_RUNTIME_HANDOFF_JOURNAL: file };
    for (const [stage, binary, args, timeout] of [
      ['dependencies', b.runtime.path, ['install', '--frozen-lockfile', '--force'], 180000],
      ['build', b.runtime.path, ['run', 'build'], 180000],
      ['desktop', '/bin/bash', ['cli/install-desktop-app.sh'], 600000],
      ['instructions', '/bin/bash', ['cli/instructions.sh', 'install'], 60000],
    ]) {
      if (journal.stages[stage]) continue;
      await publication(journal);
      save(journal, { phase: stage });
      await runStage(binary, args, { cwd: b.root, env, timeout, log });
      save(journal, { stages: { ...journal.stages, [stage]: { completedAt: Date.now(), logDigest: fileHash(log) } } });
    }
    save(journal, { phase: 'starting' });
    const deadline = Math.min(journal.deadline, Date.now() + 60000);
    let evidence;
    // Start once; readiness polling does not repeatedly restart the daemon.
    try { await controller(journal, 'handoff-start'); } catch (error) { journal.startObservation = error.message; }
    while (Date.now() < deadline) {
      try { evidence = JSON.parse(await controller(journal, 'handoff-verify')); break; } catch { await sleep(200); }
    }
    if (!evidence) throw new Error(`Candidate runtime readiness failed: ${journal.startObservation || 'health deadline'}`);
    if (b.desktopWasRunning && !journal.stages.desktopRelaunch) {
      run('/bin/bash', ['cli/install-desktop-app.sh', '--relaunch', b.nativeApp, 'mandible-app', '0'], { cwd: b.root, env, timeout: 15000, log });
      save(journal, { stages: { ...journal.stages, desktopRelaunch: { completedAt: Date.now() } } });
      if (!desktopRunning(b.nativeApp)) throw new Error('Installed desktop did not remain running after relaunch.');
    }
    const receipt = await observeRuntimeHandoff(journal);
    save(journal, { phase: 'complete', receipt });
  } catch (error) { save(journal, { phase: 'failed', error: error.message }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, file] = process.argv.slice(2);
  (command === 'worker' ? worker(file) : command === 'arm' ? armRuntimeHandoff(path.resolve(file || process.cwd())).then(j => {
    if (j) { process.stderr.write(`MANDIBLE_RUNTIME_HANDOFF_PENDING:${j.bindingDigest}\n`); process.exitCode = 75; }
  }) : Promise.reject(new Error('Usage: runtime-handoff.mjs arm <root>|worker <journal>'))).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
