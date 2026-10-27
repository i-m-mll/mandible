#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stageAppPayload } from './stage-app-payload.mjs';
import { installedRuntimeEnvironment, verifyInstalledRelease } from './installed-release.mjs';
import { finalizeAppPayload } from './finalize-app-payload.mjs';
import { openAppSigner } from './app-signing.mjs';
import { installedExecutionProfile } from './installed-execution.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-installed-proof-')));
let stage;
if (process.argv[2]) {
  const contents = path.join(scratch, 'Mandible.app/Contents');
  fs.cpSync(path.resolve(fs.realpathSync(process.argv[2]), '..'), contents, { recursive: true });
  const signature = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', path.dirname(contents)], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(signature.status, 0, signature.stderr);
  const signer = openAppSigner({ identity: '-', hardenedRuntime: true, entitlements: null });
  try { assert.throws(() => finalizeAppPayload(path.dirname(contents), signer), /already signed/); }
  finally { signer.close(); }
  stage = { resources: path.join(contents, 'Resources') };
} else stage = await stageAppPayload(path.join(scratch, 'Mandible.app/Contents'));
const release = verifyInstalledRelease(stage.resources);
const home = path.join(scratch, 'home');
fs.mkdirSync(home);
const listener = net.createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const environment = installedRuntimeEnvironment(stage.resources, { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  TMPDIR: scratch, MANDIBLE_HOME: path.join(home, '.mandible'), MANDIBLE_PORT: String(port),
  MANDIBLE_INSTALLATION_ID: 'installed-payload-proof', MANDIBLE_BACKEND_GENERATION: release.provenance.commit,
  MANDIBLE_ALLOWED_EFFECTS: '["ledger:read"]', MANDIBLE_SOCKET: path.join(scratch, 'api.sock') });
const sourceCheckout = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8', timeout: 5000 }).stdout.trim();
const profile = installedExecutionProfile({ checkout: root, commonDirectory: sourceCheckout, app: path.resolve(stage.resources, '../..') });
const sandbox = (command, args, options = {}) => spawnSync('/usr/bin/sandbox-exec', ['-p', profile, command, ...args],
  { cwd: scratch, env: environment, encoding: 'utf8', timeout: 10_000, ...options });
const log = fs.openSync(path.join(scratch, 'daemon.log'), 'w');
const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, environment.MANDIBLE_RUNTIME, '--no-install', path.join(stage.resources, release.entrypoints.daemon)],
  { cwd: scratch, env: environment, stdio: ['ignore', log, log] });
let health;
try {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Packaged daemon exited: ${fs.readFileSync(path.join(scratch, 'daemon.log'), 'utf8')}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) });
      health = await response.json();
      if (health.ready && health.warm && health.startup_commit?.hash === release.provenance.commit) break;
    } catch { /* The listener is not ready during initial database creation. */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(health?.ready, true);
  assert.equal(health?.warm, true);
  assert.equal(health?.startup_commit?.hash, release.provenance.commit);
  const ui = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(ui.status, 200);
  assert.match(await ui.text(), /<html/);
  const setup = sandbox('/usr/bin/curl', ['--fail-with-body', '--silent', '--unix-socket', environment.MANDIBLE_SOCKET,
    '-H', 'content-type: application/json', '-d', '{"slug":"payload-proof","display_name":"Payload proof"}', 'http://localhost/api/users/setup']);
  assert.equal(setup.status, 0, setup.stdout + setup.stderr);
  const issues = sandbox('/usr/bin/curl', ['--fail-with-body', '--silent', '--unix-socket', environment.MANDIBLE_SOCKET, 'http://localhost/api/issues']);
  assert.equal(issues.status, 0, issues.stdout + issues.stderr);
  assert.ok(JSON.parse(issues.stdout));
  const cli = sandbox('/bin/zsh', [path.join(stage.resources, release.entrypoints.cli), 'db', 'query', 'select count(*) as count from ledger_issues', '--json']);
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /count/);
  const nativeSdk = sandbox(path.resolve(stage.resources, release.native.claude), ['--version']);
  assert.equal(nativeSdk.status, 0, nativeSdk.stderr);
  const channel = spawn('/usr/bin/sandbox-exec', ['-p', profile, environment.MANDIBLE_RUNTIME, '--no-install', path.join(stage.resources, release.entrypoints.channel)],
    { cwd: scratch, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const initialized = new Promise((resolve, reject) => {
      let output = '';
      const deadline = setTimeout(() => reject(new Error('Packaged channel MCP initialization timed out')), 5000);
      channel.stdout.on('data', bytes => {
        output += bytes.toString();
        if (output.includes('"name":"mandible"')) { clearTimeout(deadline); resolve(); }
      });
      channel.once('error', reject);
      channel.once('exit', code => { clearTimeout(deadline); reject(new Error(`Packaged channel exited before initialization: ${code}`)); });
    });
    channel.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'installed-proof', version: '1' } } })}\n`);
    await initialized;
  } finally { channel.kill('SIGTERM'); }
  const packageLogs = fs.readFileSync(path.join(scratch, 'daemon.log'), 'utf8');
  assert.doesNotMatch(packageLogs, /startup_commit_failed|cowork_cli_cache_materialize_failed|"fatal"|unhandled_rejection/);
  process.stdout.write(`${JSON.stringify({ passed: true, scratch, target: release.target, commit: release.provenance.commit,
    evidence: ['sandbox denies checkout, developer dependencies and ambient runtimes', 'ready and warm health with shipped provenance',
      'bundled UI response', 'ledger worker request', 'CLI SQLite query', 'native SDK execution', 'channel MCP initialization'], health }, null, 2)}\n`);
} finally {
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000))]);
  fs.closeSync(log);
}
