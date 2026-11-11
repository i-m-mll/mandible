import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { withOwnedRunLock, saveOwnedMetadata, finalizeOwnedRun, cleanupOwnedRun, ownedRunIdentityMatches, ownedRunReceipt, processIdentity } from './owned-run.mjs';
import { previewBaseDir, previewPaths, recordedPreview } from './preview-custody.mjs';
import { reconcilePreviewRegistration } from './preview-registration.mjs';
import { serviceInstallationContext } from './service-definitions.mjs';
import { readBundleOwner, readBundleLaunch, admitBundleOwner } from './bundle-services.mjs';
import { installedRuntimeEnvironment, readInstalledRelease, releaseFile } from './installed-release.mjs';

/**
 * Preview teardown: the one implementation behind `bun run iab-preview -- teardown`
 * (an exact run) and a merge's declared teardown (the run a branch records). The
 * daemon runs the declared form in a subprocess through this file's command line,
 * because finalization hashes every interactive file and inspects processes
 * synchronously. It imports none of the launcher's build or snapshot code.
 */

const LOCAL_SESSION_CUTOVER_SCHEMA = "mandible-local-session-cutover@1";
const LOCAL_SESSION_CUTOVER_STATES = new Set(["preparing", "prepared", "activating", "migration", "completing", "normal_pending", "rolling_back", "complete", "rolled_back", "recovery_failed"]);

export async function finalizePreview(options) {
  if (!options.root) throw new Error("finalize requires --root");
  if (options.revision === undefined) throw new Error('teardown requires --revision');
  const root = path.resolve(expandHome(options.root));
  if (canonicalPath(root) !== root || !isPathWithin(previewBaseDir(), root) || root === previewBaseDir()) throw new Error("Finalization root must be an exact owned preview child");
  const result = await withOwnedRunLock(root, async () => {
    const selected = selectedPreviewRun(options, root);
    if (selected.receipt) return { ok: selected.cleanup === 'completed', status: selected.cleanup === 'completed' ? 'cleaned' : 'cleanup-pending', ...selected };
    return tearDownRun(root, selected, options);
  });
  if (result.status === 'cleaned' && result.receipt) return finishPreviewWorktree(result);
  return result;
}

/**
 * Tear down the run recorded for `branch` as a merge's declared teardown: accepted,
 * converged, its interactive data discarded. The run is the one the branch's root
 * records under its lifecycle lock; the worktree is left to the merge finalizer.
 */
export async function tearDownBranchPreview({ branch, summary }) {
  assertOrdinaryPreviewLifecycleAllowed();
  const { root } = previewPaths(branch);
  const result = await withOwnedRunLock(root, async () => {
    const metadata = recordedPreview(branch);
    if (!metadata) return { ok: true, status: 'absent', branch };
    if (!metadata.ownership || !ownedRunIdentityMatches(root, metadata.ownership)) throw new Error('Preview run identity changed');
    return tearDownRun(root, metadata, { outcome: 'accepted', converged: true, disposition: 'discard', summary });
  }, { recoverStale: true });
  if (result.status === 'cleaned' && result.receipt) return leaveWorktreeToMergeFinalizer(result);
  return result;
}

