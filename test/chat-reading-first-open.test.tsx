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
  const size = 100;
  const item = (index: number) => ({
    key: boundary.options.getItemKey(index), index, size, start: index * size, end: (index + 1) * size,
  });
  boundary.engine = {
    options: {}, isScrolling: false,
    get range() {
      const count = boundary.options?.count ?? 0;
      return count ? { startIndex: Math.max(0, count - 4), endIndex: count - 1 } : null;
    },
    get scrollOffset() { return boundary.options.getScrollElement()?.scrollTop ?? 0; },
    measure: () => {}, getTotalSize: () => boundary.options.count * size, cancelScroll: () => {},
    getVirtualItems: () => {
      const count = boundary.options.count;
      const first = Math.max(0, count - 10);
      return Array.from({ length: count - first }, (_, index) => item(first + index));
    },
    getVirtualItemForOffset: (offset: number) => {
      const count = boundary.options.count;
      return count ? item(Math.min(count - 1, Math.max(0, Math.floor(offset / size)))) : undefined;
    },
    getOffsetForIndex:(index:number)=>[index*size,'start'],
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
