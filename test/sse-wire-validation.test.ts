import { afterEach, expect, it, vi } from 'vitest';
import { waitFor } from './helpers/dom.js';
import { QueryClient } from '@tanstack/preact-query';
import { createSSEClient, type SseStateHandler, type SSEPayload } from '../ui/src/sse-client';
import { __resetBrowserSessionForTests } from '../ui/src/client-auth-token';
import { browserResourceKeys, browserResourceKeysForEvent, refreshBrowserResources } from '../ui/src/query/browserResources';

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


it('ignores a delayed subscribe response after disconnect and a newer connection', async () => {
  const responses: Array<(response: Response) => void> = [];
  const fetchImpl = (async (input) => {
    if (String(input) === '/api/client-auth/whoami') return new Response(JSON.stringify({ authenticated: true, session: { csrf_token: 'fixture' } }));
    return await new Promise<Response>((resolve) => responses.push(resolve));
  }) as typeof fetch;
  const client = createSSEClient({ fetchImpl });
  client.connect();
  await waitFor(() => expect(responses).toHaveLength(1));
  client.disconnect();
  client.connect();
  await waitFor(() => expect(responses).toHaveLength(2));
  const canceled = vi.fn();
  responses[0](new Response(new ReadableStream({ cancel: canceled })));
  await waitFor(() => expect(canceled).toHaveBeenCalledOnce());
  expect(client.getState()).toBe('connecting');
  let currentStream!: ReadableStreamDefaultController<Uint8Array>;
  responses[1](new Response(new ReadableStream({ start(controller) { currentStream = controller; } })));
  await waitFor(() => expect(client.getState()).toBe('open'));
  client.close();
  currentStream.close();
});

it('does not retry when a connection-state listener disconnects at stream completion', async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let subscriptions = 0;
  const fetchImpl = (async (input) => {
    if (String(input) === '/api/client-auth/whoami') return new Response(JSON.stringify({ authenticated: true, session: { csrf_token: 'fixture' } }));
    subscriptions += 1;
    return new Response(new ReadableStream({ start(controller) { stream = controller; } }));
  }) as typeof fetch;
  const client = createSSEClient({ fetchImpl });
  client.connect();
  await waitFor(() => expect(client.getState()).toBe('open'));
  vi.useFakeTimers();
  try {
    const disconnected = new Promise<void>((resolve) => client.onState((state) => {
      if (state === 'down') { client.disconnect(); resolve(); }
    }));
    stream.close();
    await disconnected;
    await vi.runAllTimersAsync();
    expect(subscriptions).toBe(1);
    expect(client.getState()).toBe('idle');
  } finally {
    client.close();
    vi.useRealTimers();
  }
});
