#!/usr/bin/env bun
import fs from 'node:fs';
import os from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createOwnedRun, saveOwnedMetadata, withOwnedRunLock, finalizeOwnedRun, cleanupOwnedRun } from './owned-run.mjs';

const script = fileURLToPath(import.meta.url);
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command}: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 1) throw new Error('Invalid native child PID');
  const result = spawnSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8', timeout: 5000 });
  if (result.status === 1 && !result.stdout.trim()) return null;
  if (result.error || result.status !== 0) throw new Error(`Cannot inspect native process: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}

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

export async function stopNativePreview(file) {
  return withOwnedRunLock(path.dirname(file), async () => {
    const receipt = ownedReceipt(file);
    const identity = processIdentity(receipt.pid);
    if (identity !== null) {
      if (identity !== receipt.processIdentity || !identity.includes(receipt.executable)) {
        throw new Error('Native PID identity changed; refusing to signal a different process');
      }
      process.kill(receipt.pid, 'SIGTERM');
      await until(() => processIdentity(receipt.pid) === null, 'Native preview did not stop');
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

export async function launchNativePreview({ branch, bundle, project, workUnit, agentSession }) {
  if (process.platform !== 'darwin' || Number(run('/usr/bin/sw_vers', ['-productVersion']).split('.')[0]) < 14) {
    throw new Error('Visible native preview requires macOS 14+ for a separate WebKit store');
  }
  if (!branch || !bundle || !project || !workUnit) throw new Error('launch requires --branch, --bundle, --project and --work-unit');
  const { healthyExistingPreview } = await import('./iab-preview.mjs');
  const selected = await healthyExistingPreview(branch);
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
  const sourceBundle = fs.realpathSync(bundle);
  if (!sourceBundle.endsWith('.app') || sourceBundle.startsWith('/Applications/') || sourceBundle.startsWith(path.join(os.homedir(), 'Applications') + path.sep)) {
    throw new Error('Supply the noninstalled Tauri build bundle');
  }
  const build = read(path.join(sourceBundle, 'Contents/Resources/build-revision.json'));
  if (!/^[a-f0-9]{40}$/.test(build.commit) || !/^[a-f0-9]{64}$/.test(build.source_digest)) throw new Error('Bundle build identity is missing');
  const base = path.join(os.homedir(), '.cache/mandible/native-previews');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(base, 'native-')));
  const profile = path.join(root, 'profile'); fs.mkdirSync(profile, { mode: 0o700 });
  const ownership = createOwnedRun({ root, instanceId: owner.instanceId, project, workUnit,
    outputs: [{ path: 'profile', kind: 'interactive' }, { path: 'app', kind: 'generated' },
      { path: 'stdout.log', kind: 'generated' }, { path: 'stderr.log', kind: 'generated' }] });
  const receiptFile = path.join(root, 'metadata.json');
  const receipt = { schema: 'mandible-native-preview@1', ownership, status: 'preparing',
    executable: path.join(root, 'app', `Mandible Preview ${ownership.runId.slice(0, 8)}.app`, 'Contents/MacOS', `mandible-native-preview-${ownership.runId.slice(0, 8)}`),
    build, sourceBundle, manifest: path.join(previewRoot, 'metadata.json'), previewRunId: owner.runId,
    instanceId: owner.instanceId, origin: selected.instanceEnv.MANDIBLE_PUBLIC_ORIGIN, profile,
    windowLabel: 'main', windowTitle: `Mandible Preview ${ownership.runId.slice(0, 8)}`,
    stdout: path.join(root, 'stdout.log'), stderr: path.join(root, 'stderr.log'), receipt: receiptFile };
  saveOwnedMetadata(receiptFile, receipt);
  let child;
  try {
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
    return receipt;
  } catch (error) {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await until(() => child.exitCode !== null || child.signalCode !== null, 'Failed native child did not stop');
    }
    receipt.status = 'failed'; receipt.error = String(error); saveOwnedMetadata(receiptFile, receipt);
    throw new Error(`${error.message}; native receipt: ${receiptFile}`);
  }
}

export async function cleanupNativePreview(file) {
  return withOwnedRunLock(path.dirname(file), () => {
    const receipt = ownedReceipt(file);
    if (receipt.pid && processIdentity(receipt.pid) !== null) throw new Error('Stop the native preview before cleanup');
    if (receipt.ownership.state !== 'terminal') {
      const finalized = finalizeOwnedRun(file, { expectedRevision: receipt.ownership.revision, outcome: 'assessed',
        disposition: 'discard', summary: 'Native preview closed; isolated browser profile discarded' });
      const compact = finalized.ownership.receipt;
      const { ownership, ...launch } = receipt;
      saveOwnedMetadata(compact, { ...read(compact), nativePreview: launch });
    }
    return cleanupOwnedRun(file, { apply: true });
  });
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
    if (command === 'launch') result = await launchNativePreview({ ...args, workUnit: args['work-unit'], agentSession: args['agent-session'] ?? process.env.CODEX_THREAD_ID });
    else if (command === 'stop') result = await stopNativePreview(args.receipt);
    else if (command === 'cleanup') result = await cleanupNativePreview(args.receipt);
    else throw new Error('Usage: bun scripts/native-preview.mjs launch --branch <preview-branch> --bundle <noninstalled.app> --project <project-id> --work-unit <unit-id> [--agent-session <id>] | stop|cleanup --receipt <metadata.json>');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(JSON.stringify({ ok: false, error: String(error) })); process.exitCode = 1; }
}
