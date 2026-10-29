// @vitest-environment jsdom
import { setImmediate } from 'node:timers/promises';
import { beginDetailRequest, clearPersistedDetailCache, isPersistedDetailFresh, writePersistedDetail } from '../ui/src/detail-cache';
import { QueryObserver } from '@tanstack/preact-query';
import { waitFor } from './helpers/dom';
import { artifactBackrefsOptions } from '../ui/src/query/details';
import * as api from '../ui/src/api';
import { queryClient } from '../ui/src/query/client';
import { browserResourceKeys } from '../ui/src/query/browserResources';
import { ensureClientAccess, __resetBrowserSessionForTests } from '../ui/src/client-auth-token';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { addSpaceItem, getBriefingSidebarSnapshot, clearApiGetCache } from '../ui/src/api';
import { spacePacketOptions } from '../ui/src/query/spaces';


function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('dashboard API GET cache', () => {
  beforeEach(async () => {
    queryClient.clear();
    __resetBrowserSessionForTests();
    await ensureClientAccess(async () => jsonResponse({ authenticated: true, session: { csrf_token: 'test' } }));
    clearApiGetCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearApiGetCache();
  });

  it('does not cache a preference GET that started before a successful PUT', async () => {
    const initial = { version: 1, key: 'chat_shown_projects', value: [], revision: 1 };
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn((_url, init) => init?.method === 'PUT'
      ? Promise.resolve(jsonResponse({ ...initial, revision: 2 }))
      : new Promise<Response>((resolve) => { finish = resolve; })));
    const old = api.getChatShownProjectsPreference();
    await api.updateChatShownProjectsPreference([], 1);
    finish(jsonResponse(initial));
    await old;
    expect((await api.getChatShownProjectsPreference({ warm: true })).revision).toBe(2);
  });

  it.each(['one', 'all', 'event'])('expires inbox data after acknowledgement: %s', async (mode) => {
    let acknowledged = false;
    const fetch = vi.fn(async (_url, init) => jsonResponse(init?.method === 'POST'
      ? (acknowledged = true, {}) : { total: acknowledged ? 0 : 1 }));
    vi.stubGlobal('fetch', fetch);
    expect((await api.getInboxGlobal()).total).toBe(1);
    if (mode === 'one') await api.acknowledgeInboxItem('continuation', 'one');
    else if (mode === 'all') await api.ackAllInbox();
    else { acknowledged = true; api.invalidateDashboardApiCacheForEvent('inbox:acknowledged'); }
    expect((await api.getInboxGlobal()).total).toBe(0);
  });

  it('resync invalidates GET, detail, and TanStack data without dropping retained values', async () => {
    clearPersistedDetailCache();
    writePersistedDetail('timeline', 'one', { rows: [] });
    queryClient.setQueryData(['gap'], { value: 1 });
    const fetch = vi.fn(async () => jsonResponse({ total: 1 }));
    vi.stubGlobal('fetch', fetch);
    await api.getInboxGlobal();
    api.invalidateDashboardCaches();
    expect(isPersistedDetailFresh('timeline', 'one')).toBe(false);
    expect(queryClient.getQueryState(['gap'])?.isInvalidated).toBe(true);
    await api.getInboxGlobal();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('expires knowledge backrefs locally after a write and on an artifact event', async () => {
    let backrefs: { id: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo, init?: RequestInit) => {
      if (init?.method === 'POST') {
        backrefs = [{ id: 'local-write' }];
        return jsonResponse({ backref: backrefs[0] });
      }
      return jsonResponse({ backrefs });
    }));
    const observer = new QueryObserver(queryClient, artifactBackrefsOptions('artifact'));
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await waitFor(() => expect(observer.getCurrentResult().data).toEqual([]));
      await api.createArtifactKnowledgeBackref('artifact', { ref_type: 'claim', external_ref: 'one' });
      await waitFor(() => expect(observer.getCurrentResult().data).toEqual([{ id: 'local-write' }]));
      backrefs = [{ id: 'external-write' }];
      api.invalidateDashboardApiCacheForEvent('artifact:changed');
      await waitFor(() => expect(observer.getCurrentResult().data).toEqual([{ id: 'external-write' }]));
    } finally {
      unsubscribe();
    }
  });

  it('deduplicates concurrent Space packet consumers through Query', async () => {
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

    const [packet, other] = await Promise.all([
      queryClient.fetchQuery(spacePacketOptions('sp1')),
      queryClient.fetchQuery(spacePacketOptions('sp1')),
    ]);

    expect(packet.space.id).toBe('sp1');
    expect(other.space.id).toBe('sp1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/spaces/sp1', expect.any(Object));
  });

  it('replaces a cancelled GET immediately and keeps the replacement joinable after old settlement', async () => {
    const oldTransport = deferred<Response>();
    const started = deferred<void>();
    const replacementTransport = deferred<Response>();
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => { started.resolve(); return oldTransport.promise; })
      .mockReturnValueOnce(replacementTransport.promise);
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const old = api.getSessions(undefined, { signal: controller.signal });
    const cancelled = expect(old).rejects.toMatchObject({ name: 'AbortError' });
    await started.promise;

    controller.abort();
    const replacement = api.getSessions();
    await setImmediate();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    oldTransport.reject(controller.signal.reason);
    await cancelled;
    await setImmediate();
    const joined = api.getSessions();
    await setImmediate();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    replacementTransport.resolve(jsonResponse({ items: [{ id: 'current' }] }));
    await expect(replacement).resolves.toEqual([{ id: 'current' }]);
    await expect(joined).resolves.toEqual([{ id: 'current' }]);
  });

  it('keeps a shared GET alive when one of its consumers cancels', async () => {
    const transport = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValue(transport.promise);
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const cancelled = api.getSessions(undefined, { signal: controller.signal });
    const remaining = api.getSessions();
    const cancellation = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });

    controller.abort();
    await cancellation;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
    transport.resolve(jsonResponse({ items: [{ id: 'shared' }] }));
    await expect(remaining).resolves.toEqual([{ id: 'shared' }]);
  });

  it('does not cache an aborted body that completes after its replacement', async () => {
    const body = deferred<unknown>();
    const readingBody = deferred<void>();
    const oldResponse = jsonResponse(null);
    vi.spyOn(oldResponse, 'json').mockImplementation(() => {
      readingBody.resolve();
      return body.promise;
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(oldResponse)
      .mockResolvedValueOnce(jsonResponse({ items: [{ id: 'current' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const old = api.getSessions(undefined, { signal: controller.signal });
    const cancelled = expect(old).rejects.toMatchObject({ name: 'AbortError' });
    await readingBody.promise;

    controller.abort();
    const replacement = api.getSessions();
    await cancelled;
    await setImmediate();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(replacement).resolves.toEqual([{ id: 'current' }]);
    body.resolve({ items: [{ id: 'obsolete' }] });
    await setImmediate();

    await expect(api.getSessions()).resolves.toEqual([{ id: 'current' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
      if (method === 'GET' && ['/api/spaces/sp1', '/api/spaces/sp2'].includes(path)) {
        return jsonResponse({
          space: {
            id: path.split('/').at(-1),
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

    await queryClient.fetchQuery(spacePacketOptions('sp1'));
    await queryClient.fetchQuery(spacePacketOptions('sp2'));
    await addSpaceItem('sp1', { ref_type: 'issue', ref_id: 'abc1234' });
    await queryClient.fetchQuery(spacePacketOptions('sp2'));
    await queryClient.fetchQuery(spacePacketOptions('sp1'));

    const getCalls = fetchMock.mock.calls.filter(([path, init]) =>
      String(path) === '/api/spaces/sp1' && ((init as RequestInit | undefined)?.method ?? 'GET') === 'GET',
    );
    expect(getCalls).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([path]) => String(path) === '/api/spaces/sp2')).toHaveLength(1);
  });
});