/** Record teardown intent, stop and clean consumers, stop the process, retire the route, finalize and clean up. Runs under the run's lifecycle lock. */
async function tearDownRun(root, metadata, options) {
  const file = path.join(root, "metadata.json");
  if (!metadata.ownership.lifecycle) throw new Error('Legacy owned preview lacks runtime custody; inspect and retire its registration explicitly');
  if (options.outcome !== 'investigating' && metadata.ownership.state !== 'terminal') {
    if (!['accepted', 'assessed', 'failed', 'abandoned'].includes(options.outcome) || !options.summary?.trim()
      || options.outcome === 'accepted' && !options.converged) throw new Error('Teardown requires a terminal outcome, summary and accepted convergence');
    if (!options.disposition && !metadata.ownership.disposable) throw new Error('Teardown requires explicit interactive data disposition');
    metadata.ownership.lifecycle.teardown = true;
    metadata.ownership.lifecycle.phase = 'stopping';
    persistPreview(metadata);
    await retirePreviewRuntime(metadata, { cleanupChildren: true, options });
  }
  const active = await previewConsumerReason(metadata, root);
  if (active) throw new Error(active);
  const finalized = metadata.ownership.state === 'terminal' ? metadata : finalizeOwnedRun(file, { expectedRevision: metadata.ownership.revision, outcome: options.outcome,
    converged: options.converged, disposition: options.disposition, destination: options.destination, summary: options.summary, reviewBy: options.reviewBy, transferReference: options.transferReference });
  const activeAfterDisposition = await previewConsumerReason(finalized, root);
  const cleanup = activeAfterDisposition ? { action: "skip-active", reason: activeAfterDisposition, remaining: finalized.ownership.cleanup.remaining }
    : cleanupOwnedRun(file, { apply: true });
  const complete = cleanup.action === "delete-owned" && cleanup.remaining?.length === 0;
  return { ok: complete || options.outcome === "investigating", status: options.outcome === "investigating" ? "investigating" : complete ? "cleaned" : "cleanup-pending", ...cleanup,
    outcome: options.outcome, converged: options.converged, runId: finalized.ownership.runId };
}

function leaveWorktreeToMergeFinalizer(result) {
  const receipt = JSON.parse(fs.readFileSync(result.receipt, 'utf8'));
  receipt.worktreeDisposition = { ...receipt.acquisition?.worktree, retained: true, reason: 'The merge finalizer removes the landed branch and its worktree' };
  saveOwnedMetadata(result.receipt, receipt);
  return { ...result, worktree: receipt.worktreeDisposition };
}

