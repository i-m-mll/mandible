import { ConversationStructureCache } from '../src/conversations/structure-cache';
import { CURRENT_CONVERSATION_SOURCE_EPOCHS } from '../src/conversations/source-types';
import { expect, it } from 'vitest';
import { preparePositionSpace } from '../src/conversations/position-space';
import type { ConversationBlock, ChatItem } from '../src/parsers/types';
import { projectReadingRows } from '../ui/src/chat/readingProjection';
import { ReadingWindowRequests } from '../ui/src/query/readingWindowRequests';
import type { ConversationPositionWindow } from '../ui/src/api';
import type { CanonicalChatItemEvent } from '../ui/src/components/stream-renderer/types';

function item(id: string, position?: number): CanonicalChatItemEvent {
  const value: ChatItem = { type: 'activity', role: 'assistant', activity_kind: 'information', parts: [{ type: 'text', text: id }],
    content_completion: 'complete', identity: { provider: 'codex', session_id: 'session', native_item_id: id,
      source_record_ordinal: 0, source_sub_block_ordinal: 0 },
    provenance: { provider: 'codex', source: position === undefined ? 'live-provider-event' : 'verified-provider-transcript', source_event_type: 'native' } };
  return { type: 'chat:item', item: value, ...(position === undefined ? {} : { source: { blockId: `cblk:conv:${position}`, position } }) };
}

it('proves native subitem prefixes independently of content edits and presentation coordinates', () => {
  const block = (position: number, text: string): Omit<ConversationBlock, 'id' | 'conversation_id'> => ({
    position, type: 'event', role: 'assistant', content: text, timestamp: null, parent_id: null,
    metadata: { chat_item: item('native').item, source_record_ordinal: 100 } });
  const initial = preparePositionSpace([block(0, 'first')], null, false);
  const edited = preparePositionSpace([block(0, 'edited')], initial, false);
  expect(edited.position_space_id).toBe(initial.position_space_id);
  const append = preparePositionSpace([block(1, 'second')], initial, true);
  expect(append.position_space_id).toBe(initial.position_space_id);
  const rebuilt = preparePositionSpace([block(0, 'edited'), block(1, 'second')], append, false);
  expect(rebuilt.position_space_id).toBe(initial.position_space_id);
  const distinct = block(0, 'edited');
  distinct.metadata.chat_item!.identity.native_content_index = 1;
  expect(preparePositionSpace([distinct], initial, false).position_space_id).not.toBe(initial.position_space_id);
  const anonymous = block(0, 'immutable'); delete anonymous.metadata.chat_item;
  const before = preparePositionSpace([anonymous], null, false);
  expect(preparePositionSpace([{ ...anonymous, content: 'replaced' }], before, false).position_space_id).not.toBe(before.position_space_id);
});

it('keeps summary/member/native/intent identity through window edges and disclosure changes', () => {
  const context = new Map([0, 1, 2].map(position => [position, { position, activity_owner: 0, action_scope: { start: 0, end: 2 } }]));
  const project = (events: CanonicalChatItemEvent[], expanded = new Set<number>()) => projectReadingRows({ events,
    conversationId: 'conv', positionSpaceId: 'space', readingContext: context, expanded });
  const tail = project([item('one', 1), item('two', 2)]);
  const all = project([item('zero', 0), item('one', 1), item('two', 2)]);
  expect(tail.rows[0].key).toBe(all.rows[0].key);
  expect(tail.rows[0].actionGroup).toMatchObject({ start: 0, end: 2 });
  expect(all.membership.get(2)?.disclosurePath).toEqual([0]);
  const open = project([item('one', 1), item('two', 2)], new Set([0]));
  expect(open.rows).toHaveLength(2);
  expect(open.membership.get(2)?.disclosurePath).toEqual([]);
  expect(project([item('one')]).rows[0].key).toBe(open.rows[0].key);
  const live = project([item('one')]);
  const closed = project([item('one', 1)]);
  expect(closed.rows).toHaveLength(1);
  expect(closed.rows[0].kind).toBe('activity-summary');
  expect(closed.viewMembership.get(live.rows[0].key)).toMatchObject({
    rowKey: closed.rows[0].key, memberKey: live.rows[0].key, position: 1, disclosurePath: [0], subtarget: 'source:1',
  });
  const optimistic = { ...item('prompt'), displayKey: 'intent:exact' };
  const durable = { ...item('prompt', 3), intentId: 'exact' };
  expect(project([optimistic]).rows[0].key).toBe(project([durable]).rows[0].key);
});

