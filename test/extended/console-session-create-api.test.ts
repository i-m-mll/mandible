import { afterEach, describe, expect, it, vi } from 'vitest';

import { createConsoleSession, invalidateApiGetCache, listCanonicalProjects } from '../../ui/src/api';

afterEach(() => {
  invalidateApiGetCache();
  vi.unstubAllGlobals();
});

describe('console session creation payload', () => {
  it('posts the exact registered cwd only for scoped creation', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ session: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await createConsoleSession('Scoped', 'codex', 'agent', 'acp', { cwd: '/registered/project' });
    await createConsoleSession('Unscoped', 'codex', 'agent', 'acp');

    const scopedBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const unscopedBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(scopedBody).toMatchObject({ label: 'Scoped', command: 'codex', cwd: '/registered/project' });
    expect(unscopedBody).toMatchObject({ label: 'Unscoped', command: 'codex' });
    expect(unscopedBody).not.toHaveProperty('cwd');
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
