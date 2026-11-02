// @vitest-environment jsdom
import { act, cleanup, render } from './helpers/dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatSurface } from '../ui/src/chat/ChatSurface';
import type { ConversationTranscriptConsumer } from '../ui/src/query/conversationData';

const boundary = vi.hoisted(() => ({ input: null as any, exact: false, showLatest: false, reveals: [] as any[], scrollRef: { current: null } }));
vi.mock('../ui/src/chat/readingResizeProfile', () => ({ getReadingResizeScale: () => 1 }));
vi.mock('../ui/src/chat/useCompleteReading', () => ({ useCompleteReading: (input: any) => {
  if (!input.enabled || input.total === 0) return { rows: [], bodies: new Map(), ready: true, plan: null,
    materialize: async () => [], onRange: () => {}, protect: () => {}, refresh: async () => {} };
  const expanded = input.expanded['group:activity'];
  const row = { sourcePositions: [42], key: expanded ? 'exact-source' : 'folded-summary', revision: expanded ? 'open' : 'closed' };
  const membership = new Map([[42, { rowKey: row.key, summaryRowKey: 'folded-summary', disclosurePath: expanded ? [] : ['activity'], position: 42 }]]);
  return { rows: [row], bodies: new Map(), ready: true, plan: { rows: [row], membership },
    materialize: async () => [], onRange: () => {}, protect: () => {}, refresh: async () => {} };
} }));
vi.mock('../ui/src/chat/useReadingGeometry', () => ({ useReadingGeometry: (input: any) => ({ geometry: boundary.exact ? { rows: input.rows, exact: true } : null, reportHeight: () => {}, retry: () => {} }) }));
vi.mock('../ui/src/chat/useReadingViewport', () => ({ useReadingViewport: (input: any) => {
  boundary.input = input;
  return { rows: input.geometry?.rows ?? [], appliedGeometry: input.geometry, engine: { range: null, getVirtualItems: () => [], getTotalSize: () => 0 },
    scrollRef: boundary.scrollRef, inputHandlers: {}, showLatest: boundary.showLatest, reveal: async (request: any) => { boundary.reveals.push(request); return { status: 'revealed' }; }, focusTarget: () => {}, cancel: () => {},
    register: () => () => {}, registerRow: () => () => {}, rowOffset: () => 0 };
} }));
afterEach(() => { cleanup(); boundary.exact = false; boundary.showLatest = false; boundary.reveals = []; });

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


it('does not report an empty conversation before admission confirms it', async () => {
  boundary.exact = true;
  const emptyLabel = 'Confirmed-empty fixture';
  const view = render(<ChatSurface events={[]} streaming={false} showEmpty={false} emptyLabel={emptyLabel} />);
  await act(async () => {});
  expect(view.queryByText(emptyLabel)).toBeNull();
  const transcript = { conversationId: 'empty', positionSpaceId: 'space', sourceVersionId: 'source', total: 0,
    displayContext: undefined, readingContext: new Map(), command: null } as unknown as ConversationTranscriptConsumer;
  await act(async () => { view.rerender(<ChatSurface events={[]} streaming={false} transcript={transcript} showEmpty emptyLabel={emptyLabel} />); });
  expect(view.queryByText(emptyLabel)).not.toBeNull();
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
