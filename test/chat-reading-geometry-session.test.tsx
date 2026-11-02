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
afterEach(() => { cleanup(); document.body.replaceChildren(); jobs.pending = []; vi.unstubAllGlobals(); });

it('finishes a pinned prefix during append and ignores late geometry from an obsolete width', async () => {
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
  Object.defineProperty(document, 'fonts', { configurable: true, value: new EventTarget() });
  const parent = document.createElement('div'); parent.style.padding = '0px'; parent.style.setProperty('--reading-responsive-variant', 'wide'); document.body.append(parent);
  let width = 400; Object.defineProperty(parent, 'clientWidth', { get: () => width });
  const first = [{ key: 'first', revision: '1' }];
  const appended = [...first, { key: 'second', revision: '1' }];
  const view = render(<Harness parent={parent} rows={first} />);
  await waitFor(() => expect(jobs.pending).toHaveLength(1));
  expect(geometry!.geometry).toBeNull();
  view.rerender(<Harness parent={parent} rows={appended} />);
  expect(jobs.pending).toHaveLength(1);
  await act(async () => complete(0));
  await waitFor(() => expect(jobs.pending).toHaveLength(2));
  expect(geometry!.geometry?.rows).toEqual(first);
  expect(jobs.pending[1].request.reuse?.map(value => value.row.key)).toEqual(['first']);
  await act(async () => complete(1));
  await waitFor(() => expect(geometry!.geometry?.rows).toEqual(appended));
  width = 800; act(() => resize());
  await waitFor(() => expect(jobs.pending).toHaveLength(3));
  expect(geometry!.geometry?.exact).toBe(false);
  width = 1200; act(() => resize());
  await waitFor(() => expect(jobs.pending).toHaveLength(4));
  expect(jobs.pending[2].request.signal?.aborted).toBe(true);
  await act(async () => complete(2));
  expect(geometry!.geometry?.layout.width).toBe(1200);
  expect(geometry!.geometry?.exact).toBe(false);
  await act(async () => complete(3));
  await waitFor(() => expect(geometry!.geometry?.exact).toBe(true));
  expect(geometry!.geometry?.layout.width).toBe(1200);
});
