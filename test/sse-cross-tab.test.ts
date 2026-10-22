import { describe, expect, it, vi } from 'vitest';
import { getGraph, invalidateApiGetCache } from '../ui/src/api';
import { establishTestClientAccess } from './helpers/local-client-access';
import { __resetBrowserSessionForTests } from '../ui/src/client-auth-token';
import {
  CrossTabSseCoordinator,
  type BroadcastChannelLike,
  type ExclusiveLockManager,
} from '../ui/src/sse-cross-tab';
import type {
  SSEHandler,
  SSEPayload,
  SseConnectionState,
  SseStateHandler,
} from '../ui/src/sse-client';

class FakeTransport {
  readonly listeners = new Map<string, Set<SSEHandler>>();
  readonly stateListeners = new Set<SseStateHandler>();
  state: SseConnectionState = 'idle';
  connectCount = 0;
  disconnectCount = 0;

  on(type: string, handler: SSEHandler): () => void {
    const bucket = this.listeners.get(type) ?? new Set<SSEHandler>();
    bucket.add(handler);
    this.listeners.set(type, bucket);
    return () => bucket.delete(handler);
  }

  onState(handler: SseStateHandler): () => void {
    this.stateListeners.add(handler);
    return () => this.stateListeners.delete(handler);
  }

  getState(): SseConnectionState {
    return this.state;
  }

  connect(): void {
    this.connectCount += 1;
    this.setState('connecting');
  }

  disconnect(): void {
    this.disconnectCount += 1;
    this.setState('idle');
  }

  open(): void {
    this.setState('open');
  }

  emit(payload: SSEPayload): void {
    this.listeners.get(payload.type)?.forEach((handler) => handler(payload));
    this.listeners.get('*')?.forEach((handler) => handler(payload));
  }

  private setState(state: SseConnectionState): void {
    this.state = state;
    this.stateListeners.forEach((handler) => handler(state, { reconnected: false }));
  }
}

class FakeChannel implements BroadcastChannelLike {
  readonly listeners = new Set<(event: MessageEvent) => void>();
  closed = false;

  constructor(
    readonly name: string,
    private readonly bus: FakeBroadcastBus,
  ) {}

  postMessage(message: unknown): void {
    this.bus.broadcast(this, message);
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.listeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    this.bus.close(this);
  }
}

class FakeBroadcastBus {
  readonly channels = new Set<FakeChannel>();
  readonly messages: unknown[] = [];

  readonly createChannel = (name: string): BroadcastChannelLike => {
    const channel = new FakeChannel(name, this);
    this.channels.add(channel);
    return channel;
  };

  broadcast(sender: FakeChannel, message: unknown): void {
    this.messages.push(message);
    for (const channel of this.channels) {
      if (channel !== sender && !channel.closed && channel.name === sender.name) {
        const event = { data: message } as MessageEvent;
        channel.listeners.forEach((listener) => listener(event));
      }
    }
  }

  close(channel: FakeChannel): void {
    this.channels.delete(channel);
  }
}

type PendingLock = {
  signal: AbortSignal;
  callback: (lock: unknown) => Promise<unknown> | unknown;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

class FakeExclusiveLocks implements ExclusiveLockManager {
  private readonly queue: PendingLock[] = [];
  private active: PendingLock | null = null;
  activeCount = 0;
  maxActiveCount = 0;

  request<T>(
    _name: string,
    options: { mode: 'exclusive'; signal: AbortSignal },
    callback: (lock: unknown) => Promise<T> | T,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const pending: PendingLock = {
        signal: options.signal,
        callback,
        resolve: (value) => resolve(value as T),
        reject,
      };
      const abort = () => {
        if (this.active === pending) {
          return;
        }
        const index = this.queue.indexOf(pending);
        if (index >= 0) {
          this.queue.splice(index, 1);
          const error = new Error('Lock request aborted');
          error.name = 'AbortError';
          reject(error);
        }
      };
      options.signal.addEventListener('abort', abort, { once: true });
      this.queue.push(pending);
      this.pump();
    });
  }

  private pump(): void {
    if (this.active) {
      return;
    }
    const next = this.queue.shift();
    if (!next) {
      return;
    }
    if (next.signal.aborted) {
      const error = new Error('Lock request aborted');
      error.name = 'AbortError';
      next.reject(error);
      this.pump();
      return;
    }
    this.active = next;
    this.activeCount += 1;
    this.maxActiveCount = Math.max(this.maxActiveCount, this.activeCount);
    void Promise.resolve(next.callback({ name: 'mandible:sse:leader:v1' })).then(
      (value) => {
        this.active = null;
        this.activeCount -= 1;
        next.resolve(value);
        this.pump();
      },
      (error) => {
        this.active = null;
        this.activeCount -= 1;
        next.reject(error);
        this.pump();
      },
    );
  }
}