async function finishPreviewWorktree(result) {
  const receipt = JSON.parse(fs.readFileSync(result.receipt, 'utf8'));
  const acquired = receipt.acquisition?.worktree;
  let worktree = { ...acquired, retained: true, reason: 'Borrowed candidate worktree remains with its owner' };
  if (acquired?.created) {
    try {
      if (receipt.lifecycle?.phase !== 'retired' || receipt.consumers?.some(child => child.state !== 'released')) throw new Error('Runtime retirement or attached consumers remain');
      if (!fs.existsSync(acquired.path)) worktree = { ...acquired, retained: false, reason: 'Owned worktree already removed' };
      else {
        const stat = fs.lstatSync(acquired.path);
        if (!acquired.identity || stat.isSymbolicLink() || stat.dev !== acquired.identity.dev || stat.ino !== acquired.identity.ino) throw new Error('Owned worktree directory identity changed');
        if (git(['branch', '--show-current'], { cwd: acquired.path }).stdout.trim() !== acquired.branch) throw new Error('Owned worktree branch changed');
        if (git(['status', '--porcelain', '--untracked-files=all'], { cwd: acquired.path }).stdout.trim()) throw new Error('Owned worktree has modified or untracked files');
        if (git(['merge-base', '--is-ancestor', 'HEAD', acquired.base], { cwd: acquired.path, allowFailure: true }).status !== 0) throw new Error('Owned worktree has unique unmerged commits');
        const findUnits = branch => {
          const found = JSON.parse(run('mandible', ['work-unit', 'find', '--repo', receipt.project, '--branch', branch], { cwd: receipt.acquisition.hostRoot }).stdout);
          return Array.isArray(found) ? found : found.work_units ?? (found.id ? [found] : []);
        };
        const units = findUnits(receipt.acquisition.ownerBranch);
        const owner = units.find(unit => unit.id === receipt.workUnit);
        if (!owner || owner.state !== 'resolved') throw new Error('Owning delivery work unit is unresolved or cannot be verified');
        if (findUnits(acquired.branch).some(unit => !['resolved', 'abandoned'].includes(unit.state))) throw new Error('Owned worktree has unresolved delivery work');
        for (const entry of fs.readdirSync(previewBaseDir(), { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
          const other = readJsonFile(path.join(previewBaseDir(), entry.name, 'metadata.json'));
          if (other?.worktree && canonicalPath(other.worktree) === canonicalPath(acquired.path)) throw new Error('Another preview retains this worktree');
        }
        const removed = run('wt', ['rm', acquired.branch], { cwd: receipt.acquisition.hostRoot, allowFailure: true });
        if (removed.status !== 0 || fs.existsSync(acquired.path)) throw new Error(`wt retained owned worktree: ${removed.stderr?.trim() || removed.stdout?.trim()}`);
        worktree = { ...acquired, retained: false, reason: 'Owned clean merged worktree removed by wt' };
      }
    } catch (error) { worktree.reason = error.message; }
  }
  receipt.worktreeDisposition = worktree;
  saveOwnedMetadata(result.receipt, receipt);
  return { ...result, worktree };
}

export function selectedPreviewRun(options, root) {
  if (!options.runId) throw new Error('Exact --run-id is required; use the setup run handle');
  const file = path.join(root, 'metadata.json');
  if (!fs.existsSync(file)) {
    const receipt = ownedRunReceipt({ root, runId: options.runId });
    if (!receipt) throw new Error('Owned preview run or retained receipt not found');
    return receipt;
  }
  const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!ownedRunIdentityMatches(root, metadata.ownership) || metadata.ownership.runId !== options.runId) {
    const receipt = ownedRunReceipt({ root, runId: options.runId });
    if (receipt?.cleanup === 'completed') return receipt;
    throw new Error('Preview run identity changed');
  }
  if (options.revision !== undefined && metadata.ownership.revision !== Number(options.revision)) throw new Error('Owned run metadata revision changed');
  return metadata;
}

export function persistPreview(metadata) {
  metadata.ownership.revision++;
  saveOwnedMetadata(path.join(metadata.previewRoot, 'metadata.json'), metadata);
}

export async function retirePreviewRuntime(metadata, { cleanupChildren = false, options = {} } = {}) {
  const run = metadata.ownership;
  for (const consumer of run.consumers ?? []) {
    if (consumer.state === 'released') continue;
    const childReceipt = ownedRunReceipt({ root: consumer.root, runId: consumer.runId });
    if (childReceipt?.cleanup === 'completed') { consumer.state = 'released'; consumer.receipt = childReceipt.receipt; persistPreview(metadata); continue; }
    if (!fs.existsSync(consumer.metadataFile)) throw new Error(`Pending native consumer ${consumer.consumerId} requires acquisition recovery`);
    const child = JSON.parse(fs.readFileSync(consumer.metadataFile, 'utf8'));
    if (child.ownership?.runId !== consumer.runId || !ownedRunIdentityMatches(consumer.root, child.ownership)
      || child.ownership.rootIdentity.dev !== consumer.rootIdentity.dev || child.ownership.rootIdentity.ino !== consumer.rootIdentity.ino) throw new Error('Attached native consumer identity changed');
    const adapter = await import('./native-preview.mjs');
    await adapter.stopNativePreview(consumer.metadataFile, { parentLockHeld: true });
    if (cleanupChildren) {
      await adapter.cleanupNativePreview(consumer.metadataFile, { parentLockHeld: true, disposition: options.disposition, outcome: options.outcome, summary: options.summary });
      const retired = ownedRunReceipt({ root: consumer.root, runId: consumer.runId });
      if (retired?.cleanup !== 'completed') throw new Error('Native child cleanup remains pending');
      consumer.state = 'released'; consumer.receipt = retired.receipt;
    }
    persistPreview(metadata);
  }
  await stopPreviewProcess(metadata);
  run.lifecycle.phase = 'retiring';
  persistPreview(metadata);
  if (run.lifecycle.registration) await reconcileRegistration(metadata, run.lifecycle.registration, null, options.effects?.reloadGateway);
  run.lifecycle.phase = 'retired';
  run.lifecycle.retiredAt = new Date().toISOString();
  run.lifecycle.worktree = { ...run.acquisition?.worktree, retained: true,
    reason: run.acquisition?.worktree?.created ? 'Owning delivery work unit must be resolved before wt removal' : 'Borrowed candidate worktree remains with its owner' };
  run.state = 'stopped';
  persistPreview(metadata);
}

export async function previewConsumerReason(metadata, root) {
  if (metadata.ownership?.consumers?.some(child => child.state !== 'released')) return 'attached or pending native/build consumer requires explicit cleanup';
  const pids = [metadata.pidFile, path.join(root, "mandible.pid")].filter(Boolean).map(readPidFile);
  if (pids.some(pid => pid && isProcessAlive(pid))) return "recorded pid is live; identity or ownership may be shared";
  if (metadata.port && await isPortOpen(metadata.port)) return "recorded port has a consumer; health is not deletion authority";
  if (metadata.launchLabel) return 'recorded respawn authority requires explicit exact retirement';
  return null;
}

/** Stop only the recorded process lifetime and selected instance. */
export async function stopPreviewProcess(metadata, timeoutMs = 10_000) {
  const launch = metadata.ownership?.lifecycle?.launch;
  const filePid = metadata.pidFile ? readPidFile(metadata.pidFile) : null;
  if (filePid && filePid !== launch?.pid && isProcessAlive(filePid)) throw new Error('Preview pid file identity changed; refusing to signal');
  const pid = launch?.pid;
  if (!pid || processIdentity(pid) === null) {
    if (metadata.port && await isPortOpen(metadata.port)) throw new Error('Stopped preview backend port has a conflicting consumer');
    return { pid: pid ?? null, outcome: 'already-stopped' };
  }
  const verify = async () => {
    const identity = processIdentity(pid);
    if (!identity) return false;
    if (identity.slice(0, 24) !== launch.startedAt
      || !(identity.includes(launch.runScript) || identity.includes(launch.runtime) && identity.includes('src/index.ts'))) throw new Error('Preview process identity changed; refusing to signal');
    const cwd = run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']).stdout.split('\n').find(line => line.startsWith('n'))?.slice(1);
    if (!cwd || canonicalPath(cwd) !== canonicalPath(launch.worktree)) throw new Error('Preview process launch context changed');
    if (metadata.port && await isPortOpen(metadata.port)) {
      const health = await readHealth(metadata.port);
      if (health?.instance?.instance_id !== metadata.instanceEnv?.MANDIBLE_INSTANCE_ID
        || health?.instance?.backend_generation !== metadata.instanceEnv?.MANDIBLE_BACKEND_GENERATION) throw new Error('Preview listener belongs to a different instance or generation');
    }
    return true;
  };
  if (!await verify()) return { pid, outcome: 'already-stopped' };

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
    return { pid, outcome: "already-stopped" };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return { pid, outcome: "terminated" };
    await delay(100);
  }

  try {
    if (!await verify()) return { pid, outcome: 'terminated' };
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
    return { pid, outcome: "terminated" };
  }
  const killDeadline = Date.now() + 5_000;
  while (Date.now() < killDeadline) {
    if (!isProcessAlive(pid)) return { pid, outcome: "killed" };
    await delay(100);
  }
  throw new Error(`Preview daemon ${pid} did not exit after SIGTERM and SIGKILL.`);
}

