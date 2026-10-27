#!/usr/bin/env bun
import fs from 'node:fs';
import os from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createOwnedRun, saveOwnedMetadata, withOwnedRunLock, finalizeOwnedRun, cleanupOwnedRun, processIdentity, processLifetimeMatches, processReleaseBlocked } from './owned-run.mjs';

import { nativeCandidate, verifyNativeBundle, buildNativePreview, nativeToolchain, verifyNativeSelection } from './native-build.mjs';

const script = fileURLToPath(import.meta.url);
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command}: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export { processIdentity } from './owned-run.mjs';

function ownedReceipt(file) {
  if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error('Native receipt must be a regular owned file');
  const receipt = read(file);
  const root = fs.realpathSync(path.dirname(file));
  const stat = fs.statSync(root);
  if (path.basename(file) !== 'metadata.json' || receipt.schema !== 'mandible-native-preview@1'
      || receipt.ownership.root !== root || receipt.ownership.rootIdentity.dev !== stat.dev
      || receipt.ownership.rootIdentity.ino !== stat.ino
      || !receipt.executable.startsWith(`${root}${path.sep}`)
      || receipt.profile !== path.join(root, 'profile')) throw new Error('Invalid native preview receipt ownership');
  return receipt;
}

function terminalNativeReceipt(file) {
  const root = path.dirname(path.resolve(file));
  const runId = path.basename(root).replace(/^native-/, '');
  const compact = path.join(path.dirname(root), '.receipts', `${runId}.json`);
  if (!fs.existsSync(compact)) throw new Error('Native receipt is missing; exact retained receipt required');
  const receipt = read(compact);
  if (receipt.runId !== runId || receipt.nativePreview?.receipt !== path.resolve(file)
    || receipt.cleanup !== 'completed' || fs.existsSync(root)) throw new Error('Native terminal receipt identity changed');
  return { ...receipt, receipt: compact };
}

async function nativeOperation(file, options, operation) {
  if (!fs.existsSync(file)) return terminalNativeReceipt(file);
  const initial = ownedReceipt(file);
  const execute = () => withOwnedRunLock(path.dirname(file), () => {
    const current = ownedReceipt(file);
    if (options.attemptId && current.attemptId !== options.attemptId) throw new Error('Native launch attempt changed; refusing stale lifecycle action');
    return operation(current);
  });
  if (options.parentLockHeld || !initial.parent) return execute();
  const { withPreviewRun } = await import('./preview-custody.mjs');
  return withPreviewRun(initial.parent, execute);
}

export async function stopNativePreview(file, options = {}) {
  return nativeOperation(file, options, async receipt => {
    const processes = [receipt.buildProcess && !receipt.buildProcess.finishedAt && {
      pid: receipt.buildProcess.pid, identity: receipt.buildProcess.identity, birth: receipt.buildProcess.birth, group: true },
      ...(receipt.buildProcess?.remaining ?? []),
      receipt.pid && { pid: receipt.pid, identity: receipt.processIdentity, executable: receipt.executable }].filter(Boolean);
    for (const child of processes) {
      const identity = processIdentity(child.pid);
      if (identity === null) continue;
      const matches = processLifetimeMatches(child, identity);
      if (receipt.status === 'stopped' && matches === false) continue;
      if (matches !== true || (child.executable && !identity.includes(child.executable))) {
        throw new Error('Native PID identity changed; refusing to signal a different process');
      }
      process.kill(child.group ? -child.pid : child.pid, child.group ? 'SIGKILL' : 'SIGTERM');
      await until(() => !processReleaseBlocked(child, true), 'Native preview did not stop');
    }
    receipt.status = 'stopped'; receipt.stoppedAt ??= new Date().toISOString();
    saveOwnedMetadata(file, receipt);
    return receipt;
  });
}

