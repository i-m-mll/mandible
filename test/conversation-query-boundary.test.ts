import { QueryClient, QueryObserver } from '@tanstack/query-core';
import { describe, expect, it, vi } from 'vitest';
import { waitUntilPasses } from './helpers/wait-until.js';

import type {
  Conversation,
  ConversationBlock,
  ConversationPositionWindow,
} from '../ui/src/api';
import { conversationKeys, normalizeWindowTarget } from '../ui/src/query/conversationKeys';
import {
  conversationTranscriptFromWindow,
  reconcileConversationWindow,
} from '../ui/src/query/conversationData';
import { applyConversationSse } from '../ui/src/query/conversationSse';
import { markSidebarListsStale, startSidebarRefresh } from '../ui/src/query/conversationSidebarRefresh';
import { LIVE_REFRESH_DEADLINE_MS, RefreshDeadlineError } from '../ui/src/lib/coalesced-refresh';

function conversation(id = 'conv-1', blockCount = 0): Conversation {
  return {
    id,
    source: 'codex',
    source_path: `/tmp/${id}.jsonl`,
    title: id,
    summary: null,
    started_at: '2026-09-13T00:00:00.000Z',
    ended_at: null,
    block_count: blockCount,
    session_id: `session-${id}`,
    project_path: null,
    cwd: null,
    branch: null,
    model: null,
    cli_version: null,
    starred: false,
    tags: [],
    notes: null,
    parent_conversation_id: null,
    children_count: 0,
  };
}

function block(id: string, position: number): ConversationBlock {
  return {
    id,
    conversation_id: 'conv-1',
    type: 'assistant_message',
    role: 'assistant',
    content: id,
    position,
    timestamp: '2026-09-13T00:00:00.000Z',
    parent_id: null,
    metadata_json: '{}',
    dag_uuid: null,
    dag_parent_uuid: null,
  };
}

function window(target: ConversationPositionWindow['target'], blocks: ConversationBlock[], total = 4): ConversationPositionWindow {
  return {
    conversation: conversation('conv-1', total),
    body_source: 'source',
    source_version_id: 'source-v1',
    children: [],
    parent: null,
    revision: total,
    total,
    target,
    window: {
      start_position: blocks[0]?.position ?? null,
      end_position: blocks.at(-1)?.position ?? null,
      has_before: (blocks[0]?.position ?? 0) > 0,
      has_after: (blocks.at(-1)?.position ?? total - 1) < total - 1,
      after_count: Math.max(0, total - (blocks.at(-1)?.position ?? -1) - 1),
      limit: 2,
    },
    blocks,
  };
}

