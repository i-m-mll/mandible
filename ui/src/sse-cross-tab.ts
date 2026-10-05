import type {
  SSEHandler,
  SSEPayload,
  SseConnectionState,
  SseStateHandler,
} from './sse-client';

const PROTOCOL_VERSION = 1;
const DEFAULT_CHANNEL_NAME = 'mandible:sse:v1';
const DEFAULT_LOCK_NAME = 'mandible:sse:leader:v1';
const ANNOUNCE_INTERVAL_MS = 10_000;

type StateMeta = { reconnected: boolean; error: string | null };

export type SseTransport = {
  on(type: string, handler: SSEHandler): () => void;
  onState(handler: SseStateHandler): () => void;
  getState(): SseConnectionState;
  connect(): void;
  disconnect(): void;
};

export type BroadcastChannelLike = {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  close(): void;
};

export type ExclusiveLockManager = {
  request<T>(
    name: string,
    options: { mode: 'exclusive'; signal: AbortSignal },
    callback: (lock: unknown) => Promise<T> | T,
  ): Promise<T>;
};

export type CrossTabSseCoordinatorOptions = {
  createTransport: () => SseTransport;
  channelFactory?: ((name: string) => BroadcastChannelLike) | null;
  lockManager?: ExclusiveLockManager | null;
  channelName?: string;
  lockName?: string;
  announceIntervalMs?: number;
};

type HelloMessage = {
  version: typeof PROTOCOL_VERSION;
  kind: 'hello';
  sourceId: string;
};

type StateMessage = {
  version: typeof PROTOCOL_VERSION;
  kind: 'state';
  sourceId: string;
  leaderEpoch: string;
  state: SseConnectionState;
  error?: string | null;
};

type EventMessage = {
  version: typeof PROTOCOL_VERSION;
  kind: 'event';
  sourceId: string;
  leaderEpoch: string;
  sequence: number;
  payload: SSEPayload;
};

type LeaderReleasedMessage = {
  version: typeof PROTOCOL_VERSION;
  kind: 'leader-released';
  sourceId: string;
  leaderEpoch: string;
};

type CrossTabMessage = HelloMessage | StateMessage | EventMessage | LeaderReleasedMessage;

function createInstanceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function defaultChannelFactory(): ((name: string) => BroadcastChannelLike) | null {
  if (typeof BroadcastChannel !== 'function') {
    return null;
  }
  return (name) => new BroadcastChannel(name);
}

function defaultLockManager(): ExclusiveLockManager | null {
  if (typeof navigator === 'undefined' || !navigator.locks) {
    return null;
  }
  return navigator.locks as ExclusiveLockManager;
}

function isConnectionState(value: unknown): value is SseConnectionState {
  return value === 'idle' || value === 'connecting' || value === 'open' || value === 'down';
}

function isCrossTabMessage(value: unknown): value is CrossTabMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const message = value as Record<string, unknown>;
  if (message.version !== PROTOCOL_VERSION || typeof message.sourceId !== 'string') {
    return false;
  }
  if (message.kind === 'hello') {
    return true;
  }
  if (typeof message.leaderEpoch !== 'string') {
    return false;
  }
  if (message.kind === 'leader-released') {
    return true;
  }
  if (message.kind === 'state') {
    return isConnectionState(message.state) && (message.error === undefined || message.error === null || typeof message.error === 'string');
  }
  if (message.kind === 'event') {
    return Number.isSafeInteger(message.sequence)
      && message.sequence as number > 0
      && !!message.payload
      && typeof message.payload === 'object'
      && typeof (message.payload as Record<string, unknown>).type === 'string';
  }
  return false;
}

function isAbortError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError';
}

/**
 * One document-local subscription hub backed by at most one origin-wide SSE
 * transport. Web Locks supplies exclusive leadership; BroadcastChannel fans
 * the leader's JSON events and connection state out to follower documents.
 *
 * BroadcastChannel alone cannot make leader election exclusive. If either
 * primitive is missing or lock acquisition itself fails, this coordinator
 * deliberately falls back to the previous document-local transport.
 */
export class CrossTabSseCoordinator {
  private readonly createTransport: () => SseTransport;
  private readonly channelFactory: ((name: string) => BroadcastChannelLike) | null;
  private readonly lockManager: ExclusiveLockManager | null;
  private readonly channelName: string;
  private readonly lockName: string;
  private readonly announceIntervalMs: number;
  private readonly instanceId = createInstanceId();
  private readonly listeners = new Map<string, Set<SSEHandler>>();
  private readonly stateListeners = new Set<SseStateHandler>();
  private pendingEvents: SSEPayload[] = [];
  private state: SseConnectionState = 'idle';
  private error: string | null = null;
  private hasOpened = false;
  private started = false;
  private channel: BroadcastChannelLike | null = null;
  private lockAbort: AbortController | null = null;
  private releaseLeadership: (() => void) | null = null;
  private isLeader = false;
  private leaderEpoch: string | null = null;
  private activeLeaderEpoch: string | null = null;
  private readonly retiredLeaderEpochs = new Set<string>();
  private eventSequence = 0;
  private lastSequenceByLeader = new Map<string, number>();
  private announceTimer: ReturnType<typeof setInterval> | null = null;
  private transport: SseTransport | null = null;
  private transportOffs: Array<() => void> = [];

