import { planReadingLayout, type ReadingPlanMember } from '../src/presentation/reading-plan';
import { chatItemIdentityKey } from '../src/conversation-control/provider-live';
import { ConversationStructureCache } from '../src/conversations/structure-cache';
import { CURRENT_CONVERSATION_SOURCE_EPOCHS } from '../src/conversations/source-types';
import { expect, it } from 'vitest';
import { preparePositionSpace } from '../src/conversations/position-space';
import type { ConversationBlock, ChatItem } from '../src/parsers/types';
import { projectReadingRows } from '../ui/src/chat/readingProjection';
import { ReadingWindowRequests } from '../ui/src/query/readingWindowRequests';
import type { ConversationPositionWindow } from '../ui/src/api';
import { activityRunFacts, presentActivityRunFacts } from '../src/presentation/activity-presentation';
import type { ConversationDisplayContext } from '../src/conversations/display-context';
import { projectDisplayFragments } from '../src/presentation/fragments';
import { presentTool } from '../src/presentation/tool-presentation';
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

it('keeps canonical run and exact member identity through window edges and disclosure changes', () => {
  const context = new Map([0, 1, 2].map(position => [position, { position, activity_owner: 0, action_scope: { start: 0, end: 2 } }]));
  const facts = activityRunFacts([item('zero').item, item('one').item, item('two').item] as import('../src/presentation/types').DisplayActivityItem[]);
  const displayContext: ConversationDisplayContext = { version: 1, aliases: [], owners: [],
    fragments: [0, 1, 2].map(position => ({ id: `${position}:activity:0`, coordinate: { position, part: 'activity:0' }, kind: 'activity',
      activity_run_id: '0:activity:0', paired_source_positions: [] })),
    activity_runs: [{ id: '0:activity:0', first: { position: 0, part: 'activity:0' }, last: { position: 2, part: 'activity:0' }, member_count: 3,
      presentation: { ...presentActivityRunFacts(facts), facts } }] };
  const project = (events: CanonicalChatItemEvent[], expanded: Record<string, boolean> = {}) => projectReadingRows({ events,
    conversationId: 'conv', positionSpaceId: 'space', readingContext: context, displayContext, expanded });
  const tail = project([item('one', 1), item('two', 2)]);
  const all = project([item('zero', 0), item('one', 1), item('two', 2)]);
  expect(tail.rows[0].key).toBe(all.rows[0].key);
  expect(tail.rows[0].actionGroup).toMatchObject({ start: 0, end: 2 });
  expect(all.membership.get(2)?.disclosurePath).toEqual(['0:activity:0']);
  const open = project([item('one', 1), item('two', 2)], { 'group:0:activity:0': true });
  expect(open.rows).toHaveLength(3);
  expect(open.membership.get(2)?.disclosurePath).toEqual([]);
  expect(open.membership.get(2)?.summaryRowKey).toBe(tail.rows[0].key);
  const live = project([item('one')]);
  expect(open.viewMembership.get(live.rows[0].key)?.memberKey).toBe(open.rows[1].key);
  const closed = project([item('one', 1)]);
  expect(closed.rows).toHaveLength(1);
  expect(closed.rows[0].kind).toBe('activity-summary');
  expect(closed.viewMembership.get(live.rows[0].key)).toMatchObject({
    rowKey: closed.rows[0].key, memberKey: open.rows[1].key, position: 1, disclosurePath: ['0:activity:0'], subtarget: 'source:1',
  });
  const optimistic = { ...item('prompt'), displayKey: 'intent:exact' };
  const durable = { ...item('prompt', 3), intentId: 'exact' };
  expect(project([durable]).viewMembership.get(project([optimistic]).rows[0].key)?.memberKey).toBe(project([durable]).rows[0].key);
});