export async function reconcileRegistration(metadata, expected, desired, reload = reloadLocalFrontDoor) {
  return reconcilePreviewRegistration({ home: mandibleHome(), runId: metadata.ownership.runId, expected, desired,
    reload: token => reload(token) });
}

export function reloadLocalFrontDoor(token) {
  const context = serviceInstallationContext({ home: mandibleHome() });
  const owner = readBundleOwner(context);
  let script = path.join(path.dirname(fileURLToPath(import.meta.url)), "local-runtime.mjs");
  let runtime = process.execPath;
  const args = ['reload-gateway'];
  let environment = { ...process.env, ...(token ? { MANDIBLE_GATEWAY_LOCK_TOKEN: token } : {}) };
  if (owner) {
    const resources = path.join(context.bundleRoot, 'Contents/Resources');
    const release = readInstalledRelease(resources);
    const admission = admitBundleOwner(context, release);
    if (!admission.ok) throw new Error(admission.message);
    environment = installedRuntimeEnvironment(resources, environment);
    runtime = environment.MANDIBLE_RUNTIME;
    script = releaseFile(resources, release.entrypoints.controller);
    args.push(`--launch-mode=${readBundleLaunch(context).launchMode}`);
  }
  const result = spawnSync(runtime, [script, ...args], {
    encoding: "utf8", timeout: 20_000,
    env: environment,
  });
  if (result.error || result.status !== 0) throw new Error(`Gateway reconciliation failed: ${result.error?.message ?? result.stderr.trim()}`);
  return result.stdout.trim();
}

