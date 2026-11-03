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
    router.patch('/api/sessions/:id', (req, res) => {
      expect(req.params.id).toBe('agent:claude:native-chat:native-child');
      res.json({ updated: true });
    }, { fileRpc: 'deny', operation: { id: 'fixture.channel.task', effects: ['ledger:write'], reportingCategory: null, requestSchema: null } });
    router.patch('/api/work-units/:id', (req, res) => {
      mutations++;
      expect(req.client_identity).toBe(identity);
      expect(req.ambient_identity).toEqual({ provider: 'claude', agent_id: 'native-child', session_id: 'native-chat' });
      expect(currentRequestOrigin()).toEqual({ provider: 'claude', agent_id: null, session_id: 'origin-chat' });
      res.json({ updated: true });
    }, { fileRpc: 'allow', operation: { id: 'fixture.channel.patch', effects: ['ledger:write'], reportingCategory: 'work_units', requestSchema: null } });
    router.post('/api/auth/v2/request', (_req, res) => { mutations++; res.json({ request_id: 'never' }); },
      { fileRpc: 'allow', operation: { id: 'fixture.channel.auth', effects: ['auth:protected'], reportingCategory: 'auth', requestSchema: null } });
    const invoke = (name: string, args: unknown) => router.invoke({ method: 'POST', url: '/api/channel/call', transport: 'http',
      credential: 'agent-token', ambient_identity: { provider: 'claude', agent_id: 'native-child', session_id: 'native-chat' },
      request_origin: { provider: 'claude', agent_id: null, session_id: 'origin-chat' }, body: { ...context, name, arguments: args } });
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

  it('keeps concurrent child assignment and status mutations separate from wrapper liveness and initiating origin', async () => {
    const router = new Router(); registerChannelRoutes(router);
    const wrapper = 'wrapper-session';
    const refs = { a: 'agent:claude:root:a', b: 'agent:claude:root:b' };
    const tasks = new Map<string, string>([[wrapper, 'parent task'], [refs.a, ''], [refs.b, '']]);
    const units = new Map<string, Record<string, unknown>>([['a', {}], ['b', {}]]);
    const liveness: string[] = [];
    let arrivals = 0;
    let release!: () => void;
    const siblings = new Promise<void>(resolve => { release = resolve; });
    router.post('/api/sessions/:id/channel-tool-call', (req, res) => { liveness.push(req.params.id); res.json({}); },
      { fileRpc: 'deny', operation: { id: 'fixture.channel.liveness', effects: ['ledger:write'], reportingCategory: null, requestSchema: null } });
    router.get('/api/work-units', async (req, res) => {
      if (++arrivals === 2) release();
      await siblings;
      const id = req.query.repo_id;
      res.json({ work_units: [{ id, issue_id: `issue-${id}`, repo_id: id, state: 'open', kind: 'solo', liveness: { state: 'stopped' } }] });
    }, { fileRpc: 'deny', operation: { id: 'fixture.channel.available', effects: ['ledger:read'], reportingCategory: null, requestSchema: null } });
    router.patch('/api/work-units/:id', (req, res) => {
      Object.assign(units.get(req.params.id)!, req.body);
      res.json({});
    }, { fileRpc: 'deny', operation: { id: 'fixture.channel.assign-status', effects: ['ledger:write'], reportingCategory: null, requestSchema: null } });
    router.patch('/api/sessions/:id', (req, res) => { tasks.set(req.params.id, (req.body as { task: string }).task); res.json({}); },
      { fileRpc: 'deny', operation: { id: 'fixture.channel.task-status', effects: ['ledger:write'], reportingCategory: null, requestSchema: null } });
    const invoke = (agent: string | null, name: string, args: Record<string, unknown>) => router.invoke({
      method: 'POST', url: '/api/channel/call', ambient_identity: { provider: 'claude', agent_id: agent, session_id: 'root' },
      request_origin: { provider: 'claude', agent_id: 'different-initiator', session_id: 'another-root' },
      body: { ...context, session_id: wrapper, name, arguments: args },
    });
    const assignments = await Promise.all(['a', 'b'].map(id => invoke(id, 'mandible_request_work', { assign: true, repo_id: id })));
    for (const assignment of assignments) expect(assignment.body).not.toHaveProperty('isError');
    expect(units.get('a')?.assigned_session_id).toBe(refs.a);
    expect(units.get('b')?.assigned_session_id).toBe(refs.b);
    const reports = await Promise.all(['a', 'b'].map(id => invoke(id, 'mandible_report_status', { status: `task-${id}`, work_unit_id: id })));
    for (const report of reports) expect(report.body).not.toHaveProperty('isError');
    expect(tasks.get(refs.a)).toBe('task-a'); expect(tasks.get(refs.b)).toBe('task-b');
    expect(tasks.get(wrapper)).toBe('parent task');
    expect(units.get('a')).toMatchObject({ continuation: 'task-a', continuation_by: refs.a });
    expect(units.get('b')).toMatchObject({ continuation: 'task-b', continuation_by: refs.b });
    expect(liveness).toEqual([wrapper, wrapper, wrapper, wrapper]);
    const before = JSON.stringify([...units]);
    expect((await invoke(null, 'mandible_report_status', { status: 'unknown', work_unit_id: 'a' })).body).toMatchObject({ isError: true });
    expect((await invoke(null, 'mandible_request_work', { assign: true, repo_id: 'a' })).body).toMatchObject({ isError: true });
    expect(JSON.stringify([...units])).toBe(before);
    expect(tasks.get(wrapper)).toBe('parent task');
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
