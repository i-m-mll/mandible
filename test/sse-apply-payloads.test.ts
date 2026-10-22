import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitUntilPasses } from './helpers/wait-until.js';
import { acquireSharedSse, __resetSharedSseForTests } from '../ui/src/sse-shared';
import { __resetBrowserSessionForTests, ensureClientAccess } from '../ui/src/client-auth-token';
import {
  applyConversationAppendPayload,
  mergeConversationSummaryIntoList,
} from '../ui/src/query/conversationData';
import type { Conversation, ConversationBlock, ConversationChild } from '../ui/src/api';

/**
 * Controllable fake EventSource — same pattern as sse-shared-client.test.ts.
 * Tests drive open()/error()/emit() manually for deterministic dispatch.
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

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  error(): void {
    this.readyState = 2;
    this.onerror?.();
    for (const listener of this.errorListeners) listener();
  }

  emit(payload: Record<string, unknown>): void {
    const event = new MessageEvent('message', { data: JSON.stringify(payload) });
    for (const listener of this.messageListeners) listener(event);
  }
}

function reset(): void {
  FakeEventSource.instances = [];
  __resetSharedSseForTests(FakeEventSource as unknown as typeof EventSource);
}

type ConvWithBlocks = Conversation & {
  blocks: ConversationBlock[];
  children: ConversationChild[];
};

function conversation(blocks: ConversationBlock[]): ConvWithBlocks {
  return {
    id: 'conv-1',
    source: 'codex',
    source_path: '/tmp/session.jsonl',
    title: 'Session',
    summary: null,
    started_at: '2026-07-22T00:00:00.000Z',
    ended_at: null,
    block_count: blocks.length,
    session_id: 'session-1',
    project_path: null,
    cwd: null,
    branch: null,
    model: null,
    cli_version: null,
    starred: false,
    label: null,
    notes: null,
    parent_conversation_id: null,
    children_count: 0,
    created_at: '2026-07-22T00:00:00.000Z',
    updated_at: '2026-07-22T00:00:00.000Z',
    blocks,
    children: [],
  } as ConvWithBlocks;
}

function block(id: string, position: number): ConversationBlock {
  return {
    id,
    conversation_id: 'conv-1',
    type: 'assistant_message',
    role: 'assistant',
    content: `content-${position}`,
    position,
    timestamp: '2026-07-22T00:00:00.000Z',
    parent_id: null,
    metadata_json: '{}',
    dag_uuid: null,
    dag_parent_uuid: null,
  };
}

describe('SSE payload application (patch, gap, debounce, heartbeat, reconnect)', () => {
  beforeEach(async () => {
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
  });

  it('applies a burst of append events in order with zero refetches', async () => {
    let current: ConvWithBlocks = conversation([block('b0', 0)]);
    let refetches = 0;

    const handle = acquireSharedSse();
    handle.on('conversation:updated', (payload) => {
      const data = (typeof payload.data === 'object' && payload.data !== null ? payload.data : payload) as {
        id?: string;
        block_count?: number;
        append?: { from_position?: number; blocks?: ConversationBlock[] };
      };
      const next = applyConversationAppendPayload(current, data);
      if (!next) {
        refetches += 1;
        return;
      }
      current = next;
    });
    handle.connect();
    await waitUntilPasses(() => expect(FakeEventSource.instances.length).toBe(1));
    const es = FakeEventSource.instances[0];
    es.open();

    for (let i = 1; i <= 5; i += 1) {
      es.emit({
        type: 'conversation:updated',
        data: {
          id: 'conv-1',
          block_count: i + 1,
          append: { from_position: i, blocks: [block(`b${i}`, i)] },
        },
      });
    }

    await waitUntilPasses(() => expect(current.blocks.map((b) => b.id)).toEqual(['b0', 'b1', 'b2', 'b3', 'b4', 'b5']));
    expect(refetches).toBe(0);
    expect(current.block_count).toBe(6);
  });

  it('signals exactly one detail refetch on a sequence gap', async () => {
    let current: ConvWithBlocks = conversation([block('b0', 0)]);
    let refetches = 0;

    const handle = acquireSharedSse();
    handle.on('conversation:updated', (payload) => {
      const data = (typeof payload.data === 'object' && payload.data !== null ? payload.data : payload) as Parameters<
        typeof applyConversationAppendPayload
      >[1];
      const next = applyConversationAppendPayload(current, data);
      if (!next) {
        refetches += 1;
        return;
      }
      current = next;
    });
    handle.connect();
    await waitUntilPasses(() => expect(FakeEventSource.instances.length).toBe(1));
    const es = FakeEventSource.instances[0];
    es.open();

    // from_position 2 skips position 1 → gap.
    es.emit({
      type: 'conversation:updated',
      data: { id: 'conv-1', block_count: 3, append: { from_position: 2, blocks: [block('b2', 2)] } },
    });

    await waitUntilPasses(() => expect(refetches).toBe(1));
    expect(current.blocks.map((b) => b.id)).toEqual(['b0']); // unchanged
  });

  it('merges a monotonic summary in place and refetches on unknown id', async () => {
    let list: Conversation[] = [conversation([]), { ...conversation([]), id: 'conv-2', block_count: 2 }];
    let refetches = 0;

    const handle = acquireSharedSse();
    handle.on('conversation:updated', (payload) => {
      const data = (typeof payload.data === 'object' && payload.data !== null ? payload.data : payload) as {
        id?: string;
        block_count?: number;
        title?: string;
      };
      const result = mergeConversationSummaryIntoList(list, data);
      if (result.applied) list = result.conversations;
      else if (result.refetch) refetches += 1;
    });
    handle.connect();
    await waitUntilPasses(() => expect(FakeEventSource.instances.length).toBe(1));
    const es = FakeEventSource.instances[0];
    es.open();

    es.emit({ type: 'conversation:updated', data: { id: 'conv-1', block_count: 4, title: 'Renamed' } });
    await waitUntilPasses(() => expect(list[0].block_count).toBe(4));
    expect(list[0].title).toBe('Renamed');
    expect(refetches).toBe(0);

    es.emit({ type: 'conversation:updated', data: { id: 'conv-unknown', block_count: 9 } });
    await waitUntilPasses(() => expect(refetches).toBe(1));
  });

  it('fires the reconnect resync exactly once per real reconnect', async () => {
    vi.useFakeTimers();
    let resyncs = 0;

    const handle = acquireSharedSse();
    handle.onState((_state, { reconnected }) => {
      if (reconnected) resyncs += 1;
    });
    handle.connect();
    await waitUntilPasses(() => expect(FakeEventSource.instances.length).toBe(1));
    const es1 = FakeEventSource.instances[0];
    es1.open(); // first open: not a reconnect
    expect(resyncs).toBe(0);

    es1.error();
    await vi.advanceTimersByTimeAsync(500);
    await waitUntilPasses(() => expect(FakeEventSource.instances.length).toBe(2));
    FakeEventSource.instances[1].open(); // reopen: reconnect
    await waitUntilPasses(() => expect(resyncs).toBe(1));
  });
});
