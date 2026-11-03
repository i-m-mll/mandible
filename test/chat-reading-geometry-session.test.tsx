// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from './helpers/dom';
import { afterEach, expect, it, vi } from 'vitest';
import { useReadingGeometry } from '../ui/src/chat/useReadingGeometry';
import { measurementLayoutIdentity, type MeasurementRequest, type MeasurementResult, type MeasurementRow } from '../ui/src/chat/readingMeasurement';
const jobs = vi.hoisted(() => ({ pending: [] as Array<{ request: MeasurementRequest<any>; finish: (result: MeasurementResult) => void }> }));
vi.mock('../ui/src/chat/readingMeasurement', async importOriginal => ({
  ...await importOriginal<typeof import('../ui/src/chat/readingMeasurement')>(),
  ReadingMeasurementService: class {
    measure(request: MeasurementRequest<any>) { return new Promise<MeasurementResult>(finish => jobs.pending.push({ request, finish })); }
    dispose() {}
  },
}));
vi.mock('../ui/src/chat/readingCapacity', () => ({ nativeReadingCapacity: () => ({ totalHeight: 10_000_000, maxRowHeight: 10_000_000 }) }));
let geometry: ReturnType<typeof useReadingGeometry>;
let resize: () => void;
function Harness({ parent, rows }: { parent: HTMLElement; rows: readonly MeasurementRow[] }) {
  geometry = useReadingGeometry({ scope: 'chat', parent, rows, chrome: 48, membership: new Map(), rowMembers: new Map(),
    materialize: async () => [], renderProps: () => ({} as any), scale: () => 2, onMeasuring: () => {}, onPrepared: () => {} });
  return null;
}
function complete(index: number) {
  const job = jobs.pending[index];
  const layoutIdentity = measurementLayoutIdentity(job.request.layouts[0]);
  job.finish({ status: 'complete', measurements: job.request.rows.map(row => ({ row, layoutIdentity, height: 80 })),
    vectors: [{ layoutIdentity, heights: job.request.rows.map(() => 80), totalHeight: 80 * job.request.rows.length, maxRowHeight: 80 }] });
}
function canvasWidth(parent: HTMLElement, width: () => number) {
  const canvas = document.createElement('div'); canvas.className = 'stream-renderer__virtual-canvas';
  canvas.getBoundingClientRect = () => ({ width: width() } as DOMRect); parent.append(canvas);
  Object.defineProperty(parent, 'clientWidth', { get: () => Math.round(width()) });
}
afterEach(() => { vi.useRealTimers(); cleanup(); document.body.replaceChildren(); jobs.pending = []; vi.unstubAllGlobals(); });

it('finishes a pinned prefix during append and ignores late geometry from an obsolete width', async () => {
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
  Object.defineProperty(document, 'fonts', { configurable: true, value: new EventTarget() });
  const parent = document.createElement('div'); parent.style.padding = '0px'; parent.style.setProperty('--reading-responsive-variant', 'wide'); document.body.append(parent);
  let width = 400; canvasWidth(parent, () => width);
  const first = [{ key: 'first', revision: '1' }];
  const appended = [...first, { key: 'second', revision: '1' }];
  const view = render(<Harness parent={parent} rows={first} />);
  await waitFor(() => expect(jobs.pending).toHaveLength(1));
  expect(geometry!.geometry).toBeNull();
  view.rerender(<Harness parent={parent} rows={appended} />);
  expect(jobs.pending).toHaveLength(1);
  await act(async () => complete(0));
  await waitFor(() => expect(jobs.pending).toHaveLength(2));
  await waitFor(() => expect(geometry!.geometry?.rows).toEqual(first));
  expect(jobs.pending[1].request.reuse?.map(value => value.row.key)).toEqual(['first']);
  await act(async () => complete(1));
  await waitFor(() => expect(geometry!.geometry?.rows).toEqual(appended));
  width = 800; act(() => resize());
  await waitFor(() => expect(jobs.pending).toHaveLength(3));
  await waitFor(() => expect(geometry!.geometry?.exact).toBe(false));
  width = 1200; act(() => resize());
  await waitFor(() => expect(jobs.pending).toHaveLength(4));
  expect(jobs.pending[2].request.signal?.aborted).toBe(true);
  await act(async () => complete(2));
  await waitFor(() => expect(geometry!.geometry?.layout.width).toBe(1200));
  await waitFor(() => expect(geometry!.geometry?.exact).toBe(false));
  await act(async () => complete(3));
  await waitFor(() => expect(geometry!.geometry?.exact).toBe(true));
  await waitFor(() => expect(geometry!.geometry?.layout.width).toBe(1200));
});