  private readonly onChannelMessage = (event: MessageEvent): void => {
    const message = event.data;
    if (!isCrossTabMessage(message) || message.sourceId === this.instanceId) {
      return;
    }

    if (message.kind === 'hello') {
      if (this.isLeader) {
        this.announceState();
      }
      return;
    }

    if (message.kind === 'leader-released') {
      this.retiredLeaderEpochs.add(message.leaderEpoch);
      if (this.activeLeaderEpoch === message.leaderEpoch) {
        this.activeLeaderEpoch = null;
        if (this.started && !this.isLeader) {
          this.setState('connecting');
        }
      }
      // A successor may already own the lock. Ask it to re-announce so
      // cross-sender message ordering cannot strand us on the retired epoch.
      this.post({
        version: PROTOCOL_VERSION,
        kind: 'hello',
        sourceId: this.instanceId,
      });
      return;
    }

    if (this.isLeader || this.retiredLeaderEpochs.has(message.leaderEpoch)) {
      return;
    }

    if (message.kind === 'state') {
      this.activeLeaderEpoch = message.leaderEpoch;
      this.setState(message.state, message.error ?? null);
      return;
    }

    if (this.activeLeaderEpoch !== message.leaderEpoch) {
      return;
    }
    const lastSequence = this.lastSequenceByLeader.get(message.leaderEpoch) ?? 0;
    if (message.sequence <= lastSequence) {
      return;
    }
    this.lastSequenceByLeader.set(message.leaderEpoch, message.sequence);
    this.dispatch(message.payload);
  };

  constructor(options: CrossTabSseCoordinatorOptions) {
    this.createTransport = options.createTransport;
    this.channelFactory = options.channelFactory === undefined
      ? defaultChannelFactory()
      : options.channelFactory;
    this.lockManager = options.lockManager === undefined
      ? defaultLockManager()
      : options.lockManager;
    this.channelName = options.channelName ?? DEFAULT_CHANNEL_NAME;
    this.lockName = options.lockName ?? DEFAULT_LOCK_NAME;
    this.announceIntervalMs = options.announceIntervalMs ?? ANNOUNCE_INTERVAL_MS;
  }

  on(type: string, handler: SSEHandler): () => void {
    const bucket = this.listeners.get(type) ?? new Set<SSEHandler>();
    bucket.add(handler);
    this.listeners.set(type, bucket);

    if (this.pendingEvents.length > 0) {
      const remaining: SSEPayload[] = [];
      for (const event of this.pendingEvents) {
        if (type === '*' || event.type === type) {
          this.invokeHandler(handler, event);
        } else {
          remaining.push(event);
        }
      }
      this.pendingEvents = remaining;
    }

    return () => {
      const current = this.listeners.get(type);
      current?.delete(handler);
      if (current?.size === 0) {
        this.listeners.delete(type);
      }
    };
  }

  onState(handler: SseStateHandler): () => void {
    this.stateListeners.add(handler);
    return () => {
      this.stateListeners.delete(handler);
    };
  }

  getState(): SseConnectionState {
    return this.state;
  }

  connect(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.setState('connecting');

    if (!this.channelFactory || !this.lockManager) {
      this.startFallbackTransport();
      return;
    }

    try {
      this.channel = this.channelFactory(this.channelName);
      this.channel.addEventListener('message', this.onChannelMessage);
    } catch (error) {
      console.error('Cross-tab SSE channel setup failed; using a document-local stream', error);
      this.channel = null;
      this.startFallbackTransport();
      return;
    }

    this.post({
      version: PROTOCOL_VERSION,
      kind: 'hello',
      sourceId: this.instanceId,
    });

    const abortController = new AbortController();
    this.lockAbort = abortController;
    try {
      void this.lockManager.request(
        this.lockName,
        { mode: 'exclusive', signal: abortController.signal },
        async () => {
          if (!this.started) {
            return;
          }
          this.becomeLeader();
          await new Promise<void>((resolve) => {
            this.releaseLeadership = resolve;
          });
          this.releaseLeadership = null;
        },
      ).catch((error) => this.handleLockFailure(error));
    } catch (error) {
      this.handleLockFailure(error);
    }
  }

