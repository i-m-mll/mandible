#!/usr/bin/env bun
// A finite convergence worker, owned by one already-applied auth publication.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { runSupervisedCommand } from './process-group-supervisor.mjs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { runtimeEnvironment } from './runtime-environment.mjs';
import { readRuntimeHandoffLock, runtimeHandoffLockFile, runtimeHandoffLockRefusal, runtimeHandoffBindingDigest } from './runtime-handoff-lock.mjs';
import { RuntimeObservationError, observationPending, runtimeObservationAcceptance } from './runtime-observation.mjs';
import { withLifecycleLock, withInstallationGatewayLock, inspectLifecycleLock, assertLifecycleLockHeld, processIdentity as lockProcessIdentity } from './lifecycle-lock.mjs';
import { acceptedInstallPaths, preparedApplicationContext, applicationRootIdentity, prepareAcceptedApplication, installAcceptedApplication } from './accepted-app-install.mjs';
import { serviceInstallationContext, inspectServiceDefinitionsSync, matchingServiceDefinitions, parseLoadedService } from './service-definitions.mjs';
import { admitBundleOwner } from './bundle-services.mjs';
import { installedResourceRoot, installedRuntimeEnvironment, installedFileIdentity, readInstalledRelease, releaseFile } from './installed-release.mjs';
import { readAcceptedReleaseReceipt, disposeAcceptedRelease } from './accepted-release.mjs';
import { ownedRunReceipt, inspectRunConsumers } from './owned-run.mjs';
import SqliteDatabase from '../src/sqlite.ts';
import { verifyRuntimeHandoffAuthority } from '../src/runtime-handoff-proof.ts';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fileHash = file => hash(fs.readFileSync(file));
const acceptedOperations = new AsyncLocalStorage();
const installationOperations = new AsyncLocalStorage();
const observationOperations = new AsyncLocalStorage();
export function verifyUpdaterClosure(reference) {
  const receipt = readAcceptedReleaseReceipt(reference);
  const app = path.join(receipt.package.handle.root, receipt.package.path);
  const resources = path.join(app, 'Contents/Resources');
  const release = receipt.shipped;
  for (const relative of new Set(['handoff/helper.mjs', release.native.bun, release.native.sqlite])) {
    const expected = release.files[relative];
    if (!expected) throw new Error(`Updater closure input is not approved: ${relative}`);
    const actual = installedFileIdentity(releaseFile(resources, relative, release.layout));
    if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) throw new Error(`Approved updater closure changed: ${relative}`);
  }
  return { receipt, app, resources };
}
function withAcceptedClosure(journal, operation) {
  if (acceptedOperations.getStore()?.bindingDigest === journal.bindingDigest) return operation();
  return acceptedOperations.run({ bindingDigest: journal.bindingDigest, accepted: null }, operation);
}
function preparedLease(journal) {
  const observation = observationOperations.getStore();
  const installation = installationOperations.getStore();
  const attemptId = journal.attempt?.id;
  if (!observation || !installation || !attemptId) throw new Error('Prepared application requires live attempt ownership.');
  return () => {
    if (observationOperations.getStore() !== observation || installationOperations.getStore() !== installation
        || journal.attempt?.id !== attemptId) throw new Error('Prepared application lease expired.');
    assertObservationLease(journal);
    exactActiveOwner(journal);
  };
}
function installedApplication(journal) {
  const scope = acceptedOperations.getStore();
  if (!scope || scope.bindingDigest !== journal.bindingDigest) throw new Error('Application verification requires its owned operation.');
  scope.prepared ??= prepareAcceptedApplication(journal.binding, { until: (journal.attempt?.deadline ?? journal.deadline),
    attemptId: journal.attempt.id, assertHeld: preparedLease(journal), phase: 'installed',
    stageIdentity: journal.attempt.effects.prepare?.stageIdentity ?? journal.attempt.receipt?.installed?.identity });
  const application = preparedApplicationContext(scope.prepared, journal.binding);
  if (!application.installed) throw new Error('Operation requires the installed prepared application.');
  return application;
}
export const bindingDigest = runtimeHandoffBindingDigest;
async function verifyAcceptedBytes(journal, cleanup = false) {
  assertObservationLease(journal);
  const b = journal.binding;
  if (!b.acceptedRelease) return;
  if (!cleanup) {
    installedApplication(journal);
    return;
  }
  const previous = acceptedInstallPaths(b).previous;
  if (fs.existsSync(previous)) {
    const prior = applicationRootIdentity(previous);
    if (!b.priorAppIdentity || prior.dev !== b.priorAppIdentity.dev || prior.ino !== b.priorAppIdentity.ino) throw new Error('Previous app custody changed.');
    const oldProcesses = [b.oldProcess, ...Object.values(journal.attempt?.effects.drain?.processes ?? {})];
    if (oldProcesses.some(identity => identity && startedAt(identity.pid) === identity.startedAt)) throw new Error('Prior application still has a live owned process.');
    const consumers = inspectRunConsumers(previous);
    if (!consumers.idle) throw new Error(consumers.reason);
    assertObservationLease(journal);
    fs.rmSync(previous, { recursive: true });
  }
  const superseded = b.bundleOwner?.acceptedRelease;
  if (superseded && superseded !== b.acceptedRelease.reference) {
    const old = readAcceptedReleaseReceipt(superseded);
    if (ownedRunReceipt(old.package.handle)?.cleanup !== 'completed') {
      const result = await disposeAcceptedRelease(superseded, old.candidate, `Superseded by ${b.acceptedRelease.reference}`,
        { home: b.home, assertHeld: () => assertObservationLease(journal) });
      if (result.action !== 'delete-owned' || result.remaining?.length) throw new Error('Superseded package cleanup is incomplete.');
    }
  }
}

function atomic(file, value) {
  assertObservationLease();
  const scope = observationOperations.getStore();
  if (!file.startsWith(`${path.dirname(scope.file)}${path.sep}`) && file !== runtimeHandoffLockFile(scope.home)) throw new Error('Handoff write belongs to another journal.');
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
  assertObservationLease(journal);
  const b = journal.binding;
  if (!b.desktopWasRunning) return;
  const stage = journal.attempt?.effects.desktop ?? journal.stages?.desktopRelaunch;
  const identities = desktopIdentities(b.nativeApp);
  if (stage?.identity) {
    if (!identities.some(identity => JSON.stringify(identity) === JSON.stringify(stage.identity))) {
      throw observationFailure('desktop_exited', 'Installed desktop did not remain running after relaunch.');
    }
    return;
  }
  const issuedAt = stage?.issuedAt ?? journal.desktopInstallation?.issuedAt ?? journal.launch?.enteredAt;
  const prior = stage?.prior ?? journal.desktopInstallation?.prior ?? journal.launch?.desktopPrior;
  const exact = issuedAt && prior ? identities.filter(identity => identity.startedAt && identity.installedImage
    && Date.parse(identity.startedAt) >= Math.floor(issuedAt / 1000) * 1000
    && !prior.some(old => old.pid === identity.pid && old.startedAt === identity.startedAt)) : [];
  if (exact.length !== 1) throw new RuntimeObservationError('desktop_unconfirmed',
    'Backend is at the expected build; the updated desktop has not been observed. Quit and reopen the installed Mandible app; verification will resume.', { issuedAt, identities, prior }, 'pending');
  if (journal.attempt) { saveEffect(journal, 'desktop', { identity: exact[0], confirmedAt: Date.now() }); return; }
  unchangedJournal(journal);
  save(journal, { ...(journal.phase === 'failed' && !journal.failure ? { failure: retainedFailure(journal) } : {}),
    stages: { ...journal.stages, desktopRelaunch: { ...stage,
    identity: exact[0], confirmedAt: Date.now(), ...(!stage?.issuedAt ? { suppliedExternally: true } : {}) } } });
}

