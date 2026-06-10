import type { MandibleEvent } from '../../src/contracts';

export type SSEPayload = MandibleEvent;

export type SSEHandler = (payload: SSEPayload) => void;

export type SSEClientOptions = {
  url?: string;
  EventSourceImpl?: typeof EventSource;
  backoffMs?: number;
  maxBackoffMs?: number;
};

export class SSEClient {
  private url: string;
  private EventSourceImpl: typeof EventSource;
  private backoffMs: number;
  private maxBackoffMs: number;
  private listeners: Map<string, Set<SSEHandler>> = new Map();
  private eventSource: EventSource | null = null;
  private retryTimer: number | null = null;
  private currentBackoff: number;
  private closed = false;
  private pendingEvents: SSEPayload[] = [];

  constructor(options: SSEClientOptions = {}) {
    this.url = options.url || '/api/events';
    this.EventSourceImpl = options.EventSourceImpl || EventSource;
    this.backoffMs = options.backoffMs ?? 500;
    this.maxBackoffMs = options.maxBackoffMs ?? 15000;
    this.currentBackoff = this.backoffMs;
  }

  connect(): void {
    if (this.eventSource || this.closed) {
      return;
    }
    const source = new this.EventSourceImpl(this.url);

    // Use addEventListener for the message handler -- more reliable across
    // browsers than assigning to onmessage, and works identically for
    // unnamed SSE events (server sends "data:" without an "event:" line).
    const messageHandler = (event: MessageEvent) => {
      this.handleMessage(event.data);
    };
    source.addEventListener('message', messageHandler);

    source.onerror = () => {
      // Only manually reconnect when EventSource has given up (readyState
      // CLOSED = 2).  When readyState is CONNECTING (0), the browser is
      // already retrying on its own -- closing the source here would destroy
      // that automatic reconnection and create a gap where events are lost.
      if (source.readyState === 2) {
        this.scheduleReconnect();
      }
    };

    source.onopen = () => {
      this.currentBackoff = this.backoffMs;
    };

    this.eventSource = source;
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  on(type: string, handler: SSEHandler): () => void {
    const bucket = this.listeners.get(type) || new Set<SSEHandler>();
    bucket.add(handler);
    this.listeners.set(type, bucket);

    // Flush any events that arrived before this handler was registered.
    if (this.pendingEvents.length > 0) {
      const remaining: SSEPayload[] = [];
      for (const event of this.pendingEvents) {
        if (event.type === type || type === '*') {
          handler(event);
        } else {
          remaining.push(event);
        }
      }
      this.pendingEvents = remaining;
    }

    return () => this.off(type, handler);
  }

  off(type: string, handler: SSEHandler): void {
    const bucket = this.listeners.get(type);
    if (!bucket) {
      return;
    }
    bucket.delete(handler);
    if (!bucket.size) {
      this.listeners.delete(type);
    }
  }

  private handleMessage(data: string): void {
    const payload = this.parsePayload(data);
    if (!this.dispatch(payload.type, payload)) {
      // No handler matched -- queue for late-registered handlers
      this.pendingEvents.push(payload);
      // Cap the pending queue to avoid leaking memory
      if (this.pendingEvents.length > 100) {
        this.pendingEvents = this.pendingEvents.slice(-50);
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.retryTimer || this.closed) {
      return;
    }
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.currentBackoff = Math.min(this.currentBackoff * 2, this.maxBackoffMs);
      this.connect();
    }, this.currentBackoff);
  }

  private parsePayload(data: string): SSEPayload {
    try {
      const parsed = JSON.parse(data) as SSEPayload;
      const type = parsed.type || (parsed as { event?: string }).event || 'message';
      return { type, ...parsed };
    } catch {
      return { type: 'message', data };
    }
  }

  /** Dispatch to registered handlers. Returns true if at least one handler ran. */
  private dispatch(type: string, payload: SSEPayload): boolean {
    let handled = false;

    // Exact-match handlers
    const handlers = this.listeners.get(type);
    if (handlers && handlers.size > 0) {
      handlers.forEach((handler) => handler(payload));
      handled = true;
    }

    // Wildcard handlers (registered with '*')
    const wildcards = this.listeners.get('*');
    if (wildcards && wildcards.size > 0) {
      wildcards.forEach((handler) => handler(payload));
      handled = true;
    }

    return handled;
  }
}

export function createSSEClient(options?: SSEClientOptions): SSEClient {
  return new SSEClient(options);
}
