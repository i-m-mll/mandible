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
function Harness({ geometry, clearance = 16 }: { geometry: ReadingGeometry; clearance?: number }) {
  viewport = useReadingViewport({ scope: 'chat', positionSpaceId: 'space', geometry, clearance, disclosures: {}, protectedKeys: new Set(),
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
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

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

let wrapping = 1;
let nativeDuringRestore = false;
function CenterHarness({ geometry }: { geometry: ReadingGeometry }) {
  viewport = useReadingViewport({ scope: 'chat', positionSpaceId: 'space', geometry, clearance: 16, disclosures: {}, protectedKeys: new Set(),
    onInput: () => {}, onApplied: () => {}, onRange: () => {}, prepare: async () => ({ status: 'not-renderable' }) });
  const connect = useCallback((node: HTMLDivElement | null) => {
    viewport.scrollRef.current = node;
    if (!node) return;
    Object.defineProperties(node, { clientHeight: { value: 400 }, offsetHeight: { value: 400 }, offsetWidth: { value: 853 }, clientWidth: { value: 853 },
      scrollHeight: { get: () => Math.max(400, parseFloat((node.firstElementChild as HTMLElement)?.style.height ?? '0')) } });
    node.getBoundingClientRect = () => ({ top: 0, bottom: 400, left: 0, right: 853, width: 853, height: 400 } as DOMRect);
    node.scrollTo = ((options: ScrollToOptions) => {
      node.scrollTop = Math.max(0, Math.min(options.top ?? node.scrollTop, node.scrollHeight - node.clientHeight));
      if (nativeDuringRestore) {
        nativeDuringRestore = false; node.dispatchEvent(new WheelEvent('wheel', { deltaY: 300, bubbles: true })); node.scrollTop += 300;
      }
      queueMicrotask(() => { node.dispatchEvent(new Event('scroll')); node.dispatchEvent(new Event('scrollend')); });
    }) as typeof node.scrollTo;
  }, []);
  return <div ref={connect} {...viewport.inputHandlers}><div style={{ height: `${viewport.engine.getTotalSize()}px` }}>
    {viewport.engine.getVirtualItems().map(item => <div key={item.key} data-reading-key={item.key} data-index={item.index}
      ref={node => {
        if (!node) return;
        node.getBoundingClientRect = () => {
          const start = parseFloat(node.style.top); const height = parseFloat(node.style.height);
          return { top: start - viewport.scrollRef.current!.scrollTop, bottom: start + height - viewport.scrollRef.current!.scrollTop, left: 0, right: 853, width: 853, height } as DOMRect;
        };
        viewport.registerRow(String(item.key), node);
      }} style={{ top: `${item.start}px`, height: `${item.size}px` }}>{'prose '.repeat(1000)}</div>)}
  </div></div>;
}

it('keeps the center text point through poor prefix estimates and exact replacement, then yields to native input', async () => {
  const originalCaret = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint');
  const originalRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: function(this: Range) {
    const row = this.startContainer.parentElement!; const rect = row.getBoundingClientRect();
    return [{ ...rect, top: rect.top + this.startOffset * wrapping, bottom: rect.top + this.startOffset * wrapping + 16, height: 16 }];
  } });
  Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: (_x: number, y: number) => {
    const row = [...viewport.scrollRef.current!.querySelectorAll<HTMLElement>('[data-reading-key]')].find(row => { const rect = row.getBoundingClientRect(); return rect.top <= y && rect.bottom > y; });
    return row ? { offsetNode: row.firstChild!, offset: Math.round((y - row.getBoundingClientRect().top) / wrapping) } : null;
  } });
  try {
    const wide = { ...provisional, exact: true, sizes: rows.map((_, index) => index === 50 ? 3000 : 80) };
    const view = render(<CenterHarness geometry={wide} />);
    await waitFor(() => expect(viewport!.appliedGeometry).toBe(wide));
    const scroller = viewport!.scrollRef.current!;
    await act(async () => {
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, bubbles: true }));
      scroller.scrollTo({ top: 32 + 50 * 80 + 1700 - 192 });
    });
    await waitFor(() => expect(viewport!.engine.isScrolling).toBe(false));
    const textTop = (offset: number) => scroller.querySelector<HTMLElement>('[data-index="50"]')!.getBoundingClientRect().top + offset * wrapping;
    expect(textTop(1700)).toBe(192);
    wrapping = 1.5;
    const narrow = { ...wide, serial: 2, exact: false, layout: { ...wide.layout, width: 619, responsiveVariant: 'narrow' }, sizes: rows.map((_, index) => index === 50 ? 4500 : 40) };
    await act(async () => view.rerender(<CenterHarness geometry={narrow} />));
    await waitFor(() => expect(viewport!.appliedGeometry).toBe(narrow));
    expect(textTop(1700)).toBeCloseTo(192, 5);
    const measured = { ...narrow, serial: 3, exact: true, sizes: rows.map((_, index) => index === 50 ? 4500 : 120) };
    await act(async () => view.rerender(<CenterHarness geometry={measured} />));
    await waitFor(() => expect(viewport!.appliedGeometry).toBe(measured));
    expect(textTop(1700)).toBeCloseTo(192, 5);
    nativeDuringRestore = true;
    const next = { ...measured, serial: 4, sizes: rows.map((_, index) => index === 50 ? 4500 : 140) };
    await act(async () => view.rerender(<CenterHarness geometry={next} />));
    await waitFor(() => expect(viewport!.appliedGeometry).toBe(next));
    expect(textTop(1900)).toBeCloseTo(192, 5);
  } finally {
    wrapping = 1; nativeDuringRestore = false;
    if (originalCaret) Object.defineProperty(document, 'caretPositionFromPoint', originalCaret); else delete (document as any).caretPositionFromPoint;
    if (originalRects) Object.defineProperty(Range.prototype, 'getClientRects', originalRects); else delete (Range.prototype as any).getClientRects;
  }
});