it('deduplicates bounded scoped Query requests and cancels late completions on a space change', async () => {
  const requests = new ReadingWindowRequests();
  requests.select('conv', 'space');
  const completions: Array<(window: ConversationPositionWindow) => void> = [];
  let captured: AbortSignal | undefined;
  const read = async (_id: string, request: { signal?: AbortSignal }) => {
    captured = request.signal;
    return new Promise<ConversationPositionWindow>(done => { completions.push(done); });
  };
  const first = requests.read({ position: 0 }, read);
  expect(requests.read({ position: 0 }, read)).toBe(first);
  const second = requests.read({ position: 1 }, read);
  expect(await requests.read({ position: 2 }, read)).toEqual({ status: 'busy' });
  await Promise.resolve();
  requests.select('conv', 'new-space');
  expect(captured?.aborted).toBe(true);
  for (const complete of completions) complete({ conversation: { id: 'conv' }, position_space_id: 'space' } as ConversationPositionWindow);
  expect(await Promise.all([first, second])).toEqual([{ status: 'cancelled' }, { status: 'cancelled' }]);
});

it('publishes canonical owner and complete action scope independently of bounded windows and append generations', () => {
  const cache = new ConversationStructureCache(undefined, { cachePath: ':memory:' });
  const epochs = CURRENT_CONVERSATION_SOURCE_EPOCHS;
  const manifest = (version: string, count: number) => ({ conversation_id: 'conv', source_version_id: version,
    parser_format: epochs.parserFormat, parser_version: epochs.parserVersion,
    normalization_version: epochs.normalizationVersion, redaction_epoch: epochs.redactionEpoch, block_count: count });
  const row = (position: number, type: 'tool_use' | 'tool_result' | 'assistant_message' | 'user_message', parentPosition: number | null = null) => ({ position, type,
    role: type === 'tool_result' ? 'tool' as const : type === 'user_message' ? 'user' as const : 'assistant' as const,
    parentPosition, recordOffset: position * 10, recordLength: 10, recordOrdinal: position, subBlockOrdinal: 0 });
  try {
    cache.replaceRows(manifest('v1', 3), [row(0, 'user_message'), row(1, 'tool_use'), row(2, 'tool_result', 1)]);
    expect(cache.readReadingContext('conv', 'v1', 2, 2, epochs)).toEqual([{ position: 2, activity_owner: 1, action_scope: { start: 1, end: 2 } }]);
    cache.replaceRows(manifest('v2', 5), [row(3, 'assistant_message'), row(4, 'user_message')], new Map(), 'v1');
    expect(cache.readReadingContext('conv', 'v2', 2, 2, epochs)).toEqual([{ position: 2, activity_owner: 1, action_scope: { start: 1, end: 3 } }]);
    expect(cache.readReadingContext('conv', 'v1', 2, 2, epochs)?.[0].action_scope.end).toBe(2);
    expect(cache.readReadingContext('conv', 'v2', 4, 4, epochs)?.[0].action_scope).toEqual({ start: 4, end: 4 });
  } finally { cache.close(); }
});

it('keeps provisional actions within their contiguous run and binds only an adjacent canonical aggregate scope', () => {
  const assistant = (id: string, position?: number) => ({ ...item(id, position), item: { ...item(id, position).item, type: 'message', role: 'assistant', parts: [{ type: 'text', text: id }] } } as CanonicalChatItemEvent);
  const prompt = { ...assistant('prompt'), item: { ...assistant('prompt').item, role: 'user' } } as CanonicalChatItemEvent;
  const prefix = { ...assistant('saved', 12), usage: { key: 'same-message', input: 7, output: 3 } };
  const suffix = { ...assistant('pending'), usage: { key: 'same-message', input: 7, output: 3 } };
  const projected = projectReadingRows({ events: [assistant('unrelated'), prompt, prefix, suffix], conversationId: 'conv', positionSpaceId: 'space',
    readingContext: new Map([[12, { position: 12, activity_owner: null, action_scope: { start: 10, end: 15 } }]]), expanded: new Set() });
  const pending = projected.rows.find(row => row.items[0]?.item.identity.native_item_id === 'pending')!;
  const run = projected.actionRuns.get(pending.actionGroup.key)!;
  expect(run.group).toMatchObject({ start: 10, end: 15 });
  expect(run.events.map(event => event.item.identity.native_item_id)).toEqual(['saved', 'pending']);
  expect(pending.sources).toEqual([]);
  expect(pending.totalTokens).toBe(10);
  const local = projected.rows.find(row => row.items[0]?.item.identity.native_item_id === 'unrelated')!;
  expect(projected.actionRuns.get(local.actionGroup.key)?.events).toHaveLength(1);
});
