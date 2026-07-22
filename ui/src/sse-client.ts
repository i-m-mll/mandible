import type { MandibleEvent } from '../../src/contracts';
import { getStoredToken } from './client-auth-token';

export type SSEPayload = MandibleEvent;

export type SSEHandler = (payload: SSEPayload) => void;

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
  private abortController: AbortController | null = null;
  private eventSource: EventSource | null = null;
  private connecting = false;
  private retryTimer: number | null = null;
  private currentBackoff: number;
  private closed = false;
  private pendingEvents: SSEPayload[] = [];

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
    this.eventSource?.close();
    this.eventSource = null;
    this.connecting = false;
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
    this.eventSource?.close();
    this.eventSource = null;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.currentBackoff = Math.min(this.currentBackoff * 2, this.maxBackoffMs);
      this.connect();
    }, this.currentBackoff);
  }

  private openAnonymousEventSource(): void {
    if (!this.EventSourceImpl) {
      this.scheduleReconnect();
      return;
    }
    const legacyUrl = this.url === '/api/events/subscribe' ? '/api/events' : this.url;
    const source = new this.EventSourceImpl(legacyUrl);
    source.addEventListener('message', (event: MessageEvent) => {
      this.handleMessage(event.data);
    });
    source.onerror = () => {
      if (source.readyState === 2) this.scheduleReconnect();
    };
    source.onopen = () => {
      this.currentBackoff = this.backoffMs;
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
      if (!response.ok || !response.body) {
        throw new Error(`SSE subscribe failed (${response.status})`);
      }
      this.currentBackoff = this.backoffMs;
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
    } catch (error) {
      if (!controller.signal.aborted && !this.closed) shouldReconnect = true;
    } finally {
      if (this.abortController === controller) this.abortController = null;
      this.connecting = false;
    }
    if (shouldReconnect) this.scheduleReconnect();
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
