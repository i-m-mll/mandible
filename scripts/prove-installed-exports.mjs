#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installedRuntimeEnvironment, verifyInstalledRelease } from './installed-release.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const accountHome = os.homedir();
const sourceRoot = path.dirname(execFileSync('/usr/bin/git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8', timeout: 5000 }).trim());
const resources = fs.realpathSync(process.argv[2]);
const release = verifyInstalledRelease(resources);
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-export-proof-')));
const home = path.join(scratch, 'home'); fs.mkdirSync(home);
const env = installedRuntimeEnvironment(resources, { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: scratch,
  MANDIBLE_HOME: path.join(home, '.mandible'), MANDIBLE_DB: path.join(scratch, 'fixture.db'), MANDIBLE_BASE: '',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', MANDIBLE_NO_KEYCHAIN_TOKEN: '1',
  MANDIBLE_SOCKET: path.join(scratch, 'private/api.sock') });
Object.assign(process.env, env);
const load = name => import(pathToFileURL(path.join(resources, 'dist', `${name}.js`)).href);
const { openDb, setDb } = await load('db');
const { Router, createServer, createLocalSocketServer } = await load('server');
const { ClientAuthenticator } = await load('client-auth/authenticator');
const { SseManager } = await load('sse');
const { setupOperator, createUser, addBinding } = await load('users/store');
const { SessionRegistry } = await load('registry');
const { registerSessionRoutes } = await load('routes/sessions');
const { registerSettingsRoutes } = await load('routes/settings');
const { startLocalApiSocket } = await load('local-api-socket');
const { PRODUCTION_EFFECTS } = await load('security/effect-policy');
const { PRODUCTION_ORIGIN } = await load('canonical-origin');
const instance = { role: 'main', instance_id: 'production', installation_id: 'export-proof', public_origin: PRODUCTION_ORIGIN,
  backend_generation: 'export-proof', allowed_effects: PRODUCTION_EFFECTS, writable_roots: [scratch], preview_root: null,
  user_preferences_root: home, db_path: env.MANDIBLE_DB, db_path_source: 'test', source_db_path: null, source_db_path_source: null };
const db = openDb(env.MANDIBLE_DB); setDb(db);
setupOperator(db, { display_name: 'Fixture', email: 'fixture@example.invalid' });
const claude = createUser(db, { slug: 'export-proof-claude', kind: 'agent', display_name: 'Fixture Claude' });
addBinding(db, claude.id, { binding_type: 'provider_session_env', value: 'CLAUDE_CODE_SESSION_ID' });
const auth = new ClientAuthenticator(db, { instance, secretsDir: path.join(scratch, 'auth'), sessionAuthorityDir: path.join(scratch, 'sessions') });
const router = new Router({ clientAuth: auth, instance });
const registry = new SessionRegistry(db, () => undefined);
registerSessionRoutes(router, registry);
registerSettingsRoutes(router);
router.get('/api/inbox/global', (_req, res) => res.json({ auth_results: [{ tier: 1 }, { tier: 2 }], continuations: [], work_units: [] }),
  { fileRpc: 'allow', operation: { id: 'fixture.inbox', effects: ['ledger:read'], reportingCategory: null, requestSchema: null } });
const serverOptions = { db, sse: new SseManager(), logger: () => undefined, version: 'test', router,
  getStartupInfo: () => null, instance, clientAuth: auth };
createServer(serverOptions);
const socketServer = createLocalSocketServer(serverOptions);
const closeSocket = await startLocalApiSocket(socketServer, env.MANDIBLE_SOCKET);
const denied = [sourceRoot, path.join(accountHome, '.dotfiles'), path.join(accountHome, '.local/share/mandible/runtimes'), path.join(accountHome, '.bun'), '/opt/homebrew', '/usr/local'];
const profile = `(version 1)(allow default)\n${denied.filter(p => fs.existsSync(p)).map(p => `(deny file-read* (subpath ${JSON.stringify(fs.realpathSync(p))}))`).join('\n')}\n(deny file-write* (subpath ${JSON.stringify(resources)}))\n(deny network-outbound (remote ip "*:80") (remote ip "*:443"))`;
const cli = path.join(resources, release.entrypoints.cli);
async function run(args, input = '', extra = {}, command = cli) {
  const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, command, ...args], { cwd: scratch, env: { ...env, ...extra }, detached: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
  child.stdin.on('error', error => { if (error.code !== 'EPIPE') throw error; });
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }, 10_000);
  child.stdin.end(input);
  return new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}
