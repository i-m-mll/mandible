import { QueryClient, QueryObserver } from '@tanstack/query-core';
import { describe, expect, it, vi } from 'vitest';

import type {
  Conversation,
  ConversationBlock,
  ConversationPositionWindow,
  ConversationSidebarGroup,
} from '../../ui/src/api';
import { conversationKeys, normalizeWindowTarget } from '../../ui/src/query/conversationKeys';
import {
  conversationTranscriptFromWindow,
  reconcileConversationWindow,
  mergeSidebarPages,
} from '../../ui/src/query/conversationData';
import { applyConversationSse } from '../../ui/src/query/conversationSse';

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

function group(key: string, ids: string[], cursor: string | null): ConversationSidebarGroup {
  return {
    key,
    kind: key === 'pinned' ? 'pinned' : 'chats',
    label: key,
    total: 3,
    conversations: ids.map((id) => ({
      ...conversation(id, 1),
      canonical_project_id: null,
      canonical_project_key: null,
    })),
    next_cursor: cursor,
  };
}

describe('Chat Query authority', () => {
  it('uses distinct bounded keys for exact navigation and independent group continuations', () => {
    const filters = { limit: 5, project_ids: ['p2', 'p1'], pinned_ids: ['b', 'a'] };
    expect(conversationKeys.window('conv-1', normalizeWindowTarget({ block: 'b-1' })))
      .not.toEqual(conversationKeys.window('conv-1', normalizeWindowTarget({ turn: 't-1' })));
    expect(conversationKeys.window('conv-1', normalizeWindowTarget({ position: 42 }))[4])
      .toEqual({ kind: 'position', value: 42, limit: null });
    expect(conversationKeys.sidebarPage(filters, 'pinned', 'cursor-1'))
      .not.toEqual(conversationKeys.sidebarPage(filters, 'chats', 'cursor-1'));
    expect(conversationKeys.sidebarInitial(filters)[3]).toMatchObject({ project_ids: ['p1', 'p2'], pinned_ids: ['b', 'a'] });
    expect(conversationKeys.sidebarInitial({ limit: 5 })[3])
      .not.toEqual(conversationKeys.sidebarInitial({ limit: 5, pinned_ids: [] })[3]);
  });

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
    await vi.waitFor(() => expect(aborted).toBe(true));
    expect(client.getQueryData(conversationKeys.window('new', normalizeWindowTarget({ target: 'initial' })))).toBeUndefined();
  });

  it('refetches an active failed window after a non-append source reparse event', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = conversationKeys.window('conv-1', normalizeWindowTarget({ target: 'initial' }));
    const queryFn = vi.fn()
      .mockRejectedValueOnce(new Error('older parser epoch'))
      .mockResolvedValue(window(
        { kind: 'initial', requested_value: null, position: 0, block_id: 'b0', turn_id: null },
        [block('b0', 0)],
        1,
      ));
    const observer = new QueryObserver(client, { queryKey: key, queryFn });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await vi.waitFor(() => expect(observer.getCurrentResult().isError).toBe(true));
      applyConversationSse(client, 'conversation:updated', { id: 'conv-1', block_count: 1 });
      await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true));
      expect(queryFn).toHaveBeenCalledTimes(2);
      expect(client.getQueryData<ConversationPositionWindow>(key)?.body_source).toBe('source');
    } finally {
      unsubscribe();
    }
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

  it('evicts distant content while retaining the requested reading range', () => {
    const large = (position: number) => ({ ...block(`b${position}`, position), content: 'x'.repeat(20_000) });
    const first = window(
      { kind: 'position', requested_value: 120, position: 120, block_id: 'b120', turn_id: null },
      Array.from({ length: 241 }, (_, position) => large(position)),
      601,
    );
    const distant = window(
      { kind: 'position', requested_value: 600, position: 600, block_id: 'b600', turn_id: null },
      Array.from({ length: 241 }, (_, index) => large(index + 360)),
      601,
    );
    const merged = reconcileConversationWindow(conversationTranscriptFromWindow(first), distant);
    expect(merged.blocks.at(-1)?.position).toBe(600);
    expect(merged.blocks.find((item) => item.position === 0)).toBeUndefined();
    expect(merged.blocks.reduce((bytes, item) => bytes + JSON.stringify(item).length * 2, 0))
      .toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(merged.loaded_intervals.at(-1)).toEqual({ start: 360, end: 600 });
  });

  it('merges each sidebar continuation without disturbing the existing prefix', () => {
    const merged = mergeSidebarPages(
      { limit: 1, groups: [group('pinned', ['a'], 'p1'), group('chats', ['x'], 'c1')] },
      [
        { limit: 1, groups: [group('chats', ['y'], null)] },
        { limit: 1, groups: [group('pinned', ['b'], null)] },
      ],
    );
    expect(merged.find((item) => item.key === 'pinned')?.conversations.map((item) => item.id)).toEqual(['a', 'b']);
    expect(merged.find((item) => item.key === 'chats')?.conversations.map((item) => item.id)).toEqual(['x', 'y']);
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
    await client.fetchQuery({ queryKey: initialKey, queryFn: refetch });
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
    await vi.waitFor(() => expect(refetch).toHaveBeenCalledTimes(2));
  });
});
