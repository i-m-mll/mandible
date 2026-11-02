// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { ReadingMeasurementService, type MeasurementLayout, type MeasurementRequest, type MeasurementRow } from '../ui/src/chat/readingMeasurement';

const layout: MeasurementLayout = { width: 480, styleIdentity: 'font/theme-1', fonts: [] };
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

it('retains completed geometry on cancellation, releases the host, and reuses unaffected rows only', async () => {
  Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: Promise.resolve() } });
  const parent = document.createElement('div');
  document.body.append(parent);
  const service = new ReadingMeasurementService(parent);
  const rows: MeasurementRow[] = [{ key: 'first', revision: '1' }, { key: 'second', revision: '1' }];
  const controller = new AbortController();
  let finishLate!: (value: readonly MeasurementRow[]) => void;
  let reachedSecond!: () => void;
  const second = new Promise<void>(resolve => { reachedSecond = resolve; });
  const renderBatch: MeasurementRequest<MeasurementRow>['renderBatch'] = (host, bodies) => {
    const elements = new Map(bodies.map(row => {
      const element = document.createElement('div');
      element.getBoundingClientRect = () => ({ height: 75.25, width: 480 }) as DOMRect;
      host.append(element);
      return [row.key, element];
    }));
    return { elements, dispose: () => host.replaceChildren() };
  };
  const work = service.measure({ rows, layouts: [layout], batchSize: 1, renderBatch, signal: controller.signal,
    materialize: async batch => {
      if (batch[0].key === 'first') return batch;
      reachedSecond();
      return new Promise(resolve => { finishLate = resolve; });
    } });
  await second;
  controller.abort();
  const partial = await work;
  expect(partial.status).toBe('cancelled');
  expect(partial.measurements).toHaveLength(1);
  expect(parent.childElementCount).toBe(0);
  finishLate([rows[1]]);
  await Promise.resolve();
  expect(parent.childElementCount).toBe(0);
  const materialize = vi.fn(async (batch: readonly MeasurementRow[]) => batch);
  const complete = await service.measure({ rows, layouts: [layout], reuse: partial.measurements, materialize, renderBatch });
  expect(complete.status).toBe('complete');
  expect(materialize.mock.calls.flatMap(([batch]) => batch.map(row => row.key))).toEqual(['second']);
  const changed = vi.fn(async (batch: readonly MeasurementRow[]) => batch);
  await service.measure({ rows: [{ ...rows[0], disclosureIdentity: 'open' }, rows[1]], layouts: [layout], reuse: complete.measurements, materialize: changed, renderBatch });
  expect(changed.mock.calls.flatMap(([batch]) => batch.map(row => row.key))).toEqual(['first']);
  service.dispose();
  expect(parent.childElementCount).toBe(0);
});
