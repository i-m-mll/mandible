import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitUntilPasses } from './helpers/wait-until.js';
import { acquireSharedSse, __resetSharedSseForTests } from '../ui/src/sse-shared';
import type { SSEPayload } from '../ui/src/sse-client';
import { __resetBrowserSessionForTests, ensureClientAccess } from '../ui/src/client-auth-token';

/**
 * Controllable fake EventSource. Tests drive `open()` / `error()` / `emit()`
 * manually so backoff, reconnect, and teardown timing are deterministic.
 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private messageListeners = new Set<(event: MessageEvent) => void>();
  private errorListeners = new Set<() => void>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    if (type === 'message') this.messageListeners.add(listener);
    if (type === 'error') this.errorListeners.add(listener as unknown as () => void);
  }

  removeEventListener(): void {}

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  /** Simulate the browser opening the stream. */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** Simulate a terminal socket error (browser gave up). */
  error(): void {
    this.readyState = 2;
    this.onerror?.();
    for (const listener of this.errorListeners) listener();
  }

  /** Emit a server event payload. */
  emit(payload: Record<string, unknown>): void {
    const event = new MessageEvent('message', { data: JSON.stringify(payload) });
    for (const listener of this.messageListeners) listener(event);
  }
}

function reset(): void {
  FakeEventSource.instances = [];
  __resetSharedSseForTests(FakeEventSource as unknown as typeof EventSource);
}

describe('shared SSE client', () => {
  beforeEach(async () => {
    // This file exercises document-local sharing; cross-tab election has its own suite.
    vi.stubGlobal("BroadcastChannel", undefined);
    __resetBrowserSessionForTests();
    await ensureClientAccess(async () => new Response(JSON.stringify({ authenticated: true, session: { csrf_token: 'csrf-sse',
    } }), { status: 200, headers: { 'content-type': 'application/json' } }));
    reset();
  });

  afterEach(() => {
    __resetSharedSseForTests();
    __resetBrowserSessionForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('opens exactly one fetch stream for two handles and dispatches to both; closing one keeps the other', async () => {
    const a = acquireSharedSse();
    const b = acquireSharedSse();
    const aEvents: SSEPayload[] = [];
    const bEvents: SSEPayload[] = [];
    a.on('heartbeat', (p) => aEvents.push(p));
    b.on('heartbeat', (p) => bEvents.push(p));
    a.connect();
    b.connect();

    await waitUntilPasses(() => expect(FakeEventSource.instances.length).toBe(1));
    await waitUntilPasses(() => expect(FakeEventSource.instances.length).toBe(1));
    const es = FakeEventSource.instances[0];
    es.open();
    es.emit({ type: 'heartbeat', data: { timestamp: 1 } });
    await waitUntilPasses(() => expect(aEvents.length).toBe(1));
    expect(bEvents.length).toBe(1);

    // A releases: only A's handlers detach, socket stays open for B.
    a.close();
    es.emit({ type: 'heartbeat', data: { timestamp: 2 } });
    expect(aEvents.length).toBe(1);
    await waitUntilPasses(() => expect(bEvents.length).toBe(2));
    expect(es.closed).toBe(false);
  });

  it('retains handlers across a dropped stream and reports reconnected on reopen', async () => {
    vi.useFakeTimers();
    const a = acquireSharedSse();
    const events: SSEPayload[] = [];
    const states: Array<{ state: string; reconnected: boolean }> = [];
    a.on('heartbeat', (p) => events.push(p));
    a.onState((state, meta) => states.push({ state, reconnected: meta.reconnected }));
    a.connect();
    await waitUntilPasses(() => expect(FakeEventSource.instances.length).toBe(1));
    const es1 = FakeEventSource.instances[0];
    es1.open();
    await waitUntilPasses(() => expect(states.at(-1)).toEqual({ state: 'open', reconnected: false }));

    es1.error(); // terminal drop -> down + backoff
    await waitUntilPasses(() => expect(states.at(-1)?.state).toBe('down'));
    await vi.advanceTimersByTimeAsync(500); // default backoff -> reconnect
    await waitUntilPasses(() => expect(FakeEventSource.instances.length).toBe(2));
    await waitUntilPasses(() => expect(FakeEventSource.instances.length).toBe(2));
    const es2 = FakeEventSource.instances[1];
    es2.open();
    await waitUntilPasses(() => expect(states.at(-1)).toEqual({ state: 'open', reconnected: true }));
    es2.emit({ type: 'heartbeat', data: { timestamp: 1 } });
    await waitUntilPasses(() => expect(events.length).toBe(1));
  });

  it('cancels the pending reconnect timer when the last handle releases mid-backoff', async () => {
    vi.useFakeTimers();
    const a = acquireSharedSse();
    a.connect();
    await waitUntilPasses(() => expect(FakeEventSource.instances.length).toBe(1));
    const es1 = FakeEventSource.instances[0];
    es1.open();
    es1.error(); // schedules reconnect at +500ms
    a.close(); // teardown at +0ms cancels the retry timer
    vi.advanceTimersByTime(1000);
    await waitUntilPasses(() => expect(FakeEventSource.instances.length).toBe(1));
    expect(es1.closed).toBe(true);
  });

  it('isolates a throwing handler so other handlers for the same event still run', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = acquireSharedSse();
    let wildcardRan = false;
    a.on('heartbeat', () => {
      throw new Error('boom');
    });
    a.on('*', () => {
      wildcardRan = true;
    });
    a.connect();
    await waitUntilPasses(() => expect(FakeEventSource.instances.length).toBe(1));
    const es = FakeEventSource.instances[0];
    es.open();
    es.emit({ type: 'heartbeat', data: { timestamp: 1 } });
    await waitUntilPasses(() => expect(wildcardRan).toBe(true));
    expect(errorSpy).toHaveBeenCalled();
  });
});
