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
  applyReadingWindowOperation,
  retainReadingWindow,
  conversationBlockDetailsCurrent,
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
    reading_context: { positions: blocks.map(block => ({ position: block.position, activity_owner_position: null, speaker_run_start: 0 })), speaker_runs: [{ start: 0, end: total - 1 }] },
    source_version_id: 'source-v1',
    position_space_id: 'space-1',
    publication_revision: 1,
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
  it('never lets an old full detail outrank a newer compact block after an intervening newer range', () => {
    const target = { kind: 'position' as const, requested_value: 0, position: 0, block_id: 'b0', turn_id: null };
    const detail = { ...block('b0', 0), content: 'old full body', details_loaded: true };
    const initial = conversationTranscriptFromWindow(window(target, [detail], 2));
    const newerRange = { ...window(target, [block('b1', 1)], 2), source_version_id: 'v2', publication_revision: 2 };
    const advanced = reconcileConversationWindow(initial, newerRange);
    expect(conversationBlockDetailsCurrent(advanced, detail)).toBe(false);
    const compact = { ...window(target, [{ ...detail, content: 'new compact body', details_loaded: false }], 2),
      source_version_id: 'v2', publication_revision: 2 };
    expect(reconcileConversationWindow(advanced, compact).blocks.find(block => block.id === 'b0'))
      .toMatchObject({ content: 'new compact body', details_loaded: false });
  });
  it('derives true-end availability from the active span and rejects a delayed obsolete space', () => {
    const target = { kind: 'position' as const, requested_value: 0, position: 0, block_id: 'b0', turn_id: null };
    const payload = window(target, [block('b0', 0), block('b1', 1)], 2);
    const tail = conversationTranscriptFromWindow(payload);
    expect(tail.end_reached).toBe(true);
    const trimmed = applyReadingWindowOperation(tail, { kind: 'trim-end', position: 0, protected: [] });
    expect(trimmed).toMatchObject({ status: 'committed', data: { end_reached: false, after_count: 1 } });
    const grown = reconcileConversationWindow(tail, { ...window(target, [block('b0', 0)], 3),
      source_version_id: 'append-v2', publication_revision: 2 });
    expect(grown).toMatchObject({ active_window: { start: 0, end: 1 }, end_reached: false, after_count: 1 });
    const changed = reconcileConversationWindow(grown, { ...payload, position_space_id: 'space-B', publication_revision: 3 });
    expect(reconcileConversationWindow(changed, payload)).toBe(changed);
  });
  it('extends one active span across append freshness, advances through hidden positions, and protects the reading region', () => {
    const target = { kind: 'position' as const, requested_value: 0, position: 0, block_id: 'b0', turn_id: null };
    const initial = conversationTranscriptFromWindow(window(target, [block('b0', 0), block('b1', 1)], 6));
    const incoming = { ...window(target, [block('b2', 2), block('b3', 3)], 6),
      source_version_id: 'append-version', publication_revision: 2 };
    const extended = applyReadingWindowOperation(initial, { kind: 'extend-end', window: incoming, protected: [{ start: 0, end: 1 }] });
    expect(extended.status).toBe('committed');
    if (extended.status !== 'committed') throw new Error('extension failed');
    expect(extended.data.active_window).toEqual({ start: 0, end: 3 });
    expect(extended.data.blocks.map(block => block.position)).toEqual([0, 1, 2, 3]);
    expect(reconcileConversationWindow(extended.data, window(target, [block('obsolete', 0)], 4))).toBe(extended.data);
    expect(applyReadingWindowOperation(extended.data, { kind: 'trim-start', position: 2, protected: [{ start: 1, end: 2 }] }).status).toBe('protected');
    expect(retainReadingWindow(extended.data.blocks, extended.data.active_window, [{ start: 1, end: 2 }],
      { bytes: 100000, positions: 2 })?.span).toEqual({ start: 1, end: 2 });
    expect(applyReadingWindowOperation(extended.data, { kind: 'extend-end', window: window(target, [block('b5', 5)], 6), protected: [] }).status).toBe('obsolete');
    const distant = { ...window({ ...target, position: 5, requested_value: 5, block_id: 'b5' }, [block('b5', 5)], 6), publication_revision: 2 };
    expect(applyReadingWindowOperation(extended.data, { kind: 'extend-end', window: distant, protected: [] }).status).toBe('noncontiguous');
    const replaced = applyReadingWindowOperation(extended.data, { kind: 'replace', window: distant,
      command: { token: 'jump', target: { conversationId: 'conv-1', positionSpaceId: 'space-1', position: 5 } } });
    expect(replaced).toMatchObject({ status: 'committed', data: { active_window: { start: 5, end: 5 } }, command: { token: 'jump' } });
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

  it('keeps distant cache reads outside the active window and replaces the aggregate when position space changes at the same count', () => {
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
    expect(gapped.loaded_intervals).toEqual([{ start: 0, end: 1 }]);
    expect(gapped.blocks.map((item) => item.id)).toEqual(['b0', 'b1']);

    const replacement = {
      ...tail,
      source_version_id: 'source-v2',
      position_space_id: 'space-2',
      publication_revision: 2,
      blocks: [block('replacement', 4), block('b5', 5)],
    };
    const replaced = reconcileConversationWindow(gapped, replacement);
    expect(replaced.loaded_intervals).toEqual([{ start: 4, end: 5 }]);
    expect(replaced.blocks.map((item) => item.id)).toEqual(['replacement', 'b5']);
  });

  it('retains captured source bytes and context until an indexed append refresh', async () => {
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
    expect(client.getQueryData<ConversationPositionWindow>(initialKey)?.blocks.map((item) => item.id)).toEqual(['b0']);
    await waitUntilPasses(() => expect(refetch).toHaveBeenCalledTimes(2));

    applyConversationSse(client, 'conversation:updated', {
      id: 'conv-1',
      block_count: 4,
      append: { from_position: 3, blocks: [block('b3', 3)] },
    });
    await waitUntilPasses(() => expect(refetch).toHaveBeenCalledTimes(3));
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
