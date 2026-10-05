// @vitest-environment node
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClientAuthenticator } from '../src/client-auth/authenticator.js';
import { openDb, setDb, type Db } from '../src/db.js';
import { PRODUCTION_EFFECTS, STANDARD_PREVIEW_EFFECTS } from '../src/security/effect-policy.js';
import { createServer, Router } from '../src/server.js';
import { registerClientAuthRoutes } from '../src/routes/client-auth.js';
import { SseManager } from '../src/sse.js';
import { PRODUCTION_ORIGIN } from '../src/canonical-origin.js';
import type { InstanceInfo } from '../src/types.js';
import { createUser, setupOperator } from '../src/users/store.js';

let root: string;
let db: Db;
let server: http.Server;
let port: number;
let auth: ClientAuthenticator;
const host = new URL(PRODUCTION_ORIGIN).host;
const browserHeaders = { Host: host, Origin: PRODUCTION_ORIGIN, 'Sec-Fetch-Site': 'same-origin' };

function instance(): InstanceInfo {
  return {
    role: 'main', instance_id: 'production', installation_id: 'install-test',
    public_origin: PRODUCTION_ORIGIN, backend_generation: 'main-1',
    allowed_effects: PRODUCTION_EFFECTS, writable_roots: [root], preview_root: null,
    user_preferences_root: path.join(root, 'settings', 'users'),
    db_path: path.join(root, 'mandible.db'), db_path_source: 'test',
    source_db_path: null, source_db_path_source: null,
  };
}

async function request(method: string, url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: url, method, headers }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 500, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    req.end();
  });
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mandible-os-access-'));
  db = openDb(path.join(root, 'mandible.db'));
  setDb(db);
  const policy = instance();
  auth = new ClientAuthenticator(db, {
    instance: policy, secretsDir: path.join(root, 'client-auth'),
    sessionAuthorityDir: path.join(root, 'local-sessions'), initializeSessionAuthority: true,
  });
  auth.registerInstance({ instance_id: 'production', installation_id: 'install-test', role: 'main',
    public_origin: PRODUCTION_ORIGIN, backend_origin: 'http://127.0.0.1:29420',
    backend_generation: 'main-1', effect_ceiling: PRODUCTION_EFFECTS, writable_roots: [root] });
  auth.registerInstance({ instance_id: 'preview-test', installation_id: 'install-test', role: 'preview',
    public_origin: 'https://preview-test.mandible.localhost:19421', backend_origin: 'http://127.0.0.1:29421',
    backend_generation: 'preview-1', effect_ceiling: STANDARD_PREVIEW_EFFECTS, writable_roots: [root] });
  setupOperator(db, { display_name: 'Operator', email: 'operator@example.invalid' });
  const router = new Router({ clientAuth: auth, instance: policy });
  registerClientAuthRoutes(router, auth);
  router.get('/api/read', (req, res) => res.json({ user: req.client_identity?.user_id, source: req.client_identity?.source }), { operation: { id: "fixture:get:/api/read", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: 'allow' });
  router.post('/api/issues/test-write', (req, res) => res.json({ user: req.client_identity?.user_id }), { operation: { id: "fixture:post:/api/issues/test-write", effects: ["ledger:write"], requestSchema: null, reportingCategory: "data-write" }, fileRpc: 'allow' });
  server = createServer({ db, sse: new SseManager(), logger: () => undefined, version: 'test',
    router, getStartupInfo: () => null, instance: policy, clientAuth: auth });
  port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('OS-owned local browser access', () => {
  it('retains the same human and CSRF after time advances and the authenticator is recreated', () => {
    const original = auth.localBrowserIdentity()!;
    const restarted = new ClientAuthenticator(db, {
      instance: instance(), secretsDir: path.join(root, 'client-auth'),
      sessionAuthorityDir: path.join(root, 'local-sessions'),
      now: () => Date.now() + 400 * 24 * 60 * 60 * 1_000,
    });
    const later = restarted.localBrowserIdentity()!;
    expect(later).toMatchObject({
      user_id: original.user_id, method: 'local_os_user', source: 'local_os_user',
      csrf_token: original.csrf_token,
    });
    expect(restarted.validateBrowserCsrf(later, original.csrf_token)).toBe(true);
  });

  it('resolves a fresh browser on every request without a cookie or expiry', async () => {
    const first = await request('GET', '/api/client-auth/whoami', browserHeaders);
    expect(first).toMatchObject({ status: 200, body: { authenticated: true,
      evidence_method: 'local_os_user', source: 'local_os_user',
      user: { kind: 'human' }, session: { audience: 'production' } } });
    expect((await request('GET', '/api/read', browserHeaders)).body).toMatchObject({
      user: first.body.user.id, source: 'local_os_user',
    });
    expect((await request('GET', '/api/client-auth/whoami', browserHeaders)).body.session.csrf_token)
      .toBe(first.body.session.csrf_token);
    expect((await request('POST', '/api/issues/test-write', browserHeaders)).status).toBe(403);
    expect((await request('POST', '/api/issues/test-write', {
      ...browserHeaders, 'X-Mandible-CSRF': first.body.session.csrf_token,
    })).status).toBe(200);
  });

  it('keeps explicit agents separate and rejects hostile browser origins', async () => {
    const agent = createUser(db, { slug: 'agent-test', kind: 'agent', display_name: 'Agent' });
    const token = auth.mintApiToken(agent.id).token;
    expect((await request('GET', '/api/read', { Host: host, Authorization: `Bearer ${token}` })).body)
      .toMatchObject({ user: agent.id, source: 'http_bearer' });
    expect((await request('GET', '/api/read', { ...browserHeaders, Authorization: `Bearer ${token}` })).status).toBe(400);
    expect((await request('GET', '/api/read', { ...browserHeaders, Host: 'evil.invalid' })).status).toBe(403);
    expect((await request('POST', '/api/issues/test-write', { ...browserHeaders, Origin: 'https://evil.invalid' })).status).toBe(403);
    expect((await request('GET', '/api/read', { Host: host })).status).toBe(401);
  });

  it('reissues the current bounded preview capability for the existing local browser after daemon restart', async () => {
    const beforeRestart = auth.localBrowserIdentity()!;
    const restartedAuth = new ClientAuthenticator(db, {
      instance: instance(), secretsDir: path.join(root, 'client-auth'),
      sessionAuthorityDir: path.join(root, 'local-sessions'),
    });
    const identity = restartedAuth.localBrowserIdentity()!;
    expect(identity).toMatchObject({
      user_id: beforeRestart.user_id,
      csrf_token: beforeRestart.csrf_token,
      source: 'local_os_user',
    });
    expect(identity.effect_ceiling).toContain('preferences:instance');
    const token = await restartedAuth.signPreviewContext(identity, 'preview-test');
    const preview = new ClientAuthenticator(db, {
      instance: { ...instance(), role: 'preview', instance_id: 'preview-test',
        public_origin: 'https://preview-test.mandible.localhost:19421',
        backend_generation: 'preview-1', allowed_effects: STANDARD_PREVIEW_EFFECTS },
      secretsDir: path.join(root, 'preview-auth'), sessionAuthorityDir: path.join(root, 'local-sessions'),
      contextVerificationKeyPem: fs.readFileSync(path.join(root, 'local-sessions', 'context-verification-key.pem'), 'utf8'),
    });
    expect(preview.localBrowserIdentity()).toBeNull();
    expect(await preview.authenticateInternalContext(token)).toMatchObject({
      user_id: identity.user_id, source: 'installation_context', effect_ceiling: STANDARD_PREVIEW_EFFECTS,
    });
  });
});
