import type { MandibleEvent } from '../../src/contracts';
import {
  getClientAuthSessionState,
  getStoredToken,
  isTerminalClientAuthState,
} from './client-auth-token';

export type SSEPayload = MandibleEvent;

export type SSEHandler = (payload: SSEPayload) => void;

/** Connection lifecycle state exposed via {@link SSEClient.onState}. */
export type SseConnectionState = 'idle' | 'connecting' | 'open' | 'down';

/**
 * Connection-state observer. `meta.reconnected` is true only when this `open`
 * follows a prior `open` in the client's current lifetime (i.e. a real
 * reconnect after a drop), never on the first open or on the first open after a
 * full {@link SSEClient.disconnect}.
 */
export type SseStateHandler = (state: SseConnectionState, meta: { reconnected: boolean }) => void;

export type SSEClientOptions = {
  url?: string;
  fetchImpl?: typeof fetch;
  EventSourceImpl?: typeof EventSource;
  backoffMs?: number;
  maxBackoffMs?: number;
};

export class SSEClient {
  private url: string;
  private fetchImpl: typeof fetch;
  private EventSourceImpl: typeof EventSource | null;
  private backoffMs: number;
  private maxBackoffMs: number;
  private listeners: Map<string, Set<SSEHandler>> = new Map();
  private stateListeners: Set<SseStateHandler> = new Set();
  private abortController: AbortController | null = null;
  private eventSource: EventSource | null = null;
  private connecting = false;
  private retryTimer: number | null = null;
  private currentBackoff: number;
  private closed = false;
  private pendingEvents: SSEPayload[] = [];
  private state: SseConnectionState = 'idle';
  // Whether this client has ever reached `open` in its current lifetime. Reset
  // by disconnect() so a fresh acquire's first open is not treated as a
  // reconnect, but preserved across the backoff reconnect path.
  private hasOpened = false;

  constructor(options: SSEClientOptions = {}) {
    this.url = options.url || '/api/events/subscribe';
    this.fetchImpl = options.fetchImpl || fetch.bind(window);
    this.EventSourceImpl = options.EventSourceImpl
      ?? (typeof EventSource === 'function' ? EventSource : null);
    this.backoffMs = options.backoffMs ?? 500;
    this.maxBackoffMs = options.maxBackoffMs ?? 15000;
    this.currentBackoff = this.backoffMs;
  }

  connect(): void {
    if (this.abortController || this.eventSource || this.connecting || this.closed) {
      return;
    }
    this.setState('connecting');
    // Client-auth (user-system): with a stored token, subscribe over a POST
    // fetch stream so the token rides the global Authorization wrapper instead
    // of a URL query param; without one, fall back to an anonymous EventSource.
    if (!getStoredToken()) {
      this.openAnonymousEventSource();
      return;
    }
    this.connecting = true;
    void this.openFetchStream();
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.abortController?.abort();
    this.abortController = null;
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.connecting = false;
    this.setState('idle');
  }

  /**
   * Tear down the live stream/EventSource and cancel any pending retry, but KEEP
   * the registered listeners and clear the terminal `closed` flag so a
   * subsequent connect() reconnects with a fresh backoff. This is the
   * shared-singleton teardown path: the class instance is reused, only its
   * socket is dropped.
   */
  disconnect(): void {
    if (this.retryTimer) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.abortController?.abort();
    this.abortController = null;
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.connecting = false;
    this.closed = false;
    this.currentBackoff = this.backoffMs;
    this.hasOpened = false;
    this.setState('idle');
  }

  getState(): SseConnectionState {
    return this.state;
  }

  onState(handler: SseStateHandler): () => void {
    this.stateListeners.add(handler);
    return () => {
      this.stateListeners.delete(handler);
    };
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
          this.invokeHandler(handler, event);
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

  private setState(next: SseConnectionState, reconnected = false): void {
    this.state = next;
    this.stateListeners.forEach((handler) => {
      try {
        handler(next, { reconnected });
      } catch (err) {
        console.error('SSE state handler threw', err);
      }
    });
  }

  private invokeHandler(handler: SSEHandler, payload: SSEPayload): void {
    // Shared client: one consumer throwing must not starve the others.
    try {
      handler(payload);
    } catch (err) {
      console.error('SSE handler threw', err);
    }
  }

  private markOpened(): void {
    this.currentBackoff = this.backoffMs;
    const reconnected = this.hasOpened;
    this.hasOpened = true;
    this.setState('open', reconnected);
  }

  private openAnonymousEventSource(): void {
    if (!this.EventSourceImpl) {
      this.setState('down');
      this.scheduleReconnect();
      return;
    }
    const legacyUrl = this.url === '/api/events/subscribe' ? '/api/events' : this.url;
    const source = new this.EventSourceImpl(legacyUrl);

    // Use addEventListener for the message handler -- more reliable across
    // browsers than assigning to onmessage, and works identically for
    // unnamed SSE events (server sends "data:" without an "event:" line).
    source.addEventListener('message', (event: MessageEvent) => {
      this.handleMessage(event.data);
    });

    source.onerror = () => {
      // Only manually reconnect when EventSource has given up (readyState
      // CLOSED = 2).  When readyState is CONNECTING (0), the browser is
      // already retrying on its own -- closing the source here would destroy
      // that automatic reconnection and create a gap where events are lost.
      if (source.readyState === 2) {
        this.setState('down');
        this.scheduleReconnect();
      }
    };

    source.onopen = () => {
      this.markOpened();
    };

    this.eventSource = source;
  }

  private async openFetchStream(): Promise<void> {
    const controller = new AbortController();
    this.abortController = controller;
    let shouldReconnect = false;
    try {
      // Fetch can carry Authorization through the global client-auth wrapper;
      // unlike EventSource, no bearer credential is placed in the URL.
      const response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        this.setState('down');
        return;
      }
      if (!response.ok || !response.body) {
        throw new Error(`SSE subscribe failed (${response.status})`);
      }
      this.markOpened();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!this.closed && !controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) {
          shouldReconnect = true;
          break;
        }
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (data) this.handleMessage(data);
          boundary = buffer.indexOf('\n\n');
        }
      }
    } catch {
      if (!controller.signal.aborted && !this.closed
          && !isTerminalClientAuthState(getClientAuthSessionState())) {
        shouldReconnect = true;
      }
    } finally {
      if (this.abortController === controller) this.abortController = null;
      this.connecting = false;
    }
    if (shouldReconnect) {
      this.setState('down');
      this.scheduleReconnect();
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
      return { ...parsed, type };
    } catch {
      return { type: 'message', data };
    }
  }

  /**
   * Dispatch to registered handlers. Returns true if at least one handler ran.
   * Ordering guarantee: exact-type handlers in registration order, then '*'
   * handlers in registration order. Each invocation is isolated so one
   * consumer's throw cannot starve the others.
   */
  private dispatch(type: string, payload: SSEPayload): boolean {
    let handled = false;

    // Exact-match handlers
    const handlers = this.listeners.get(type);
    if (handlers && handlers.size > 0) {
      handlers.forEach((handler) => this.invokeHandler(handler, payload));
      handled = true;
    }

    // Wildcard handlers (registered with '*')
    const wildcards = this.listeners.get('*');
    if (wildcards && wildcards.size > 0) {
      wildcards.forEach((handler) => this.invokeHandler(handler, payload));
      handled = true;
    }

    return handled;
  }
}

export function createSSEClient(options?: SSEClientOptions): SSEClient {
  return new SSEClient(options);
}