async function restoreDesktop(journal) {
  const b = journal.binding;
  if (!b.desktopWasRunning) return;
  if (journal.attempt) {
    const effect = journal.attempt.effects.desktop;
    if (effect?.identity) { requireDesktopForObservation(journal); return; }
    if (!effect?.issuedAt) saveEffect(journal, 'desktop', { issuedAt: Date.now(), prior: desktopIdentities(b.nativeApp) });
    const current = journal.attempt.effects.desktop;
    const identities = desktopIdentities(b.nativeApp).filter(identity => identity.installedImage && identity.startedAt
      && !current.prior.some(old => old.pid === identity.pid && old.startedAt === identity.startedAt));
    if (identities.length !== 1) {
      await runStage('/bin/bash', [path.join(installedApplication(journal).resources, 'cli/install-desktop-app.sh'), '--relaunch', b.nativeApp, 'mandible-app', '0'], {
        cwd: path.dirname(journalFile(b)), env: { ...journal.environment, MANDIBLE_RUNTIME_HANDOFF_JOURNAL: journalFile(b) },
        timeout: Math.max(1, Math.min(15000, journal.attempt.deadline - Date.now())), log: path.join(path.dirname(journalFile(b)), 'convergence.log') });
    }
    requireDesktopForObservation(journal);
    saveEffect(journal, 'desktop', { completedAt: Date.now() });
    return;
  }
  throw new Error('Desktop effects require a current approved update attempt.');
}

const homeDirectory = home => path.join(home, 'config', 'local-sessions');
export function handoffDirectory(home, requestId, executionId) {
  for (const id of [requestId, executionId]) if (!/^[a-zA-Z0-9_-]{8,128}$/.test(id)) throw new Error('Invalid runtime handoff owner.');
  return path.join(homeDirectory(home), 'handoff', `${requestId}-${executionId}`);
}
function journalFile(binding) { return path.join(handoffDirectory(binding.home, binding.requestId, binding.executionId), 'journal.json'); }
function validateJournal(journal) {
  if (journal?.schema !== 'mandible-runtime-handoff@1' || bindingDigest(journal.binding) !== journal.bindingDigest) throw new Error('Runtime handoff binding is malformed or changed.');
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
  assertObservationLease(journal);
  const scope = observationOperations.getStore();
  const current = fs.existsSync(scope.file) ? journalState(JSON.parse(fs.readFileSync(scope.file, 'utf8'))) : null;
  if (current !== scope.baseline || current !== null && journalState(journal) !== current) throw observationFailure('observation_changed', 'Journal changed within its observation ownership.');
  Object.assign(journal, changes, { updatedAt: Date.now() });
  atomic(journalFile(journal.binding), journal);
  scope.baseline = journalState(journal);
}
function observationFailure(code, message, evidence) {
  return new RuntimeObservationError(code, message, evidence);
}
async function ownedNativeContext(journal) {
  const api = await import('./local-runtime.mjs');
  const scope = acceptedOperations.getStore();
  const b = journal.binding;
  scope.context ??= api.createHandoffContext({ home: b.home, root: b.root, accountHome: b.accountHome,
    domain: b.domain, bundleRoot: b.nativeApp, bundleIdentifier: scope.prepared?.bundleIdentifier });
  return scope.context;
}
async function controller(journal, command, currentVerifier = false, { until = (journal.attempt?.deadline ?? journal.deadline), awaitReady = false, signal } = {}) {
  assertObservationLease(journal);
  const api = await import('./local-runtime.mjs');
  const scope = acceptedOperations.getStore();
  const b = journal.binding;
  const context = await ownedNativeContext(journal);
  const options = { context, journal, assertHeld: preparedLease(journal), prepared: scope.prepared,
    until, awaitReady, signal, processes: journal.attempt?.effects.services?.processes ?? {},
    expectedProcesses: journal.attempt?.effects.services?.processes ?? {},
    expectedServing: !!journal.attempt?.effects.services?.readyAt, startupEpoch: scope.startupEpoch };
  let result;
  if (command === 'handoff-remove') result = await api.removeHandoffDefinitions(b, options);
  else if (command === 'handoff-start') result = await api.startHandoffDefinitions(b, options);
  else if (command === 'handoff-evidence') result = await api.inspectHandoffEvidence(b, options.processes, options);
  else if (command === 'handoff-verify') result = await api.verifyHandoffDefinitions(b, options);
  else if (command === 'handoff-probe') result = await api.probeHandoffRuntime(b, { ...options,
    generation: preparedApplicationContext(scope.prepared, b).release.provenance.commit });
  else throw new Error(`Unsupported direct handoff operation: ${command}`);
  if (command === 'handoff-verify' && result.process?.startupEpoch) scope.startupEpoch ??= result.process.startupEpoch;
  assertObservationLease(journal);
  return JSON.stringify(result);
}

async function confirmPreparedRuntime(journal, { control = controller, until } = {}) {
  const scope = acceptedOperations.getStore();
  const application = installedApplication(journal);
  const evidence = await readControllerEvidence(journal, 'handoff-evidence', false, {
    until, prepared: scope.prepared, assertHeld: preparedLease(journal), context: scope.context,
  }, control);
  if (!scope.startupEpoch) throw new Error('Serving startup epoch was not captured.');
  const serving = await readControllerEvidence(journal, 'handoff-probe', false, { until }, control);
  requireDesktopForObservation(journal);
  return { schema: 'mandible-runtime-receipt@2', approved: { reference: application.reference,
    packageSha256: application.digest, publicationEvidence: journal.binding.publicationEvidence },
    installed: { root: application.app, identity: application.identity },
    services: evidence.processes,
    startup: { epoch: serving.process.startupEpoch, generation: serving.health.instance.backend_generation,
      database: path.resolve(serving.health.instance.db_path) },
    desktop: journal.attempt.effects.desktop ?? { required: false },
    diagnostics: { daemonLog: evidence.daemonLog } };
}

