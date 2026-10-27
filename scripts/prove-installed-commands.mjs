#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installedRuntimeEnvironment, verifyInstalledRelease } from './installed-release.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resources = fs.realpathSync(process.argv[2]);
const release = verifyInstalledRelease(resources);
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-command-proof-')));
const home = path.join(scratch, 'home');
fs.mkdirSync(path.join(home, ".mandible"), { recursive: true });
const denied = [root, path.join(os.homedir(), '.dotfiles'), path.join(os.homedir(), '.local/share/mandible/runtimes'), path.join(os.homedir(), '.bun'), '/opt/homebrew', '/usr/local'];
const profile = `(version 1)(allow default)\n${denied.filter(p => fs.existsSync(p)).map(p => `(deny file-read* (subpath ${JSON.stringify(fs.realpathSync(p))}))`).join('\n')}\n(deny network-outbound (remote ip "*:80") (remote ip "*:443"))`;
const requests = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    requests.push({ path: req.url, headers: req.headers, body: JSON.parse(body || '{}') });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const environment = installedRuntimeEnvironment(resources, { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: scratch,
  MANDIBLE_HOME: path.join(home, '.mandible'), MANDIBLE_DB: path.join(home, '.mandible/proof.db'),
  MANDIBLE_BASE: `http://127.0.0.1:${server.address().port}`, MANDIBLE_RUNTIME_STORE: '/unavailable/developer-store',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
const cli = path.join(resources, release.entrypoints.cli);
async function run(command, args, input = '', env = environment, cwd = scratch, until = null) {
  const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, command, ...args], { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; if (until && until.test(stdout)) child.kill('SIGTERM'); });
  child.stderr.on('data', chunk => stderr += chunk);
  const deadline = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }, 10_000);
  child.stdin.on('error', error => { if (error.code !== 'EPIPE') throw error; });
  child.stdin.end(input);
  return await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => { clearTimeout(deadline); resolve({ status, signal, stdout, stderr }); });
  });
}
const successful = result => { assert.equal(result.status, 0, result.stderr); return result.stdout; };
try {
  assert.match(successful(await run(cli, ['help', 'issue', 'report'])), /issue report/);
  assert.equal((await run(cli, ['issue', 'report'])).status, 2);
  const source = path.join(home, '.claude/projects/proof/session.jsonl');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  const record = { type: 'user', sessionId: 'proof-session', cwd: scratch, message: { role: 'user', content: 'installed command proof' } };
  fs.writeFileSync(source, `${JSON.stringify(record)}\n`);
  const inspected = JSON.parse(successful(await run(cli, ['logs', 'inspect', source, '--json'])));
  assert.deepEqual(inspected.records, [record]);
  const inventory = JSON.parse(successful(await run(cli, ['logs', 'inventory', '--provider', 'claude', '--json'])));
  assert.equal(inventory[0].session_id, 'proof-session');
  const parsed = JSON.parse(successful(await run(cli, ['logs', 'inspect', source, '--parse', '--json'])));
  assert.match(JSON.stringify(parsed), /installed command proof/);
  const target = path.join(home, 'instructions.md');
  successful(await run(cli, ['instructions', 'install', '--target', target]));
  assert.match(fs.readFileSync(target, 'utf8'), /mandible issue report/);
  const bootstrap = `import Database from ${JSON.stringify(path.join(resources, 'dist/sqlite.js'))};const db=new Database(process.env.MANDIBLE_DB);db.exec(${JSON.stringify("create table proof (value text); insert into proof values ('installed')")});db.close();`;
  successful(await run(environment.MANDIBLE_RUNTIME, ['--no-install', '-e', bootstrap]));
  assert.deepEqual(JSON.parse(successful(await run(cli, ['db', 'query', 'select value from proof', '--json']))).rows, [['installed']]);

  const settingsFile = path.join(scratch, 'generated-settings.json');
  const generate = `import {mergeMandibleClaudeHookSettings} from ${JSON.stringify(path.join(resources, 'dist/claude-hook-settings.js'))};await Bun.write(${JSON.stringify(settingsFile)},JSON.stringify(mergeMandibleClaudeHookSettings({statusLine:{type:'command',command:'cat >/dev/null; printf chained-proof'}},'console-alias')));`;
  successful(await run(environment.MANDIBLE_RUNTIME, ['--no-install', '-e', generate]));
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const provider = '12345678-1234-4234-8234-123456789abc';
  const payload = { session_id: provider, model: { display_name: 'Proof' } };
  assert.equal(successful(await run('/bin/sh', ['-c', settings.statusLine.command], JSON.stringify(payload))), 'chained-proof');
  assert.equal(requests[0].headers['x-mandible-ambient-provider-session-id'], provider);
  assert.deepEqual(requests[0].body, payload);
  assert.match(requests[0].path, /sessionRef=console-alias/);
  successful(await run(cli, ['hook', 'session-execution', 'claude'], JSON.stringify({ session_id: provider, hook_event_name: 'Stop' })));
  // Resolve the same outbox role as the hook rather than assuming its filesystem spelling.
  const outboxFiles = successful(await run(environment.MANDIBLE_RUNTIME, ['--no-install', '-e', `import {executionOutboxDir,listExecutionOutbox} from ${JSON.stringify(path.join(resources, 'dist/session-execution-outbox.js'))};import {localApiSocketPath} from ${JSON.stringify(path.join(resources, 'dist/local-api-socket.js'))};const dir=executionOutboxDir(localApiSocketPath({role:'main',instance_id:''}));console.log(JSON.stringify(listExecutionOutbox(dir).entries.map(name=>JSON.parse(require("node:fs").readFileSync(require("node:path").join(dir,name),"utf8")))));`]));
  assert.match(outboxFiles, new RegExp(provider));
  const channel = successful(await run(cli, ['channel'], `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'command-proof', version: '1' } } })}\n`, environment, scratch, /"name":"mandible"/));
  assert.match(channel, /"name":"mandible"/);

  const repo = path.join(scratch, 'repo');
  fs.mkdirSync(repo);
  const git = args => { const result = spawnSync('/usr/bin/git', args, { cwd: repo, env: environment, encoding: 'utf8', timeout: 5000 }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  git(['init', '-q', '-b', 'scratch']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'fixture']);
  const tip = git(['rev-parse', 'HEAD']);
  const guardDir = path.join(home, '.mandible/git-guard'); fs.mkdirSync(guardDir, { recursive: true });
  fs.writeFileSync(path.join(guardDir, 'protected-refs'), `# fixture\nnames\trefs/heads/main\n${fs.realpathSync(path.join(repo, '.git'))}\trefs/heads/main\n`);
  fs.writeFileSync(path.join(guardDir, 'allowed_signers'), '# no operator signature for fixture\n');
  fs.writeFileSync(path.join(repo, '.git/hooks/reference-transaction'), `#!/bin/sh\nexec '${cli.replaceAll("'", "'\\''")}' git-guard "$@"\n`, { mode: 0o755 });
  const refused = await run('/usr/bin/git', ['update-ref', 'refs/heads/main', tip], '', environment, repo);
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /refusing.*protected branch/);
  const guard = path.join(resources, 'hooks/git/reference-transaction');
  fs.renameSync(guard, `${guard}.absent`);
  try { assert.notEqual((await run('/usr/bin/git', ['update-ref', 'refs/heads/main', tip], '', environment, repo)).status, 0); }
  finally { fs.renameSync(`${guard}.absent`, guard); }

  const manifest = path.join(resources, 'release.json');
  fs.renameSync(manifest, `${manifest}.absent`);
  try {
    const unselected = { ...environment }; delete unselected.MANDIBLE_RELEASE_ROOT;
    assert.notEqual((await run(cli, ['hook', 'ingest-nudge'], '{}', unselected)).status, 0);
  } finally { fs.renameSync(`${manifest}.absent`, manifest); }

  const cache = path.join(scratch, 'projected-cli');
  successful(await run(environment.MANDIBLE_RUNTIME, ['--no-install', '-e', `import {materializeCoworkCliCache} from ${JSON.stringify(path.join(resources, 'dist/cowork-cli-cache.js'))};materializeCoworkCliCache({sourceRoot:process.env.MANDIBLE_RELEASE_ROOT,targetDir:${JSON.stringify(cache)}});`]));
  const projected = await run('/bin/bash', [path.join(cache, 'issue.sh'), 'report'], '', { ...environment, MANDIBLE_CLI_DIR: cache });
  assert.equal(projected.status, 2, projected.stderr); assert.match(projected.stderr, /Arguments do not match/);
  assert.doesNotMatch(projected.stderr, /download|Cannot find|unavailable|denied/i);
  process.stdout.write(`${JSON.stringify({ passed: true, commit: release.provenance.commit, source_digest: release.provenance.source_digest, resources, scratch, evidence: ['public CLI grammar and prebuilt SQLite query', 'native log inspection and parsed blocks', 'instruction rendering', 'generated hook stdin/stdout and provider identity', 'execution outbox hook', 'public channel MCP initialization', 'Git rejects unsigned update and unavailable guard', 'projected client grammar from packaged offline archive'] }, null, 2)}\n`);
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