it('retains nonempty content when a breakpoint discovers a new font generation', async () => {
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
  const fonts = new EventTarget();
  Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
  const parent = document.createElement('div'); parent.style.padding = '0px'; parent.style.setProperty('--reading-responsive-variant', 'wide'); document.body.append(parent);
  let width = 772; canvasWidth(parent, () => width);
  const rows = [{ key: 'reader', revision: 'same' }, { key: 'remote', revision: 'same' }];
  render(<Harness parent={parent} rows={rows} />);
  await waitFor(() => expect(jobs.pending).toHaveLength(1));
  await act(async () => complete(0));
  await waitFor(() => expect(geometry!.geometry?.exact).toBe(true));
  const visible = document.createElement('div'); visible.dataset.readingKey = 'reader'; visible.dataset.readingPayload = JSON.stringify(['reader', 'same', '']);
  visible.getBoundingClientRect = () => ({ width, height: 200 } as DOMRect); parent.append(visible);
  width = 619; parent.style.setProperty('--reading-responsive-variant', 'narrow');
  act(() => resize());
  await waitFor(() => expect(jobs.pending).toHaveLength(2));
  act(() => fonts.dispatchEvent(new Event('loadingdone')));
  await waitFor(() => expect(jobs.pending).toHaveLength(3));
  await waitFor(() => expect(geometry!.geometry?.layout.styleIdentity).toContain('[1,'));
  expect(geometry!.geometry?.rows).toEqual(rows);
  expect(geometry!.geometry?.sizes).toEqual([200, 160]);
  expect(geometry!.geometry?.exact).toBe(false);
  expect(jobs.pending[1].request.signal?.aborted).toBe(true);
  await act(async () => complete(1));
  expect(geometry!.geometry?.exact).toBe(false);
  await act(async () => { geometry!.reportHeight(rows[0], 210, width); complete(2); });
  await waitFor(() => expect(geometry!.geometry?.exact).toBe(true));
});


it('publishes local resize frames while acquiring only the latest quiet width, with append work independent', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
  Object.defineProperty(document, 'fonts', { configurable: true, value: new EventTarget() });
  const parent = document.createElement('div'); parent.style.padding = '0px'; parent.style.setProperty('--reading-responsive-variant', 'wide'); document.body.append(parent);
  let width = 400; canvasWidth(parent, () => width);
  const rows = [{ key: 'first', revision: 'same' }];
  const view = render(<Harness parent={parent} rows={rows} />);
  expect(jobs.pending).toHaveLength(1);
  width = 450; act(() => resize());
  expect(jobs.pending[0].request.signal?.aborted).toBe(true);
  await act(async () => vi.advanceTimersByTime(50));
  expect(jobs.pending).toHaveLength(1);
  width = 475; act(() => resize());
  await act(async () => vi.advanceTimersByTime(50));
  expect(jobs.pending).toHaveLength(1);
  expect(geometry!.geometry).toBeNull();
  await act(async () => vi.advanceTimersByTime(120));
  expect(jobs.pending).toHaveLength(2);
  expect(jobs.pending[1].request.layouts[0].width).toBe(475);
  await act(async () => complete(1));
  await act(async () => vi.advanceTimersByTime(20));
  expect(geometry!.geometry?.exact).toBe(true);
  for (width of [500, 600, 700]) {
    act(() => resize());
    await act(async () => vi.advanceTimersByTime(50));
    expect(geometry!.geometry?.layout.width).toBe(width);
    expect(geometry!.geometry?.exact).toBe(false);
    expect(jobs.pending).toHaveLength(2);
  }
  await act(async () => vi.advanceTimersByTime(120));
  expect(jobs.pending).toHaveLength(3);
  expect(jobs.pending[2].request.layouts[0].width).toBe(700);
  await act(async () => complete(2));
  await act(async () => vi.advanceTimersByTime(20));
  view.rerender(<Harness parent={parent} rows={[...rows, { key: 'append', revision: 'new' }]} />);
  expect(jobs.pending).toHaveLength(4);
});

it('patches current fractional-width mounted boxes before each provisional handoff', async () => {
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
  Object.defineProperty(document, 'fonts', { configurable: true, value: new EventTarget() });
  const parent = document.createElement('div'); parent.style.padding = '0px'; document.body.append(parent);
  let width = 944.203125; canvasWidth(parent, () => width);
  const rows = [{ key: 'prose', revision: 'same' }, { key: 'tool', revision: 'same' }, { key: 'remote', revision: 'same' }];
  render(<Harness parent={parent} rows={rows} />);
  await waitFor(() => expect(jobs.pending).toHaveLength(1));
  await act(async () => complete(0));
  await waitFor(() => expect(geometry!.geometry?.exact).toBe(true));
  let heights = [140, 67];
  for (const [index, row] of rows.slice(0, 2).entries()) {
    const element = document.createElement('div'); element.dataset.readingKey = row.key;
    element.dataset.readingPayload = JSON.stringify([row.key, row.revision, '']);
    element.getBoundingClientRect = () => ({ width, height: heights[index] } as DOMRect); parent.append(element);
  }
  for (const nextWidth of [772.203125, 452.203125, 944.203125]) {
    width = nextWidth; heights = width < 500 ? [390, 67] : [140, 67];
    act(() => resize());
    await waitFor(() => expect(geometry!.geometry?.layout.width).toBe(width));
    expect(geometry!.geometry?.exact).toBe(false);
    expect(geometry!.geometry?.sizes.slice(0, 2)).toEqual(heights);
  }
  await waitFor(() => expect(jobs.pending.at(-1)?.request.layouts[0].width).toBe(width));
});
