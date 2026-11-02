// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { Router, type RequestLike, type ResolvedClientIdentity } from '../src/server.js';
import { registerChannelRoutes } from '../src/routes/channel.js';
import { ClientAuthzError } from '../src/client-auth/authz.js';
import { PRODUCTION_EFFECTS } from '../src/security/effect-policy.js';
import { currentRequestOrigin } from '../src/request-origin.js';

const context = { session_id: null, conversation_id: 'chat', cwd: '/tmp', parent_pid: process.pid, app: 'claude' };

describe('daemon channel composition authority', () => {
  it('retains the ingress caller and origin and rechecks effect ceilings and protected approval on each operation', async () => {
    const identity: ResolvedClientIdentity = { user_id: 'agent', slug: 'claude', method: 'api_token', credential_id: 'agent-credential',
      source: 'http_bearer', effect_ceiling: ['ledger:read'] };
    let authentications = 0;
    const protectedChecks: string[] = [];
    const router = new Router({ clientAuth: {
      mode: () => 'strict', authenticate: () => { authentications++; return identity; }, recordUnattributedWrite() {},
      async authorizeProtectedMutation(req, operation) {
        protectedChecks.push(operation.id);
        expect(req.client_identity).toBe(identity);
        if (operation.effects.includes('auth:protected')) throw new ClientAuthzError(403, 'operator_presence_required', 'Hardware approval is required');
      },
    } });
    registerChannelRoutes(router);
    let mutations = 0;
    router.patch('/api/work-units/:id', (req, res) => {
      mutations++;
      expect(req.client_identity).toBe(identity);
      expect(req.ambient_identity).toEqual({ provider: 'claude', provider_session_id: 'native-chat' });
      expect(currentRequestOrigin()).toEqual({ provider: 'claude', provider_session_id: 'origin-chat' });
      res.json({ updated: true });
    }, { fileRpc: 'allow', operation: { id: 'fixture.channel.patch', effects: ['ledger:write'], reportingCategory: 'work_units', requestSchema: null } });
    router.post('/api/auth/v2/request', (_req, res) => { mutations++; res.json({ request_id: 'never' }); },
      { fileRpc: 'allow', operation: { id: 'fixture.channel.auth', effects: ['auth:protected'], reportingCategory: 'auth', requestSchema: null } });
    const invoke = (name: string, args: unknown) => router.invoke({ method: 'POST', url: '/api/channel/call', transport: 'http',
      credential: 'agent-token', ambient_identity: { provider: 'claude', provider_session_id: 'native-chat' },
      request_origin: { provider: 'claude', provider_session_id: 'origin-chat' }, body: { ...context, name, arguments: args } });
    const denied = await invoke('mandible_report_status', { status: 'working', work_unit_id: 'unit' });
    expect(denied.body).toMatchObject({ isError: true });
    expect(mutations).toBe(0);
    identity.effect_ceiling = PRODUCTION_EFFECTS;
    const allowed = await invoke('mandible_report_status', { status: 'working', work_unit_id: 'unit' });
    expect(allowed.body).not.toHaveProperty('isError');
    expect(mutations).toBe(1);
    const auth = await invoke('mandible_submit_auth', { branch: 'feature/example', title: 'Example', message: 'Change', verification: 'Checks passed' });
    expect(auth.body).toMatchObject({ isError: true });
    expect(protectedChecks).toContain('fixture.channel.auth');
    expect(mutations).toBe(1);
    expect(authentications).toBe(3);
    expect((await invoke('arbitrary_operation', {})).status).toBe(404);
  });

  it('rejects fabricated and expired caller capabilities', async () => {
    const router = new Router();
    await expect(router.invokeFrom({} as RequestLike, { method: 'GET', url: '/anything' })).rejects.toThrow('live router request');
    let captured: RequestLike;
    router.get('/capture', (req, res) => { captured = req; res.json({}); },
      { fileRpc: 'deny', operation: { id: 'fixture.capture', effects: [], reportingCategory: null, requestSchema: null } });
    await router.invoke({ method: 'GET', url: '/capture' });
    await expect(router.invokeFrom(captured!, { method: 'GET', url: '/capture' })).rejects.toThrow('live router request');
  });
});
