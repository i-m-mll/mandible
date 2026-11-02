// @vitest-environment jsdom
import { waitUntil } from './helpers/wait-until';
import { afterEach, expect, it, vi } from 'vitest';
import { ReadingMeasurementService, type MeasurementLayout, type MeasurementRequest, type MeasurementRow, type MaterializedMeasurementBatch } from '../ui/src/chat/readingMeasurement';

const layout: MeasurementLayout = { width: 480, styleIdentity: 'font/theme-1', fonts: [] };
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

it('retains completed geometry on cancellation, releases the host, and reuses unaffected rows only', async () => {
  Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: Promise.resolve() } });
  const parent = document.createElement('div');
  document.body.append(parent);
  const service = new ReadingMeasurementService(parent);
  const rows: MeasurementRow[] = [{ key: 'first', revision: '1' }, { key: 'second', revision: '1' }];
  const controller = new AbortController();
  let finishLate!: (value: MaterializedMeasurementBatch<MeasurementRow>) => void;
  const firstRelease = vi.fn(); const lateRelease = vi.fn();
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
      if (batch[0].key === 'first') return { bodies: batch, release: firstRelease };
      reachedSecond();
      return new Promise(resolve => { finishLate = resolve; });
    } });
  await second;
  controller.abort();
  const partial = await work;
  expect(partial.status).toBe('cancelled');
  expect(partial.measurements).toHaveLength(1);
  expect(parent.childElementCount).toBe(0);
  expect(firstRelease).toHaveBeenCalledOnce();
  finishLate({ bodies: [rows[1]], release: lateRelease });
  await waitUntil(() => lateRelease.mock.calls.length, 'late acquired buffer release');
  expect(lateRelease).toHaveBeenCalledOnce();
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

it('retains one mounted batch across finite calibration layouts and releases it afterwards', async () => {
  Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: Promise.resolve() } });
  const parent = document.createElement('div'); document.body.append(parent);
  const service = new ReadingMeasurementService(parent);
  const rows = [{ key: 'row', revision: '1' }];
  const dispose = vi.fn();
  const renderBatch = vi.fn<MeasurementRequest<MeasurementRow>['renderBatch']>((host, bodies) => {
    const element = document.createElement('div'); host.append(element);
    element.getBoundingClientRect = () => ({ width: parseFloat(host.style.width), height: 90 }) as DOMRect;
    return { elements: new Map([[bodies[0].key, element]]), dispose };
  });
  const result = await service.measure({ rows, layouts: [layout, { ...layout, width: 800 }],
    renderBatch, materialize: async batch => batch });
  expect(result.status).toBe('complete');
  expect(result.measurements).toHaveLength(2);
  expect(renderBatch).toHaveBeenCalledOnce();
  expect(dispose).toHaveBeenCalledOnce();
  expect(parent.childElementCount).toBe(0);
  service.dispose();
});


it('acquires one bounded buffer independently of small DOM slices', async () => {
  Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: Promise.resolve() } });
  const parent = document.createElement('div'); document.body.append(parent);
  const service = new ReadingMeasurementService(parent);
  const rows = Array.from({ length: 4 }, (_, index) => ({ key: String(index), revision: '1' }));
  const release = vi.fn();
  const materialize = vi.fn(async (bodies: readonly MeasurementRow[]) => ({ bodies, release }));
  const rendered: string[] = [];
  const result = await service.measure({ rows, layouts: [layout], batchSize: 1, materializeBatchSize: 4, materialize,
    renderBatch: (host, bodies) => {
      expect(release).not.toHaveBeenCalled();
      const element = document.createElement('div'); host.append(element);
      element.getBoundingClientRect = () => ({ width: 480, height: 80 }) as DOMRect;
      rendered.push(bodies[0].key);
      return { elements: new Map([[bodies[0].key, element]]), dispose: () => host.replaceChildren() };
    } });
  expect(result.status).toBe('complete');
  expect(materialize).toHaveBeenCalledOnce();
  expect(rendered).toEqual(rows.map(row => row.key));
  expect(release).toHaveBeenCalledOnce();
  service.dispose();
});
