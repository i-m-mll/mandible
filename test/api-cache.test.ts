import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addSpaceItem,
  feedbackApiCacheFamiliesForEvent,
  getSpace,
  getSpaceFactPacket,
  getSessions,
  invalidateApiGetCache,
} from '../ui/src/api';

describe('feedback SSE cache invalidation matrix', () => {
  it.each([
    'briefing:ingested',
    'briefing:decided',
    'briefing:commented',
    'briefing:expired',
  ])('%s invalidates only Briefing and badge caches', (topic) => {
    expect(feedbackApiCacheFamiliesForEvent(topic)).toEqual([
      '/api/briefing',
      '/api/dashboard/badges',
    ]);
  });

  it.each([
    'ask:created',
    'ask:submitted',
    'ask:cancelled',
    'ask:expired',
  ])('%s invalidates only ask and badge caches', (topic) => {
    expect(feedbackApiCacheFamiliesForEvent(topic)).toEqual([
      '/api/asks',
      '/api/dashboard/badges',
    ]);
  });

  it('does not classify unrelated or merely prefix-matching topics as feedback', () => {
    for (const topic of ['ledger:issue:updated', 'auth:new', 'briefing:unknown', 'ask:answered']) {
      expect(feedbackApiCacheFamiliesForEvent(topic)).toEqual([]);
    }
  });

  it('keeps event bursts bounded to the union of their declared families', () => {
    const burst = [
      'briefing:ingested',
      'briefing:decided',
      'ask:created',
      'ask:submitted',
      'briefing:expired',
    ];
    const families = new Set(burst.flatMap((topic) => feedbackApiCacheFamiliesForEvent(topic)));
    expect([...families].sort()).toEqual([
      '/api/asks',
      '/api/briefing',
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
  beforeEach(() => {
    invalidateApiGetCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    invalidateApiGetCache();
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
