import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getWorkCompare, invalidateApiGetCache, patchSession, updateConversation } from '../ui/src/api';
import { __resetBrowserSessionForTests, ensureClientAccess } from '../ui/src/client-auth-token';
beforeEach(async () => {
 __resetBrowserSessionForTests();
 await ensureClientAccess(async () => new Response(JSON.stringify({ authenticated: true, session: { family_id: 'test-family', audience: 'production', csrf_token: 'test-csrf', effect_ceiling: ['ledger:read', 'ledger:write'] } }), { status: 200, headers: { 'content-type': 'application/json' } }));
});
afterEach(() => { __resetBrowserSessionForTests(); invalidateApiGetCache(); vi.unstubAllGlobals(); });

describe('API contract helpers', () => {
  it('loads Projects compare payloads with raw unified diff text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => (
      new Response(JSON.stringify({
        repo_root: '/tmp/repo',
        from: 'main',
        to: 'feature',
        mode: 'merge-base',
        range: 'main...feature',
        raw: 'diff --git a/a.txt b/a.txt\n',
        stat: 'a.txt | 1 +',
      }), {
        headers: { 'content-type': 'application/json' },
      })
    )));

    const compare = await getWorkCompare('repo', { from: 'main', to: 'feature', mode: 'merge-base' });

    expect(compare.raw).toContain('diff --git');
    expect(compare.range).toBe('main...feature');
  });

  it('surfaces server error bodies for PATCH helpers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => (
      new Response(JSON.stringify({ error: 'specific failure' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      })
    )));

    await expect(patchSession('s1', { status: 'dead' })).rejects.toThrow('specific failure');
  });

  it('sends conversation starred updates as booleans', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo, init?: RequestInit) => (
      new Response(JSON.stringify({ id: 'c1', starred: true }), {
        headers: { 'content-type': 'application/json' },
      })
    ));
    vi.stubGlobal('fetch', fetchMock);

    await updateConversation('c1', { starred: true });

    const mutation = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    const body = JSON.parse(String(mutation?.[1]?.body));
    expect(body.starred).toBe(true);
  });
});
