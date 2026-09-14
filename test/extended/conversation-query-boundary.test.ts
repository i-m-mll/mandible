import { QueryClient, QueryObserver } from '@tanstack/query-core';
import { describe, expect, it, vi } from 'vitest';

import type {
  Conversation,
  ConversationBlock,
  ConversationPositionWindow,
  ConversationSidebarGroup,
} from '../../ui/src/api';
import { conversationKeys, normalizeWindowTarget } from '../../ui/src/query/conversationKeys';
import { mergeConversationWindows, mergeSidebarPages } from '../../ui/src/query/conversationData';
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
    expect(conversationKeys.sidebarInitial(filters)[3]).toMatchObject({ project_ids: ['p1', 'p2'], pinned_ids: ['a', 'b'] });
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

  it('merges overlapping initial and exact windows by canonical block identity', () => {
    const initial = window(
      { kind: 'initial', requested_value: null, position: 0, block_id: 'b0', turn_id: null },
      [block('b0', 0), block('b1', 1)],
    );
    const exact = window(
      { kind: 'block', requested_value: 'b1', position: 1, block_id: 'b1', turn_id: null },
      [block('b1', 1), block('b2', 2)],
    );
    expect(mergeConversationWindows(initial, exact).blocks.map((item) => item.id)).toEqual(['b0', 'b1', 'b2']);
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
