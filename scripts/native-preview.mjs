#!/usr/bin/env bun
import fs from 'node:fs';
import os from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createOwnedRun, saveOwnedMetadata, withOwnedRunLock, finalizeOwnedRun, cleanupOwnedRun, processIdentity } from './owned-run.mjs';

import { nativeCandidate, verifyNativeBundle, buildNativePreview } from './native-build.mjs';

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
  const execute = () => withOwnedRunLock(path.dirname(file), () => operation(ownedReceipt(file)));
  if (options.parentLockHeld || !initial.parent) return execute();
  const { withPreviewRun } = await import('./preview-custody.mjs');
  return withPreviewRun(initial.parent, execute);
}

export async function stopNativePreview(file, options = {}) {
  return nativeOperation(file, options, async receipt => {
    const processes = [receipt.buildProcess && !receipt.buildProcess.finishedAt && {
      pid: receipt.buildProcess.pid, identity: receipt.buildProcess.identity, group: true },
      receipt.pid && { pid: receipt.pid, identity: receipt.processIdentity, executable: receipt.executable }].filter(Boolean);
    for (const child of processes) {
      const identity = processIdentity(child.pid);
      if (identity === null) continue;
      if (identity !== child.identity || (child.executable && !identity.includes(child.executable))) {
        throw new Error('Native PID identity changed; refusing to signal a different process');
      }
      process.kill(child.group ? -child.pid : child.pid, child.group ? 'SIGKILL' : 'SIGTERM');
      await until(() => processIdentity(child.pid) === null, 'Native preview did not stop');
    }
    receipt.status = 'stopped'; receipt.stoppedAt = new Date().toISOString();
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
  const { healthyExistingPreview } = await import('./iab-preview.mjs');
  const selected = supplied ?? await healthyExistingPreview(branch);
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
  if (candidate.commit !== selected.instanceEnv.MANDIBLE_BACKEND_GENERATION) throw new Error('Selected backend generation differs from candidate');
  const parent = { root: previewRoot, runId: owner.runId };
  const { withPreviewRun, acquirePreviewConsumer, publishPreviewConsumer, releasePreviewConsumer } = await import('./preview-custody.mjs');
  const existing = await withPreviewRun(parent, metadata => {
    if (newInstance) return null;
    const consumers = metadata.ownership.consumers?.filter(entry => entry.state !== 'released') ?? [];
    if (!consumers.length) return null;
    const consumer = consumers[0];
    const current = ownedReceipt(consumer.metadataFile);
    if (current.status !== 'visible' || current.build.commit !== candidate.commit || current.build.source_digest !== candidate.source_digest
      || processIdentity(current.pid) !== current.processIdentity) throw new Error('Existing native attachment requires stop/cleanup before retry');
    return { ...current, reused: true };
  });
  if (existing) return existing;
  if (bundle) {
    bundle = fs.realpathSync(bundle);
    if (!bundle.endsWith('.app') || bundle.startsWith('/Applications/') || bundle.startsWith(path.join(os.homedir(), 'Applications') + path.sep)) {
      throw new Error('Supply the noninstalled Tauri build bundle');
    }
    verifyNativeBundle(bundle, candidate);
  }
  const base = path.join(os.homedir(), '.cache/mandible/native-previews');
  fs.mkdirSync(base, { recursive: true });
  const runId = randomUUID();
  const root = path.join(fs.realpathSync(base), `native-${runId}`);
  fs.mkdirSync(root, { mode: 0o700 });
  const profile = path.join(root, 'profile'); fs.mkdirSync(profile, { mode: 0o700 });
  const ownership = createOwnedRun({ root, runId, instanceId: owner.instanceId, project, workUnit,
    outputs: [{ path: 'profile', kind: 'interactive' }, { path: 'app', kind: 'generated' },
      { path: 'build', kind: 'generated' }, { path: 'build.log', kind: 'generated' }, { path: 'stdout.log', kind: 'generated' }, { path: 'stderr.log', kind: 'generated' }] });
  const receiptFile = path.join(root, 'metadata.json');
  const receipt = { schema: 'mandible-native-preview@1', ownership, status: 'preparing',
    executable: path.join(root, 'app', `Mandible Preview ${ownership.runId.slice(0, 8)}.app`, 'Contents/MacOS', `mandible-native-preview-${ownership.runId.slice(0, 8)}`),
    build: candidate, sourceBundle: bundle ?? null, parent, manifest: path.join(previewRoot, 'metadata.json'), previewRunId: owner.runId,
    instanceId: owner.instanceId, origin: selected.instanceEnv.MANDIBLE_PUBLIC_ORIGIN, profile,
    windowLabel: 'main', windowTitle: `Mandible Preview ${ownership.runId.slice(0, 8)}`,
    stdout: path.join(root, 'stdout.log'), stderr: path.join(root, 'stderr.log'), receipt: receiptFile };
  saveOwnedMetadata(receiptFile, receipt);
  let child;
  let reservation;
  try {
    reservation = await acquirePreviewConsumer(parent, { consumerId: ownership.runId, runId: ownership.runId, root,
      rootIdentity: ownership.rootIdentity, metadataFile: receiptFile, borrowedBackend: true, newInstance,
      expectedGeneration: selected.instanceEnv.MANDIBLE_BACKEND_GENERATION, expectedSource: owner.source });
    receipt.reservation = reservation; saveOwnedMetadata(receiptFile, receipt);
    await withOwnedRunLock(root, async () => {
      const sourceBundle = bundle ?? await buildNativePreview({ worktree: selected.worktree, root, candidate, receipt,
        save: () => saveOwnedMetadata(receiptFile, receipt), identity: processIdentity });
      verifyNativeBundle(sourceBundle, candidate);
      receipt.sourceBundle = sourceBundle;

      const copiedBundle = path.join(root, 'app', `${receipt.windowTitle}.app`);
      fs.mkdirSync(path.dirname(copiedBundle));
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
      ownership.state = 'active'; receipt.status = 'loading'; saveOwnedMetadata(receiptFile, receipt);
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
    receipt.status = 'failed'; receipt.error = String(error); saveOwnedMetadata(receiptFile, receipt);
    try {
      await stopNativePreview(receiptFile);
      await cleanupNativePreview(receiptFile, { disposition: 'discard' });
    } catch (cleanupError) {
      if (fs.existsSync(receiptFile)) {
        receipt.cleanupPending = String(cleanupError); saveOwnedMetadata(receiptFile, receipt);
      }
      throw new Error(`${error.message}; cleanup pending: ${cleanupError.message}; native receipt: ${receiptFile}`);
    }
    throw new Error(`${error.message}; native receipt: ${receiptFile}`);
  }
}

export async function cleanupNativePreview(file, options = {}) {
  let reservation;
  const result = await nativeOperation(file, options, receipt => {
    if (receipt.pid && processIdentity(receipt.pid) !== null) throw new Error('Stop the native preview before cleanup');
    if (receipt.buildProcess && !receipt.buildProcess.finishedAt && processIdentity(receipt.buildProcess.pid) !== null) throw new Error('Stop the native build before cleanup');
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
    else throw new Error('Usage: bun scripts/native-preview.mjs launch --branch <preview-branch> [--bundle <noninstalled.app>] --project <project-id> --work-unit <unit-id> [--agent-session <id>] | stop|cleanup --receipt <metadata.json>');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(JSON.stringify({ ok: false, error: String(error) })); process.exitCode = 1; }
}
