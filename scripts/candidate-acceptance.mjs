#!/usr/bin/env bun
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { localCaPaths, assertLocalCaIdentity, probeCurrentMacOsTrust } from './local-ca-trust.mjs';
import { installedRuntimeEnvironment, releaseFile, verifyInstalledRelease } from './installed-release.mjs';
import { installedExecutionProfile } from './installed-execution.mjs';
import { applicationIdentity, retainAcceptedRelease, resolveAcceptedRelease } from './accepted-release.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { runSupervisedCommand } from './process-group-supervisor.mjs';
import { fileURLToPath } from 'node:url';
import { withOwnedRunLock, createOwnedRun, saveOwnedMetadata, finalizeOwnedRun, cleanupOwnedRun } from './owned-run.mjs';
import { readBuildRevision } from './build-revision.mjs';
import { observeRuntimeHealthCoverage, RuntimeHealthObservationError } from '../src/runtime-health-contract.ts';

import { readRuntimeHandoffLock, runtimeHandoffLockRefusal } from './runtime-handoff-lock.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sweepWorkDirectory = 'route-cost-work';
export const acceptanceOwnedOutputs = ['home', 'Mandible.app', 'build.log', 'route-cost.json', 'route-cost.log', sweepWorkDirectory, 'daemon.log', 'desktop.log', 'gateway.log', 'Caddyfile'].map(path => ({ path, kind: path === 'Mandible.app' ? 'interactive' : 'generated' }));
export function routeCostSweepArgs(run) {
  return ['--no-install', path.join(root, 'scripts', 'route-cost-sweep.ts'), '--json', '--work-root', path.join(run, sweepWorkDirectory)];
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, { cwd: root, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, encoding: 'utf8', timeout: 60_000, ...options });
  if (result.error || result.status !== 0) throw new Error(`${binary} ${args.join(' ')} failed: ${result.error?.message || result.stderr || result.status}`);
  return result.stdout?.trim();
}

import { assessRuntimeLogs } from './runtime-log-assessment.mjs';

/** The acceptance record of a route-cost sweep report; null when the sweep printed none. */
export function routeCostCheck(text) {
  if (!text.trim()) return null;
  const report = JSON.parse(text);
  const route = entry => `${entry.method} ${entry.path}`;
  return {
    schema: report.schema,
    judging_rule: report.judging_rule,
    confirmation_trials: report.confirmation_trials,
    load: report.load,
    threshold_ms: report.threshold_ms,
    counts: report.counts,
    offenders: report.offenders.map(entry => ({ route: route(entry), first_call_turn_ms: entry.first_call_turn_ms, warm_turn_ms: entry.warm_turn_ms })),
    excepted: report.excepted.map(entry => ({ route: route(entry), issue: entry.issue, first_call_turn_ms: entry.first_call_turn_ms, warm_turn_ms: entry.warm_turn_ms })),
    exception_problems: report.exception_problems,
    remeasured: report.measured.filter(entry => entry.trials.length > 1).map(entry => ({ route: route(entry), trials: entry.trials })),
    unclassified: report.unclassified.map(route),
    failed_requests: report.failed_requests.map(entry => `${entry.url} (trial ${entry.trial}, pass ${entry.pass}): ${entry.status} ${String(entry.error).slice(0, 200)}`),
  };
}

/** The sweep's reasons for failing, in the order a reader acts on them. */
export function routeCostVerdict(check) {
  const reasons = [
    ...check.offenders.map(entry => `${entry.route} blocked the loop ${entry.first_call_turn_ms} ms on first call, ${entry.warm_turn_ms} ms warm`),
    ...check.failed_requests.slice(0, 3).map(entry => `request failed: ${entry}`),
    ...(check.failed_requests.length > 3 ? [`${check.failed_requests.length - 3} more failed requests`] : []),
    ...check.unclassified.map(route => `${route} is unclassified`),
    ...check.exception_problems.map(entry => `exception for ${entry.route} (${entry.issue}): ${entry.problem}`),
  ];
  return reasons.length > 0 ? reasons.join('; ') : 'the report names no failure; see route-cost.log';
}

