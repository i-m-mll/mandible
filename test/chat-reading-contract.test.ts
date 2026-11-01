import { expect, it } from 'vitest';
import { preparePositionSpace } from '../src/conversations/position-space';
import type { ConversationBlock, ChatItem } from '../src/parsers/types';
import { activityOwners, projectReadingRows, sourceActionGroups } from '../ui/src/chat/readingProjection';
import { ReadingWindowRequests } from '../ui/src/query/readingWindowRequests';
import type { ConversationPositionWindow, ConversationStructure } from '../ui/src/api';
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
  const structure = { conversation_id: 'conv', position_space_id: 'space', rows: [0, 1, 2].map(position => ({ position, type: 'event', role: 'assistant', parent_position: null })) } as ConversationStructure;
  const owners = activityOwners(structure);
  const project = (events: CanonicalChatItemEvent[], expanded = new Set<number>()) => projectReadingRows({ events,
    conversationId: 'conv', positionSpaceId: 'space', activityOwners: owners, actionGroups: sourceActionGroups(structure), expanded });
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