it.each([false, true])('keeps a live system diagnostic outside assistant activity (saved prefix: %s)', saved => {
  const prefix = [item('first', saved ? 0 : undefined), item('second', saved ? 1 : undefined)];
  const facts = activityRunFacts(prefix.map(event => event.item) as import('../src/presentation/types').DisplayActivityItem[]);
  const displayContext: ConversationDisplayContext | undefined = saved ? { version: 1, aliases: [], owners: [],
    fragments: [0, 1].map(position => ({ id: `${position}:activity:0`, coordinate: { position, part: 'activity:0' }, kind: 'activity',
      activity_run_id: '0:activity:0', paired_source_positions: [] })),
    activity_runs: [{ id: '0:activity:0', first: { position: 0, part: 'activity:0' }, last: { position: 1, part: 'activity:0' }, member_count: 2,
      presentation: { ...presentActivityRunFacts(facts), facts } }] } : undefined;
  const diagnostic = item('failure');
  diagnostic.item = { ...diagnostic.item, type: 'activity', role: 'system', activity_kind: 'diagnostic', severity: 'error' } as ChatItem;
  const projected = projectReadingRows({ events: [...prefix, item('live-assistant'), diagnostic], conversationId: 'conv',
    positionSpaceId: 'space', readingContext: new Map(), displayContext, expanded: {} });
  expect(projected.rows).toHaveLength(2);
  expect(projected.rows[0].activityGroup?.items.map(node => node.entity)).toEqual(['assistant', 'assistant', 'assistant']);
  expect(projected.rows[1].nodes[0]).toMatchObject({ kind: 'activity', entity: 'system', item: { severity: 'error' } });
});

it('keeps an off-window call and its inline result under the full call identity without extending history', () => {
  const call = { ...item('call', 0), item: { ...item('call').item, type: 'tool-call', role: 'assistant', phase: 'call',
    tool_id: 'tool', tool_name: 'read', input: { file_path: '/tmp/exact-file' }, parts: [] } } as CanonicalChatItemEvent;
  const result = { ...item('result', 2), item: { ...item('result').item, type: 'tool-call', role: 'tool', phase: 'result',
    tool_id: 'tool', output: 'inline result', parts: [] }, source: { ...item('result', 2).source!, parentBlockId: call.source!.blockId } } as CanonicalChatItemEvent;
  const fragment = projectDisplayFragments([call, result])[0];
  if (fragment.node.kind !== 'activity' || fragment.node.item.type !== 'tool-call-activity') throw new Error('Expected paired call');
  const { input, result: paired, ...shellItem } = fragment.node.item;
  const facts = activityRunFacts([fragment.node.item]);
  const coordinate = { position: 0, part: fragment.part };
  const id = `0:${fragment.part}`;
  const displayContext: ConversationDisplayContext = { version: 1,
    fragments: [{ id, coordinate, kind: 'activity', activity_run_id: id, paired_source_positions: [2] }],
    activity_runs: [{ id, first: coordinate, last: coordinate, member_count: 1, presentation: { ...presentActivityRunFacts(facts), facts } }],
    aliases: [{ position: 2, fragment_id: id }], owners: [{ fragment_id: id, coordinate, memberKey: fragment.memberKey,
      item: shellItem, source: { ...call.source!, detailsLoaded: false }, header: presentTool(shellItem.name, input, shellItem.toolKind),
      action_scope: { start: 0, end: 2 } }] };
  const readingContext = new Map([0, 2].map(position => [position, { position, activity_owner: 0, action_scope: { start: 0, end: 2 } }]));
  const project = (events: CanonicalChatItemEvent[]) => projectReadingRows({ events, conversationId: 'conv', positionSpaceId: 'space', readingContext, displayContext, expanded: {} });
  const bounded = project([result]);
  const full = project([call, result]);
  expect(bounded.rows[0].key).toBe(full.rows[0].key);
  expect(bounded.membership.get(0)?.rowKey).toBe(bounded.membership.get(2)?.rowKey);
  expect(bounded.rows[0].sources.map(source => source.blockId)).toEqual([call.source!.blockId, result.source!.blockId]);
  expect(bounded.rows[0].nodes[0]).toMatchObject({ kind: 'activity', item: { input: undefined, result: paired } });
  expect(bounded.actionRuns.values().next().value?.events).toEqual([result]);
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
    readingContext: new Map([[12, { position: 12, activity_owner: null, action_scope: { start: 10, end: 15 } }]]), expanded: {} });
  const pending = projected.rows.find(row => row.items[0]?.item.identity.native_item_id === 'pending')!;
  const run = projected.actionRuns.get(pending.actionGroup.key)!;
  expect(run.group).toMatchObject({ start: 10, end: 15 });
  expect(run.events.map(event => event.item.identity.native_item_id)).toEqual(['saved', 'pending']);
  expect(pending.sources).toEqual([]);
  expect(pending.totalTokens).toBe(10);
  const local = projected.rows.find(row => row.items[0]?.item.identity.native_item_id === 'unrelated')!;
  expect(projected.actionRuns.get(local.actionGroup.key)?.events).toHaveLength(1);
});

