// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from './helpers/dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatSurface } from '../ui/src/chat/ChatSurface';
import { queryClient } from '../ui/src/query/client';
import type { ConversationTranscriptConsumer } from '../ui/src/query/conversationData';

const boundary = vi.hoisted(() => ({ options: null as any, engine: null as any, acquired: [] as number[], geometryScopes: [] as string[] }));
vi.mock('../ui/src/chat/readingResizeProfile', () => ({ getReadingResizeScale: () => 1 }));
vi.mock('../ui/src/query/readingPresentation', () => ({
  readingManifestOptions: () => ({ queryKey: ['first-open-manifest'], queryFn: async () => ({}) }),
  isReadingPublicationChanged: () => false,
  ReadingPresentationError: class extends Error {},
  acquirePresentationRows: async (_scope: string, request: any) => {
    boundary.acquired.push(...request.rows.map((ref: any) => Number(ref.key.split(':')[1])));
    return { rows: request.rows.map((ref: any) => ({ ...ref, kind: 'content', isFinalResponse: false, protectedPositions: [], sources: [], nodes: [], items: [], actionGroup: { key: 'turn', start: 0, end: 30 }, disclosureOwner: null })), release: () => {} };
  },
}));
vi.mock('../src/presentation/reading-composition', () => ({
  composeConversationReading: () => ({ plan: { rows: Array.from({ length: 30 }, (_, index) => ({ key: `row:${index}`, revision: '1', sourcePositions: [], memberKeys: [`row:${index}`] })), membership: new Map(), viewMembership: new Map() }, actionRuns: new Map() }),
  readingCompositionRequests: (_composition: any, refs: any) => refs,
  materializeConversationReading: (_composition: any, _refs: any, rows: any) => ({ status: 'source', rows }),
}));
vi.mock('../ui/src/chat/useReadingGeometry', async () => {
  const { useMemo, useLayoutEffect } = await import('preact/hooks');
  return { useReadingGeometry: (input: any) => {
    const geometry = useMemo(() => ({ scope: input.scope, rows: input.rows, sizes: input.rows.map(() => 100), serial: 1, exact: true,
      membership: input.membership, rowMembers: input.rowMembers, layout: { width: 600, styleIdentity: 'fixture', fonts: [] }, renderProps: input.renderProps }), [input.scope, input.rows]);
    useLayoutEffect(() => { boundary.geometryScopes.push(input.scope); input.onPrepared(input.rows); }, [geometry]);
    return { geometry, reportHeight: () => {}, retry: () => {} };
  } };
});
vi.mock('@tanstack/react-virtual', async importOriginal => {
  const actual = await importOriginal<typeof import('@tanstack/react-virtual')>();
  return { ...actual, useVirtualizer: (options: any) => { boundary.options = options; boundary.engine.options = options; return boundary.engine; } };
});
let frames = new Map<number, FrameRequestCallback>(); let nextFrame = 0;
async function flushFrames() {
  await act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)); });
}
beforeEach(() => {
  boundary.acquired = []; boundary.geometryScopes = []; frames = new Map(); nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(3000);
  boundary.engine = {
    options: {}, isScrolling: false, range: { startIndex: 26, endIndex: 29 },
    get scrollOffset() { return boundary.options.getScrollElement()?.scrollTop ?? 0; },
    measure: () => {}, getTotalSize: () => boundary.options.count * 100, cancelScroll: () => {},
    getVirtualItems: () => Array.from({ length: Math.min(10, boundary.options.count) }, (_, index) => {
      const row = boundary.options.count - 10 + index; return { key: boundary.options.getItemKey(row), index: row, size: 100, start: row * 100, end: (row + 1) * 100 };
    }),
    getVirtualItemForOffset: (offset: number) => ({ index: Math.min(29, Math.floor(offset / 100)) }),
    isAtEnd: () => boundary.options.getScrollElement()?.scrollTop === 2600,
    scrollToEnd: () => { boundary.options.getScrollElement().scrollTop = 2600; },
    scrollToOffset: (offset: number) => { boundary.options.getScrollElement().scrollTop = offset; },
  };
});
afterEach(() => { cleanup(); queryClient.clear(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('opens a measured long chat when mounted body demand extends beyond the retained initial tail', async () => {
  const transcript = { conversationId: 'conv', positionSpaceId: 'space', sourceVersionId: 'source', total: 30,
    readingContext: new Map(), command: null } as unknown as ConversationTranscriptConsumer;
  const view = render(<ChatSurface events={[]} streaming={false} transcript={transcript} />);
  await waitFor(() => expect(boundary.options.count).toBe(30));
  await flushFrames();
  await flushFrames();
  expect(boundary.acquired).toContain(20);
  await waitFor(() => expect(view.container.querySelector('.stream-renderer__virtual-canvas')?.getAttribute('style')).toContain('visibility: visible'));
  expect(boundary.geometryScopes).toContain('conv:space');
  expect(view.container.querySelectorAll('[data-reading-key]')).toHaveLength(10);
  expect(view.container.querySelectorAll('[data-reading-key][aria-busy="true"]')).toHaveLength(0);
});
