import { afterEach, describe, expect, it, vi } from 'vitest';

import { createConsoleSession, invalidateApiGetCache, listCanonicalProjects } from '../../ui/src/api';

afterEach(() => {
  invalidateApiGetCache();
  vi.unstubAllGlobals();
});

describe('console session creation payload', () => {
  it('posts the exact registered cwd only for scoped creation', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input) === '/api/projects'
        ? { projects: [{ id: 'project-1', project_key: 'project', display_name: 'Project', checkouts: [{ id: 'checkout-1', project_id: 'project-1', root: '/registered/project', name: 'Project', default_branch: 'main', remote_url: '' }] }] }
        : { session: {} },
    ), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await createConsoleSession('Scoped', 'codex', 'agent', 'acp', { cwd: '/registered/project' });
    await createConsoleSession('Unscoped', 'codex', 'agent', 'acp');

    const spawnCalls = fetchMock.mock.calls.filter(([input]) => String(input) === '/api/conversation-spawns');
    const scopedBody = JSON.parse(String(spawnCalls[0][1]?.body));
    const unscopedBody = JSON.parse(String(spawnCalls[1][1]?.body));
    expect(scopedBody).toMatchObject({
      schema: 'mandible-conversation-spawn-request@1', provider: 'codex', label: 'Scoped',
      placement: { project_id: 'project-1', checkout_id: 'checkout-1' }, topology: { kind: 'top-level' },
      command: { name: 'codex', backend_type: 'acp', transport_lane: 'acp' },
    });
    expect(unscopedBody).toMatchObject({ label: 'Unscoped', placement: { project_id: null, checkout_id: null } });
  });
});

describe('canonical Chat project registry payload', () => {
  it('retains canonical project and checkout IDs while reading the existing projects route', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      projects: [{
        id: 'prj-1', project_key: 'mandible', display_name: 'Mandible',
        checkouts: [{
          id: 'checkout-1', project_id: 'prj-1', work_repo_id: 'mandible',
          root: '/repos/mandible', name: 'Mandible', default_branch: 'main', remote_url: '',
        }],
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listCanonicalProjects()).resolves.toEqual([{
      id: 'prj-1', project_key: 'mandible', display_name: 'Mandible',
      checkouts: [expect.objectContaining({ id: 'checkout-1', project_id: 'prj-1', root: '/repos/mandible' })],
    }]);
    expect(fetchMock).toHaveBeenCalledWith('/api/projects', expect.anything());
  });
});
