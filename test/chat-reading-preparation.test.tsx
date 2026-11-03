// @vitest-environment jsdom
import { act, cleanup, render } from './helpers/dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatSurface } from '../ui/src/chat/ChatSurface';
import type { ConversationTranscriptConsumer } from '../ui/src/query/conversationData';
import { projectReadingRows, type ReadingProjection } from '../ui/src/chat/readingProjection';
import type { CanonicalChatItemEvent } from '../src/presentation/types';

const boundary = vi.hoisted(() => ({ input: null as any, exact: false, showLatest: false, reveals: [] as any[], scrollRef: { current: null }, project: null as ((expanded: Record<string, boolean>) => ReadingProjection) | null }));
vi.mock('../ui/src/chat/readingResizeProfile', () => ({ getReadingResizeScale: () => 1 }));
vi.mock('../ui/src/chat/useCompleteReading', () => ({ useCompleteReading: (input: any) => {
  if (boundary.project) {
    const projection = boundary.project(input.expanded);
    return { ...projection, plan: projection, rows: projection.rows.map(row => ({ ...row, revision: JSON.stringify([row.key, row.activityGroup?.expanded]) })),
      bodies: new Map(), priorityKeys:[],ready: true, onRange: () => {}, protect: () => {}, refresh: async () => {} };
  }
  if (!input.enabled || input.total === 0) return { rows: [], bodies: new Map(), priorityKeys:[],ready: true, plan: null,
    materialize: async () => [], onRange: () => {}, protect: () => {}, refresh: async () => {} };
  const expanded = input.expanded['group:activity'];
  const row = { sourcePositions: [42], key: expanded ? 'exact-source' : 'folded-summary', revision: expanded ? 'open' : 'closed' };
  const membership = new Map([[42, { rowKey: row.key, summaryRowKey: 'folded-summary', disclosurePath: expanded ? [] : ['activity'], position: 42 }]]);
  return { rows: [row], bodies: new Map(), priorityKeys:[],ready: true, plan: { rows: [row], membership },
    materialize: async () => [], onRange: () => {}, protect: () => {}, refresh: async () => {} };
} }));
vi.mock('../ui/src/chat/useReadingGeometry', async importOriginal => ({ ...await importOriginal<typeof import('../ui/src/chat/useReadingGeometry')>(),useReadingGeometry: (input: any) => ({ geometry: boundary.exact ? { rows: input.rows, exact: true } : null, reportHeight: () => {}, retry: () => {} }) }));
vi.mock('../ui/src/chat/useReadingViewport', () => ({ useReadingViewport: (input: any) => {
  boundary.input = input;
  return { rows: input.geometry?.rows ?? [], appliedGeometry: input.geometry, engine: { options: { paddingStart: 32 }, range: null, getVirtualItems: () => [], getTotalSize: () => 0 },
    scrollRef: boundary.scrollRef, inputHandlers: {}, showLatest: boundary.showLatest, reveal: async (request: any) => { boundary.reveals.push(request); return { status: 'revealed' }; }, focusTarget: () => {}, cancel: () => {},
    register: () => () => {}, registerRow: () => () => {}, rowOffset: () => 0 };
} }));
afterEach(() => { cleanup(); boundary.exact = false; boundary.showLatest = false; boundary.reveals = []; boundary.project = null; });

