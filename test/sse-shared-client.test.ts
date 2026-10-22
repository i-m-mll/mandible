import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const es = FakeEventSource.instances[0];
    es.open();
    es.emit({ type: 'heartbeat', data: { timestamp: 1 } });
    await vi.waitFor(() => expect(aEvents.length).toBe(1));
    expect(bEvents.length).toBe(1);

    // A releases: only A's handlers detach, socket stays open for B.
    a.close();
    es.emit({ type: 'heartbeat', data: { timestamp: 2 } });
    expect(aEvents.length).toBe(1);
    await vi.waitFor(() => expect(bEvents.length).toBe(2));
    expect(es.closed).toBe(false);
  });

  it('defers teardown to a timer so a re-acquire in the same tick keeps the socket', async () => {
    vi.useFakeTimers();
    const a = acquireSharedSse();
    a.connect();
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const es = FakeEventSource.instances[0];

    a.close(); // refcount 0 -> teardown scheduled
    const b = acquireSharedSse(); // re-acquire cancels teardown
    vi.advanceTimersByTime(1);
    expect(es.closed).toBe(false);
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

    b.close();
    vi.advanceTimersByTime(1);
    expect(es.closed).toBe(true);
  });

  it('re-acquires with a fresh fetch stream after full teardown; first open is not a reconnect', async () => {
    vi.useFakeTimers();
    const a = acquireSharedSse();
    a.connect();
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const es1 = FakeEventSource.instances[0];
    es1.open();
    a.close();
    vi.advanceTimersByTime(1);
    expect(es1.closed).toBe(true);

    const b = acquireSharedSse();
    const events: SSEPayload[] = [];
    const states: Array<{ state: string; reconnected: boolean }> = [];
    b.on('heartbeat', (p) => events.push(p));
    b.onState((state, meta) => states.push({ state, reconnected: meta.reconnected }));
    b.connect();
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(2));
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(2));
    const es2 = FakeEventSource.instances[1];
    es2.open();
    es2.emit({ type: 'heartbeat', data: { timestamp: 1 } });
    await vi.waitFor(() => expect(events.length).toBe(1));
    expect(states.find((s) => s.state === 'open')?.reconnected).toBe(false);
  });

  it('retains handlers across a dropped stream and reports reconnected on reopen', async () => {
    vi.useFakeTimers();
    const a = acquireSharedSse();
    const events: SSEPayload[] = [];
    const states: Array<{ state: string; reconnected: boolean }> = [];
    a.on('heartbeat', (p) => events.push(p));
    a.onState((state, meta) => states.push({ state, reconnected: meta.reconnected }));
    a.connect();
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const es1 = FakeEventSource.instances[0];
    es1.open();
    await vi.waitFor(() => expect(states.at(-1)).toEqual({ state: 'open', reconnected: false }));

    es1.error(); // terminal drop -> down + backoff
    await vi.waitFor(() => expect(states.at(-1)?.state).toBe('down'));
    await vi.advanceTimersByTimeAsync(500); // default backoff -> reconnect
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(2));
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(2));
    const es2 = FakeEventSource.instances[1];
    es2.open();
    await vi.waitFor(() => expect(states.at(-1)).toEqual({ state: 'open', reconnected: true }));
    es2.emit({ type: 'heartbeat', data: { timestamp: 1 } });
    await vi.waitFor(() => expect(events.length).toBe(1));
  });

  it('cancels the pending reconnect timer when the last handle releases mid-backoff', async () => {
    vi.useFakeTimers();
    const a = acquireSharedSse();
    a.connect();
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const es1 = FakeEventSource.instances[0];
    es1.open();
    es1.error(); // schedules reconnect at +500ms
    a.close(); // teardown at +0ms cancels the retry timer
    vi.advanceTimersByTime(1000);
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    expect(es1.closed).toBe(true);
  });

  it('decrements the refcount only once for a double close', async () => {
    vi.useFakeTimers();
    const a = acquireSharedSse();
    const b = acquireSharedSse();
    a.connect();
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const es = FakeEventSource.instances[0];
    es.open();

    a.close();
    a.close(); // no-op; must not drop B's refcount
    vi.advanceTimersByTime(10);
    expect(es.closed).toBe(false);

    b.close();
    vi.advanceTimersByTime(10);
    expect(es.closed).toBe(true);
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
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const es = FakeEventSource.instances[0];
    es.open();
    es.emit({ type: 'heartbeat', data: { timestamp: 1 } });
    await vi.waitFor(() => expect(wildcardRan).toBe(true));
    expect(errorSpy).toHaveBeenCalled();
  });

  it('exposes the live connection state through the handle getState()', async () => {
    vi.useFakeTimers();
    const a = acquireSharedSse();
    expect(a.getState()).toBe('idle');
    a.connect();
    expect(a.getState()).toBe('connecting');
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const es = FakeEventSource.instances[0];
    es.open();
    await vi.waitFor(() => expect(a.getState()).toBe('open'));
    es.error(); // terminal drop -> down + backoff
    await vi.waitFor(() => expect(a.getState()).toBe('down'));
    await vi.advanceTimersByTimeAsync(500); // reconnect attempt
    FakeEventSource.instances[1].open();
    await vi.waitFor(() => expect(a.getState()).toBe('open'));
  });

  it('dispatches exact handlers before wildcard handlers, each in registration order', async () => {
    const a = acquireSharedSse();
    const order: string[] = [];
    a.on('heartbeat', () => order.push('exact1'));
    a.on('heartbeat', () => order.push('exact2'));
    a.on('*', () => order.push('star1'));
    a.on('*', () => order.push('star2'));
    a.connect();
    await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const es = FakeEventSource.instances[0];
    es.open();
    es.emit({ type: 'heartbeat', data: { timestamp: 1 } });
    await vi.waitFor(() => expect(order).toEqual(['exact1', 'exact2', 'star1', 'star2']));
  });
});
