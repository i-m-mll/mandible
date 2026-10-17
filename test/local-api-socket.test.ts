// @vitest-environment node
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, setDb, type Db } from '../src/db.js';
import { ClientAuthenticator } from '../src/client-auth/authenticator.js';
import { createLocalSocketServer, createServer, Router } from '../src/server.js';
import { localApiSocketPath, startLocalApiSocket } from '../src/local-api-socket.js';
import { SseManager } from '../src/sse.js';
import { PRODUCTION_EFFECTS, STANDARD_PREVIEW_EFFECTS } from '../src/security/effect-policy.js';
import { addBinding, createUser, OPERATOR_SETTING_KEY, setupOperator } from '../src/users/store.js';
import { PRODUCTION_ORIGIN } from '../src/canonical-origin.js';
import { registerUserRoutes } from '../src/routes/users.js';
import { registerSessionRoutes } from '../src/routes/sessions.js';
import { SessionRegistry } from '../src/registry.js';
import type { InstanceInfo } from '../src/types.js';

let root: string; let db: Db; let auth: ClientAuthenticator; let router: Router;
let socketServer: http.Server; let tcpServer: http.Server; let closeSocket: () => Promise<void>;
let socketPath: string; let port: number;
function instance(): InstanceInfo {
  return { role: 'main', instance_id: 'production', installation_id: 'install-test',
    public_origin: PRODUCTION_ORIGIN, backend_generation: 'main-1',
    allowed_effects: PRODUCTION_EFFECTS, writable_roots: [root], preview_root: null,
    user_preferences_root: path.join(root, 'prefs'), db_path: path.join(root, 'db'),
    db_path_source: 'test', source_db_path: null, source_db_path_source: null };
}
function request(method: string, route: string, headers: Record<string, string> = {}, local = true, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(local ? { socketPath, path: route, method, headers } :
      { hostname: '127.0.0.1', port, path: route, method, headers }, (res) => {
      let raw = ''; res.on('data', chunk => raw += chunk);
      res.on('end', () => resolve({ status: res.statusCode ?? 500, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-socket-'));
  db = openDb(path.join(root, 'db')); setDb(db);
  setupOperator(db, { display_name: 'Operator', email: 'operator@example.invalid' });
  auth = new ClientAuthenticator(db, { instance: instance(), secretsDir: path.join(root, 'auth'), sessionAuthorityDir: path.join(root, 'sessions') });
  router = new Router({ clientAuth: auth, instance: instance() });
  registerUserRoutes(router);
  router.get('/api/read', (req, res) => res.json({ identity: req.client_identity, ambient: req.ambient_identity,
    localManaged: req.local_managed_identity, managed: req.managed_client }), { fileRpc: 'allow', operation: { id: 'socket.read', effects: ['ledger:read'], reportingCategory: null, requestSchema: null } });
  router.post('/api/write', (req, res) => res.json({ identity: req.client_identity }), { fileRpc: 'allow', operation: { id: 'socket.write', effects: ['ledger:write'], reportingCategory: 'ledger', requestSchema: null } });
  const serverOptions: Parameters<typeof createServer>[0] = { db, sse: new SseManager(), logger: () => undefined, version: 'test', router,
    getStartupInfo: () => null, instance: instance(), clientAuth: auth };
  tcpServer = createServer(serverOptions);
  port = await new Promise<number>(resolve => tcpServer.listen(0, '127.0.0.1', () => resolve((tcpServer.address() as { port: number }).port)));
  socketPath = path.join(root, 'private', 'api.sock');
  socketServer = createLocalSocketServer(serverOptions);
  closeSocket = await startLocalApiSocket(socketServer, socketPath);
});
afterEach(async () => {
  await closeSocket();
  await new Promise<void>(resolve => tcpServer.close(() => resolve()));
  db.close(); fs.rmSync(root, { recursive: true, force: true });
});

describe('owner-only local API socket', () => {
  it('registers a managed wrapper session before a provider ID exists and retains its agent on later calls', async () => {
    const agent = createUser(db, { slug: 'wrapper-agent', kind: 'agent', display_name: 'Wrapper Agent' });
    addBinding(db, agent.id, { binding_type: 'app_name', value: 'codex' });
    addBinding(db, agent.id, { binding_type: 'app_name', value: 'claude' });
    registerSessionRoutes(router, new SessionRegistry(db, () => undefined));
    const headers = { 'X-Mandible-Managed-Client': '1', 'X-Mandible-Managed-App': 'codex', 'X-Mandible-Managed-Session-Id': 'wrapper-session-1' };
    const registered = await request('POST', '/api/sessions/register', headers, true, { id: 'wrapper-session-1', app: 'codex' });
    expect(registered).toMatchObject({ status: 200, body: { id: 'wrapper-session-1', app: 'codex' } });
    const later = await request('GET', '/api/read', headers);
    expect(later).toMatchObject({ status: 200, body: { identity: { user_id: agent.id, method: 'local_socket' },
      localManaged: { app_name: 'codex', session_id: 'wrapper-session-1' } } });
    expect((await request('GET', '/api/read', { ...headers, 'X-Mandible-Managed-App': 'claude' })).status).toBe(401);
  });
  it('keeps a wrapper-launched Claude session and its claim intact when the channel server re-registers it', async () => {
    // Issue f52d4dd: the channel server relabeled the session `claude-channel`
    // and nulled the wrapper's pid and terminal, so every later `claude` claim
    // from the session was refused.
    const agent = createUser(db, { slug: 'claude-code', kind: 'agent', display_name: 'Claude Code' });
    addBinding(db, agent.id, { binding_type: 'app_name', value: 'claude' });
    registerSessionRoutes(router, new SessionRegistry(db, () => undefined));
    const id = 'wrapped-claude-1';
    const headers = { 'X-Mandible-Managed-Client': '1', 'X-Mandible-Managed-App': 'claude', 'X-Mandible-Managed-Session-Id': id };
    expect((await request('POST', '/api/sessions/register', headers, true,
      { id, app: 'claude', pid: process.pid, terminal: 'iterm' })).status).toBe(200);

    for (const [key, value] of Object.entries({ MANDIBLE_SOCKET: socketPath, MANDIBLE_BASE: '', MANDIBLE_MANAGED_CLIENT: '1',
      MANDIBLE_MANAGED_APP: 'claude', MANDIBLE_SESSION_ID: id, CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '' })) {
      vi.stubEnv(key, value);
    }
    try {
      const channel = await import('../channel-server/client.js');
      await channel.registerSession({ id, status: 'active', cwd: root, branch: null });
    } finally {
      vi.unstubAllEnvs();
    }

    expect(db.prepare('SELECT app, pid, terminal FROM sessions WHERE id = ?').get(id))
      .toEqual({ app: 'claude', pid: process.pid, terminal: 'iterm' });
    expect(await request('GET', '/api/read', headers)).toMatchObject({ status: 200,
      body: { identity: { user_id: agent.id, method: 'local_socket' } } });
  });
  it('authenticates a Claude lifecycle hook as the Claude agent without clearing the stored pid', async () => {
    const agent = createUser(db, { slug: 'claude-hooks', kind: 'agent', display_name: 'Claude Hooks' });
    addBinding(db, agent.id, { binding_type: 'provider_session_env', value: 'CLAUDE_CODE_SESSION_ID' });
    const seen: Array<{ identity: unknown; body: Record<string, unknown> }> = [];
    const operation = (id: string, effects: string[]) => ({ fileRpc: 'allow' as const,
      operation: { id, effects, reportingCategory: null, requestSchema: null } });
    router.post('/api/sessions/register', (req, res) => { seen.push({ identity: req.client_identity, body: req.body as Record<string, unknown> }); res.json({}); },
      operation('hook.register', ['process:external']));
    router.get('/api/inbox/global', (_req, res) => res.json({}), operation('hook.inbox', ['ledger:read']));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(MANDIBLE_|CLAUDE|CODEX_)/.test(key)));
    const hook = spawn('bash', [path.resolve('hooks/session-start.sh')], { env: { ...env, MANDIBLE_SOCKET: socketPath } });
    let stderr = ''; hook.stderr.on('data', (chunk) => { stderr += chunk; });
    hook.stdin.end(JSON.stringify({ session_id: 'claude-session-1', cwd: root }));
    expect(await new Promise((resolve) => hook.once('close', resolve)), stderr).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0].identity).toMatchObject({ user_id: agent.id, method: 'local_socket' });
    expect(seen[0].body).toMatchObject({ id: 'claude-session-1', conversation_id: 'claude-session-1', app: 'claude' });
    expect(Object.keys(seen[0].body)).not.toContain('pid');
  });
  it('rejects unknown, malformed, human-bound, and conflicting managed app claims', async () => {
    const codex = createUser(db, { slug: 'codex-agent', kind: 'agent', display_name: 'Codex Agent' });
    const claude = createUser(db, { slug: 'claude-agent', kind: 'agent', display_name: 'Claude Agent' });
    addBinding(db, codex.id, { binding_type: 'provider_session_env', value: 'CODEX_THREAD_ID' });
    addBinding(db, claude.id, { binding_type: 'app_name', value: 'claude' });
    const base = { 'X-Mandible-Managed-Client': '1', 'X-Mandible-Managed-App': 'claude', 'X-Mandible-Managed-Session-Id': 'managed-1' };
    expect((await request('GET', '/api/read', base)).body.identity.user_id).toBe(claude.id);
    expect((await request('GET', '/api/read', { ...base, 'X-Mandible-Managed-App': 'unknown' })).status).toBe(401);
    expect((await request('GET', '/api/read', { 'X-Mandible-Managed-App': 'claude' })).status).toBe(401);
    expect((await request('GET', '/api/read', { ...base, 'X-Mandible-Managed-Session-Id': 'x'.repeat(257) })).status).toBe(401);
    expect((await request('GET', '/api/read', { ...base, 'X-Mandible-Ambient-Provider': 'codex',
      'X-Mandible-Ambient-Provider-Session-Id': 'provider-1' })).status).toBe(401);
    const token = auth.mintApiToken(codex.id);
    expect((await request('GET', '/api/read', { ...base, Authorization: `Bearer ${token.token}` })).status).toBe(401);
    const human = setupOperator(db, { display_name: 'Operator', email: 'operator@example.invalid' });
    addBinding(db, human.id, { binding_type: 'app_name', value: 'human-app' });
    expect((await request('GET', '/api/read', { ...base, 'X-Mandible-Managed-App': 'human-app' })).status).toBe(401);
  });
  it('bootstraps the first operator only from an unmanaged bearer-free production socket', async () => {
    db.prepare('DELETE FROM settings WHERE key = ?').run(OPERATOR_SETTING_KEY);
    expect((await request('GET', '/api/read')).status).toBe(401);
    const setup = { slug: 'fresh-operator', display_name: 'Fresh Operator', email: 'fresh@example.invalid' };
    expect((await request('POST', '/api/users/setup', { 'X-Mandible-Managed-Client': '1' }, true, setup)).status).toBe(401);
    expect((await request('POST', '/api/users/setup', { Authorization: 'Bearer invalid' }, true, setup)).status).toBe(401);
    const first = await request('POST', '/api/users/setup', {}, true, setup);
    expect(first).toMatchObject({ status: 200, body: { user: { slug: 'fresh-operator' } } });
    expect(auth.localSocketBootstrapAllowed()).toBe(false);
    expect((await request('GET', '/api/read')).body.identity.user_id).toBe(first.body.user.id);
  });
  it('uses the operator for an unmanaged request, but TCP cannot spoof the socket', async () => {
    const local = await request('GET', '/api/read');
    expect(local).toMatchObject({ status: 200, body: { identity: { method: 'local_socket', source: 'local_socket', credential_id: null } } });
    expect(fs.statSync(path.dirname(socketPath)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);
    const tcp = await request('GET', '/api/read', { 'X-Mandible-Managed-Client': '1', 'X-Mandible-Transport': 'local-socket' }, false);
    expect(tcp.status).toBe(401);
  });
  it('refuses unknown managed claims and resolves only an active agent binding', async () => {
    expect((await request('GET', '/api/read', { 'X-Mandible-Managed-Client': '1' })).status).toBe(401);
    expect((await request('GET', '/api/read', { 'X-Mandible-Ambient-Provider': 'unknown' })).status).toBe(401);
    const agent = createUser(db, { slug: 'codex-test', kind: 'agent', display_name: 'Codex Test' });
    addBinding(db, agent.id, { binding_type: 'provider_session_env', value: 'CODEX_THREAD_ID' });
    const headers = { 'X-Mandible-Managed-Client': '1', 'X-Mandible-Ambient-Provider': 'codex', 'X-Mandible-Ambient-Provider-Session-Id': 'task-1' };
    const response = await request('GET', '/api/read', headers);
    expect(response).toMatchObject({ status: 200, body: { identity: { user_id: agent.id, method: 'local_socket' }, managed: true } });
    expect(response.body.ambient).toEqual({ provider: 'codex', provider_session_id: 'task-1' });
  });
  it('preserves explicit durable bearer identity and refuses an invalid bearer', async () => {
    const agent = createUser(db, { slug: 'agent-test', kind: 'agent', display_name: 'Agent Test' });
    const token = auth.mintApiToken(agent.id);
    expect(await request('GET', '/api/read', { Authorization: `Bearer ${token.token}` })).toMatchObject({
      status: 200, body: { identity: { user_id: agent.id, method: 'api_token', credential_id: token.credential.id } },
    });
    expect((await request('GET', '/api/read', { Authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await request('GET', '/api/read', { Authorization: '' })).status).toBe(401);
  });
  it('keeps preview on a separate socket path and the preview effect ceiling', () => {
    const production = localApiSocketPath(instance(), { HOME: root });
    const preview = localApiSocketPath({ ...instance(), role: 'preview', instance_id: 'preview-1', allowed_effects: STANDARD_PREVIEW_EFFECTS }, { HOME: root });
    expect(production).toContain('production.sock');
    expect(preview).toMatch(/preview-[a-f0-9]{16}\.sock$/);
    expect(preview).not.toBe(production);
    expect(() => localApiSocketPath(instance(), { MANDIBLE_SOCKET: 'relative.sock' })).toThrow('absolute');
  });
  it('refuses active, symlink and unsafe paths, and reclaims only a stale socket', async () => {
    await expect(startLocalApiSocket(http.createServer(), socketPath)).rejects.toThrow('already active');
    const unsafe = path.join(root, 'unsafe'); fs.mkdirSync(unsafe, { mode: 0o755 });
    await expect(startLocalApiSocket(http.createServer(), path.join(unsafe, 'x.sock'))).rejects.toThrow('not private');
    const linked = path.join(root, 'linked'); fs.symlinkSync(path.dirname(socketPath), linked);
    await expect(startLocalApiSocket(http.createServer(), path.join(linked, 'x.sock'))).rejects.toThrow('Unsafe');
    const stale = path.join(root, 'private', 'stale.sock');
    const child = spawn(process.execPath, ['-e', 'const http=require("node:http"); http.createServer().listen(process.argv[1],()=>process.stdout.write("ready\\n"));', stale], { stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once('data', () => resolve()); child.once('error', reject);
    });
    child.kill('SIGKILL');
    await new Promise<void>(resolve => child.once('exit', () => resolve()));
    expect(fs.lstatSync(stale).isSocket()).toBe(true);
    const replacement = http.createServer(); const cleanup = await startLocalApiSocket(replacement, stale);
    expect(fs.lstatSync(stale).isSocket()).toBe(true);
    await cleanup(); expect(fs.existsSync(stale)).toBe(false);
  });
  it('serves the event stream over the local socket', async () => {
    await new Promise<void>((resolve, reject) => {
      const req = http.request({ socketPath, path: '/api/events/subscribe?topic=auth:', method: 'POST' }, res => {
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toBe('text/event-stream');
        req.destroy(); resolve();
      });
      req.once('error', reject); req.end();
    });
  });
  it('rejects a foreign-owned ancestor even when its mode is read-only', async () => {
    const original = fs.lstatSync.bind(fs);
    const inspect = vi.spyOn(fs, 'lstatSync').mockImplementation(((target: fs.PathLike, options?: any) => {
      const stat = original(target, options);
      return String(target) === root ? Object.assign(stat, { uid: (process.getuid?.() ?? 0) + 1 }) : stat;
    }) as typeof fs.lstatSync);
    try {
      await expect(startLocalApiSocket(http.createServer(), path.join(root, 'private', 'other.sock')))
        .rejects.toThrow('Foreign-owned');
    } finally { inspect.mockRestore(); }
  });
  it('accepts the managed app alias on the event stream', async () => {
    const agent = createUser(db, { slug: 'stream-agent', kind: 'agent', display_name: 'Stream Agent' });
    addBinding(db, agent.id, { binding_type: 'app_name', value: 'codex' });
    const headers = { 'X-Mandible-Managed-Client': '1', 'X-Mandible-Managed-App': 'codex',
      'X-Mandible-Managed-Session-Id': 'stream-session' };
    await new Promise<void>((resolve, reject) => {
      const req = http.request({ socketPath, path: '/api/events/subscribe?topic=auth:', method: 'POST', headers }, res => {
        expect(res.statusCode).toBe(200);
        req.destroy(); resolve();
      });
      req.once('error', reject); req.end();
    });
  });
  it('rebinds the same path after clean shutdown', async () => {
    await closeSocket();
    expect(fs.existsSync(socketPath)).toBe(false);
    socketServer = createLocalSocketServer({ db, sse: new SseManager(), logger: () => undefined,
      version: 'test', router, getStartupInfo: () => null, instance: instance(), clientAuth: auth });
    closeSocket = await startLocalApiSocket(socketServer, socketPath);
    expect((await request('GET', '/api/read')).status).toBe(200);
  });
});