it('retains explicit latest ownership through provisional and exact resize commits before command readback completes', async () => {
  let frameId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const original = { ...exact, layout: { ...exact.layout, width: 700 } };
  const resized = { ...provisional, serial: 3 };
  const final = { ...exact, serial: 4, sizes: rows.map(() => 120) };
  const view = render(<Harness geometry={original} />);
  await waitFor(() => expect(viewport!.appliedGeometry).toBe(original));
  const scroller = viewport!.scrollRef.current!;
  await act(async () => {
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }));
    scroller.scrollTo({ top: 4000 });
  });
  await waitFor(() => expect(viewport!.engine.isScrolling).toBe(false));
  let result: Awaited<ReturnType<typeof viewport.reveal>> | undefined;
  await act(async () => { void viewport!.reveal({ token: 'latest', end: true }).then(value => { result = value; }); });
  expect(result).toBeUndefined();
  await act(async () => view.rerender(<Harness geometry={resized} />));
  await waitFor(() => expect(viewport!.appliedGeometry).toBe(resized));
  expect(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop).toBeLessThanOrEqual(1);
  expect(result).toBeUndefined();
  await act(async () => view.rerender(<Harness geometry={final} />));
  await waitFor(() => expect(viewport!.appliedGeometry).toBe(final));
  expect(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop).toBeLessThanOrEqual(1);
  expect(result).toBeUndefined();
  await act(async () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(0)); });
  expect(result?.status).toBe('revealed');
  const appended = { ...final, serial: 5, sizes: rows.map(() => 140) };
  await act(async () => view.rerender(<Harness geometry={appended} />));
  await waitFor(() => expect(viewport!.appliedGeometry).toBe(appended));
  expect(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop).toBeLessThanOrEqual(1);
});

it('follows completed latest through resized geometry when native end has no intersecting row', async () => {
  const original = { ...exact, layout: { ...exact.layout, width: 700 } };
  const view = render(<Harness geometry={original} clearance={900} />);
  await waitFor(() => expect(viewport!.appliedGeometry).toBe(original));
  const scroller = viewport!.scrollRef.current!;
  await act(async () => {
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }));
    scroller.scrollTo({ top: 4000 });
  });
  await waitFor(() => expect(viewport!.engine.isScrolling).toBe(false));
  let result: Awaited<ReturnType<typeof viewport.reveal>> | undefined;
  await act(async () => { void viewport!.reveal({ token: 'latest', end: true }).then(value => { result = value; }); });
  await waitFor(() => expect(result?.status).toBe('revealed'));
  expect(viewport!.engine.getVirtualItems().some(item => item.end > scroller.scrollTop)).toBe(false);
  const resized = { ...provisional, serial: 3 };
  await act(async () => view.rerender(<Harness geometry={resized} clearance={900} />));
  await waitFor(() => expect(viewport!.appliedGeometry).toBe(resized));
  await waitFor(() => expect(viewport!.engine.isScrolling).toBe(false));
  expect(Math.abs(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop)).toBeLessThanOrEqual(1);
  expect(viewport!.engine.getVirtualItems().some(item => item.end > scroller.scrollTop)).toBe(false);
  const final = { ...exact, serial: 4, sizes: rows.map(() => 120) };
  await act(async () => view.rerender(<Harness geometry={final} clearance={900} />));
  await waitFor(() => expect(viewport!.appliedGeometry).toBe(final));
  await waitFor(() => expect(viewport!.engine.isScrolling).toBe(false));
  expect(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop).toBeLessThanOrEqual(1);
});