export function assertOrdinaryPreviewLifecycleAllowed() {
  const journalPath = path.join(localSessionAuthorityDir(), "cutover.json");
  if (!fs.existsSync(journalPath)) return;
  let journal;
  try {
    journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  } catch {
    throw new Error(`Local-session cutover journal is unreadable: ${journalPath}`);
  }
  if (journal.schema !== LOCAL_SESSION_CUTOVER_SCHEMA || !LOCAL_SESSION_CUTOVER_STATES.has(journal.state)) {
    throw new Error(`Local-session cutover journal has an invalid schema or state: ${journalPath}`);
  }
  if (journal.state === "complete") {
    if (journal.runtime?.gateway_mode === "normal" && journal.runtime?.intents?.["preview.promote"]?.status === "done") return;
    throw new Error(`Completed local-session cutover journal lacks its normal gateway or preview-promotion receipt: ${journalPath}`);
  }
  if (journal.state === "rolled_back") {
    if (journal.runtime?.intents?.["files.restore"]?.status === "done" && journal.runtime?.intents?.["registrations.restore"]?.status === "done") return;
    throw new Error(`Rolled-back local-session cutover journal lacks restoration receipts: ${journalPath}`);
  }
  throw new Error(
    `Local-session cutover is ${journal.state}; ordinary preview lifecycle is disabled until that historical state is explicitly reconciled.`,
  );
}

export function localSessionAuthorityDir() {
  return path.join(mandibleHome(), "config", "local-sessions");
}

export function mandibleHome() {
  return process.env.MANDIBLE_HOME?.trim()
    ? path.resolve(expandHome(process.env.MANDIBLE_HOME.trim()))
    : path.join(os.homedir(), ".mandible");
}

export function readHealth(port) {
  return new Promise((resolve) => {
    const req = http.get({
      hostname: "127.0.0.1",
      port,
      path: "/api/health",
      timeout: 1_000,
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
  });
}

export function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(500);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(false));
  });
}

export function readPidFile(filePath) {
  try {
    const value = Number.parseInt(fs.readFileSync(filePath, "utf8").trim(), 10);
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function canonicalPath(candidatePath) {
  try {
    return fs.realpathSync.native(candidatePath);
  } catch {
    return path.resolve(candidatePath);
  }
}

export function isPathWithin(parentPath, candidatePath) {
  const relative = path.relative(canonicalPath(parentPath), canonicalPath(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 60_000,
    stdio: options.inherit ? "inherit" : "pipe",
  });

  if (result.error && !options.allowFailure) {
    throw result.error;
  }

  if (result.status !== 0 && !options.allowFailure) {
    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    throw new Error([
      `${command} ${commandArgs.join(" ")} failed with exit ${result.status}`,
      stderr,
      stdout,
    ].filter(Boolean).join("\n"));
  }

  return result;
}

export function git(commandArgs, options = {}) {
  return run("git", ["--no-optional-locks", ...commandArgs], options);
}

export function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function describeError(failure) {
  return failure instanceof AggregateError
    ? `${failure.message}: ${failure.errors.map(describeError).join('; ')}`
    : failure instanceof Error ? failure.message : String(failure);
}

if (process.argv[1] && canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url))) {
  const { values } = parseArgs({ options: { branch: { type: 'string' }, summary: { type: 'string' } } });
  if (!values.branch?.trim() || !values.summary?.trim()) {
    console.error('Usage: bun scripts/preview-teardown.mjs --branch <branch> --summary <text>\nTears down the preview recorded for the branch as accepted and converged, discarding its interactive data, and prints the result as JSON.');
    process.exit(2);
  }
  let result;
  try { result = await tearDownBranchPreview({ branch: values.branch, summary: values.summary }); }
  catch (error) { result = { ok: false, status: 'failed', error: describeError(error) }; }
  console.log(JSON.stringify(result));
}
