// @vitest-environment jsdom
import { act, cleanup, render } from './helpers/dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatSurface } from '../ui/src/chat/ChatSurface';
import type { ConversationTranscriptConsumer } from '../ui/src/query/conversationData';

const boundary = vi.hoisted(() => ({ input: null as any, exact: false, scrollRef: { current: null } }));
vi.mock('../ui/src/chat/readingResizeProfile', () => ({ getReadingResizeScale: () => 1 }));
vi.mock('../ui/src/chat/useCompleteReading', () => ({ useCompleteReading: (input: any) => {
  const expanded = input.expanded['group:activity'];
  const row = { sourcePositions: [42], key: expanded ? 'exact-source' : 'folded-summary', revision: expanded ? 'open' : 'closed' };
  const membership = new Map([[42, { rowKey: row.key, summaryRowKey: 'folded-summary', disclosurePath: expanded ? [] : ['activity'], position: 42 }]]);
  return { rows: [row], bodies: new Map(), ready: true, plan: { rows: [row], membership },
    materialize: async () => [], onRange: () => {}, protect: () => {}, refresh: async () => {} };
} }));
vi.mock('../ui/src/chat/useReadingGeometry', () => ({ useReadingGeometry: (input: any) => ({ geometry: boundary.exact ? { rows: input.rows, exact: true } : null, reportHeight: () => {}, retry: () => {} }) }));
vi.mock('../ui/src/chat/useReadingViewport', () => ({ useReadingViewport: (input: any) => {
  boundary.input = input;
  return { rows: input.geometry?.rows ?? [], engine: { range: null, getVirtualItems: () => [], getTotalSize: () => 0 },
    scrollRef: boundary.scrollRef, inputHandlers: {}, showLatest: false, reveal: async () => ({ status: 'revealed' }), focusTarget: () => {}, cancel: () => {},
    register: () => () => {}, registerRow: () => () => {}, rowOffset: () => 0 };
} }));
afterEach(() => { cleanup(); boundary.exact = false; });

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
