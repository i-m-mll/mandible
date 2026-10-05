import { afterEach, expect, it } from 'vitest';
import { waitFor } from '@testing-library/preact';
import { QueryClient } from '@tanstack/preact-query';
import { createSSEClient, type SseStateHandler, type SSEPayload } from '../../ui/src/sse-client';
import { __resetBrowserSessionForTests } from '../../ui/src/client-auth-token';
import { browserResourceKeys, browserResourceKeysForEvent, refreshBrowserResources } from '../../ui/src/query/browserResources';

afterEach(() => __resetBrowserSessionForTests());

it('rejects malformed wire frames without replacing useful content and resumes on valid events', async () => {
  __resetBrowserSessionForTests();
  const cache = new QueryClient();
  const lastGood = { briefings: [{ title: 'My current document' }] };
  cache.setQueryData(browserResourceKeys.briefingSidebar, lastGood);
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const fetchImpl = (async (input, init) => {
    if (String(input) === '/api/client-auth/whoami') {
      return new Response(JSON.stringify({ authenticated: true, session: { csrf_token: 'fixture' } }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller;
        init?.signal?.addEventListener('abort', () => controller.close(), { once: true });
      },
    }));
  }) as typeof fetch;
  const client = createSSEClient({ fetchImpl });
  const events: SSEPayload[] = [];
  const states: Array<{ state: string; meta: Parameters<SseStateHandler>[1] }> = [];
  client.on('*', (event) => {
    events.push(event);
    void refreshBrowserResources(cache, browserResourceKeysForEvent(event.type, event.data));
  });
  client.onState((state, meta) => states.push({ state, meta }));
  client.connect();
  try {
    await waitFor(() => expect(client.getState()).toBe('open'));
    for (const [frame, error] of [
      ['{broken', 'Invalid JSON'],
      [JSON.stringify({ type: 'briefing:group-name-updated', data: {} }), 'Invalid briefing:group-name-updated event payload'],
      [JSON.stringify({ type: 'space:block:changed', data: {} }), 'Invalid space:block:changed event payload'],
      [JSON.stringify({ type: 'unknown', data: {} }), 'Invalid domain event envelope'],
    ]) {
      stream.enqueue(new TextEncoder().encode(`data: ${frame}\n\n`));
      await waitFor(() => expect(states.at(-1)?.meta.error).toContain(error));
      expect(events).toEqual([]);
      expect(cache.getQueryState(browserResourceKeys.briefingSidebar)?.isInvalidated).toBe(false);
      expect(cache.getQueryData(browserResourceKeys.briefingSidebar)).toEqual(lastGood);
    }
    stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
      type: 'briefing:group-name-updated', data: { group_id: 'group-one' },
    })}\n\n`));
    await waitFor(() => expect(events).toHaveLength(1));
    await waitFor(() => expect(cache.getQueryState(browserResourceKeys.briefingSidebar)?.isInvalidated).toBe(true));
    expect(states.at(-1)).toEqual({ state: 'open', meta: { reconnected: true, error: null } });
    expect(cache.getQueryData(browserResourceKeys.briefingSidebar)).toEqual(lastGood);
  } finally {
    client.close();
    cache.clear();
  }
});