export function createAcceptanceHome(home) {
  fs.mkdirSync(home, { mode: 0o700 });
}

export function acceptanceGatewayConfig({ origin, backendPort, adminPort, storageRoot }) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.hostname !== 'app.mandible.localhost' || !url.port || url.origin !== origin) throw new Error('Acceptance requires an exact Mandible HTTPS origin.');
  const ports = [Number(url.port), backendPort, adminPort];
  if (!ports.every(port => Number.isInteger(port) && port > 0 && port < 65536) || new Set(ports).size !== 3 || !path.isAbsolute(storageRoot)) throw new Error('Acceptance gateway requires distinct valid ports and owned absolute storage.');
  return `{\n  admin 127.0.0.1:${adminPort}\n  storage file_system ${JSON.stringify(storageRoot)}\n  local_certs\n  skip_install_trust\n  auto_https disable_redirects\n}\n\n${origin} {\n  bind 127.0.0.1 ::1\n  tls internal\n  header -Server\n  reverse_proxy http://127.0.0.1:${backendPort} {\n    header_up -X-Mandible-Target-Instance\n    header_up -X-Mandible-Session-Context\n  }\n}\n`;
}

/** Acceptance's log verdict: runtime log failures plus every health event, since a stall on the fixture is the code's. */
export function assessAcceptanceLogs(text) {
  const { failures, diagnostics } = assessRuntimeLogs(text);
  return { failures: [...failures, ...diagnostics.health_events.retained.map(entry => `Runtime health event: ${JSON.stringify(entry)}`)], diagnostics };
}

export async function observeAcceptanceHealth({
  probe,
  now = Date.now,
  wait = delay,
  observationMs = 31_000,
  deadlineMs = 62_000,
}) {
  const result = await observeRuntimeHealthCoverage({
    probe,
    healthOf: value => value,
    validate: (value, initial) => {
      if (value.startup_epoch !== initial.startup_epoch) throw new Error('Daemon startup epoch changed during acceptance observation.');
    },
    now,
    wait,
    pollMs: 500,
    observationMs,
    deadlineMs,
  });
  // Acceptance runs on an empty fixture database, so any performance finding is the code's.
  const [finding] = result.performance.findings;
  if (finding) throw new RuntimeHealthObservationError(finding.code, finding.message, { observation: result.observation, performance: result.performance });
  return result.value;
}

export function copyAcceptanceCa(sourceHome, home) {
  const source = localCaPaths(sourceHome);
  if (assertLocalCaIdentity(source).state !== 'trusted') throw new Error('Acceptance requires an already trusted installation CA; run explicit secure-local-connections setup first.');
  probeCurrentMacOsTrust(source);
  const ca = localCaPaths(home);
  fs.mkdirSync(path.dirname(ca.installationAuthority), { recursive: true });
  fs.copyFileSync(source.installationAuthority, ca.installationAuthority);
  fs.cpSync(source.storageRoot, ca.storageRoot, { recursive: true });
  const receipt = JSON.parse(fs.readFileSync(source.receipt, 'utf8'));
  fs.writeFileSync(ca.receipt, JSON.stringify({ ...receipt, storage_root: ca.storageRoot, fixture_source_digest: sha256(source.receipt) }), { mode: 0o600 });
  assertLocalCaIdentity(ca);
  return ca;
}

