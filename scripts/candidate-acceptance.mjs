#!/usr/bin/env bun
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withOwnedRunLock, createOwnedRun, saveOwnedMetadata, finalizeOwnedRun, cleanupOwnedRun } from './owned-run.mjs';
import { readBuildRevision } from './build-revision.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, { cwd: root, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) throw new Error(`${binary} ${args.join(' ')} failed: ${result.error?.message || result.stderr || result.status}`);
  return result.stdout?.trim();
}

export { assessLogs } from './runtime-log-assessment.mjs';
import { assessLogs } from './runtime-log-assessment.mjs';

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
  if (command('git', ['status', '--porcelain', '--untracked-files=all'])) throw new Error('Candidate acceptance requires a clean committed checkout.');
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
  const ownership = createOwnedRun({ root: run, instanceId, project, workUnit, disposable: true, outputs: ['home', 'Mandible.app', 'build.log', 'daemon.log', 'desktop.log'].map(path => ({ path, kind: 'generated' })) });
  const metadataFile = path.join(run, 'metadata.json');
  saveOwnedMetadata(metadataFile, { ownership, candidate });
  const home = path.join(run, 'home');
  fs.mkdirSync(home);
  const result = { schema: 'mandible-candidate-acceptance@1', scope: 'isolated production daemon and packaged dashboard; live installation and protected delivery excluded', status: 'failed', candidate, runtime, run, checks: {}, provenance: {} };
  let daemon, desktop;
  const files = [];
  const launch = (binary, args, env, name) => {
    const fd = fs.openSync(path.join(run, `${name}.log`), 'w'); files.push(fd);
    const child = spawn(binary, args, { cwd: root, env, stdio: ['ignore', fd, fd] });
    child.on('error', error => { result.checks[`${name}_launch_error`] = error.message; });
    return child;
  };
  let interrupted = false;
  const interrupt = () => { interrupted = true; daemon?.kill('SIGTERM'); desktop?.kill('SIGTERM'); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    const buildLog = fs.openSync(path.join(run, 'build.log'), 'w'); files.push(buildLog);
    command(runtime, ['run', 'build'], { env: buildEnv, stdio: ['ignore', buildLog, buildLog], timeout: 180000 });
    if (readBuildRevision(root) !== candidate) throw new Error('Built daemon revision does not match the exact candidate.');
    command(runtime, ['run', 'tauri:build', '--', '--bundles', 'app'], { env: buildEnv, stdio: ['ignore', buildLog, buildLog], timeout: 600000 });
    const builtApp = path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'macos', 'Mandible.app');
    command('/usr/bin/codesign', ['--verify', '--deep', '--strict', builtApp]);
    const app = path.join(run, 'Mandible.app'); fs.cpSync(builtApp, app, { recursive: true });
    const resources = path.join(app, 'Contents', 'Resources');
    const bundledMarker = JSON.parse(fs.readFileSync(path.join(resources, 'build-revision.json'), 'utf8'));
    const marker = JSON.parse(fs.readFileSync(path.join(root, 'dist', 'build-revision.json'), 'utf8'));
    if (JSON.stringify(bundledMarker) !== JSON.stringify(marker)) throw new Error('Native package carries a different candidate marker.');
    if (sha256(path.join(resources, '.bun-version')) !== sha256(path.join(root, '.bun-version')) || sha256(path.join(resources, 'scripts', 'bun-runtime.sh')) !== sha256(path.join(root, 'scripts', 'bun-runtime.sh'))) throw new Error('Native package has stale runtime selection resources');
    if (sha256(path.join(resources, 'scripts/bun-runtime-lock.tsv')) !== sha256(path.join(root, 'scripts/bun-runtime-lock.tsv'))) throw new Error('Native package has stale runtime byte/revision pins');
    const packagedRuntime = command('/bin/sh', [path.join(resources, 'scripts/bun-runtime.sh')], { env: { HOME: home, XDG_CACHE_HOME: path.join(home, 'runtime-cache'), PATH: '/usr/bin:/bin:/usr/sbin:/sbin', MANDIBLE_RUNTIME_ARCHIVE: path.join(resources, 'runtime/bun.zip') } });
    for (const name of ['local-runtime.mjs', 'canonical-origin.mjs', 'build-revision.mjs', 'pinned-caddy.mjs', 'local-ca-trust.mjs']) {
      if (sha256(path.join(resources, name)) !== sha256(path.join(root, 'scripts', name))) throw new Error(`Native package has stale ${name}`);
    }
    result.provenance = { marker, daemon_sha256: sha256(path.join(root, 'dist', 'index.js')), native_sha256: sha256(path.join(app, 'Contents', 'MacOS', 'mandible-app')), harness_sha256: sha256(fileURLToPath(import.meta.url)), packaged_runtime_sha256: sha256(packagedRuntime), packaged_runtime_revision: command(packagedRuntime, ['--no-install', '--print', 'Bun.revision']), packaged_archive_sha256: sha256(path.join(resources, 'runtime/bun.zip')) };
    const port = await freePort(); const origin = `http://127.0.0.1:${port}`;
    fs.writeFileSync(path.join(home, 'acceptance.json'), JSON.stringify({ home, origin, nonce }), { mode: 0o600 });
    const env = { ...Object.fromEntries(Object.entries(buildEnv).filter(([key]) => !key.startsWith('MANDIBLE_'))), HOME: home, MANDIBLE_HOME: home, MANDIBLE_DB: path.join(home, 'mandible.db'), MANDIBLE_PORT: String(port), MANDIBLE_PUBLIC_ORIGIN: origin, MANDIBLE_INSTANCE_ROLE: 'main', MANDIBLE_INSTANCE_ID: instanceId, MANDIBLE_INSTALLATION_ID: instanceId, MANDIBLE_BACKEND_GENERATION: candidate, MANDIBLE_WORK_SCANNER_ROOTS: JSON.stringify([{ path: home, depth: 1 }]), MANDIBLE_PID_FILE: path.join(home, 'daemon.pid'), MANDIBLE_SOCKET: path.join(home, 'api.sock'), MANDIBLE_STDERR_LOG_PATH: path.join(run, 'daemon.log'), MANDIBLE_USER_PREFERENCES_DIR: path.join(home, 'settings', 'users'), MANDIBLE_CANDIDATE_ACCEPTANCE: path.join(home, 'acceptance.json') };
    daemon = launch(runtime, [path.join(root, 'dist', 'index.js')], env, 'daemon');
    let health;
    const probe = async () => {
      if (interrupted || daemon.exitCode !== null || daemon.signalCode !== null) throw new Error('Owned daemon exited before acceptance completed.');
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) throw new Error(`Health HTTP ${response.status}`);
      const value = await response.json();
      if (value.instance?.instance_id !== env.MANDIBLE_INSTANCE_ID || value.instance?.backend_generation !== candidate || value.instance?.public_origin !== origin) throw new Error('Wrong or stale instance answered acceptance health.');
      return value;
    };
    await until(async () => {
      try { health = await probe(); } catch (error) { if (error.cause?.code === 'ECONNREFUSED' || ['ECONNREFUSED', 'ConnectionRefused'].includes(error.code)) return false; throw error; }
      return health.ready === true && health.startup_commit?.hash === candidate;
    }, 30000, 'Exact production daemon readiness');
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
    // Observe a full diagnostics interval while the real dashboard stays open.
    const observationEnd = Date.now() + 31000;
    while (Date.now() < observationEnd) {
      const current = await probe();
      if (current.startup_epoch !== health.startup_epoch || current.eventLoop?.warning || desktop.exitCode !== null || desktop.signalCode !== null) throw new Error('Runtime restarted, stalled, or closed during observation.');
      await delay(500);
    }
    result.status = 'passed';
  } catch (error) { result.error = error.message; }
  finally {
    for (const child of [desktop, daemon]) {
      try { await stopOwned(child); } catch (error) { result.status = 'failed'; result.cleanup_error = error.message; }
    }
    for (const fd of files) fs.closeSync(fd);
    const logs = ['daemon', 'desktop'].map(name => {
      const file = path.join(run, `${name}.log`); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    }).join('\n');
    result.checks.log_failures = assessLogs(logs);
    if (result.status !== 'passed' && fs.existsSync(path.join(run, 'build.log'))) result.checks.build_failure_excerpt = fs.readFileSync(path.join(run, 'build.log'), 'utf8').split('\n').slice(-30).join('\n').slice(-8000);
    result.checks.log_digest = createHash('sha256').update(logs).digest('hex');
    result.checks.log_bytes = Buffer.byteLength(logs);
    if (result.checks.log_failures.length) result.status = 'failed';
    result.checks.shutdown = { daemon_exit: daemon?.exitCode, daemon_signal: daemon?.signalCode, desktop_exit: desktop?.exitCode, desktop_signal: desktop?.signalCode };
    if (daemon && (daemon.exitCode !== 0 || daemon.signalCode)) result.status = 'failed';
    if (![daemon, desktop].every(child => !child || child.exitCode !== null || child.signalCode !== null)) {
      result.status = 'failed'; result.cleanup_error = 'Owned process remains alive; scratch data preserved';
    } else {
      try {
        const final = finalizeOwnedRun(metadataFile, { expectedRevision: ownership.revision, outcome: result.status === 'passed' ? 'assessed' : 'failed', summary: `${candidate}: ${result.status}${result.error ? ` — ${result.error}` : ''}; daemon and packaged Settings edit checked; raw-log SHA256 ${result.checks.log_digest}` });
        result.checks.cleanup = cleanupOwnedRun(metadataFile, { apply: true });
        const receipt = final.ownership.receipt;
        if (result.checks.cleanup.action !== 'delete-owned' || result.checks.cleanup.remaining?.length) result.status = 'failed';
        saveOwnedMetadata(receipt, { ...JSON.parse(fs.readFileSync(receipt, 'utf8')), acceptance: result });
        result.receipt = receipt;
      } catch (error) { result.status = 'failed'; result.cleanup_error = error.message; }
    }
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.status === 'passed' ? 0 : 1;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(JSON.stringify({ status: 'unavailable', error: error.message })); process.exitCode = 1; });