async function publication(journal) {
  const db = new SqliteDatabase(journal.database, { readonly: true, fileMustExist: true });
  try { return await verifyRuntimeHandoffAuthority(db, journal.binding); } finally { db.close(); }
}
function plist(journal, helper) {
  const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const binding = journal.binding;
  const dir = path.dirname(journalFile(binding));
  const environment = ['HOME', 'MANDIBLE_HOME', 'MANDIBLE_RELEASE_ROOT', 'MANDIBLE_SQLITE_LIBRARY', 'MANDIBLE_SQLITE_LIBRARY_ARCHIVE'].filter(key => journal.environment[key]).map(key => `<key>${esc(key)}</key><string>${esc(journal.environment[key])}</string>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${esc(journal.helperLabel)}</string><key>ProgramArguments</key><array>${[binding.runtime.path, helper, 'worker', journalFile(binding)].map(v => `<string>${esc(v)}</string>`).join('')}</array><key>EnvironmentVariables</key><dict>${environment}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>10</integer><key>WorkingDirectory</key><string>${esc(dir)}</string><key>StandardOutPath</key><string>${esc(path.join(dir, 'helper.log'))}</string><key>StandardErrorPath</key><string>${esc(path.join(dir, 'helper.log'))}</string></dict></plist>`;
}
export async function armRuntimeHandoff(root) {
  const home = path.resolve(process.env.MANDIBLE_HOME || path.join(os.userInfo().homedir, '.mandible'));
  const identity = { binding: { home, requestId: process.env.MANDIBLE_AUTH_REQUEST_ID, executionId: process.env.MANDIBLE_HOOK_EXECUTION_ID } };
  const journal = await withRuntimeObservation(identity, () => armRuntimeHandoffOwned(root));
  return waitForAdmission(journal);
}
async function armRuntimeHandoffOwned(root) {
  if (process.platform !== 'darwin') throw new Error('Production runtime handoff requires macOS launchd.');
  const home = path.resolve(process.env.MANDIBLE_HOME || path.join(os.userInfo().homedir, '.mandible'));
  const requestId = process.env.MANDIBLE_AUTH_REQUEST_ID;
  const executionId = process.env.MANDIBLE_HOOK_EXECUTION_ID;
  const existing = readRuntimeHandoff(home, requestId, executionId);
  if (existing) {
    if (existing.binding.commandDigest !== process.env.MANDIBLE_HOOK_COMMAND_DIGEST || existing.binding.root !== root) throw new Error('Repeated hook differs from the armed handoff.');
    return withAcceptedClosure(existing, () => prepareHandoffAdmission(existing));
  }
  const lock = readRuntimeHandoffLock(home);
  if (lock) throw new Error(`Another handoff owns this installation; preserving it. ${runtimeHandoffLockRefusal(lock)}`);
  const database = process.env.MANDIBLE_DB || path.join(home, 'mandible.db');
  const preliminary = { delivery: 'accepted-release', root, requestId, executionId,
    hookId: process.env.MANDIBLE_HOOK_ID, commandDigest: process.env.MANDIBLE_HOOK_COMMAND_DIGEST };
  const { freezeRuntimeHandoffPublication } = await import(pathToFileURL(path.join(root, 'src/runtime-handoff-proof.ts')).href);
  const { default: Database } = await import(pathToFileURL(path.join(root, 'src/sqlite.ts')).href);
  const authority = new Database(database, { fileMustExist: true });
  let approved;
  try { approved = await freezeRuntimeHandoffPublication(authority, preliminary); } finally { authority.close(); }
  const accepted = verifyUpdaterClosure(approved.acceptedRelease.reference);
  const runtime = releaseFile(accepted.resources, accepted.receipt.shipped.native.bun);
  const dir = handoffDirectory(home, requestId, executionId);
  fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
  const runtimeHash = accepted.receipt.shipped.files[accepted.receipt.shipped.native.bun].sha256;
  const preparation = { requestId, executionId, root, runtime, runtimeHash };
  const preparationFile = path.join(dir, 'preparation.json');
  if (fs.existsSync(preparationFile)) {
    if (JSON.stringify(JSON.parse(fs.readFileSync(preparationFile, 'utf8'))) !== JSON.stringify(preparation)) throw new Error('Preparation belongs to different handoff bytes.');
  } else atomic(preparationFile, preparation);
  const environment = installedRuntimeEnvironment(accepted.resources, runtimeEnvironment({ runtime, root }));
  for (const key of Object.keys(environment)) if (/TOKEN|SECRET|KEYCHAIN|API_KEY/.test(key)) delete environment[key];
  const native = await import('./local-runtime.mjs');
  const context = native.createHandoffContext({ home, root, accountHome: os.userInfo().homedir });
  const binding = { ...await native.captureRuntimeHandoff(root, { context }), accountHome: context.accountHome, handoffProtocol: 2,
    delivery: 'accepted-release', requestId, executionId, hookId: process.env.MANDIBLE_HOOK_ID, commandDigest: process.env.MANDIBLE_HOOK_COMMAND_DIGEST,
    mergeBase: process.env.MANDIBLE_AUTH_MERGE_BASE_SHA || undefined, mergeHead: process.env.MANDIBLE_AUTH_MERGE_HEAD_SHA || undefined,
    mergeCommit: process.env.MANDIBLE_AUTH_MERGE_COMMIT_SHA || undefined,
    nativeApp: path.resolve(process.env.MANDIBLE_DESKTOP_INSTALL_PATH || '/Applications/Mandible.app'), desktopWasRunning: desktopRunning(path.resolve(process.env.MANDIBLE_DESKTOP_INSTALL_PATH || '/Applications/Mandible.app')),
    runtime: { path: runtime, version: accepted.receipt.shipped.provenance.bun_revision, sha256: runtimeHash } };
  assertNativePredecessor(binding);
  if (binding.bundleOwner) {
    if (!process.env.MANDIBLE_DESKTOP_INSTALL_PATH) binding.nativeApp = binding.bundleOwner.bundleRoot;
    if (binding.nativeApp !== binding.bundleOwner.bundleRoot) throw new Error('Accepted-package replacement must preserve the owning app location. Relocate it explicitly before publication.');
    binding.desktopWasRunning = desktopRunning(binding.nativeApp);
  }
  binding.priorAppIdentity = fs.existsSync(binding.nativeApp) ? applicationRootIdentity(binding.nativeApp) : null;
  binding.predecessorHandoffProtocol = readInstalledRelease(path.join(binding.nativeApp, 'Contents/Resources')).handoff_protocol ?? 1;
  if (![1, 2].includes(binding.predecessorHandoffProtocol)) throw new Error('Unsupported predecessor handoff protocol.');
  const journal = { schema: 'mandible-runtime-handoff@1', binding, bindingDigest: '', phase: 'preparing', attempts: 0,
    deadline: Date.now() + 30 * 60 * 1000, stages: {}, environment,
    database,
    helperLabel: `bio.mll.mandible.runtime-handoff.${hash(`${home}:${requestId}:${executionId}`).slice(0, 16)}` };
  Object.assign(binding, approved);
  binding.updater = { resources: accepted.resources, helper: path.join(accepted.resources, 'handoff/helper.mjs') };
  binding.stagedFiles = {};
  journal.bindingDigest = bindingDigest(binding);
  const helper = binding.updater.helper;
  const service = path.join(homeDirectory(home), 'launch-agents', `${journal.helperLabel}.plist`);
  journal.helperPlist = service;
  return withAcceptedClosure(journal, () => prepareHandoffAdmission(journal));
}
function assertNativePredecessor(binding) {
  if (!binding.bundleOwner || binding.priorBackend?.definition?.BundleProgram !== 'Contents/MacOS/mandible-service') {
    throw new Error('New update admission requires the currently owned native application.');
  }
}
function pendingAdmission(journal) {
  return !journal.attempt?.fence && !journal.mutationFence && !['retired', 'acknowledged', 'complete', 'failed'].includes(journal.phase)
    && (journal.attempt ? journal.attempt.state === 'running' : journal.phase === 'preparing');
}
function publishActiveOwner(journal) {
  assertObservationLease(journal);
  const active = readRuntimeHandoffLock(journal.binding.home);
  if (active) { exactActiveOwner(journal); return; }
  if (journal.admission?.publication !== 'publishing' || journal.admission.attemptId !== journal.attempt.id
    || journal.acknowledgedAt || journal.attempt.effects.drain || journal.admission.bootstrapIssuedAt) throw new Error('Missing active ownership is not an unfinished initial publication.');
  atomic(runtimeHandoffLockFile(journal.binding.home), { journal: journalFile(journal.binding), bindingDigest: journal.bindingDigest });
}
async function bootstrapHandoffHelper(journal) {
  assertObservationLease(journal);
  exactActiveOwner(journal);
  if (!pendingAdmission(journal)) throw new Error('Terminal admission cannot launch a helper.');
  const bytes = plist(journal, helperPath(journal));
  if (fs.readFileSync(journal.helperPlist, 'utf8') !== bytes) throw new Error('Helper registration changed during admission.');
  const target = journal.binding.domain + '/' + journal.helperLabel;
  const loaded = spawnSync('/bin/launchctl', ['print', target], { encoding: 'utf8', timeout: 2500 });
  if (loaded.error) throw loaded.error;
  if (loaded.status === 0) {
    const job = parseLoadedService(loaded.stdout);
    if (JSON.stringify(job.argv) !== JSON.stringify([journal.binding.runtime.path, helperPath(journal), 'worker', journalFile(journal.binding)])) throw new Error('The loaded helper has different arguments.');
    if (!job.pid) { assertObservationLease(journal); launchctl(['kickstart', target]); }
  } else {
    if (!/Could not find service|service not found/i.test(loaded.stderr)) throw new Error('Cannot establish helper registration.');
    assertObservationLease(journal);
    launchctl(['bootstrap', journal.binding.domain, journal.helperPlist]);
  }
}
async function prepareHandoffAdmission(journal, { verifyPublication = publication,
  bootstrap = bootstrapHandoffHelper, now = Date.now } = {}) {
  assertObservationLease(journal);
  assertNativePredecessor(journal.binding);
  if (!pendingAdmission(journal)) {
    const owner = readRuntimeHandoffLock(journal.binding.home);
    if (journal.phase === 'armed' && owner?.bindingDigest === journal.bindingDigest && owner.journalPath === journalFile(journal.binding)) {
      save(journal, { phase: journal.attempt?.state === 'complete' ? 'complete' : 'failed', acknowledgedAt: null, drainReady: null });
    }
    return journal;
  }
  const active = readRuntimeHandoffLock(journal.binding.home);
  if (active && (active.bindingDigest !== journal.bindingDigest || active.journalPath !== journalFile(journal.binding))) throw new Error('Another handoff owns this installation.');
  try {
    if (journal.acknowledgedAt || journal.drainReady) save(journal, { phase: 'preparing', acknowledgedAt: null, drainReady: null });
    await verifyPublication(journal);
    if (!journal.admission) {
      save(journal, { phase: 'preparing', acknowledgedAt: null, drainReady: null,
        attempt: journal.attempt ?? { id: randomBytes(12).toString('hex'), actor: { requestId: journal.binding.requestId, executionId: journal.binding.executionId },
          enteredAt: now(), deadline: journal.deadline, state: 'running', effects: { prepare: { issuedAt: now() } } }, cleanup: { state: 'pending' } });
      fs.mkdirSync(path.dirname(journal.helperPlist), { recursive: true, mode: 0o700 });
      const bytes = plist(journal, helperPath(journal));
      if (fs.existsSync(journal.helperPlist) && fs.readFileSync(journal.helperPlist, 'utf8') !== bytes) throw new Error('Helper registration changed during preparation.');
      fs.writeFileSync(journal.helperPlist, bytes, { mode: 0o600 });
      save(journal, { phase: 'armed', bridgeInstalled: true, admission: { attemptId: journal.attempt.id, publication: 'publishing', publishedAt: now() },
        attempt: { ...journal.attempt, deadline: Math.min(journal.deadline, now() + 60_000),
          effects: journal.attempt.effects } });
    }
    publishActiveOwner(journal);
    if (journal.admission.publication === 'publishing') save(journal, { admission: { ...journal.admission, publication: 'published' } });
    if (!journal.admission.bootstrapIssuedAt) save(journal, { admission: { ...journal.admission, bootstrapIssuedAt: now() } });
    await bootstrap(journal);
    return journal;
  } catch (error) {
    assertObservationLease(journal);
    save(journal, { phase: 'failed', acknowledgedAt: null, drainReady: null,
      attempt: journal.attempt && { ...journal.attempt, state: 'failed', failedAt: now(), lastObservation: pendingMetadata(error) } });
    throw error;
  }
}
/** Resume the initial producer under the same exact ownership as the consumer. */
export async function admitRuntimeHandoff(journal, options = {}) {
  const admitted = await withRuntimeObservation(journal, async () => {
    const current = readRuntimeHandoff(journal.binding.home, journal.binding.requestId, journal.binding.executionId);
    if (current && current.bindingDigest !== journal.bindingDigest) throw new Error('Admission binding changed.');
    return prepareHandoffAdmission(current ?? validateJournal(journal), options);
  });
  return waitForAdmission(admitted, options);
}
async function waitForAdmission(journal, { now = Date.now, wait = sleep } = {}) {
  const b = journal.binding;
  for (;;) {
    const current = readRuntimeHandoff(b.home, b.requestId, b.executionId);
    if (!current || current.bindingDigest !== journal.bindingDigest) throw new Error('Admission changed while waiting.');
    if (current.attempt?.state === 'complete') return current;
    if (!pendingAdmission(current)) throw new RuntimeObservationError('admission_failed', 'The update admission is terminal or fenced.', current.attempt?.lastObservation);
    if (liveDrainOwner(current)) return current;
    if (now() >= current.attempt.deadline) throw new RuntimeObservationError('admission_pending', 'The prepared helper has not acquired update ownership.', null, 'pending');
    await wait(Math.min(25, current.attempt.deadline - now()));
  }
}

export function runtimeHandoffDrainIdentity(journal) {
  validateJournal(journal);
  const active = runtimeHandoffLockFile(journal.binding.home);
  if (!liveDrainOwner(journal) || !fs.existsSync(active)) return null;
  const owner = JSON.parse(fs.readFileSync(active, 'utf8'));
  const old = journal.binding.oldProcess;
  if (owner.journal !== journalFile(journal.binding) || owner.bindingDigest !== journal.bindingDigest
      || old.pid !== process.pid || old.startedAt !== startedAt(process.pid)) return null;
  return `${journal.binding.executionId}:${journal.attempt.id}:${journal.drainReady.owner.token}:${old.pid}:${old.startedAt}`;
}

function leaseRecord(journal, kind) {
  const root = kind === 'gateway' ? path.join(homeDirectory(journal.binding.home), 'gateway') : observationLockRoot(journal);
  return JSON.parse(fs.readFileSync(path.join(path.dirname(root), `.${path.basename(root)}.lock/owner.json`), 'utf8'));
}
function liveDrainOwner(journal) {
  const a = journal.attempt, ready = journal.drainReady;
  if (journal.phase !== 'armed' || !journal.bridgeInstalled || !journal.acknowledgedAt || !a || a.state !== 'running'
    || a.fence || journal.mutationFence || !a.effects.prepare?.completedAt || !a.effects.drain?.issuedAt
    || ready?.attemptId !== a.id || journal.admission?.attemptId !== a.id || journal.admission.publication !== 'published') return false;
  try {
    const active = readRuntimeHandoffLock(journal.binding.home);
    if (active?.bindingDigest !== journal.bindingDigest || active.journalPath !== journalFile(journal.binding)) return false;
    for (const kind of ['gateway', 'owner']) {
      const expected = ready[kind], current = leaseRecord(journal,
        kind === 'gateway' || journal.binding.predecessorHandoffProtocol === 2 ? 'gateway' : 'observation');
      if (!expected || ['pid', 'identity', 'guardPid', 'guardIdentity', ...(kind === 'owner' ? ['token'] : [])].some(key => current[key] !== expected[key])
        || lockProcessIdentity(current.pid) !== current.identity || lockProcessIdentity(current.guardPid) !== current.guardIdentity) return false;
    }
    return true;
  } catch { return false; }
}
function drainOwnership(journal) {
  assertObservationLease(journal);
  const { pid, identity, guardPid, guardIdentity } = leaseRecord(journal, 'gateway');
  return { attemptId: journal.attempt.id,
    owner: leaseRecord(journal, journal.binding.predecessorHandoffProtocol === 2 ? 'gateway' : 'observation'),
    gateway: { pid, identity, guardPid, guardIdentity } };
}

function exactActiveOwner(journal) {
  assertObservationLease(journal);
  const active = JSON.parse(fs.readFileSync(runtimeHandoffLockFile(journal.binding.home), 'utf8'));
  if (active.journal !== journalFile(journal.binding) || active.bindingDigest !== journal.bindingDigest) throw new Error('Active runtime handoff owner changed.');
}

export function assertRuntimeHandoffOwner(journal) {
  assertObservationLease(journal);
  if (journal.attempt?.fence) {
    const active = readRuntimeHandoffLock(journal.binding.home);
    if (!active) return;
    if (active.bindingDigest !== journal.bindingDigest) throw new Error('Another active handoff owns this installation.');
  }
  if (journal.phase === 'acknowledged') return;
  if (journal.phase === 'complete' && journal.cleanupStartedAt && !fs.existsSync(runtimeHandoffLockFile(journal.binding.home))) return;
  exactActiveOwner(journal);
}

function observationLockRoot(journal) { return path.join(path.dirname(journalFile(journal.binding)), 'verification'); }
function assertObservationLease(journal) {
  const gateway = installationOperations.getStore();
  const observer = observationOperations.getStore();
  if (!gateway || !observer || gateway.home !== observer.home || journal && journalFile(journal.binding) !== observer.file) {
    throw new RuntimeObservationError('observer_lost', 'Exact installation and journal observation ownership is required.', null, 'pending');
  }
  try { gateway.assertHeld(); observer.assertHeld(); observer.legacy?.assertHeld(); assertLifecycleLockHeld(); }
  catch (error) {
    if (error.code === 'PROCESS_LOCK_LOST') throw new RuntimeObservationError('observer_lost', 'Runtime verification ownership was lost; observation remains unconfirmed.', null, 'pending');
    throw error;
  }
}
async function observationLockHeld(journal) {
  return ['held', 'uncertain'].includes((await inspectLifecycleLock(observationLockRoot(journal))).state);
}
export async function withRuntimeObservation(journal, operation, token) {
  const current = observationOperations.getStore();
  if (current && current.file !== journalFile(journal.binding)) throw new RuntimeObservationError('observer_lost', 'Another journal owns this observation scope.', null, 'pending');
  if (current && !token) throw new RuntimeObservationError('observer_busy', 'Nested observation requires its current ownership token.', null, 'pending');
  if (installationOperations.getStore()?.home !== journal.binding.home) {
    try { return await withInstallationGatewayLock(journal.binding.home, (gatewayToken, assertHeld) =>
      installationOperations.run({ home: journal.binding.home, token: gatewayToken, assertHeld }, () => withRuntimeObservation(journal, operation, token))); }
    catch (error) {
      if (error.code === 'PROCESS_LOCK_BUSY') throw new RuntimeObservationError('observer_busy', 'Runtime mutation ownership is busy.', null, 'pending');
      if (error.code === 'PROCESS_LOCK_LOST') throw new RuntimeObservationError('observer_lost', 'Installation ownership was lost.', null, 'pending');
      throw error;
    }
  }
  if (token) {
    assertObservationLease(journal);
    if (current?.token !== token) throw new Error('Runtime observation lease changed.');
    return withAcceptedClosure(journal, () => operation(token));
  }
  const installation = installationOperations.getStore();
  installation.assertHeld();
  fs.mkdirSync(path.dirname(observationLockRoot(journal)), { recursive: true, mode: 0o700 });
  return observationOperations.run({ home: journal.binding.home, file: journalFile(journal.binding), token: installation.token, assertHeld: installation.assertHeld,
      baseline: fs.existsSync(journalFile(journal.binding)) ? journalState(JSON.parse(fs.readFileSync(journalFile(journal.binding), 'utf8'))) : null },
      () => withAcceptedClosure(journal, () => operation(installation.token)));
}

async function withPredecessorAdmission(journal, operation) {
  if (journal.binding.predecessorHandoffProtocol === 2
      || startedAt(journal.binding.oldProcess.pid) !== journal.binding.oldProcess.startedAt) return operation();
  if (journal.binding.predecessorHandoffProtocol !== undefined && journal.binding.predecessorHandoffProtocol !== 1) throw new Error('Unsupported predecessor handoff protocol.');
  const scope = observationOperations.getStore();
  return withLifecycleLock(observationLockRoot(journal), async (token, assertHeld) => {
    scope.legacy = { token, assertHeld };
    try { return await operation(); } finally { delete scope.legacy; }
  }, { recoverStale: true });
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
function bindLaunchedProcesses(journal, evidence) {
  if (journal.attempt) {
    if (!evidence.processes) return;
    const fixed = journal.attempt.effects.services?.processes;
    for (const [name, identity] of Object.entries(evidence.processes)) {
      if (fixed?.[name] && JSON.stringify(fixed[name]) !== JSON.stringify(identity)) throw observationFailure('process_changed', 'Attempt service process identity changed.', { expected: fixed, current: evidence.processes });
    }
    if (JSON.stringify(fixed) !== JSON.stringify(evidence.processes)) saveEffect(journal, 'services', { processes: { ...fixed, ...evidence.processes } });
    return;
  }
  if (!journal.launch || journal.phase === 'failed' && !(journal.recoveryStart?.qualifiedAt && journal.recoveryStart.id === journal.launch.id)) return;
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

async function consumeRuntimeEvidence(journal, read) {
  try {
    const evidence = await read();
    bindLaunchedProcesses(journal, evidence);
    return evidence;
  } catch (error) {
    if (observationPending(error) && error.evidence) bindLaunchedProcesses(journal, error.evidence);
    throw error;
  }
}

const readControllerEvidence = (journal, command, currentVerifier = false, options = {}, control = controller) =>
  consumeRuntimeEvidence(journal, async () => {
    try { return JSON.parse(await control(journal, command, currentVerifier, options)); }
    catch (error) {
      // A killed startup may have qualified identities that never reached us.
      // Verification cannot safely adopt a later process as the first identity.
      if (command === 'handoff-start' && error.code === 'observation_deadline') {
        throw new RuntimeObservationError('startup_evidence_lost',
          'Startup response was lost; preserve the failed journal for explicit recovery.', error.evidence);
      }
      throw error;
    }
  });

export async function startFailedRuntimeHandoff(file, { bindingDigest: expected, actor }, options = {}) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (raw.bindingDigest !== expected || !actor || typeof actor !== 'object' || !Object.keys(actor).length) throw new Error('Recovery requires the exact binding and attributed intent.');
  return runRuntimeHandoffWorker(file, { ...options, actor });
}

export const restoreFailedRuntimeHandoffDesktop = startFailedRuntimeHandoff;

function retainedFailure(journal) {
  return journal?.recovery?.failure ?? journal?.failure ?? { phase: journal?.phase, error: journal?.error, attempts: journal?.attempts, updatedAt: journal?.updatedAt };
}

export function readRuntimeRecoveryAttempts(home, requestId, executionId) {
  const directory = path.join(handoffDirectory(home, requestId, executionId), 'recovery-attempts');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort().map(name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')));
}

async function readRuntimeObservationAcceptance(journal) {
  const db = new SqliteDatabase(journal.database, { readonly: true, fileMustExist: true });
  try {
    const run = db.prepare('SELECT id, auth_request_id, hook_id, state, output, command_digest FROM auth_hook_executions WHERE id = ? AND auth_request_id = ?').get(journal.binding.executionId, journal.binding.requestId);
    const state = runtimeObservationAcceptance(run, journal);
    if (state === 'inconsistent') throw new Error('Runtime observation acceptance is unresolved or inconsistent; preserving its evidence and owner.');
    return state;
  } finally { db.close(); }
}

const verifiedReceipts = new WeakMap();
function observationOwnership(journal) {
  assertObservationLease(journal);
  return observationOperations.getStore().token;
}
export function readRuntimeHandoffReceipt(journal) {
  const receipt = journal.attempt?.receipt ?? journal.receipt;
  if (!receipt || receipt.bindingDigest !== journal.bindingDigest) throw new Error('Runtime handoff has no exact successful receipt.');
  if (journal.attempt && (journal.attempt.state !== 'complete' || !['mandible-runtime-receipt@1', 'mandible-runtime-receipt@2'].includes(receipt.schema)
    || receipt.attemptId !== journal.attempt.id || hash(JSON.stringify(receipt)) !== journal.attempt.receiptDigest)) throw new Error('Runtime completion receipt differs from its attempt.');
  return receipt;
}
const currentReceipt = readRuntimeHandoffReceipt;
export async function verifyRuntimeHandoffReceipt(journal, { probe = true } = {}) {
  validateJournal(journal);
  const receipt = currentReceipt(journal);
  await publication(journal);
  if (receipt.schema === 'mandible-runtime-receipt@2') {
    const assertCurrent = () => {
      const current = readRuntimeHandoff(journal.binding.home, journal.binding.requestId, journal.binding.executionId);
      if (!current || current.bindingDigest !== journal.bindingDigest || !current.attempt?.fence
          || current.attempt.receiptDigest !== journal.attempt.receiptDigest) throw new Error('Terminal receipt changed during adoption.');
      currentReceipt(current);
    };
    assertCurrent();
    if (!journal.attempt.fence || receipt.approved.reference !== journal.binding.acceptedRelease.reference
        || JSON.stringify(receipt.approved.publicationEvidence) !== JSON.stringify(journal.binding.publicationEvidence)
        || receipt.installed.root !== journal.binding.nativeApp || receipt.startup.database !== path.resolve(journal.database)) throw new Error('Terminal runtime receipt binding changed.');
    const approved = readAcceptedReleaseReceipt(receipt.approved.reference);
    if (approved.package.sha256 !== receipt.approved.packageSha256 || approved.shipped.provenance.commit !== receipt.startup.generation) throw new Error('Terminal package identity differs from approval.');
    const identity = applicationRootIdentity(receipt.installed.root);
    if (identity.dev !== receipt.installed.identity.dev || identity.ino !== receipt.installed.identity.ino) throw new Error('Terminal installed root changed.');
    if (probe) {
      const api = await import('./local-runtime.mjs');
      const context = api.createHandoffContext({ home: journal.binding.home, root: journal.binding.root,
        accountHome: journal.binding.accountHome, domain: journal.binding.domain, bundleRoot: journal.binding.nativeApp });
      const options = { context, assertHeld: assertCurrent, until: Date.now() + 5000, processes: receipt.services };
      await api.inspectHandoffProcesses(journal.binding, options);
      await api.probeHandoffRuntime(journal.binding, { ...options, generation: receipt.startup.generation, startupEpoch: receipt.startup.epoch });
    }
    assertCurrent();
    const verified = Object.freeze({ bindingDigest: journal.bindingDigest, attemptId: journal.attempt.id, receiptDigest: journal.attempt.receiptDigest, receipt });
    verifiedReceipts.set(verified, verified);
    return verified;
  }
  assertRuntimeHandoffOwner(journal);
  if (journal.binding.acceptedRelease) installedApplication(journal);
  for (const [file, expected] of Object.entries(receipt.files)) if (fileHash(file) !== expected) throw new Error('Converged installation file changed: ' + file);
  const evidence = probe ? await readControllerEvidence(journal, 'handoff-verify') : receipt.evidence;
  if (receipt.evidence?.process && JSON.stringify(evidence.process) !== JSON.stringify(receipt.evidence.process)) throw new Error('Converged daemon process changed after observation.');
  requireDesktopForObservation(journal);
  const verified = Object.freeze({ bindingDigest: journal.bindingDigest, attemptId: journal.attempt?.id, receiptDigest: hash(JSON.stringify(receipt)) });
  verifiedReceipts.set(verified, { ...verified, token: observationOwnership(journal) });
  return verified;
}
function helperPath(journal) {
  return journal.binding.updater?.helper ?? path.join(path.dirname(journalFile(journal.binding)), 'helper.mjs');
}
async function fenceHelper(journal) {
  assertObservationLease(journal);
  if (!/^gui\/\d+$/.test(journal.binding.domain ?? '') || !/^[a-zA-Z0-9.-]+$/.test(journal.helperLabel ?? '')
    || !path.isAbsolute(journal.binding.runtime?.path ?? '')) throw new Error('Helper ownership identity is incomplete.');
  if (journal.helperPlist && journal.helperPlist !== path.join(homeDirectory(journal.binding.home), 'launch-agents', `${journal.helperLabel}.plist`)) throw new Error('Helper registration path is outside its owner.');
  const target = journal.binding.domain + '/' + journal.helperLabel;
  const loaded = spawnSync('/bin/launchctl', ['print', target], { encoding: 'utf8', timeout: 2500 });
  if (loaded.error) throw loaded.error;
  if (loaded.status === 0) {
    const job = parseLoadedService(loaded.stdout);
    const expected = [journal.binding.runtime.path, helperPath(journal), 'worker', journalFile(journal.binding)];
    if (JSON.stringify(job.argv) !== JSON.stringify(expected)) throw new Error('Helper service definition changed; preserving it.');
    const process = job.pid ? { pid: job.pid, startedAt: startedAt(job.pid) } : null;
    if (process && !process.startedAt) throw new Error('Cannot qualify helper process birth.');
    save(journal, { fencing: { issuedAt: Date.now(), process } });
    launchctl(['bootout', target]);
    const after = spawnSync('/bin/launchctl', ['print', target], { encoding: 'utf8', timeout: 2500 });
    if (after.error || after.status === 0 || !/Could not find service|service not found/i.test(after.stderr)) throw new Error('Helper unregister is not confirmed.');
  } else if (!/Could not find service|service not found/i.test(loaded.stderr)) throw new Error('Cannot establish helper ownership.');
  const process = journal.fencing?.process;
  const until = Date.now() + 5000;
  while (process && startedAt(process.pid) === process.startedAt) {
    assertObservationLease(journal);
    if (Date.now() >= until) throw new Error('Exact helper process has not drained.');
    await sleep(25);
  }
  if (journal.helperPlist && fs.existsSync(journal.helperPlist)) {
    const bytes = fs.readFileSync(journal.helperPlist, 'utf8');
    if (!bytes.includes(helperPath(journal))) throw new Error('Helper registration file changed.');
    assertObservationLease(journal);
    fs.unlinkSync(journal.helperPlist);
  }
}
function releaseExactOwner(journal) {
  assertObservationLease(journal);
  const active = runtimeHandoffLockFile(journal.binding.home);
  if (!fs.existsSync(active)) return;
  const owner = JSON.parse(fs.readFileSync(active, 'utf8'));
  if (owner.journal !== journalFile(journal.binding) || owner.bindingDigest !== journal.bindingDigest) throw new Error('Active handoff owner changed.');
  assertObservationLease(journal);
  fs.unlinkSync(active);
}
async function cleanupHandoff(journal) {
  assertObservationLease(journal);
  try {
    await verifyAcceptedBytes(journal, true);
    if (journal.binding.legacyBridgeSha256) {
      const runner = journal.binding.priorBackend.argv[1];
      if (fs.existsSync(runner)) {
        const stat = fs.lstatSync(runner);
        if (!stat.isFile() || stat.isSymbolicLink() || fileHash(runner) !== journal.binding.legacyBridgeSha256) throw new Error('Legacy bridge custody changed.');
        assertObservationLease(journal);
        fs.unlinkSync(runner);
      }
    }
    save(journal, { cleanup: { state: 'complete', completedAt: Date.now() } });
    return { cleanup: 'complete' };
  } catch (error) {
    save(journal, { cleanup: { state: 'pending', attemptedAt: Date.now(), reason: error.message } });
    return { cleanup: 'pending' };
  }
}
export async function cleanupRuntimeHandoff(file) {
  const raw = validateJournal(JSON.parse(fs.readFileSync(file, 'utf8')));
  const until = Date.now() + 10_000;
  for (;;) {
    try { return await withRuntimeObservation(raw, async () => {
    const journal = readRuntimeHandoff(raw.binding.home, raw.binding.requestId, raw.binding.executionId);
    const receipt = currentReceipt(journal);
    if (receipt.schema !== 'mandible-runtime-receipt@2' || !journal.attempt.fence
        || await readRuntimeObservationAcceptance(journal) !== 'accepted') throw new Error('Cleanup requires an accepted terminal delivery.');
    if (journal.cleanup?.state === 'complete') return { cleanup: 'complete' };
    const active = readRuntimeHandoffLock(journal.binding.home);
    if (active?.bindingDigest === journal.bindingDigest && active.journalPath === file) releaseExactOwner(journal);
    try { await fenceHelper(journal); }
    catch (error) {
      save(journal, { cleanup: { state: 'pending', attemptedAt: Date.now(), reason: error.message } });
      return { cleanup: 'pending' };
    }
    return cleanupHandoff(journal);
    }); } catch (error) {
      if (error.code !== 'observer_busy' || Date.now() >= until) throw error;
      await sleep(Math.min(25, until - Date.now()));
    }
  }
}
export async function scheduleRuntimeHandoffCleanup(journal) {
  if (currentReceipt(journal).schema !== 'mandible-runtime-receipt@2' || !journal.attempt.fence) throw new Error('Only terminal delivery cleanup can be scheduled.');
  const resources = installedResourceRoot();
  if (!resources) throw new Error('Cleanup requires the current trusted installed runtime.');
  const release = readInstalledRelease(resources);
  const runtime = releaseFile(resources, release.native.bun, release.layout);
  const helper = releaseFile(resources, 'handoff/helper.mjs', release.layout);
  const log = fs.openSync(path.join(path.dirname(journalFile(journal.binding)), 'cleanup.log'), 'a', 0o600);
  try {
    await runSupervisedCommand(runtime, [helper, 'cleanup', journalFile(journal.binding)], {
      cwd: path.dirname(journalFile(journal.binding)),
      env: installedRuntimeEnvironment(resources, { ...process.env, MANDIBLE_HOME: journal.binding.home }),
      stdio: ['ignore', log, log], timeout: 30_000, graceMs: 250,
    });
    const current = readRuntimeHandoff(journal.binding.home, journal.binding.requestId, journal.binding.executionId);
    if (!current || current.bindingDigest !== journal.bindingDigest || current.attempt?.receiptDigest !== journal.attempt.receiptDigest) throw new Error('Cleanup result no longer belongs to its terminal receipt.');
    currentReceipt(current);
    return { cleanup: current.cleanup?.state === 'complete' ? 'complete' : 'pending' };
  } finally { fs.closeSync(log); }
}
export function runtimeHandoffNeedsAcknowledgment(journal) {
  const active = readRuntimeHandoffLock(journal.binding.home);
  if (!active) return false;
  if (!active.bindingDigest || !active.journalPath) throw new Error('Active delivery ownership is unresolved.');
  if ((active.bindingDigest === journal.bindingDigest) !== (active.journalPath === journalFile(journal.binding))) throw new Error('Active delivery locator changed.');
  return active.bindingDigest === journal.bindingDigest && active.journalPath === journalFile(journal.binding);
}
export async function acknowledgeRuntimeHandoff(binding, options = {}) {
  const journal = readRuntimeHandoff(binding.home, binding.requestId, binding.executionId);
  if (journal?.attempt?.receipt?.schema === 'mandible-runtime-receipt@2' && installationOperations.getStore()?.home !== binding.home) {
    try { return await withRuntimeObservation(journal, () => acknowledgeReceipt(binding, options)); }
    catch (error) {
      if (error.code === 'observer_busy') return { cleanup: 'pending', release: 'pending' };
      throw error;
    }
  }
  if (installationOperations.getStore()?.home !== binding.home) throw new Error('Acknowledgment requires its ordered installation and observation ownership.');
  return acknowledgeReceipt(binding, options);
}
async function acknowledgeReceipt(binding, { verifiedReceipt, acceptedReceiptDigest } = {}) {
  const journal = readRuntimeHandoff(binding.home, binding.requestId, binding.executionId);
  assertObservationLease(journal);
  if (!journal || journal.bindingDigest !== bindingDigest(binding)) throw new Error('Acknowledgment binding differs.');
  const receipt = currentReceipt(journal);
  if (receipt.schema !== 'mandible-runtime-receipt@2') assertRuntimeHandoffOwner(journal);
  const digest = hash(JSON.stringify(receipt));
  const verified = verifiedReceipt && verifiedReceipts.get(verifiedReceipt);
  if (await readRuntimeObservationAcceptance(journal) !== 'accepted') throw new Error('Receipt acceptance has not committed.');
  if (verified) {
    if (receipt.schema !== 'mandible-runtime-receipt@2' && verified.token !== observationOwnership(journal) || verified.bindingDigest !== journal.bindingDigest
      || verified.attemptId !== journal.attempt?.id || verified.receiptDigest !== digest) throw new Error('Receipt verification belongs to a different observation.');
    verifiedReceipts.delete(verifiedReceipt);
  } else {
    if (acceptedReceiptDigest !== digest) throw new Error('Receipt acceptance has not committed.');
  }
  if (receipt.schema === 'mandible-runtime-receipt@2') {
    if (!journal.attempt.fence) throw new Error('Completed delivery has no terminal mutation fence.');
    if (runtimeHandoffNeedsAcknowledgment(journal)) releaseExactOwner(journal);
    return { cleanup: journal.cleanup?.state === 'complete' ? 'complete' : 'pending' };
  }
  if (!journal.attempt?.fence) {
    save(journal, { phase: 'complete', acknowledgedAt: null, drainReady: null });
    await fenceHelper(journal);
    if (journal.attempt) save(journal, { attempt: { ...journal.attempt, fence: { fencedAt: Date.now(), reason: 'receipt-accepted' } } });
    else save(journal, { phase: 'acknowledged', acceptedAt: Date.now() });
    releaseExactOwner(journal);
  }
  if (journal.cleanup?.state === 'complete') return { cleanup: 'complete' };
  return cleanupHandoff(journal);
}

/** Close mutation authority while retaining the attempt’s historical outcome. */
export async function closeQuiescentRuntimeHandoff(home, { actor } = {}, { fence: fenceMutator = fenceHelper } = {}) {
  const owner = readRuntimeHandoffLock(home);
  if (!owner) return { outcome: 'none' };
  try {
    {
      const current = readRuntimeHandoffLock(home);
      if (!current) return { outcome: 'none' };
      if (current.bindingDigest !== owner.bindingDigest || current.journalPath !== owner.journalPath) throw new Error('Active owner changed.');
      if (path.dirname(path.dirname(current.journalPath)) !== path.join(homeDirectory(home), 'handoff')) throw new Error('Owner journal is outside this installation.');
      const raw = JSON.parse(fs.readFileSync(current.journalPath, 'utf8'));
      if (raw.bindingDigest !== bindingDigest(raw.binding) || raw.bindingDigest !== current.bindingDigest) throw new Error('Owner binding differs.');
      return await withRuntimeObservation(raw, async () => {
        const journal = readRuntimeHandoff(raw.binding.home, raw.binding.requestId, raw.binding.executionId);
        if (!journal || journal.bindingDigest !== raw.bindingDigest) throw new Error('Owner changed before closure.');
        exactActiveOwner(journal);
        if (journal.attempt?.state === 'complete' && journal.attempt.fence) {
          releaseExactOwner(journal);
          return { outcome: 'released', requestId: journal.binding.requestId, executionId: journal.binding.executionId };
        }
        save(journal, { phase: journal.attempt?.state === 'complete' ? 'complete' : 'failed', acknowledgedAt: null, drainReady: null });
        await fenceMutator(journal);
        const fence = { fencedAt: Date.now(), actor, reason: 'successor-publication' };
        save(journal, { phase: journal.attempt?.state === 'complete' ? 'complete' : 'failed', acknowledgedAt: null, drainReady: null,
          ...(journal.attempt ? { attempt: { ...journal.attempt, fence } } : { mutationFence: fence }) });
        releaseExactOwner(journal);
        return { outcome: 'released', requestId: journal.binding.requestId, executionId: journal.binding.executionId };
      });
    }
  } catch (error) { return { outcome: 'blocked', reason: `${runtimeHandoffLockRefusal(owner)} ${error.message}` }; }
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
      assertObservationLease(journal);
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
      if (JSON.stringify(parseLoadedService(loaded.stdout).argv) !== JSON.stringify([journal.binding.runtime.path, helperPath(journal), 'worker', journalPath])) throw new Error('Helper service definition changed; preserving it.');
      if (/\bpid = \d+/.test(loaded.stdout)) throw new Error('The handoff helper is still running; preserving the lock.');
    }
    await fenceHelper(journal);
    const retirement = { schema: 'mandible-runtime-handoff-retirement@1', bindingDigest: expected,
      requestId: journal.binding.requestId, executionId: journal.binding.executionId,
      failure: journal.failure ?? { phase: journal.phase, error: journal.error ?? null, attempts: journal.attempts, updatedAt: journal.updatedAt },
      journalSha256: fileHash(journalPath), helperBootedOut: loaded.status === 0, actor, reason: reason.trim(), retiredAt: Date.now() };
    assertObservationLease(journal);
    atomic(retirementFile, retirement);
    return finishRetirement(retirement);
  });
}