export function acceptanceHealth(origin, rootCert, signal) {
  return new Promise((resolve, reject) => {
    const request = https.get(`${origin}/api/health`, {
      ca: fs.readFileSync(rootCert),
      lookup: (_host, options, callback) => options.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4),
    }, response => {
      let bytes = ''; response.on('data', chunk => { bytes += chunk; });
      response.on('error', reject);
      response.on('end', () => {
        try {
          if (response.statusCode !== 200) throw new Error(`Health HTTPS ${response.statusCode}`);
          resolve(JSON.parse(bytes));
        } catch (error) { reject(error); }
      });
    });
    request.setTimeout(1500, () => request.destroy(new Error('Acceptance HTTPS health timed out')));
    if (signal) {
      const abort = () => request.destroy(signal.reason instanceof Error ? signal.reason : new Error('Acceptance health observation aborted'));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
      request.once('close', () => signal.removeEventListener('abort', abort));
    }
    request.on('error', reject);
  });
}

// A process that has not bound its port yet refuses the connection.
function readinessPending(error) {
  return error.cause?.code === 'ECONNREFUSED' || ['ECONNREFUSED', 'ConnectionRefused'].includes(error.code);
}

/** Resolve once something accepts TCP connections on the loopback port. */
export function loopbackListening(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', reject);
  });
}

/**
 * Probe until `isReady` accepts an answer. Connection refusal is pending by
 * default; callers may supply a scoped startup predicate. Expiry names the
 * last observation within the same fixed deadline.
 */
export async function awaitReadiness(probe, isReady, { timeout, description, interval = 100, pending = readinessPending }) {
  const end = Date.now() + timeout;
  let last = 'no probe completed';
  while (Date.now() < end) {
    try {
      const value = await probe();
      if (isReady(value)) return value;
      last = 'answered, not ready';
    } catch (error) {
      if (!pending(error)) throw error;
      last = error.message;
    }
    await delay(interval);
  }
  throw new Error(`${description} did not complete within ${timeout}ms; last observation: ${last}`);
}

export function awaitAcceptanceGatewayReadiness(probe, isReady, { onInitialTlsError = () => {}, ...options }) {
  let answered = false;
  return awaitReadiness(async () => {
    const value = await probe();
    answered = true;
    return value;
  }, isReady, { ...options, pending: error => {
    if (!answered && error.code === 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR') {
      onInitialTlsError({ code: error.code, message: error.message });
      return true;
    }
    return readinessPending(error);
  } });
}

export function acceptanceFailureLogs(run) {
  return ['daemon', 'gateway'].flatMap(name => {
    const file = path.join(run, `${name}.log`);
    if (!fs.existsSync(file)) return [];
    const bytes = fs.readFileSync(file);
    return [{ name, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
      excerpt: bytes.subarray(Math.max(0, bytes.length - 8000)).toString('utf8') }];
  });
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function until(predicate, timeout, description) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(`${description} did not complete within ${timeout}ms`);
}