it('prepares the clicked summary across expand and collapse when final prose shares its source', async () => {
  const event: CanonicalChatItemEvent = { type: 'chat:item', source: { blockId: 'cblk:conv:117', position: 117 },
    item: { type: 'message', role: 'assistant', content_completion: 'complete', parts: [{ type: 'text', text: 'Final prose\n::created-thread{threadId="one"}\n::created-thread{threadId="two"}' }],
      identity: { provider: 'codex', session_id: 'session', native_item_id: 'final', source_record_ordinal: 280, source_sub_block_ordinal: 0 },
      provenance: { provider: 'codex', source: 'verified-provider-transcript', source_event_type: 'message' } } };
  let expanded: Record<string, boolean> = {};
  boundary.project = () => projectReadingRows({ events: [event], conversationId: 'conv', positionSpaceId: 'space', readingContext: new Map(), expanded });
  const closed = boundary.project({});
  const summary = closed.rows.find(row => row.kind === 'activity-summary')!;
  const prose = closed.membership.get(117)!;
  const evidence = { rowKey: summary.key, disclosureOwner: summary.disclosureOwner! };
  const transcript = { conversationId: 'conv', positionSpaceId: 'space', sourceVersionId: 'source', total: 118,
    displayContext: undefined, readingContext: new Map(), command: null } as unknown as ConversationTranscriptConsumer;
  boundary.exact = true;
  const view = render(<ChatSurface events={[]} streaming={false} transcript={transcript} />);
  const coordinate = { conversationId: 'conv', positionSpaceId: 'space', position: 117 };
  for (const open of [true, false]) {
    expanded = { [`group:${evidence.disclosureOwner}`]: open };
    await act(async () => { view.rerender(<ChatSurface events={[]} streaming={open} transcript={transcript} />); });
    expect(await boundary.input.prepare({ ...coordinate, subtarget: 'summary' }, new AbortController().signal, 'disclosure', evidence))
      .toEqual({ status: 'prepared', rowKey: summary.key });
    expect(await boundary.input.prepare({ ...coordinate, subtarget: 'summary' }, new AbortController().signal, 'wrong-owner', { ...evidence, disclosureOwner: 'different' }))
      .toEqual({ status: 'not-renderable' });
  }
  expect(await boundary.input.prepare(coordinate, new AbortController().signal, 'source')).toEqual({ status: 'prepared', rowKey: prose.rowKey });

  boundary.exact = false;
  await act(async () => { view.rerender(<ChatSurface events={[]} streaming transcript={transcript} />); });
  const pending = boundary.input.prepare({ ...coordinate, subtarget: 'summary' }, new AbortController().signal, 'removed', evidence);
  boundary.project = () => ({ ...closed, rows: closed.rows.filter(row => row.key !== summary.key) });
  await act(async () => { view.rerender(<ChatSurface events={[]} streaming={false} transcript={transcript} />); });
  expect(await pending).toEqual({ status: 'not-renderable' });
});

it('waits for exact disclosed source geometry before reporting a folded target prepared', async () => {
  const transcript = { conversationId: 'conv', positionSpaceId: 'space', sourceVersionId: 'source', total: 100,
    displayContext: undefined, readingContext: new Map(), command: null } as unknown as ConversationTranscriptConsumer;
  const view = render(<ChatSurface events={[]} streaming={false} transcript={transcript} />);
  let result: { status: string; rowKey?: string } | undefined;
  let preparation!: Promise<{ status: string; rowKey?: string }>;
  await act(async () => {
    preparation = boundary.input.prepare({ conversationId: 'conv', positionSpaceId: 'space', position: 42 }, new AbortController().signal);
    void preparation.then(value => { result = value; });
  });
  expect(result).toBeUndefined();
  boundary.exact = true;
  await act(async () => { view.rerender(<ChatSurface events={[]} streaming transcript={transcript} />); });
  expect(await preparation).toEqual({ status: 'prepared', rowKey: 'exact-source' });
});



it('keeps explicit latest ownership when clearing a source URL exposes an older saved row restore', async () => {
  boundary.exact = true; boundary.showLatest = true;
  const transcript = { conversationId: 'conv', positionSpaceId: 'space', sourceVersionId: 'source', total: 100,
    displayContext: undefined, readingContext: new Map(), command: null } as unknown as ConversationTranscriptConsumer;
  const onJumpToLatest = vi.fn();
  const view = render(<ChatSurface events={[]} streaming={false} transcript={transcript} onJumpToLatest={onJumpToLatest}
    navigationTarget={{ key: 'source', kind: 'position', turnId: null, blockId: null, smooth: false, target: { conversationId: 'conv', positionSpaceId: 'space', position: 42 } }} />);
  await act(async () => { view.getByRole('button', { name: 'Jump to latest' }).click(); });
  expect(onJumpToLatest).toHaveBeenCalledOnce();
  await act(async () => view.rerender(<ChatSurface events={[]} streaming={false} transcript={transcript} onJumpToLatest={onJumpToLatest}
    readingRestore={{ positionSpaceId: 'space', anchor: { kind: 'row', rowKey: 'saved-row', memberKey: 'saved-member', position: 9, offset: -40 } }}
    navigationTarget={{ key: 'initial-after-url-clear', kind: 'initial', turnId: null, blockId: null, smooth: false }} />));
  expect(boundary.reveals.at(-1)).toMatchObject({ end: true });
  expect(boundary.reveals.some(request => 'restore' in request)).toBe(false);
});