async function until(predicate, message, deadlineMs = 15_000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

export async function launchNativePreview({ branch, bundle, project, workUnit, agentSession, selected: supplied, newInstance = false }) {
  if (process.platform !== 'darwin' || Number(run('/usr/bin/sw_vers', ['-productVersion']).split('.')[0]) < 14) {
    throw new Error('Visible native preview requires macOS 14+ for a separate WebKit store');
  }
  if ((!branch && !supplied) || !project || !workUnit) throw new Error('launch requires a selected preview, --project and --work-unit');
  const selected = supplied ?? await (await import('./iab-preview.mjs')).healthyExistingPreview(branch);
  if (!selected || selected.legacyContractDrift?.length || selected.userPreferencesIsolationUpgrade || selected.logIsolationUpgrade) {
    throw new Error('Selected launcher preview is unavailable or requires explicit Coordinator recovery');
  }
  const previewRoot = fs.realpathSync(selected.previewRoot);
  const owner = selected.ownership;
  const stat = fs.statSync(previewRoot);
  if (owner?.state !== 'active' || owner.root !== previewRoot || owner.rootIdentity.dev !== stat.dev || owner.rootIdentity.ino !== stat.ino
      || owner.instanceId !== selected.health.instance.instance_id) throw new Error('Selected preview ownership does not match its healthy instance');
  const selectedUrl = new URL(selected.instanceEnv.MANDIBLE_PUBLIC_ORIGIN);
  const targetHealth = JSON.parse(run('/usr/bin/curl', ['--fail', '--silent', '--show-error', '--max-time', '5',
    '--noproxy', '*', '--ca-native', '--resolve', `${selectedUrl.hostname}:${selectedUrl.port}:127.0.0.1`,
    `${selectedUrl.origin}/api/health`], { env: { ...process.env, CURL_CA_BUNDLE: '', SSL_CERT_FILE: '', SSL_CERT_DIR: '' } }));
  if (!targetHealth.ready || !targetHealth.warm || !isDeepStrictEqual(targetHealth.instance, selected.health.instance)) {
    throw new Error('Preview HTTPS origin does not serve the selected healthy instance');
  }
  const candidate = nativeCandidate(selected.worktree);
  verifyNativeSelection(selected, candidate);
  const parent = { root: previewRoot, runId: owner.runId };
  const { withPreviewRun, acquirePreviewConsumer, reacquirePreviewConsumer, publishPreviewConsumer, nativePreviewBaseDir } = await import('./preview-custody.mjs');
  const existing = await withPreviewRun(parent, async metadata => {
    if (newInstance) return null;
    const consumers = metadata.ownership.consumers?.filter(entry => entry.state !== 'released') ?? [];
    if (!consumers.length) return null;
    const consumer = consumers[0];
    return withOwnedRunLock(consumer.root, () => {
      const current = ownedReceipt(consumer.metadataFile);
      if (['preparing', 'loading'].includes(current.status)) throw new Error('Native launch attempt is still in progress');
      if (current.ownership.state === 'terminal') throw new Error('Native cleanup is pending; complete it before setup');
      const live = current.pid ? processIdentity(current.pid) : null;
      const stoppedLifetimeGone = current.status === 'stopped' && live !== null && processLifetimeMatches(current, live) === false;
      if (live !== null && !stoppedLifetimeGone) {
        if (live !== current.processIdentity || current.status !== 'visible') throw new Error('Native attachment is busy or its process identity changed');
        if (current.build.commit !== candidate.commit || current.build.source_digest !== candidate.source_digest) {
          throw new Error('Stop the native attachment before rebuilding a changed candidate');
        }
        if (current.nativeBuild && !isDeepStrictEqual(current.nativeBuild.toolchain, nativeToolchain(selected.worktree))) {
          throw new Error('Stop the native attachment before rebuilding changed toolchain/configuration');
        }
        return { ...current, reused: true };
      }
      if (processReleaseBlocked(current.buildProcess, current.status === 'stopped' || Boolean(current.buildProcess?.finishedAt))
        || current.buildProcess?.remaining?.some(child => processReleaseBlocked(child, current.status === 'stopped'))) throw new Error('Native build is still running');
      current.status = 'stopped'; current.stoppedAt ??= new Date().toISOString();
      saveOwnedMetadata(consumer.metadataFile, current);
      return { resume: true, receipt: current, consumer };
    });
  });
  if (existing && !existing.resume) return existing;
  if (bundle) {
    bundle = fs.realpathSync(bundle);
    if (!bundle.endsWith('.app') || bundle.startsWith('/Applications/') || bundle.startsWith(path.join(os.homedir(), 'Applications') + path.sep)) {
      throw new Error('Supply the noninstalled Tauri build bundle');
    }
    verifyNativeBundle(bundle, candidate);
  }
  const base = nativePreviewBaseDir();
  fs.mkdirSync(base, { recursive: true });
  const resumed = existing?.resume === true;
  const attemptId = randomUUID();
  const runId = resumed ? existing.receipt.ownership.runId : randomUUID();
  const root = resumed ? existing.receipt.ownership.root : path.join(fs.realpathSync(base), `native-${runId}`);
  if (!resumed) fs.mkdirSync(root, { mode: 0o700 });
  const profile = path.join(root, 'profile'); if (!resumed) fs.mkdirSync(profile, { mode: 0o700 });
  const ownership = resumed ? existing.receipt.ownership : createOwnedRun({ root, runId, instanceId: owner.instanceId, project, workUnit,
    outputs: [{ path: 'profile', kind: 'interactive' }, { path: 'app', kind: 'generated' },
      { path: 'build', kind: 'generated' }, { path: 'build.log', kind: 'generated' }, { path: 'stdout.log', kind: 'generated' }, { path: 'stderr.log', kind: 'generated' }] });
  const receiptFile = path.join(root, 'metadata.json');
  const receipt = resumed ? existing.receipt : { schema: 'mandible-native-preview@1', attemptId, ownership, status: 'preparing',
    executable: path.join(root, 'app', `Mandible Preview ${ownership.runId.slice(0, 8)}.app`, 'Contents/MacOS', `mandible-native-preview-${ownership.runId.slice(0, 8)}`),
    build: candidate, sourceBundle: bundle ?? null, parent, manifest: path.join(previewRoot, 'metadata.json'), previewRunId: owner.runId,
    instanceId: owner.instanceId, origin: selected.instanceEnv.MANDIBLE_PUBLIC_ORIGIN, profile,
    windowLabel: 'main', windowTitle: `Mandible Preview ${ownership.runId.slice(0, 8)}`,
    stdout: path.join(root, 'stdout.log'), stderr: path.join(root, 'stderr.log'), receipt: receiptFile };
  if (!resumed) saveOwnedMetadata(receiptFile, receipt);
  let child;
  let reservation;
  try {
    reservation = await (resumed ? reacquirePreviewConsumer : acquirePreviewConsumer)(parent, { consumerId: ownership.runId, runId: ownership.runId, root,
      rootIdentity: ownership.rootIdentity, metadataFile: receiptFile, borrowedBackend: true, newInstance, attemptId,
      expectedPriorAttemptId: existing?.consumer?.attemptId,
      expectedGeneration: selected.instanceEnv.MANDIBLE_BACKEND_GENERATION, expectedSource: candidate,
      expectedPriorGeneration: existing?.consumer?.generation, expectedPriorSource: existing?.consumer?.source });
    await withOwnedRunLock(root, async () => {
      const latest = ownedReceipt(receiptFile);
      if (latest.attemptId !== attemptId || latest.ownership.runId !== receipt.ownership.runId || latest.ownership.state === 'terminal') throw new Error('Native ownership changed before build');
      receipt.ownership = latest.ownership;
      if (resumed) {
        receipt.attempts ??= [];
        receipt.attempts.push({ attemptId: receipt.attemptId, build: receipt.build, nativeBuild: receipt.nativeBuild, status: receipt.status, error: receipt.error, pid: receipt.pid });
        for (const key of ['pid', 'processIdentity', 'window', 'error', 'cleanupPending', 'stoppedAt']) delete receipt[key];
      }
      receipt.attemptId = attemptId; receipt.reservation = reservation; receipt.build = candidate; receipt.status = 'preparing';
      saveOwnedMetadata(receiptFile, receipt);
      const sourceBundle = bundle ?? await buildNativePreview({ worktree: selected.worktree, root, candidate, receipt,
        save: () => saveOwnedMetadata(receiptFile, receipt), identity: processIdentity });
      verifyNativeBundle(sourceBundle, candidate);
      receipt.sourceBundle = sourceBundle;

      const copiedBundle = path.join(root, 'app', `${receipt.windowTitle}.app`);
      fs.mkdirSync(path.dirname(copiedBundle), { recursive: true });
      if (resumed) fs.rmSync(copiedBundle, { recursive: true, force: true });
      run('/usr/bin/ditto', [sourceBundle, copiedBundle]);
      const plist = path.join(copiedBundle, 'Contents/Info.plist');
      const oldExecutable = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', plist]);
      const executableName = `mandible-native-preview-${ownership.runId.slice(0, 8)}`;
      receipt.bundle = copiedBundle;
      receipt.executable = path.join(copiedBundle, 'Contents/MacOS', executableName);
      fs.renameSync(path.join(copiedBundle, 'Contents/MacOS', oldExecutable), receipt.executable);
      for (const [key, value] of Object.entries({ CFBundleExecutable: executableName, CFBundleName: receipt.windowTitle,
        CFBundleIdentifier: `bio.mll.mandible.preview.${ownership.runId}` })) {
        run('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
      }
      const plistObject = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist]));
      if (plistObject.CFBundleURLTypes) run('/usr/libexec/PlistBuddy', ['-c', 'Delete :CFBundleURLTypes', plist]);
      run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', copiedBundle]);
      receipt.executableDigest = digest(receipt.executable);
      fs.rmSync(path.join(profile, 'native-ready.json'), { force: true });
      saveOwnedMetadata(path.join(profile, 'native-preview.json'), {
        manifest: receipt.manifest, origin: receipt.origin, instanceId: receipt.instanceId,
        runId: ownership.runId, previewRunId: owner.runId, home: profile, windowTitle: receipt.windowTitle, agentSession: agentSession ?? null,
      });
      saveOwnedMetadata(receiptFile, receipt);
      const stdout = fs.openSync(receipt.stdout, 'a', 0o600), stderr = fs.openSync(receipt.stderr, 'a', 0o600);
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MANDIBLE_')));
      try {
        child = spawn(receipt.executable, [], { detached: true, cwd: root,
          env: { ...env, MANDIBLE_HOME: profile, MANDIBLE_CONFIG_DIR: path.join(profile, 'config'),
            MANDIBLE_NATIVE_PREVIEW: path.join(profile, 'native-preview.json') }, stdio: ['ignore', stdout, stderr] });
      } finally { fs.closeSync(stdout); fs.closeSync(stderr); }
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      receipt.pid = child.pid; receipt.processIdentity = processIdentity(child.pid);
      receipt.ownership.state = 'active'; receipt.status = 'loading'; saveOwnedMetadata(receiptFile, receipt);
      const ready = await until(() => {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Native preview exited; inspect ${receipt.stderr}`);
        const file = path.join(profile, 'native-ready.json');
        if (!fs.existsSync(file)) return false;
        const evidence = read(file);
        if (evidence.pid !== child.pid || evidence.runId !== ownership.runId || evidence.origin !== receipt.origin
            || evidence.instanceId !== receipt.instanceId || evidence.profile !== profile) throw new Error('Native ready identity mismatch');
        return evidence;
      }, `Native preview did not finish loading; inspect ${receipt.stderr}`);
      receipt.status = 'visible'; receipt.window = ready;
      saveOwnedMetadata(receiptFile, receipt); child.unref();
    });
    await publishPreviewConsumer(reservation, { pid: receipt.pid, processIdentity: receipt.processIdentity, build: candidate });
    return receipt;
  } catch (error) {
    return failNativePreviewAttempt({ receiptFile, resumed, reservation, attemptId, error });
  }
}

export async function failNativePreviewAttempt({ receiptFile, resumed, reservation, attemptId, error }) {
  if (resumed && !reservation) throw error;
  const failureOptions = { parentLockHeld: !reservation, attemptId };
  try {
    await nativeOperation(receiptFile, failureOptions, current => {
      current.status = 'failed'; current.error = String(error); saveOwnedMetadata(receiptFile, current);
    });
    await stopNativePreview(receiptFile, failureOptions);
    if (!resumed) {
      const cleanup = await cleanupNativePreview(receiptFile, { ...failureOptions, disposition: 'discard' });
      if (cleanup.action === 'skip' || cleanup.action === 'cleanup-pending' || cleanup.remaining?.length) {
        throw new Error(cleanup.reason ?? 'Native generated output cleanup is pending');
      }
    } else {
      await nativeOperation(receiptFile, failureOptions, current => {
        current.status = 'failed';
        current.cleanupPending = 'Stopped-run relaunch failed; profile and warm target retained for retry or explicit cleanup';
        saveOwnedMetadata(receiptFile, current);
      });
    }
  } catch (cleanupError) {
    throw new Error(`${error.message}; cleanup pending: ${cleanupError.message}; native receipt: ${receiptFile}`);
  }
  throw new Error(`${error.message}; native receipt: ${receiptFile}`);
}

export async function cleanupNativePreview(file, options = {}) {
  let reservation;
  const result = await nativeOperation(file, options, receipt => {
    const stopped = receipt.status === 'stopped';
    if (processReleaseBlocked(receipt, stopped)) throw new Error('Stop the native preview before cleanup');
    if (processReleaseBlocked(receipt.buildProcess, stopped || Boolean(receipt.buildProcess?.finishedAt))
      || receipt.buildProcess?.remaining?.some(child => processReleaseBlocked(child, stopped))) throw new Error('Stop the native build before cleanup');
    reservation = receipt.reservation;
    if (receipt.ownership.state !== 'terminal') {
      const finalized = finalizeOwnedRun(file, { expectedRevision: receipt.ownership.revision,
        outcome: receipt.error ? 'failed' : 'assessed', disposition: options.disposition,
        summary: receipt.error ? `Native preview failed: ${receipt.error}` : 'Native preview closed; owned native outputs reclaimed' });
      const compact = finalized.ownership.receipt;
      const { ownership, ...launch } = receipt;
      saveOwnedMetadata(compact, { ...read(compact), root: receipt.ownership.root, nativePreview: launch });
    }
    return cleanupOwnedRun(file, { apply: true });
  });
  reservation ??= result.nativePreview?.reservation;
  if (reservation && !options.parentLockHeld && !fs.existsSync(path.dirname(file))) {
    const { releasePreviewConsumer } = await import('./preview-custody.mjs');
    await releasePreviewConsumer(reservation);
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  try {
    const [command, ...argv] = process.argv.slice(2);
    const args = {};
    for (let i = 0; i < argv.length; i += 2) {
      if (!argv[i].startsWith('--') || !argv[i + 1]) throw new Error('Expected --name value arguments');
      args[argv[i].slice(2)] = argv[i + 1];
    }
    let result;
    if (command === 'launch') result = await launchNativePreview({ ...args, workUnit: args['work-unit'], newInstance: args['new-instance'] === 'true', agentSession: args['agent-session'] ?? process.env.CODEX_THREAD_ID });
    else if (command === 'stop') result = await stopNativePreview(args.receipt);
    else if (command === 'cleanup') result = await cleanupNativePreview(args.receipt, { disposition: args.disposition });
    else throw new Error('Usage: bun run native-preview -- launch --branch <preview-branch> [--bundle <noninstalled.app>] --project <project-id> --work-unit <unit-id> [--agent-session <id>] | stop|cleanup --receipt <metadata.json>');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(JSON.stringify({ ok: false, error: String(error) })); process.exitCode = 1; }
}