describe('Chat Query authority', () => {

  it('cancels an obsolete observed read when rapid selection removes its observer', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let aborted = false;
    const observer = new QueryObserver(client, {
      queryKey: conversationKeys.window('old', normalizeWindowTarget({ target: 'initial' })),
      queryFn: ({ signal }) => new Promise<ConversationPositionWindow>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        });
      }),
    });
    const unsubscribe = observer.subscribe(() => undefined);
    unsubscribe();
    await waitUntilPasses(() => expect(aborted).toBe(true));
    expect(client.getQueryData(conversationKeys.window('new', normalizeWindowTarget({ target: 'initial' })))).toBeUndefined();
  });

  it('merges overlapping initial and exact windows by canonical block identity', () => {
    const initial = window(
      { kind: 'initial', requested_value: null, position: 0, block_id: 'b0', turn_id: null },
      [block('b0', 0), block('b1', 1)],
    );
    const exact = window(
      { kind: 'block', requested_value: 'b1', position: 1, block_id: 'b1', turn_id: null },
      [block('b1', 1), block('b2', 2)],
    );
    const merged = reconcileConversationWindow(conversationTranscriptFromWindow(initial), exact);
    expect(merged.blocks.map((item) => item.id)).toEqual(['b0', 'b1', 'b2']);
    expect(merged.loaded_intervals).toEqual([{ start: 0, end: 2 }]);

    const expanded = {
      ...initial,
      blocks: initial.blocks.map((item) => item.id === 'b1'
        ? { ...item, content: 'expanded payload', details_loaded: true }
        : item),
    };
    const compactRefresh = {
      ...initial,
      blocks: initial.blocks.map((item) => ({ ...item, content: 'compact summary', details_loaded: false })),
    };
    const preserved = reconcileConversationWindow(conversationTranscriptFromWindow(expanded), compactRefresh);
    expect(preserved.blocks.find((item) => item.id === 'b1')).toMatchObject({
      content: 'expanded payload',
      details_loaded: true,
    });
  });

  it('preserves explicit gaps and replaces the aggregate when source bytes change at the same count', () => {
    const head = window(
      { kind: 'position', requested_value: 1, position: 1, block_id: 'b1', turn_id: null },
      [block('b0', 0), block('b1', 1)],
      6,
    );
    const tail = window(
      { kind: 'position', requested_value: 5, position: 5, block_id: 'b5', turn_id: null },
      [block('b4', 4), block('b5', 5)],
      6,
    );
    const gapped = reconcileConversationWindow(conversationTranscriptFromWindow(head), tail);
    expect(gapped.loaded_intervals).toEqual([{ start: 0, end: 1 }, { start: 4, end: 5 }]);
    expect(gapped.blocks.map((item) => item.id)).toEqual(['b0', 'b1', 'b4', 'b5']);

    const replacement = {
      ...tail,
      source_version_id: 'source-v2',
      blocks: [block('replacement', 4), block('b5', 5)],
    };
    const replaced = reconcileConversationWindow(gapped, replacement);
    expect(replaced.loaded_intervals).toEqual([{ start: 4, end: 5 }]);
    expect(replaced.blocks.map((item) => item.id)).toEqual(['replacement', 'b5']);
  });

  it('patches complete append payloads and refetches only a gapped window', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const initialTarget = normalizeWindowTarget({ target: 'initial' });
    const exactTarget = normalizeWindowTarget({ block: 'b1' });
    const initialKey = conversationKeys.window('conv-1', initialTarget);
    const exactKey = conversationKeys.window('conv-1', exactTarget);
    const refetch = vi.fn().mockResolvedValue(window(
      { kind: 'initial', requested_value: null, position: 0, block_id: 'b0', turn_id: null },
      [block('b0', 0)],
      1,
    ));
    const shown = new QueryObserver(client, { queryKey: initialKey, queryFn: refetch, staleTime: Infinity });
    const unsubscribe = shown.subscribe(() => undefined);
    await waitUntilPasses(() => expect(client.getQueryData(initialKey)).toBeDefined());
    client.setQueryData(exactKey, window(
      { kind: 'block', requested_value: 'b1', position: 1, block_id: 'b1', turn_id: null },
      [block('b0', 0), block('b1', 1), block('b2', 2)],
      3,
    ));

    applyConversationSse(client, 'conversation:updated', {
      id: 'conv-1',
      block_count: 2,
      append: { from_position: 1, blocks: [block('b1', 1)] },
    });
    expect(client.getQueryData<ConversationPositionWindow>(initialKey)?.blocks.map((item) => item.id)).toEqual(['b0', 'b1']);

    applyConversationSse(client, 'conversation:updated', {
      id: 'conv-1',
      block_count: 4,
      append: { from_position: 3, blocks: [block('b3', 3)] },
    });
    await waitUntilPasses(() => expect(refetch).toHaveBeenCalledTimes(2));
    unsubscribe();
  });
});

describe('Chat sidebar refresh deadline', () => {
  it('fails a sidebar refetch that hangs past the deadline and refreshes again on the next change', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const client = new QueryClient();
      const filters = {};
      const key = conversationKeys.sidebarInitial(filters);
      let hang = true;
      const queryFn = vi.fn(({ signal }: { signal: AbortSignal }) => (hang
        ? new Promise<string>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
        : Promise.resolve('fresh')));
      client.setQueryData(key, 'old');
      const observer = new QueryObserver(client, { queryKey: key, queryFn, staleTime: Infinity });
      const unsubscribe = observer.subscribe(() => undefined);
      const stop = startSidebarRefresh(client, filters);

      markSidebarListsStale(client);
      await vi.advanceTimersByTimeAsync(0);
      expect(queryFn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(LIVE_REFRESH_DEADLINE_MS);
      const state = client.getQueryCache().find({ queryKey: key, exact: true })!.state;
      expect(state.error).toBeInstanceOf(RefreshDeadlineError);
      expect(state.fetchStatus).toBe('idle');
      expect(state.data).toBe('old');

      hang = false;
      markSidebarListsStale(client);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(queryFn).toHaveBeenCalledTimes(2);
      expect(client.getQueryData(key)).toBe('fresh');
      stop();
      unsubscribe();
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});