  disconnect(): void {
    if (!this.started) {
      return;
    }
    this.started = false;

    const releasedEpoch = this.leaderEpoch;
    if (releasedEpoch && this.channel) {
      this.post({
        version: PROTOCOL_VERSION,
        kind: 'leader-released',
        sourceId: this.instanceId,
        leaderEpoch: releasedEpoch,
      });
    }

    // Stop broadcasting before disconnect() emits its local idle transition.
    this.isLeader = false;
    this.stopAnnouncing();
    this.stopTransport();
    this.releaseLeadership?.();
    this.releaseLeadership = null;
    this.lockAbort?.abort();
    this.lockAbort = null;

    if (this.channel) {
      this.channel.removeEventListener('message', this.onChannelMessage);
      this.channel.close();
      this.channel = null;
    }

    this.leaderEpoch = null;
    this.activeLeaderEpoch = null;
    this.retiredLeaderEpochs.clear();
    this.lastSequenceByLeader.clear();
    this.hasOpened = false;
    this.setState('idle');
  }

  private becomeLeader(): void {
    if (!this.started) {
      return;
    }
    this.isLeader = true;
    this.leaderEpoch = `${this.instanceId}:${createInstanceId()}`;
    this.activeLeaderEpoch = this.leaderEpoch;
    this.eventSequence = 0;
    this.startTransport();
    this.announceState();
    this.startAnnouncing();
  }

  private startFallbackTransport(): void {
    this.startTransport();
  }

  private startTransport(): void {
    if (!this.transport) {
      this.transport = this.createTransport();
    }
    if (this.transportOffs.length > 0) {
      return;
    }
    this.transportOffs.push(
      this.transport.on('*', (payload) => {
        this.dispatch(payload);
        if (this.isLeader && this.leaderEpoch) {
          this.eventSequence += 1;
          this.post({
            version: PROTOCOL_VERSION,
            kind: 'event',
            sourceId: this.instanceId,
            leaderEpoch: this.leaderEpoch,
            sequence: this.eventSequence,
            payload,
          });
        }
      }),
      this.transport.onState((state, meta) => {
        this.setState(state, meta.error ?? null);
        if (this.isLeader) {
          this.announceState();
        }
      }),
    );
    this.transport.connect();
  }

  private stopTransport(): void {
    if (!this.transport) {
      return;
    }
    this.transport.disconnect();
    for (const off of this.transportOffs.splice(0)) {
      off();
    }
  }

  private handleLockFailure(error: unknown): void {
    if (!this.started || isAbortError(error)) {
      return;
    }
    console.error('Cross-tab SSE leadership failed; using a document-local stream', error);
    this.lockAbort = null;
    if (this.channel) {
      this.channel.removeEventListener('message', this.onChannelMessage);
      this.channel.close();
      this.channel = null;
    }
    this.startFallbackTransport();
  }

  private startAnnouncing(): void {
    this.stopAnnouncing();
    this.announceTimer = setInterval(() => this.announceState(), this.announceIntervalMs);
  }

  private stopAnnouncing(): void {
    if (this.announceTimer !== null) {
      clearInterval(this.announceTimer);
      this.announceTimer = null;
    }
  }

  private announceState(): void {
    if (!this.isLeader || !this.leaderEpoch) {
      return;
    }
    this.post({
      version: PROTOCOL_VERSION,
      kind: 'state',
      sourceId: this.instanceId,
      leaderEpoch: this.leaderEpoch,
      state: this.state,
      error: this.error,
    });
  }

  private post(message: CrossTabMessage): void {
    try {
      this.channel?.postMessage(message);
    } catch (error) {
      // Local dispatch remains authoritative for this document. Followers will
      // recover through the next state announcement or their fallback poll.
      console.error('Cross-tab SSE broadcast failed', error);
    }
  }

  private setState(next: SseConnectionState, error: string | null = null): void {
    if (this.state === next && this.error === error) {
      return;
    }
    const meta: StateMeta = {
      reconnected: next === 'open' && this.hasOpened,
      error,
    };
    if (next === 'open') {
      this.hasOpened = true;
    }
    this.state = next;
    this.error = error;
    this.stateListeners.forEach((handler) => {
      try {
        handler(next, meta);
      } catch (error) {
        console.error('SSE state handler threw', error);
      }
    });
  }

  private dispatch(payload: SSEPayload): void {
    let handled = false;
    const exact = this.listeners.get(payload.type);
    if (exact?.size) {
      exact.forEach((handler) => this.invokeHandler(handler, payload));
      handled = true;
    }
    const wildcard = this.listeners.get('*');
    if (wildcard?.size) {
      wildcard.forEach((handler) => this.invokeHandler(handler, payload));
      handled = true;
    }
    if (!handled) {
      this.pendingEvents.push(payload);
      if (this.pendingEvents.length > 100) {
        this.pendingEvents = this.pendingEvents.slice(-50);
      }
    }
  }

  private invokeHandler(handler: SSEHandler, payload: SSEPayload): void {
    try {
      handler(payload);
    } catch (error) {
      console.error('SSE handler threw', error);
    }
  }
}
