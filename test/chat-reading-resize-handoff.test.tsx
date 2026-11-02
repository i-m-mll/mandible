// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from './helpers/dom';
import { afterEach, expect, it, vi } from 'vitest';
import { useCallback } from 'preact/hooks';
import { useReadingViewport } from '../ui/src/chat/useReadingViewport';
import type { ReadingGeometry } from '../ui/src/chat/useReadingGeometry';

vi.hoisted(() => { Object.defineProperty(window, 'onscrollend', { configurable: true, value: null }); });
let viewport: ReturnType<typeof useReadingViewport>;
const rows = Array.from({ length: 100 }, (_, index) => ({ key: `row:${index}`, revision: 'same' }));
const provisional: ReadingGeometry = { scope: 'chat', rows, sizes: rows.map(() => 80), exact: false, serial: 1,
  layout: { width: 853, styleIdentity: 'same-layout', fonts: [] }, membership: new Map(), rowMembers: new Map(), renderProps: () => ({} as any) };
const exact: ReadingGeometry = { ...provisional, sizes: rows.map(() => 100), exact: true, serial: 2 };
function Harness({ geometry }: { geometry: ReadingGeometry }) {
  viewport = useReadingViewport({ scope: 'chat', positionSpaceId: 'space', geometry, clearance: 16, disclosures: {}, protectedKeys: new Set(),
    onInput: () => {}, onApplied: () => {}, onRange: () => {}, prepare: async () => ({ status: 'not-renderable' }) });
  const connect = useCallback((node: HTMLDivElement | null) => {
    viewport.scrollRef.current = node;
    if (!node) return;
    Object.defineProperties(node, { clientHeight: { value: 400 }, offsetHeight: { value: 400 }, offsetWidth: { value: 853 }, clientWidth: { value: 853 },
      scrollHeight: { get: () => Math.max(400, parseFloat((node.firstElementChild as HTMLElement)?.style.height ?? '0')) } });
    node.scrollTo = ((options: ScrollToOptions) => {
      node.scrollTop = Math.max(0, Math.min(options.top ?? node.scrollTop, node.scrollHeight - node.clientHeight));
      queueMicrotask(() => { node.dispatchEvent(new Event('scroll')); node.dispatchEvent(new Event('scrollend')); });
    }) as typeof node.scrollTo;
  }, []);
  return <div ref={connect} {...viewport.inputHandlers}><div style={{ height: `${viewport.engine.getTotalSize()}px` }}>
    {viewport.engine.getVirtualItems().map(item => <div key={item.key} style={{ transform: `translateY(${item.start}px)`, height: `${item.size}px` }} />)}
  </div></div>;
}
afterEach(() => { cleanup(); localStorage.clear(); });

it('preserves a near-tail logical row when the same provisional plan commits larger exact sizes', async () => {
  const view = render(<Harness geometry={provisional} />);
  await waitFor(() => expect(viewport!.rows).toHaveLength(rows.length));
  const scroller = viewport!.scrollRef.current!;
  await act(async () => {
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, bubbles: true }));
    scroller.scrollTo({ top: viewport!.engine.getOffsetForIndex(90, 'start')![0] + 35 });
  });
  await waitFor(() => expect(viewport!.engine.isScrolling).toBe(false));
  const first = () => viewport!.engine.getVirtualItems().find(item => item.end > scroller.scrollTop)!;
  const before = { key: first().key, offset: first().start - scroller.scrollTop };
  expect(before.key).toBe(rows[90].key);
  const oldMaximum = scroller.scrollHeight - scroller.clientHeight;
  await act(async () => view.rerender(<Harness geometry={exact} />));
  await waitFor(() => expect(scroller.scrollHeight - scroller.clientHeight).toBeGreaterThan(oldMaximum));
  await waitFor(() => expect(viewport!.engine.isScrolling).toBe(false));
  expect(first().key).toBe(before.key);
  expect(first().start - scroller.scrollTop).toBeCloseTo(before.offset, 5);
  expect(scroller.scrollTop).toBeGreaterThan(oldMaximum);
});