function makeCoordinator(
  bus: FakeBroadcastBus,
  locks: FakeExclusiveLocks,
  transports: FakeTransport[],
): CrossTabSseCoordinator {
  return new CrossTabSseCoordinator({
    createTransport: () => {
      const transport = new FakeTransport();
      transports.push(transport);
      return transport;
    },
    channelFactory: bus.createChannel,
    lockManager: locks,
    announceIntervalMs: 1_000_000,
  });
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

describe('cross-tab SSE coordinator', () => {
  it('uses one locked transport and fans events and state out once to a follower', () => {
    const bus = new FakeBroadcastBus();
    const locks = new FakeExclusiveLocks();
    const leaderTransports: FakeTransport[] = [];
    const followerTransports: FakeTransport[] = [];
    const leader = makeCoordinator(bus, locks, leaderTransports);
    const follower = makeCoordinator(bus, locks, followerTransports);
    const leaderEvents: SSEPayload[] = [];
    const followerEvents: SSEPayload[] = [];

    leader.on('issue:updated', (payload) => leaderEvents.push(payload));
    follower.on('issue:updated', (payload) => followerEvents.push(payload));
    const followerErrors: Array<string | null | undefined> = [];
    follower.onState((_state, meta) => followerErrors.push(meta.error));
    leader.connect();
    leaderTransports[0].open();
    follower.connect();

    expect(leaderTransports).toHaveLength(1);
    expect(followerTransports).toHaveLength(0);
    expect(locks.maxActiveCount).toBe(1);
    expect(follower.getState()).toBe('open');
    leaderTransports[0].stateListeners.forEach((handler) => handler('down', { reconnected: false, error: 'Invalid live update' }));
    expect(follower.getState()).toBe('down');
    expect(followerErrors.at(-1)).toBe('Invalid live update');
    leaderTransports[0].open();
    expect(followerErrors.at(-1)).toBeNull();

    leaderTransports[0].emit({ type: 'issue:updated', issue_id: 'abc' } as SSEPayload);
    expect(leaderEvents).toHaveLength(1);
    expect(followerEvents).toEqual(leaderEvents);

    leader.disconnect();
    follower.disconnect();
  });

  it('promotes a waiting follower when the leader disconnects and marks its open as a reconnect', async () => {
    const bus = new FakeBroadcastBus();
    const locks = new FakeExclusiveLocks();
    const firstTransports: FakeTransport[] = [];
    const secondTransports: FakeTransport[] = [];
    const first = makeCoordinator(bus, locks, firstTransports);
    const second = makeCoordinator(bus, locks, secondTransports);
    const secondStates: Array<{ state: SseConnectionState; reconnected: boolean }> = [];
    second.onState((state, meta) => secondStates.push({ state, reconnected: meta.reconnected }));

    first.connect();
    firstTransports[0].open();
    second.connect();
    expect(second.getState()).toBe('open');

    first.disconnect();
    await flushPromises();
    expect(secondTransports).toHaveLength(1);
    expect(firstTransports[0].disconnectCount).toBe(1);
    expect(locks.maxActiveCount).toBe(1);

    secondTransports[0].open();
    expect(secondStates.at(-1)).toEqual({ state: 'open', reconnected: true });
    second.disconnect();
  });

  it('falls back to one document-local transport when cross-tab primitives are unavailable', () => {
    const transports: FakeTransport[] = [];
    const coordinator = new CrossTabSseCoordinator({
      createTransport: () => {
        const transport = new FakeTransport();
        transports.push(transport);
        return transport;
      },
      channelFactory: null,
      lockManager: null,
    });

    coordinator.connect();
    coordinator.connect();
    expect(transports).toHaveLength(1);
    expect(transports[0].connectCount).toBe(1);
    coordinator.disconnect();
  });
});


it('invalidates warmed data before exact and wildcard consumer reads while heartbeat stays warm', async () => {
  await establishTestClientAccess();
  invalidateApiGetCache();
  let revision = 1;
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ nodes: [], edges: [], mode: 'issue', revision }), {
    headers: { 'content-type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetchMock);
  const transport = new FakeTransport();
  const coordinator = new CrossTabSseCoordinator({ createTransport: () => transport, channelFactory: null, lockManager: null });
  const reads: Array<ReturnType<typeof getGraph>> = [];
  coordinator.on('ledger:issue:updated', () => reads.push(getGraph({ mode: 'issue' })));
  coordinator.on('*', () => reads.push(getGraph({ mode: 'issue' })));
  coordinator.connect();
  try {
    expect(await getGraph({ mode: 'issue' })).toMatchObject({ revision: 1 });
    revision = 2;
    transport.emit({ type: 'heartbeat', data: { timestamp: Date.now() } });
    expect(await reads.pop()).toMatchObject({ revision: 1 });
    expect(fetchMock).toHaveBeenCalledOnce();
    transport.emit({ type: 'ledger:issue:updated', data: { issue_id: 'issue-one', project_id: 'project-one' } });
    expect(await Promise.all(reads)).toEqual([
      expect.objectContaining({ revision: 2 }), expect.objectContaining({ revision: 2 }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally {
    coordinator.disconnect();
    invalidateApiGetCache();
    __resetBrowserSessionForTests();
    vi.unstubAllGlobals();
  }
});