function saveEffect(journal, name, changes) {
  unchangedJournal(journal);
  const attempt = journal.attempt;
  save(journal, { attempt: { ...attempt, effects: { ...attempt.effects, [name]: { ...attempt.effects[name], ...changes } } } });
}
function archiveAttempt(journal) {
  assertObservationLease(journal);
  const attempt = journal.attempt;
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(attempt.id)) throw new Error('Invalid attempt history identity.');
  const directory = path.join(path.dirname(journalFile(journal.binding)), 'attempts');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${attempt.id}.json`);
  const record = { schema: 'mandible-runtime-attempt-history@1', bindingDigest: journal.bindingDigest, attempt };
  if (fs.existsSync(file)) {
    if (JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8'))) !== JSON.stringify(record)) throw new Error('Attempt history changed.');
  } else atomic(file, record);
}

/** Initial delivery and interrupted delivery reconcile the same observed effects. */
export async function runRuntimeHandoffWorker(file, {
  now = Date.now, wait = sleep, control = controller, verifyPublication = publication,
  prepare = prepareAcceptedApplication, install = installAcceptedApplication,
  observe = confirmPreparedRuntime, desktop = restoreDesktop,
  waitMs = 60_000, actor, context,
} = {}) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  let journal = readJournalFile(raw.binding.home, raw.binding.requestId, raw.binding.executionId);
  if (journal?.attempt?.fence || journal?.mutationFence || journal?.phase === 'retired') return journal;
  journal = validateJournal(journal);
  const execute = () => withRuntimeObservation(journal, async token => {
    const fresh = readRuntimeHandoff(raw.binding.home, raw.binding.requestId, raw.binding.executionId);
    if (!fresh || fresh.bindingDigest !== raw.bindingDigest) throw new Error('Worker binding changed before acquisition.');
    journal = fresh;
    if (journal.attempt?.fence || journal.mutationFence || journal.phase === 'retired') return journal;
    exactActiveOwner(journal);
    if (journal.attempt?.state === 'complete') return journal;
    if (!journal.binding.acceptedRelease) throw new Error('Historical source-build handoffs are evidence only; delivery requires an accepted release.');
    if (!journal.attempt || journal.attempt.state === 'failed') {
      if (!actor) { if (journal.phase === 'armed') save(journal, { phase: 'failed', acknowledgedAt: null, drainReady: null }); return journal; }
      const priorStage = journal.attempt?.effects.prepare;
      const priorReplace = journal.attempt?.effects.replace;
      if (journal.attempt) archiveAttempt(journal);
      const attempt = { id: randomBytes(12).toString('hex'), actor, enteredAt: now(), deadline: now() + waitMs, state: 'running',
        effects: { ...(priorStage?.stageIdentity ? { prepare: { stageIdentity: priorStage.stageIdentity, stagePath: priorStage.stagePath } } : {}),
          ...(priorReplace?.issuedAt ? { replace: priorReplace } : {}) } };
      save(journal, { attempt, admission: { attemptId: attempt.id, publication: 'published', recoveryAt: now() }, cleanup: { state: 'pending' } });
    }
    if (journal.admission?.attemptId !== journal.attempt.id || journal.admission.publication !== 'published') {
      save(journal, { phase: 'failed', acknowledgedAt: null, drainReady: null, attempt: { ...journal.attempt, state: 'failed',
        lastObservation: { code: 'admission_missing', reason: 'This attempt has no completed native admission.' } } });
      return journal;
    }
    const b = journal.binding;
    const until = journal.attempt.deadline;
    acceptedOperations.getStore().context = context;
    const invokeControl = (journal, operation, currentVerifier, options) => control(journal, operation, currentVerifier, {
      ...options, prepared: acceptedOperations.getStore().prepared,
      assertHeld: preparedLease(journal), context: acceptedOperations.getStore().context,
    });
    save(journal, { phase: 'preparing', acknowledgedAt: null, drainReady: null,
      admission: { ...journal.admission, attemptId: journal.attempt.id, publication: 'published' } });
    try {
      await verifyPublication(journal);
      let prepared;
      let drained;
      await withPredecessorAdmission(journal, async () => {
      saveEffect(journal, 'prepare', { issuedAt: journal.attempt.effects.prepare?.issuedAt ?? now() });
      const paths = acceptedInstallPaths(b);
      const phase = journal.attempt.effects.replace?.completedAt || journal.attempt.effects.replace?.issuedAt
        && !fs.existsSync(paths.staging) && fs.existsSync(paths.previous) ? 'installed' : 'staged';
      prepared = await prepare(b, { until, attemptId: journal.attempt.id, assertHeld: preparedLease(journal), phase,
        stageIdentity: journal.attempt.effects.prepare?.stageIdentity,
        onStageCreated: stage => saveEffect(journal, 'prepare', { stageIdentity: stage.identity, stagePath: stage.path }) });
      acceptedOperations.getStore().prepared = prepared;
      saveEffect(journal, 'prepare', { completedAt: now(), packageSha256: prepared.packageSha256 });
      const priorDrain = journal.attempt.effects.drain;
      drained = priorDrain?.completedAt && priorDrain.processes
        && Object.values(priorDrain.processes).every(identity => !identity || startedAt(identity.pid) !== identity.startedAt);
      saveEffect(journal, 'drain', { issuedAt: journal.attempt.effects.drain?.issuedAt ?? now() });
      save(journal, { phase: 'armed', acknowledgedAt: now(),
        drainReady: startedAt(b.oldProcess.pid) === b.oldProcess.startedAt ? drainOwnership(journal) : null });
      if (!prepared.installed && !drained) {
        while (startedAt(b.oldProcess.pid) === b.oldProcess.startedAt) {
          assertObservationLease(journal);
          if (now() >= until) throw new RuntimeObservationError('drain_pending', 'Old daemon has not completed its bounded drain.', null, 'pending');
          await wait(Math.min(25, until - now()));
          unchangedJournal(journal);
        }
      }
      });
      if (!prepared.installed && !drained) {
        const stopped = JSON.parse(await invokeControl(journal, 'handoff-remove', false, { until }));
        saveEffect(journal, 'drain', { completedAt: now(), ...stopped });
      }
      saveEffect(journal, 'replace', { issuedAt: journal.attempt.effects.replace?.issuedAt ?? now() });
      const installContext = acceptedOperations.getStore().context ?? (install === installAcceptedApplication ? await ownedNativeContext(journal) : {});
      const replaced = await install(b, installContext, { until, prepared });
      saveEffect(journal, 'replace', { completedAt: now(), ...replaced });
      saveEffect(journal, 'services', { issuedAt: journal.attempt.effects.services?.issuedAt ?? now() });
      const started = await readControllerEvidence(journal, 'handoff-start', false, { until }, invokeControl);
      saveEffect(journal, 'services', { completedAt: now(), processes: started.processes });
      await readControllerEvidence(journal, 'handoff-verify', false, { until, awaitReady: true }, invokeControl);
      saveEffect(journal, 'services', { readyAt: journal.attempt.effects.services.readyAt ?? now() });
      await desktop(journal);
      const receipt = await observe(journal, { observerToken: token, until, control: invokeControl, prepared,
        context: acceptedOperations.getStore().context, assertHeld: preparedLease(journal) });
      if (receipt.schema !== 'mandible-runtime-receipt@2') throw new Error('Runtime completion requires its compact terminal receipt.');
      unchangedJournal(journal);
      const currentReceipt = { ...receipt, bindingDigest: journal.bindingDigest,
        attemptId: journal.attempt.id, desktop: journal.attempt.effects.desktop ?? { required: false }, completedAt: now() };
      save(journal, { phase: 'complete', drainReady: null, attempt: { ...journal.attempt, state: 'complete', completedAt: now(), receipt: currentReceipt,
        receiptDigest: hash(JSON.stringify(currentReceipt)), fence: { fencedAt: now(), reason: 'terminal-completion' } } });
    } catch (error) {
      assertObservationLease(journal);
      unchangedJournal(journal);
      const pending = observationPending(error) && now() < until;
      save(journal, { phase: pending ? 'verification-pending' : 'failed', acknowledgedAt: null, drainReady: null, attempt: { ...journal.attempt, state: pending ? 'running' : 'failed',
        lastObservation: pendingMetadata(error), ...(!pending ? { failedAt: now() } : {}) } });
    }
    return journal;
  });
  for (;;) {
    try { return await execute(); }
    catch (error) {
      if (error.code !== 'observer_busy' || now() >= (journal.attempt?.deadline ?? journal.deadline)) throw error;
      await wait(Math.min(25, (journal.attempt?.deadline ?? journal.deadline) - now()));
    }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, file, expected, actor] = process.argv.slice(2);
  (command === 'cleanup' ? cleanupRuntimeHandoff(file) : ['recovery-start', 'recovery-desktop'].includes(command) ? (command === 'recovery-start' ? startFailedRuntimeHandoff : restoreFailedRuntimeHandoffDesktop)(file, { bindingDigest: expected, actor: JSON.parse(actor) }).then(j => {
    process.stdout.write(`${JSON.stringify({ phase: j.phase, recoveryStart: j.recoveryStart })}\n`);
  }) : command === 'worker' ? runRuntimeHandoffWorker(file).then(j => { if (j.attempt?.state === 'running' && !j.attempt.fence) process.exitCode = 75; }) : command === 'arm' ? armRuntimeHandoff(path.resolve(file || process.cwd())).then(j => {
    if (j) { process.stderr.write(`MANDIBLE_RUNTIME_HANDOFF_PENDING:${j.bindingDigest}\n`); process.exitCode = 75; }
  }) : Promise.reject(new Error('Usage: runtime-handoff.mjs arm <root>|worker <journal>|recovery-start|recovery-desktop <journal> <binding-digest> <actor-json>'))).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