async function stopOwned(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  try { await until(() => child.exitCode !== null || child.signalCode !== null, 6000, 'Owned process shutdown'); }
  catch (error) {
    child.kill('SIGKILL');
    await until(() => child.exitCode !== null || child.signalCode !== null, 2000, 'Owned process termination');
    throw error;
  }
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('Packaged desktop acceptance requires macOS; evidence is unavailable on this platform.');
  const candidate = command('git', ['rev-parse', 'HEAD']);
  const parents = command('git', ['show', '-s', '--format=%P', candidate]).split(' ');
  const candidateBinding = { pin_sha: candidate, tree_sha: command('git', ['rev-parse', 'HEAD^{tree}']),
    base_sha: process.env.MANDIBLE_ACCEPTANCE_BASE || parents[0], head_sha: process.env.MANDIBLE_ACCEPTANCE_HEAD || parents[1] || candidate };
  if (command('git', ['status', '--porcelain', '--untracked-files=all'])) throw new Error('Candidate acceptance requires a clean committed checkout.');
  const lock = readRuntimeHandoffLock(path.resolve(process.env.MANDIBLE_HOME || path.join(os.userInfo().homedir, '.mandible')));
  const initialBlocker = lock ? { code: 'runtime_handoff_lock', message: runtimeHandoffLockRefusal(lock) } : null;
  if (initialBlocker) {
    process.stdout.write(`${JSON.stringify({ status: 'failed', candidate, publication_blocker: initialBlocker, error: initialBlocker.message })}\n`);
    process.exitCode = 1;
    return;
  }
  const runtime = command('/bin/sh', [path.join(root, 'scripts', 'bun-runtime.sh')]);
  const buildEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', PATH: `${path.dirname(runtime)}${path.delimiter}${process.env.PATH}` };
  const cache = path.join(os.homedir(), '.cache', 'mandible', 'acceptance');
  fs.mkdirSync(cache, { recursive: true });
  const run = fs.mkdtempSync(path.join(cache, 'candidate-'));
  const option = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
  const project = option('--project'); const workUnit = option('--work-unit');
  if (!project || !workUnit) { fs.rmdirSync(run); throw new Error('Candidate acceptance requires --project <canonical-id> and --work-unit <canonical-id>'); }
  return withOwnedRunLock(run, async () => {
  const nonce = randomBytes(32).toString('hex');
  const instanceId = `acceptance-${nonce.slice(0, 16)}`;
  const ownership = createOwnedRun({ root: run, instanceId, project, workUnit, disposable: true, outputs: acceptanceOwnedOutputs });
  const metadataFile = path.join(run, 'metadata.json');
  saveOwnedMetadata(metadataFile, { ownership, candidate });
  const home = path.join(run, 'home');
  createAcceptanceHome(home);
  const result = { schema: 'mandible-candidate-acceptance@1', scope: 'isolated production daemon and packaged dashboard; live installation and protected delivery excluded', status: 'failed', candidate, runtime, run, checks: {}, provenance: {} };
  let daemon, desktop, gateway, testedPackageDigest;
  let executionProfile;
  const files = [];
  const launch = (binary, args, env, name) => {
    const fd = fs.openSync(path.join(run, `${name}.log`), 'w'); files.push(fd);
    const child = spawn('/usr/bin/sandbox-exec', ['-p', executionProfile, binary, ...args], { cwd: run, env, stdio: ['ignore', fd, fd] });
    child.on('error', error => { result.checks[`${name}_launch_error`] = error.message; });
    return child;
  };
  let interrupted = false;
  const interrupt = () => { interrupted = true; daemon?.kill('SIGTERM'); desktop?.kill('SIGTERM'); gateway?.kill('SIGTERM'); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    const buildLog = fs.openSync(path.join(run, 'build.log'), 'w'); files.push(buildLog);
    await runSupervisedCommand(runtime, ['run', 'build'], { cwd: root, env: { ...buildEnv, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', buildLog, buildLog], timeout: 180000 });
    if (readBuildRevision(root) !== candidate) throw new Error('Built daemon revision does not match the exact candidate.');
    // Every route handler must stay within HANDLER_TURN_BUDGET_MS on a snapshot
    // of the live ledger. It runs before the native build so a slow handler
    // fails the candidate early.
    const routeCostFile = path.join(run, 'route-cost.json');
    const routeCostOut = fs.openSync(routeCostFile, 'w'); files.push(routeCostOut);
    const routeCostLog = fs.openSync(path.join(run, 'route-cost.log'), 'w'); files.push(routeCostLog);
    const sweepFailure = await runSupervisedCommand(runtime, routeCostSweepArgs(run), { cwd: root, env: buildEnv, stdio: ['ignore', routeCostOut, routeCostLog], timeout: 900000 }).then(() => null, error => error);
    result.checks.route_cost = routeCostCheck(fs.readFileSync(routeCostFile, 'utf8'));
    if (sweepFailure) throw new Error(`Route-cost sweep failed: ${result.checks.route_cost
      ? routeCostVerdict(result.checks.route_cost)
      : `it exited (${sweepFailure.message}) without a report: ${fs.readFileSync(path.join(run, 'route-cost.log'), 'utf8').split('\n').filter(line => line.trim() && !/^\s+at /.test(line)).slice(-8).join(' | ')}`}`);
    await runSupervisedCommand(runtime, ['run', 'tauri:build', '--', '--bundles', 'app'], { cwd: root, env: { ...buildEnv, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', buildLog, buildLog], timeout: 600000 });
    const builtApp = path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'macos', 'Mandible.app');
    command('/usr/bin/codesign', ['--verify', '--deep', '--strict', builtApp]);
    const app = path.join(run, 'Mandible.app'); fs.cpSync(builtApp, app, { recursive: true });
    const resources = path.join(app, 'Contents', 'Resources');
    const bundledMarker = JSON.parse(fs.readFileSync(path.join(resources, 'build-revision.json'), 'utf8'));
    const marker = JSON.parse(fs.readFileSync(path.join(root, 'dist', 'build-revision.json'), 'utf8'));
    if (JSON.stringify(bundledMarker) !== JSON.stringify(marker)) throw new Error('Native package carries a different candidate marker.');
    const shipped = verifyInstalledRelease(resources);
    if (shipped.provenance.commit !== candidate || shipped.provenance.source_digest !== marker.source_digest) throw new Error("Finalized package provenance differs from the candidate.");
    const resourceEnv = installedRuntimeEnvironment(resources, { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: run });
    const packagedRuntime = resourceEnv.MANDIBLE_RUNTIME;
    testedPackageDigest = applicationIdentity(app);
    executionProfile = installedExecutionProfile({ checkout: root, commonDirectory: command("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]), app });
    result.provenance = { marker, daemon_sha256: sha256(releaseFile(resources, shipped.entrypoints.daemon)), native_sha256: sha256(path.join(app, "Contents/MacOS/mandible-app")), harness_sha256: sha256(fileURLToPath(import.meta.url)), package_sha256: testedPackageDigest, shipped };
    const ports = new Set();
    while (ports.size < 3) ports.add(await freePort());
    const [port, publicPort, adminPort] = [...ports];
    const origin = `https://app.mandible.localhost:${publicPort}`;
    const caHome = option('--ca-home') || process.env.MANDIBLE_TEST_CA_HOME || process.env.MANDIBLE_HOME || path.join(os.homedir(), '.mandible');
    const ca = copyAcceptanceCa(caHome, home);
    const gatewayBinary = releaseFile(resources, shipped.native.caddy);
    const gatewayConfig = path.join(run, 'Caddyfile');
    fs.writeFileSync(gatewayConfig, acceptanceGatewayConfig({ origin, backendPort: port, adminPort, storageRoot: ca.storageRoot }), { mode: 0o600 });
    result.provenance.ca_root_sha256 = sha256(ca.rootCert);
    result.provenance.gateway_sha256 = sha256(gatewayBinary);
    fs.writeFileSync(path.join(home, 'acceptance.json'), JSON.stringify({ home, origin, nonce }), { mode: 0o600 });
    const env = { ...resourceEnv, HOME: home, MANDIBLE_HOME: home, MANDIBLE_DB: path.join(home, 'mandible.db'), MANDIBLE_PORT: String(port), MANDIBLE_PUBLIC_ORIGIN: origin, MANDIBLE_INSTANCE_ROLE: 'main', MANDIBLE_INSTANCE_ID: instanceId, MANDIBLE_INSTALLATION_ID: instanceId, MANDIBLE_BACKEND_GENERATION: candidate, MANDIBLE_WORK_SCANNER_ROOTS: JSON.stringify([{ path: home, depth: 1 }]), MANDIBLE_PID_FILE: path.join(home, 'daemon.pid'), MANDIBLE_SOCKET: path.join(home, 'api.sock'), MANDIBLE_STDERR_LOG_PATH: path.join(run, 'daemon.log'), MANDIBLE_USER_PREFERENCES_DIR: path.join(home, 'settings', 'users'), MANDIBLE_CANDIDATE_ACCEPTANCE: path.join(home, 'acceptance.json') };
    daemon = launch(packagedRuntime, ['--no-install', releaseFile(resources, shipped.entrypoints.daemon)], env, 'daemon');
    // The gateway answers 502, and logs an error, for any request that reaches
    // it before its upstream is listening, so it starts only after the bind.
    await awaitReadiness(() => {
      if (interrupted || daemon.exitCode !== null || daemon.signalCode !== null) throw new Error('Owned daemon exited before acceptance completed.');
      return loopbackListening(port);
    }, () => true, { timeout: 30000, description: 'Candidate daemon port binding' });
    gateway = launch(gatewayBinary, ['run', '--config', gatewayConfig, '--adapter', 'caddyfile'], env, 'gateway');
    const probe = async (signal) => {
      if (interrupted || daemon.exitCode !== null || daemon.signalCode !== null) throw new Error('Owned daemon exited before acceptance completed.');
      if (gateway.exitCode !== null || gateway.signalCode !== null) throw new Error('Owned HTTPS gateway exited before acceptance completed.');
      const value = await acceptanceHealth(origin, ca.rootCert, signal);
      if (value.instance?.instance_id !== env.MANDIBLE_INSTANCE_ID || value.instance?.backend_generation !== candidate || value.instance?.public_origin !== origin) throw new Error('Wrong or stale instance answered acceptance health.');
      return value;
    };
    const health = await awaitAcceptanceGatewayReadiness(probe, value => value.ready === true && value.startup_commit?.hash === candidate,
      { timeout: 30000, description: 'Exact production daemon readiness',
        onInitialTlsError: error => { result.checks.initial_transport_error ??= error; } });
    result.checks.readiness = { startup_epoch: health.startup_epoch, instance_id: health.instance.instance_id, origin };
    if (!health.local_socket_path?.startsWith(`${home}${path.sep}`)) throw new Error('Fixture bootstrap socket escapes its isolated home.');
    await new Promise((resolve, reject) => {
      const body = JSON.stringify({ slug: 'candidate-operator', display_name: 'Candidate operator', email: 'candidate@example.invalid' });
      const request = http.request({ socketPath: health.local_socket_path, path: '/api/users/setup', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
        let bytes = ''; response.on('data', chunk => { bytes += chunk; });
        response.on('end', () => response.statusCode === 200 ? resolve() : reject(new Error(`Fixture bootstrap HTTP ${response.statusCode}: ${bytes}`)));
      });
      request.setTimeout(5000, () => request.destroy(new Error('Fixture bootstrap timed out')));
      request.on('error', reject); request.end(body);
    });
    desktop = launch(path.join(app, 'Contents', 'MacOS', 'mandible-app'), [], env, 'desktop');
    const evidencePath = path.join(home, 'desktop-evidence.json');
    await until(async () => {
      const current = await probe();
      if (current.startup_epoch !== health.startup_epoch) throw new Error('Daemon startup epoch changed during acceptance.');
      if (desktop.exitCode !== null || desktop.signalCode !== null) throw new Error('Packaged app exited before its interaction completed.');
      return fs.existsSync(evidencePath);
    }, 30000, 'Packaged dashboard Settings edit');
    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    if (!evidence.passed || !evidence.rendered || !evidence.edit) throw new Error(`Packaged interaction failed: ${JSON.stringify(evidence)}`);
    result.checks.desktop_interaction = evidence;
    // Observe beyond the requested interval until one completed sampler window
    // proves coverage of its end. The deadline is fixed, so a stalled or stale
    // sampler fails instead of extending its own acceptance indefinitely.
    await observeAcceptanceHealth({
      probe: async (_deadline, signal) => {
        if (desktop.exitCode !== null || desktop.signalCode !== null) throw new Error('Packaged app closed during acceptance observation.');
        return probe(signal);
      },
    });
    result.status = 'passed';
  } catch (error) { result.error = error.message; }
  finally {
    for (const child of [desktop, gateway, daemon]) {
      try { await stopOwned(child); } catch (error) { result.status = 'failed'; result.cleanup_error = error.message; }
    }
    for (const fd of files) fs.closeSync(fd);
    const logs = ['daemon', 'desktop', 'gateway'].map(name => {
      const file = path.join(run, `${name}.log`); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    }).join('\n');
    const assessment = assessAcceptanceLogs(logs);
    result.checks.log_failures = assessment.failures;
    result.checks.log_diagnostics = assessment.diagnostics;
    if (result.status !== 'passed' && fs.existsSync(path.join(run, 'build.log'))) result.checks.build_failure_excerpt = fs.readFileSync(path.join(run, 'build.log'), 'utf8').split('\n').slice(-30).join('\n').slice(-8000);
    result.checks.log_digest = createHash('sha256').update(logs).digest('hex');
    result.checks.log_bytes = Buffer.byteLength(logs);
    if (result.checks.log_failures.length) result.status = 'failed';
    result.checks.shutdown = { daemon_exit: daemon?.exitCode, daemon_signal: daemon?.signalCode, desktop_exit: desktop?.exitCode, desktop_signal: desktop?.signalCode, gateway_exit: gateway?.exitCode, gateway_signal: gateway?.signalCode };
    if ([daemon, gateway].some(child => child && (child.exitCode !== 0 || child.signalCode))) result.status = 'failed';
    if (result.status !== 'passed') result.checks.failure_logs = acceptanceFailureLogs(run);
    if (![daemon, desktop, gateway].every(child => !child || child.exitCode !== null || child.signalCode !== null)) {
      result.status = 'failed'; result.cleanup_error = 'Owned process remains alive; scratch data preserved';
    } else {
      try {
        let acceptedReference;
        if (result.status === 'passed') {
          const receipts = path.join(cache, '.receipts');
          fs.mkdirSync(receipts, { recursive: true });
          const evidence = path.join(receipts, `${ownership.runId}-acceptance.json`);
          saveOwnedMetadata(evidence, result);
          acceptedReference = await retainAcceptedRelease({ app: path.join(run, 'Mandible.app'),
            storage: path.join(process.env.MANDIBLE_HOME || path.join(os.userInfo().homedir, '.mandible'), 'accepted-releases'), ownership, candidate: candidateBinding,
            acceptance: { record_id: process.env.MANDIBLE_ACCEPTANCE_ID || null, request_id: process.env.MANDIBLE_ACCEPTANCE_REQUEST || null },
            evidence: { receipt: evidence, sha256: sha256(evidence) }, expectedDigest: testedPackageDigest });
        }
        const final = finalizeOwnedRun(metadataFile, { expectedRevision: ownership.revision, outcome: result.status === 'passed' ? 'assessed' : 'failed',
          ...(acceptedReference ? { disposition: 'transferred', destination: resolveAcceptedRelease(acceptedReference, candidateBinding).receipt.package.handle.root, transferReference: acceptedReference } : {}),
          summary: `${candidate}: ${result.status}${result.error ? ` — ${result.error}` : ''}; daemon and packaged Settings edit checked; raw-log SHA256 ${result.checks.log_digest}` });
        result.checks.cleanup = cleanupOwnedRun(metadataFile, { apply: true });
        const receipt = final.ownership.receipt;
        if (result.checks.cleanup.action !== 'delete-owned' || result.checks.cleanup.remaining?.length) result.status = 'failed';
        saveOwnedMetadata(receipt, { ...JSON.parse(fs.readFileSync(receipt, 'utf8')), acceptance: result });
        result.receipt = acceptedReference || receipt;
      } catch (error) { result.status = 'failed'; result.cleanup_error = error.message; }
    }
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.status === 'passed' ? 0 : 1;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(JSON.stringify({ status: 'unavailable', error: error.message })); process.exitCode = 1; });
