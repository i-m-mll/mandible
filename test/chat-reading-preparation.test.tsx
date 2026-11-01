// @vitest-environment jsdom
import { act, cleanup, render } from './helpers/dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatSurface } from '../ui/src/chat/ChatSurface';
import type { ConversationTranscriptConsumer } from '../ui/src/query/conversationData';
import type { CanonicalChatItemEvent, PersistedBlockSource } from '../src/presentation/types';
import type { ActivityItem } from '../src/parsers/types';
import type { ConversationDisplayContext } from '../src/conversations/display-context';
import { projectDisplayFragments } from '../src/presentation/fragments';
import { activityRunFacts, presentActivityRunFacts } from '../src/presentation/activity-presentation';
import { presentTool } from '../src/presentation/tool-presentation';

const boundary = vi.hoisted(() => ({ input: null as any, scrollRef: { current: null }, engine: {
  range: { startIndex: 0, endIndex: 0 }, measureElement: () => {}, containerRef: () => {},
  getVirtualItems: (): { index: number }[] => boundary.input.rows.map((_: unknown, index: number) => ({ index })),
} }));
vi.mock('../ui/src/chat/useReadingViewport', () => ({ useReadingViewport: (input: unknown) => {
  boundary.input = input;
  return { engine: boundary.engine, scrollRef: boundary.scrollRef, inputHandlers: {}, showLatest: false,
    register: () => () => {}, registerRow: () => () => {}, cancel: () => {}, rowOffset: () => 0 };
} }));
afterEach(cleanup);

it('prepares both lazy sources opened by a result-only reveal before reporting prepared', async () => {
  const event = (phase: 'call' | 'result', position: number): CanonicalChatItemEvent => ({ type: 'chat:item', item: {
    type: 'tool-call', phase, role: phase === 'call' ? 'assistant' : 'tool', tool_id: 'tool', tool_name: 'read',
    ...(phase === 'call' ? { input: { file_path: '/tmp/exact-file' } } : { output: 'exact result body' }), parts: [],
    identity: { provider: 'codex', session_id: 'session', native_item_id: phase, native_turn_id: 'turn',
      source_record_ordinal: position, source_sub_block_ordinal: 0 }, content_completion: 'complete',
    provenance: { provider: 'codex', source: 'verified-provider-transcript', source_event_type: 'native' },
  }, source: { blockId: `cblk:conv:${position}`, position, ...(phase === 'result' ? { parentBlockId: 'cblk:conv:0' } : {}) } });
  const call = event('call', 0);
  const fullResult = event('result', 2);
  const fragment = projectDisplayFragments([call, fullResult])[0];
  if (fragment.node.kind !== 'activity' || fragment.node.item.type !== 'tool-call-activity') throw new Error('Expected paired call');
  const fullCall = fragment.node.item;
  const { input, result: _result, ...shellItem } = fullCall;
  const unrelated: CanonicalChatItemEvent = { ...call, item: { ...call.item, type: 'activity', activity_kind: 'information',
    identity: { ...call.item.identity, native_item_id: 'unrelated' }, parts: [{ type: 'text', text: 'Other activity' }] } as ActivityItem,
    source: { blockId: 'cblk:conv:3', position: 3, detailsLoaded: false } };
  const facts = activityRunFacts([fullCall, unrelated.item as ActivityItem]);
  const coordinate = { position: 0, part: fragment.part };
  const id = `0:${fragment.part}`;
  const displayContext: ConversationDisplayContext = { version: 1,
    fragments: [{ id, coordinate, kind: 'activity', activity_run_id: id, paired_source_positions: [2] },
      { id: '3:activity:0', coordinate: { position: 3, part: 'activity:0' }, kind: 'activity', activity_run_id: id, paired_source_positions: [] }],
    activity_runs: [{ id, first: coordinate, last: { position: 3, part: 'activity:0' }, member_count: 2, presentation: { ...presentActivityRunFacts(facts), facts } }],
    aliases: [{ position: 2, fragment_id: id }], owners: [{ fragment_id: id, coordinate, memberKey: fragment.memberKey,
      item: shellItem, source: { ...call.source!, detailsLoaded: false }, header: presentTool(shellItem.name, input), action_scope: { start: 0, end: 2 } }] };
  let finishDetails!: () => void;
  const prepareDetails = vi.fn((_sources: readonly PersistedBlockSource[], _signal: AbortSignal) => new Promise<void>(resolve => { finishDetails = resolve; }));
  const replaceAround = vi.fn(async () => 'loaded' as const);
  const transcript: ConversationTranscriptConsumer = { conversationId: 'conv', positionSpaceId: 'space', sourceVersionId: 'source',
    displayContext, readingContext: new Map([[2, { position: 2, activity_owner: 0, action_scope: { start: 0, end: 2 } }]]),
    activeWindow: { start: 2, end: 3 }, loadedIntervals: [{ start: 2, end: 3 }], total: 4, hasOlder: true, hasNewer: false,
    historyLoading: false, command: null, protect: () => {}, cancelNavigation: () => {}, prepareDetails, replaceAround,
    loadOlder: () => 'busy', loadNewer: () => 'busy', loadAround: () => 'busy' };
  const lazyResult = { ...fullResult, source: { ...fullResult.source!, detailsLoaded: false } };
  const view = render(<ChatSurface events={[lazyResult, unrelated]} streaming={false} transcript={transcript} />);
  let prepared = false;
  let preparation!: Promise<{ status: string; rowKey?: string }>;
  await act(async () => {
    preparation = boundary.input.prepare({ conversationId: 'conv', positionSpaceId: 'space', position: 2 }, new AbortController().signal, 'result');
    void preparation.then(() => { prepared = true; });
  });
  expect(prepareDetails.mock.calls[0][0].map(source => source.position)).toEqual([0, 2]);
  await act(async () => { finishDetails(); });
  view.rerender(<ChatSurface events={[fullResult, unrelated]} streaming={false} transcript={transcript} />);
  await act(async () => {});
  expect(prepared).toBe(false);
  const hydrated = { ...transcript, displayContext: { ...displayContext, owners: displayContext.owners.map(owner => ({ ...owner, details: fullCall })) } };
  await act(async () => { view.rerender(<ChatSurface events={[fullResult, unrelated]} streaming={false} transcript={hydrated} />); });
  expect(await preparation).toMatchObject({ status: 'prepared' });
  expect(replaceAround).not.toHaveBeenCalled();
  expect(view.container.querySelector('[data-block-id="cblk:conv:2"]')?.textContent).toContain('exact result body');
  expect(view.container.textContent).not.toContain('Loading tool input');
});
