import {
  SSEClient,
  type SSEHandler,
  type SseConnectionState,
  type SseStateHandler,
} from './sse-client';

/**
 * A ref-counted handle onto the process-wide singleton {@link SSEClient}.
 *
 * Every mounted consumer acquires its own handle; the module keeps exactly one
 * EventSource open regardless of how many handles exist. Releasing a handle
 * (`close()`) detaches only that handle's subscriptions and decrements the
 * refcount; the socket stays open while any handle remains. This collapses the
 * former up-to-nine concurrent `/api/events` streams to one, freeing Chrome's
 * six-connections-per-host budget for ordinary fetches.
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

let sharedClient: SSEClient | null = null;
let refCount = 0;
let teardownTimer: ReturnType<typeof setTimeout> | null = null;
let EventSourceOverride: typeof EventSource | undefined;

function ensureClient(): SSEClient {
  if (!sharedClient) {
    sharedClient = new SSEClient(
      EventSourceOverride ? { EventSourceImpl: EventSourceOverride } : {},
    );
  }
  return sharedClient;
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
    if (refCount <= 0 && sharedClient) {
      sharedClient.disconnect();
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
  const client = ensureClient();

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
      return track(client.on(type, handler));
    },
    onState(handler) {
      return track(client.onState(handler));
    },
    getState() {
      return client.getState();
    },
    connect() {
      client.connect();
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
 * Test-only reset: drops the singleton and refcount so each test starts clean,
 * optionally installing a fake EventSource used for all subsequently-created
 * shared clients.
 */
export function __resetSharedSseForTests(impl?: typeof EventSource): void {
  cancelTeardown();
  if (sharedClient) {
    sharedClient.disconnect();
  }
  sharedClient = null;
  refCount = 0;
  EventSourceOverride = impl;
}