const success = result => { assert.equal(result.status, 0, result.stderr); return result.stdout; };
try {
  registry.registerSession({ id: 'stale-parent', app: 'claude', pid: 999999999, conversation_id: 'parent-native' });
  const scoped = await run(['-c', 'export EXPECTED_PID=$$; exec "$@"', 'fixture', cli, 'identity', 'exec', '--', '/bin/sh', '-c',
    'printf "%s|%s|%s|%s|%s\\n" "$EXPECTED_PID" "$$" "${MANDIBLE_SESSION_ID:-}" "$CLAUDE_CODE_SESSION_ID" "$1"; cat; printf stderr-proof >&2; exit 37', 'target', 'argument with spaces'],
    'stdin-proof', { MANDIBLE_SESSION_ID: 'stale-parent', CLAUDE_CODE_SESSION_ID: 'child-native', CLAUDE_PID: '999999998' }, '/bin/sh');
  assert.equal(scoped.status, 37); assert.equal(scoped.stderr, 'stderr-proof');
  const [expectedPid, actualPid, managed, provider, argument] = scoped.stdout.split('\n')[0].split('|');
  assert.equal(expectedPid, actualPid); assert.equal(managed, ''); assert.equal(provider, 'child-native');
  assert.equal(argument, 'argument with spaces'); assert.equal(scoped.stdout.split('\n')[1], 'stdin-proof');
  db.prepare('INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('claude_notifications_enabled', 'false', Date.now());
  assert.equal(JSON.parse(success(await run(['settings', 'read'], '', { CLAUDE_CODE_SESSION_ID: 'child-native' }))).claude_notifications_enabled, 'false');

  const envFile = path.join(scratch, 'claude-env.sh');
  const session = 'lifecycle-native';
  const hookEnv = { MANDIBLE_SESSION_ID: 'stale-parent', CLAUDE_CODE_SESSION_ID: 'parent-native', CODEX_THREAD_ID: 'inherited-codex',
    CLAUDE_PID: String(process.pid), CLAUDE_ENV_FILE: envFile, TERM_PROGRAM: 'WezTerm', WEZTERM_PANE_ID: 'pane-7', ZELLIJ: 'fixture-session' };
  const payload = { session_id: session, cwd: scratch, branch: 'feature/proof', worktree: scratch,
    nav_session: 'terminal-session', nav_tab: 'terminal-tab', nav_pane_id: 'pane-7' };
  assert.match(success(await run(['hook', 'session-start'], JSON.stringify(payload), hookEnv)), /Mandible inbox: 1 item\(s\).*1 auth result/);
  assert.deepEqual(db.prepare('SELECT id,pid,conversation_id,status,terminal,nav_session,nav_tab,nav_pane_id FROM sessions WHERE id=?').get(session),
    { id: session, pid: process.pid, conversation_id: session, status: 'active', terminal: 'wezterm', nav_session: 'terminal-session', nav_tab: 'terminal-tab', nav_pane_id: 'pane-7' });
  const projection = success(await run(['-c', '. "$1"; printf "%s|%s|%s" "${MANDIBLE_SESSION_ID:-}" "$CLAUDE_CODE_SESSION_ID" "${CODEX_THREAD_ID:-}"', 'fixture', envFile], '', hookEnv, '/bin/bash'));
  assert.equal(projection, `|${session}|`);
  const childPayload = { ...payload, agent_id: 'child-proof', agent_type: 'worker', description: 'Child proof' };
  const tools = path.join(scratch, 'user-tools'); fs.mkdirSync(tools);
  const paneCapture = path.join(scratch, 'pane.json');
  fs.writeFileSync(path.join(tools, 'agent-viewer'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(tools, 'zj-query'), '#!/bin/sh\nprintf \'%s\' "$2" > "$PANE_CAPTURE_PATH"\n', { mode: 0o755 });
  db.prepare('INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('subagent_panes_enabled', 'true', Date.now());
  success(await run(['hook', 'subagent-start'], JSON.stringify(childPayload), { ...hookEnv, PATH: `${tools}:${env.PATH}`, PANE_CAPTURE_PATH: paneCapture }));
  const pane = JSON.parse(fs.readFileSync(paneCapture, 'utf8'));
  assert.equal(pane.cmd, path.join(tools, 'agent-viewer'));
  assert.deepEqual(pane.args.slice(-2), ['--mode', 'transcript']);
  assert.equal(pane.close_on_exit, true);
  assert.equal(db.prepare('SELECT parent_id,status FROM sessions WHERE id=?').get('child-proof').parent_id, session);
  success(await run(['hook', 'subagent-stop'], JSON.stringify(childPayload), hookEnv));
  assert.equal(db.prepare('SELECT status FROM sessions WHERE id=?').get('child-proof').status, 'ended');
  success(await run(['hook', 'session-end'], JSON.stringify(payload), hookEnv));
  assert.equal(db.prepare('SELECT status FROM sessions WHERE id=?').get(session).status, 'ended');
  assert.deepEqual(db.prepare('SELECT pid,conversation_id FROM sessions WHERE id=?').get('stale-parent'), { pid: 999999999, conversation_id: 'parent-native' });
  assert.notEqual(db.prepare('SELECT status FROM sessions WHERE id=?').get('stale-parent').status, 'ended');
  process.stdout.write(`${JSON.stringify({ passed: true, commit: release.provenance.commit, source_digest: release.provenance.source_digest,
    evidence: ['identity exec retains PID, argument boundaries, stdin/stdout/stderr and exit status while removing stale managed identity',
      'settings read over authenticated private socket', 'lifecycle native ID environment projection, process attachment, navigation and filtered inbox',
      'subagent registration/end and session end preserve parent ownership', 'checkout, developer stores and ambient developer tools denied'], scratch }, null, 2)}\n`);
} finally { await closeSocket(); db.close(); }
