import { BRIEFING_EVENT_VALUES } from '../src/contracts';
import { queryClient } from '../ui/src/query/client';
import { browserResourceKeys } from '../ui/src/query/browserResources';
import { ensureClientAccess, __resetBrowserSessionForTests } from '../ui/src/client-auth-token';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addSpaceItem,
  dispositionBriefingGroupProposal,
  briefingApiCacheFamiliesForEvent,
  getBriefingSidebarSnapshot,
  getSpace,
  getSpaceFactPacket,
  getSessions,
  invalidateApiGetCache,
} from '../ui/src/api';

describe('Briefing SSE cache invalidation matrix', () => {
  it.each(BRIEFING_EVENT_VALUES)('%s invalidates Briefing, bundle, and badge caches', (topic) => {
    expect(briefingApiCacheFamiliesForEvent(topic)).toEqual([
      '/api/briefings',
      '/api/briefing-bundles',
      '/api/briefing-groups',
      '/api/dashboard/badges',
    ]);
  });

  it('does not classify removed compatibility or merely prefix-matching topics', () => {
    for (const topic of ['ledger:issue:updated', 'auth:new', 'briefing:unknown', 'ask:answered', 'feedback:collection-updated']) {
      expect(briefingApiCacheFamiliesForEvent(topic)).toEqual([]);
    }
  });

  it('keeps event bursts bounded to the union of their declared families', () => {
    const burst = [
      'briefing:created',
      'briefing:round-published',
      'briefing:answered',
      'briefing:submitted',
    ];
    const families = new Set(burst.flatMap((topic) => briefingApiCacheFamiliesForEvent(topic)));
    expect([...families].sort()).toEqual([
      '/api/briefing-bundles',
      '/api/briefing-groups',
      '/api/briefings',
      '/api/dashboard/badges',
    ]);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('dashboard API GET cache', () => {
  beforeEach(async () => {
    queryClient.clear();
    __resetBrowserSessionForTests();
    await ensureClientAccess(async () => jsonResponse({ authenticated: true, session: { csrf_token: 'test' } }));
    invalidateApiGetCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    invalidateApiGetCache();
  });

  it('sends the destination changes bound into a Briefing disposition', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ error: 'Stop after request capture' }), {
      status: 409, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(dispositionBriefingGroupProposal('digest', {
      decision: 'accepted', expectedBaseBundleId: 'base', proposalBundleId: 'proposal',
      bindingDigest: 'a'.repeat(64), destinationChanges: [{
        logicalArtifactId: 'artifact:report', expectedGroupId: null, resultingGroupId: 'digest',
      }],
    })).rejects.toThrow();
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/review-dispositions'));
    expect(call).toBeDefined();
    const options = call![1]!;
    expect(JSON.parse(options.body as string)).toMatchObject({
      destination_changes: [{ logical_artifact_ref: 'artifact:report', expected_group_ref: null }],
    });
  });

  it('deduplicates concurrent same-URL GETs across API helpers', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        space: {
          id: 'sp1',
          project_id: 'p1',
          title: 'Canvas',
          default_renderer: 'canvas',
        },
        items: [],
        occurrences: [],
        edges: [],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const [packet, space] = await Promise.all([
      getSpaceFactPacket('sp1'),
      getSpace('sp1'),
    ]);

    expect(packet.space.id).toBe('sp1');
    expect(space.id).toBe('sp1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/spaces/sp1', expect.any(Object));
  });

  it('serves fresh cached GETs without refetching', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ sessions: [{ id: 's1' }] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getSessions<{ id: string }>()).resolves.toEqual([{ id: 's1' }]);
    await expect(getSessions<{ id: string }>()).resolves.toEqual([{ id: 's1' }]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('publishes cached Briefing containment only after all three reads succeed', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/briefings') return jsonResponse({ briefings: [] });
      if (path === '/api/briefing-bundles') return jsonResponse({ bundles: [] });
      if (path === '/api/briefing-groups') return new Response('unavailable', { status: 503 });
      return new Response('unexpected request', { status: 500 });
    }));

    await expect(queryClient.fetchQuery({ queryKey: browserResourceKeys.briefingSidebar, queryFn: ({ signal }) => getBriefingSidebarSnapshot(signal) })).rejects.toThrow(/503/);
    expect(queryClient.getQueryData(browserResourceKeys.briefingSidebar)).toBeUndefined();

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/briefings') return jsonResponse({ briefings: [] });
      if (path === '/api/briefing-bundles') return jsonResponse({ bundles: [] });
      if (path === '/api/briefing-groups') return jsonResponse({ groups: [] });
      return new Response('unexpected request', { status: 500 });
    }));
    await expect(queryClient.fetchQuery({ queryKey: browserResourceKeys.briefingSidebar, queryFn: ({ signal }) => getBriefingSidebarSnapshot(signal) })).resolves.toEqual({ briefings: [], bundles: [], groups: [], invalidBriefings: [] });
    expect(queryClient.getQueryData(browserResourceKeys.briefingSidebar)).toEqual({ briefings: [], bundles: [], groups: [], invalidBriefings: [] });

    await queryClient.invalidateQueries({ queryKey: browserResourceKeys.briefings });
    expect(queryClient.getQueryState(browserResourceKeys.briefingSidebar)?.isInvalidated).toBe(true);
  });

  it('invalidates a cached Space fact packet after a Space mutation', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'POST' && path === '/api/spaces/sp1/items') {
        return jsonResponse({ item: { id: 'item1' } });
      }
      if (method === 'GET' && path === '/api/spaces/sp1') {
        return jsonResponse({
          space: {
            id: 'sp1',
            project_id: 'p1',
            title: 'Canvas',
            default_renderer: 'canvas',
          },
          items: [],
          occurrences: [],
          edges: [],
        });
      }
      return new Response('unexpected request', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await getSpaceFactPacket('sp1');
    await addSpaceItem('sp1', { ref_type: 'issue', ref_id: 'abc1234' });
    await getSpaceFactPacket('sp1');

    const getCalls = fetchMock.mock.calls.filter(([path, init]) =>
      String(path) === '/api/spaces/sp1' && ((init as RequestInit | undefined)?.method ?? 'GET') === 'GET',
    );
    expect(getCalls).toHaveLength(2);
  });
});