it('keeps repeated native tool IDs distinct and pairs results by exact call coordinates', () => {
  const call = (position: number): CanonicalChatItemEvent => ({ ...item('duplicate', position), item: {
    ...item('duplicate', position).item, type: 'tool-call', phase: 'call', role: 'assistant', tool_id: 'repeated',
    tool_name: 'read', input: { file_path: `/file/${position}` }, parts: [],
  } });
  const result = (position: number, owner: CanonicalChatItemEvent): CanonicalChatItemEvent => ({ ...item('result', position), item: {
    ...item('result', position).item, type: 'tool-call', phase: 'result', role: 'tool', tool_id: 'repeated', output: `result ${position}`, parts: [],
  }, source: { ...item('result', position).source!, parentBlockId: owner.source!.blockId } });
  const first = call(0), second = call(2);
  const events = [first, result(1, first), second, result(3, second)];
  const fragments = projectDisplayFragments(events, true);
  expect(fragments.map(fragment => [fragment.position, fragment.pairedSourcePositions])).toEqual([[0, [1]], [2, [3]]]);
  const context = new Map([0,1,2,3].map(position => [position, {position, activity_owner: 0, action_scope: {start: 0, end: 3}}]));
  const project = (expanded: Record<string, boolean>) => projectReadingRows({ events, readingContext: context,
    conversationId: 'conv', positionSpaceId: 'space', expanded });
  const closed = project({});
  const open = project({ [`group:${closed.rows[0].disclosureOwner}`]: true });
  expect(new Set(open.rows.map(row => row.key)).size).toBe(open.rows.length);
  expect(open.membership.get(1)?.memberKey).not.toBe(open.membership.get(3)?.memberKey);
  expect(open.membership.get(1)?.subtarget).not.toBe(open.membership.get(3)?.subtarget);
  expect(open.viewMembership.has(chatItemIdentityKey(first.item)!)).toBe(false);
});

it('invalidates geometry when ownership or provisional summary contributors change', () => {
  const group = {key: 'group', start: 0, end: 8};
  const activity = item('activity').item as import('../src/parsers/types').ActivityItem;
  const member = (key: string, kind: 'activity' | 'content', position?: number): ReadingPlanMember => ({
    key, kind, position, part: 'part', speaker: 'assistant', actionGroup: group, activity: kind === 'activity' ? activity : null,
    dependencyRevision: key, sourcePositions: position === undefined ? [] : [position], handoffKeys: [],
  });
  const before = member('before', 'content', 0), first = member('first', 'activity', 1), second = member('second', 'activity', 2), after = member('after', 'content', 3);
  const layout = (members: ReadingPlanMember[]) => planReadingLayout({ members, conversationId: 'conv', positionSpaceId: 'space', expanded: {'group:run': true} });
  const singleton = layout([before, first, after]).rows.find(row => row.key === first.key)!;
  const facts = activityRunFacts([activity, activity]);
  const run = {id: 'run', revision: 'canonical', member_count: 2, presentation: {...presentActivityRunFacts(facts), facts}};
  const grouped = layout([before, {...first, run}, {...second, run}, after]).rows.find(row => row.key === first.key)!;
  expect(grouped.revision).not.toBe(singleton.revision);
  const provisional = member('live', 'activity');
  const canonical = [{...first, run}, {...second, run}];
  const initial = layout([...canonical, provisional]).rows[0];
  const updated = layout([...canonical, {...provisional, dependencyRevision: 'updated'}]).rows[0];
  expect(updated.revision).not.toBe(initial.revision);
});
