// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from './helpers/dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatSurface } from '../ui/src/chat/ChatSurface';
import { queryClient } from '../ui/src/query/client';
import type { ConversationTranscriptConsumer } from '../ui/src/query/conversationData';
import { readingAcquisitionFixture } from './helpers/reading-acquisition-fixture';

const boundary = vi.hoisted(() => ({ options: null as any, engine: null as any }));
const source=readingAcquisitionFixture('conv','source',Array.from({length:30},(_,index)=>`row:${index}`));
vi.mock('../ui/src/chat/readingResizeProfile', () => ({ getReadingResizeScale: () => 1 }));
vi.mock('../ui/src/query/readingPresentation', () => ({
  readingManifestOptions: () => ({ queryKey: ['first-open-manifest'], queryFn: async () => source.manifest }),
  isReadingPublicationChanged: () => false,
  ReadingPresentationError: class extends Error {},
  acquirePresentationRows: async (_scope: string, request: any) => {
    return { rows:source.materialize(request), release: () => {} };
  },
}));
vi.mock('../ui/src/chat/useReadingGeometry', async () => {
  const { useMemo, useLayoutEffect } = await import('preact/hooks');
  return { useReadingGeometry: (input: any) => {
    const geometry = useMemo(() => ({ scope: input.scope, rows: input.rows, sizes: input.rows.map(() => 100), serial: 1, exact: true,
      membership: input.membership, rowMembers: input.rowMembers, layout: { width: 600, styleIdentity: 'fixture', fonts: [] }, renderProps: input.renderProps }), [input.scope, input.rows]);
    useLayoutEffect(() => { input.onPrepared(input.rows); }, [geometry]);
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
  frames = new Map(); nextFrame = 0;
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
    getOffsetForIndex:(index:number)=>[index*100,'start'],
    isAtEnd: () => boundary.options.getScrollElement()?.scrollTop === 2600,
    scrollToEnd: () => { boundary.options.getScrollElement().scrollTop = 2600; },
    scrollToOffset: (offset: number) => { boundary.options.getScrollElement().scrollTop = offset; },
  };
});
afterEach(() => { cleanup(); queryClient.clear(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('preserves demanded source identities when the initial mounted range extends beyond the retained tail', async () => {
  const transcript = { conversationId: 'conv', positionSpaceId: 'space', sourceVersionId: 'source', total: 30,
    readingContext: new Map(), command: null } as unknown as ConversationTranscriptConsumer;
  const view = render(<ChatSurface events={[]} streaming={false} transcript={transcript} />);
  await waitFor(async () => {await flushFrames();expect(getComputedStyle(view.container.querySelector('.stream-renderer__virtual-canvas')!).visibility).toBe('visible');});
  expect(view.container.querySelector('.stream-renderer__virtual-canvas [data-block-id="cblk:conv:20"]')).not.toBeNull();
  expect(view.container.querySelectorAll('[data-reading-key][aria-busy="true"]')).toHaveLength(0);
});
