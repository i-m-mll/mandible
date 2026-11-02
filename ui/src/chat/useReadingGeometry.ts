import { readingPayloadKey } from './useCompleteReading';
import { nativeReadingCapacity } from './readingCapacity';
import { isReadingPublicationChanged } from '../query/readingPresentation';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ReadingMeasurementService, measurementLayoutIdentity, type MeasurementLayout, type MeasurementRow, type RowMeasurement, type MeasurementRequest } from './readingMeasurement';
import type { ReadingRow } from './readingProjection';
import type { ReadingContentProps } from './ReadingContent';
import { createReadingRowBatchRenderer } from './renderReadingMeasurementBatch';

type GeometryMembership = ReadonlyMap<string, { rowKey: string; position?: number | null }>;
export type ReadingGeometry = { membership: GeometryMembership; rowMembers: ReadonlyMap<string, readonly string[]>; scope: string; rows: readonly MeasurementRow[]; sizes: readonly number[]; layout: MeasurementLayout; exact: boolean; serial: number; renderProps: (row: ReadingRow) => ReadingContentProps };
/** One current width, one compatible complete basis, and reusable current-width facts. */
export function useReadingGeometry(input: {
  scope: string; chrome: number; rows: readonly MeasurementRow[]; parent: HTMLElement | null;
  materialize: MeasurementRequest<ReadingRow>['materialize'];
  renderProps: (row: ReadingRow) => ReadingContentProps;
  membership: GeometryMembership; rowMembers: ReadonlyMap<string, readonly string[]>;
  onLayoutChange?: (layout: MeasurementLayout) => void;
  onMeasuring: (rows: readonly MeasurementRow[]) => void;
  onPrepared: (rows: readonly MeasurementRow[]) => void;
  scale: (from: MeasurementLayout, to: MeasurementLayout) => number;
}) {
  const latest = useRef(input); latest.current = input;
  const [layout, setLayout] = useState<MeasurementLayout | null>(null);
  const [geometry, setGeometry] = useState<ReadingGeometry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const facts = useRef<readonly RowMeasurement[]>([]);
  const layoutRef = useRef<MeasurementLayout | null>(null);
  const queued = useRef<ReadingGeometry | null>(null);
  const publicationFrame = useRef<number | null>(null);
  const publish = useRef<(geometry: ReadingGeometry) => void>(() => {});
  const basis = useRef<ReadingGeometry | null>(null);
  const serial = useRef(0);
  const fontGeneration = useRef(0);
  const rowIndices = useMemo(() => new Map(geometry?.rows.map((row, index) => [row.key, index]) ?? []), [geometry?.rows]);
  const published = useRef({ geometry, rowIndices }); published.current = { geometry, rowIndices };
  const reports = useRef(new Map<string, { row: MeasurementRow; height: number; width: number }>());
  const reportFrame = useRef<number | null>(null);
  const reportHeight = useMemo(() => (row: MeasurementRow, height: number, width: number) => {
    if (!Number.isFinite(height) || height <= 0) return;
    reports.current.set(row.key, { row, height, width });
    if (reportFrame.current !== null) return;
    reportFrame.current = requestAnimationFrame(() => {
      reportFrame.current = null;
      const snapshot = queued.current ?? published.current.geometry;
      const indices = snapshot === published.current.geometry ? published.current.rowIndices : new Map(snapshot?.rows.map((row, index) => [row.key, index]) ?? []);
      if (!snapshot || snapshot.scope !== latest.current.scope) { reports.current.clear(); return; }
      const additions: Array<RowMeasurement & { index: number }> = [];
      for (const [key, report] of reports.current) {
        const index = indices.get(key);
        const ref = index === undefined ? undefined : snapshot.rows[index];
        if (!ref || index === undefined || Math.abs(report.width - snapshot.layout.width) > 0.05 || report.row.revision !== ref.revision || report.row.disclosureIdentity !== ref.disclosureIdentity || report.height === snapshot.sizes[index]) continue;
        additions.push({ row: ref, height: report.height, layoutIdentity: measurementLayoutIdentity(snapshot.layout), index });
      }
      reports.current.clear();
      if (!additions.length) return;
      const sizes = [...snapshot.sizes];
      for (const fact of additions) sizes[fact.index] = fact.height;
      const parent = latest.current.parent;
      if (parent) {
        const capacity = nativeReadingCapacity(parent);
        if (sizes.some(height => height > capacity.maxRowHeight) || sizes.reduce((sum, height) => sum + height, latest.current.chrome) > capacity.totalHeight) {
          setError('Rendered conversation geometry exceeds this browser’s native scroll capacity.'); return;
        }
      }
      const replaced = new Set(additions.map(fact => fact.row.key));
      facts.current = [...facts.current.filter(fact => !replaced.has(fact.row.key)), ...additions];
      const next = { ...snapshot, sizes, serial: ++serial.current };
      if (snapshot.exact) basis.current = next;
      publish.current(next);
    });
  }, []);
  useEffect(() => () => { if (reportFrame.current !== null) cancelAnimationFrame(reportFrame.current); }, []);
  publish.current = next => {
    queued.current = next;
    if (publicationFrame.current !== null) return;
    publicationFrame.current = requestAnimationFrame(() => {
      publicationFrame.current = null;
      const candidate = queued.current; queued.current = null;
      if (!candidate || candidate.scope !== latest.current.scope || !layoutRef.current
        || measurementLayoutIdentity(candidate.layout) !== measurementLayoutIdentity(layoutRef.current)) return;
      const sizes = [...candidate.sizes];
      const wanted = new Map(candidate.rows.map((row, index) => [row.key, { row, index }]));
      for (const element of latest.current.parent?.querySelectorAll<HTMLElement>('[data-reading-key]') ?? []) {
        const value = wanted.get(element.dataset.readingKey ?? '');
        if (!value || element.getAttribute('aria-busy') === 'true' || element.dataset.readingPayload !== readingPayloadKey(value.row)) continue;
        const box = element.getBoundingClientRect();
        if (box.height > 0 && Math.abs(box.width - candidate.layout.width) <= 0.05) sizes[value.index] = box.height;
      }
      const next = { ...candidate, sizes };
      latest.current.onPrepared(next.rows); setGeometry(next);
    });
  };
  useEffect(() => () => { if (publicationFrame.current !== null) cancelAnimationFrame(publicationFrame.current); }, []);
  const wake = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    const parent = input.parent;
    if (!parent) return;
    const update = () => {
      const style = getComputedStyle(parent);
      const width = parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      if (width <= 0) return;
      const next: MeasurementLayout = { width, responsiveVariant: style.getPropertyValue('--reading-responsive-variant').trim(), styleIdentity: JSON.stringify([fontGeneration.current, style.fontFamily, style.fontSize, style.fontWeight, style.fontStyle, style.lineHeight, style.letterSpacing, document.documentElement.dataset.theme]), fonts: [{ font: `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}` }] };
      if (!layoutRef.current || measurementLayoutIdentity(layoutRef.current) !== measurementLayoutIdentity(next)) {
        latest.current.onLayoutChange?.(next); layoutRef.current = next; setLayout(next);
      }
    };
    const observer = new ResizeObserver(update); observer.observe(parent);
    const fontsChanged = () => { fontGeneration.current++; update(); };
    const themeObserver = new MutationObserver(update); themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    window.addEventListener('resize', update); document.fonts?.addEventListener('loadingdone', fontsChanged); update();
    return () => { observer.disconnect(); themeObserver.disconnect(); window.removeEventListener('resize', update); document.fonts?.removeEventListener('loadingdone', fontsChanged); };
  }, [input.parent]);
  useEffect(() => {
    facts.current = []; basis.current = null; queued.current = null; setGeometry(null); setError(null);
  }, [input.scope]);
  useEffect(() => {
    if (!layout || !input.parent) return;
    const parent = input.parent;
    const controller = new AbortController();
    const service = new ReadingMeasurementService(parent);
    const identity = measurementLayoutIdentity(layout);
    facts.current = facts.current.filter(fact => fact.layoutIdentity === identity);
    const compatible = basis.current;
    const held = published.current.geometry?.scope === input.scope ? published.current.geometry : compatible;
    if (held) {
      const scalable = compatible && compatible.layout.styleIdentity === layout.styleIdentity
        && JSON.stringify(compatible.layout.fonts) === JSON.stringify(layout.fonts)
        && compatible.rows.length === latest.current.rows.length && compatible.rows.every((row, index) => row.key === latest.current.rows[index].key
          && row.revision === latest.current.rows[index].revision && row.disclosureIdentity === latest.current.rows[index].disclosureIdentity);
      const source = scalable ? compatible : held;
      const ratio = scalable ? latest.current.scale(source.layout, layout) : 1;
      publish.current({ ...source, sizes: source.sizes.map(size => size * ratio), layout, exact: false, serial: ++serial.current });
    }
    let running = false;
    let completedPlan: readonly MeasurementRow[] | undefined;
    const run = async () => {
      if (running || controller.signal.aborted || completedPlan === latest.current.rows) return;
      running = true; setError(null);
      while (!controller.signal.aborted && completedPlan !== latest.current.rows) {
        const snapshot = latest.current;
        const rows = snapshot.rows;
        snapshot.onMeasuring(rows);
        const result = await service.measure({ rows, layouts: [layout], materialize: snapshot.materialize,
          renderBatch: createReadingRowBatchRenderer(snapshot.renderProps), reuse: facts.current,
          signal: controller.signal, batchSize: 16, materializeBatchSize: 128, maxSynchronousMs: 8 });
        if (controller.signal.aborted || !layoutRef.current || measurementLayoutIdentity(layoutRef.current) !== identity) break;
        facts.current = result.measurements;
        if (result.status !== 'complete') {
          if (result.status === 'error' && result.reason === 'materialize' && isReadingPublicationChanged(result.cause)) {
            if (rows !== latest.current.rows) continue;
            break;
          }
          if (result.status !== 'cancelled') setError(result.status === 'error' ? result.detail : result.reason);
          break;
        }
        const vector = result.vectors[0];
        const capacity = nativeReadingCapacity(parent);
        if (vector.totalHeight + latest.current.chrome > capacity.totalHeight || vector.maxRowHeight > capacity.maxRowHeight) {
          setError(`This conversation exceeds this browser's native scroll capacity (${vector.totalHeight}px total; ${vector.maxRowHeight}px maximum row).`); break;
        }
        const next = { scope: input.scope, membership: snapshot.membership, rowMembers: snapshot.rowMembers, rows, sizes: vector.heights, layout, exact: true, serial: ++serial.current, renderProps: snapshot.renderProps };
        basis.current = next; publish.current(next); setError(null); completedPlan = rows;
      }
      running = false;
    };
    wake.current = () => { void run(); };
    void run();
    return () => { controller.abort(); service.dispose(); wake.current = () => {}; };
  }, [layout, input.parent, input.scope]);
  useEffect(() => { wake.current(); }, [input.rows]);
  return { geometry: geometry?.scope === input.scope ? geometry : null, error, layout, reportHeight, retry: () => wake.current() };
}
