import {
  SSEClient,
  type SSEHandler,
  type SseConnectionState,
  type SseStateHandler,
} from './sse-client';
import { CrossTabSseCoordinator } from './sse-cross-tab';

/**
 * A ref-counted handle onto the document-local SSE subscription coordinator.
 *
 * Every mounted consumer acquires its own handle. Within a document the module
 * keeps one coordinator; across documents an origin-scoped Web Lock elects one
 * SSE leader and BroadcastChannel fans its events out to followers. Releasing
 * a handle (`close()`) detaches only that handle's subscriptions and decrements
 * the refcount; the origin-wide stream remains available while any leader tab
 * is connected. Unsupported browsers retain the document-local singleton.
 */
export type SseHandle = {
  /** Subscribe to an event type (or '*'); returns an unsubscribe for this handler. */
  on(type: string, handler: SSEHandler): () => void;
  /** Observe connection-state transitions (reconnect resync hook). */
  onState(handler: SseStateHandler): () => void;
  /** Current connection-state of the shared client (poll-gate freshness). */
  getState(): SseConnectionState;
  /** Ensure the shared client is connected. Idempotent. */
  connect(): void;
  /** Release this handle: detach its handlers and decrement the refcount. Idempotent. */
  close(): void;
};

/**
 * Fallback-poll gate: the heavy periodic refetch is skipped only while the
 * shared SSE socket is `open` AND a server signal (event or heartbeat) arrived
 * within `freshForMs`. A non-open socket, or heartbeat silence beyond the
 * window (default three 15 s intervals), re-enables the poll so a silently
 * wedged stream cannot leave the dashboard stale.
 */
export function shouldSkipFallbackPoll(
  state: SseConnectionState,
  lastSignalAt: number,
  now: number,
  freshForMs = 45_000,
): boolean {
  return state === 'open' && now - lastSignalAt < freshForMs;
}

let sharedCoordinator: CrossTabSseCoordinator | null = null;
let refCount = 0;
let teardownTimer: ReturnType<typeof setTimeout> | null = null;
let testFetchImpl: typeof fetch | null = null;

type EventSourceTestConstructor = new (url: string) => {
  addEventListener(type: string, listener: EventListener): void;
  close(): void;
};

// Transitional test adapter only: old view fixtures still expose an
// EventSource-shaped controller, but their events enter the production
// SSEClient as actual encoded ReadableStream chunks. There is no alternate
// transport or parser path in application code.
function eventSourceFixtureAsFetch(EventSourceFixture: EventSourceTestConstructor): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const pathname = new URL(String(input), window.location.href).pathname;
    if (pathname === '/api/client-auth/whoami') {
      return new Response(JSON.stringify({ authenticated: true, session: {
        family_id: 'test-sse-family', audience: 'production', csrf_token: 'test-sse-csrf',
        effect_ceiling: ['ledger:read'],
      } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const source = new EventSourceFixture(String(input));
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        source.addEventListener('message', ((event: MessageEvent) => {
          controller?.enqueue(new TextEncoder().encode(`data: ${event.data}\n\n`));
        }) as EventListener);
        source.addEventListener('error', (() => {
          controller?.error(new Error('fixture stream failed'));
          controller = null;
        }) as EventListener);
        init?.signal?.addEventListener('abort', () => {
          source.close();
          controller?.close();
          controller = null;
        }, { once: true });
      },
      cancel() { source.close(); controller = null; },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
}

function ensureCoordinator(): CrossTabSseCoordinator {
  if (!sharedCoordinator) {
    sharedCoordinator = new CrossTabSseCoordinator({
      createTransport: () => new SSEClient(testFetchImpl ? { fetchImpl: testFetchImpl } : {}),
    });
  }
  return sharedCoordinator;
}

function scheduleTeardown(): void {
  if (teardownTimer !== null) {
    return;
  }
  // Deferred teardown: an effect cleanup+setup pair in one commit (e.g. the
  // app.tsx SSE effect re-running on a callback identity change) would
  // otherwise drop and immediately re-open the socket. Defer the disconnect so
  // an intervening re-acquire can cancel it and reuse the live connection.
  teardownTimer = setTimeout(() => {
    teardownTimer = null;
    if (refCount <= 0 && sharedCoordinator) {
      sharedCoordinator.disconnect();
    }
  }, 0);
}

function cancelTeardown(): void {
  if (teardownTimer !== null) {
    clearTimeout(teardownTimer);
    teardownTimer = null;
  }
}

export function acquireSharedSse(): SseHandle {
  refCount += 1;
  // A pending teardown means we are re-acquiring before the socket was dropped:
  // cancel it and reuse the live connection.
  cancelTeardown();
  const coordinator = ensureCoordinator();

  const offs = new Set<() => void>();
  let released = false;

  const track = (off: () => void): (() => void) => {
    let removed = false;
    const wrapped = () => {
      if (removed) {
        return;
      }
      removed = true;
      offs.delete(wrapped);
      off();
    };
    offs.add(wrapped);
    return wrapped;
  };

  return {
    on(type, handler) {
      return track(coordinator.on(type, handler));
    },
    onState(handler) {
      return track(coordinator.onState(handler));
    },
    getState() {
      return coordinator.getState();
    },
    connect() {
      coordinator.connect();
    },
    close() {
      if (released) {
        return;
      }
      released = true;
      for (const off of Array.from(offs)) {
        off();
      }
      offs.clear();
      refCount -= 1;
      if (refCount <= 0) {
        refCount = 0;
        scheduleTeardown();
      }
    },
  };
}

/**
 * Test-only reset: drops the authenticated fetch-stream singleton and refcount
 * so each test starts clean.
 */
export function __resetSharedSseForTests(fetchImpl?: typeof fetch | EventSourceTestConstructor): void {
  cancelTeardown();
  if (sharedCoordinator) {
    sharedCoordinator.disconnect();
  }
  sharedCoordinator = null;
  refCount = 0;
  const fixture = fetchImpl ?? (typeof globalThis.EventSource === 'function'
    ? globalThis.EventSource as unknown as EventSourceTestConstructor
    : undefined);
  testFetchImpl = fixture
    ? (/^class\s/.test(Function.prototype.toString.call(fixture))
      ? eventSourceFixtureAsFetch(fixture as EventSourceTestConstructor)
      : fixture as typeof fetch)
    : null;
}
