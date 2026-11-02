/** Exact DOM geometry only; source ownership and viewport policy stay with callers. */
export type MeasurementRow = { key: string; revision: string; disclosureIdentity?: string };
export type MeasurementLayout = {
  width: number;
  styleIdentity: string;
  responsiveVariant?: string;
  fonts: readonly { font: string; text?: string }[];
};
export type RowMeasurement = {
  row: MeasurementRow;
  layoutIdentity: string;
  height: number;
};
export type RenderedMeasurementBatch = {
  elements: ReadonlyMap<string, HTMLElement>;
  dispose: () => void;
};
export type MeasurementRequest<Body> = {
  rows: readonly MeasurementRow[];
  layouts: readonly MeasurementLayout[];
  materialize: (rows: readonly MeasurementRow[], signal: AbortSignal) => Promise<readonly Body[]>;
  renderBatch: (host: HTMLElement, bodies: readonly Body[], layout: MeasurementLayout, rows: readonly MeasurementRow[]) => RenderedMeasurementBatch;
  /** Select the real responsive/font context; honor signal before applying asynchronous changes. */
  prepareLayout?: (layout: MeasurementLayout, signal: AbortSignal) => Promise<void>;
  reuse?: readonly RowMeasurement[];
  batchSize?: number;
  maxSynchronousMs?: number;
  signal?: AbortSignal;
};
export type MeasurementResult = { measurements: readonly RowMeasurement[] } & (
  | { status: 'complete'; vectors: readonly { layoutIdentity: string; heights: readonly number[]; totalHeight: number; maxRowHeight: number }[] }
  | { status: 'cancelled' }
  | { status: 'unsupported'; reason: string }
  | { status: 'error'; reason: 'invalid-request' | 'layout' | 'materialize' | 'render' | 'readiness' | 'geometry'; detail: string; cause?: unknown }
);

export function measurementLayoutIdentity(layout: MeasurementLayout): string {
  return JSON.stringify([layout.width, layout.styleIdentity, layout.fonts, layout.responsiveVariant]);
}
function measurementKey(row: MeasurementRow, layoutIdentity: string): string {
  return JSON.stringify([row.key, row.revision, row.disclosureIdentity ?? '', layoutIdentity]);
}
function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<{ ready: true; value: T } | { ready: false }> {
  if (signal.aborted) return Promise.resolve({ ready: false });
  return new Promise((resolve, reject) => {
    const abort = () => resolve({ ready: false });
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => {
      signal.removeEventListener('abort', abort);
      resolve(signal.aborted ? { ready: false } : { ready: true, value });
    }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
function imageReady(image: HTMLImageElement, signal: AbortSignal): Promise<void> {
  image.loading = 'eager';
  const loaded = image.complete ? Promise.resolve() : new Promise<void>((resolve) => {
    const clear = () => { image.removeEventListener('load', load); image.removeEventListener('error', error); signal.removeEventListener('abort', abort); };
    const load = () => { clear(); resolve(); };
    const error = () => { clear(); resolve(); };
    const abort = () => { clear(); resolve(); };
    image.addEventListener('load', load, { once: true });
    image.addEventListener('error', error, { once: true });
    signal.addEventListener('abort', abort, { once: true });
  });
  return loaded.then(async () => {
    if (signal.aborted) return;
    if (!image.naturalWidth) return;
    try { await image.decode(); } catch (error) { if (!image.complete || image.naturalWidth) throw error; }
  });
}
function yieldToBrowser(view: Window, signal: AbortSignal): Promise<unknown> {
  return new Promise(resolve => {
    const timer = view.setTimeout(done, 0);
    function done() { view.clearTimeout(timer); signal.removeEventListener('abort', done); resolve(undefined); }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** parent must share the visible rows' CSS ancestry and inherited font/theme context. */
export class ReadingMeasurementService {
  private active?: AbortController;
  private disposed = false;
  constructor(private readonly parent: HTMLElement) {}

  dispose(): void {
    this.disposed = true;
    this.active?.abort();
  }

  async measure<Body>(request: MeasurementRequest<Body>): Promise<MeasurementResult> {
    this.active?.abort();
    const controller = new AbortController();
    this.active = controller;
    const signal = controller.signal;
    const abort = () => controller.abort();
    request.signal?.addEventListener('abort', abort, { once: true });
    if (this.disposed || request.signal?.aborted) abort();
    const measurements = new Map<string, RowMeasurement>();
    const partial = () => [...measurements.values()];
    const cancelled = (): MeasurementResult => ({ status: 'cancelled', measurements: partial() });
    let host: HTMLDivElement | undefined;
    let rendered: RenderedMeasurementBatch | undefined;
    const release = () => {
      const batch = rendered; rendered = undefined;
      try { batch?.dispose(); } finally { host?.replaceChildren(); }
    };
    let cleanupError: unknown;
    const cleanup = () => { try { release(); } catch (error) { cleanupError = error; } finally { host?.remove(); } };
    signal.addEventListener('abort', cleanup, { once: true });
    let phase: 'layout' | 'materialize' | 'render' | 'readiness' | 'geometry' = 'materialize';
    try {
      if (signal.aborted) return cancelled();
      const doc = this.parent.ownerDocument;
      const view = doc.defaultView;
      if (!view || !doc.fonts || !this.parent.isConnected) return { status: 'unsupported', reason: 'Connected browser layout and FontFaceSet are required.', measurements: [] };
      const batchSize = request.batchSize ?? 32;
      let activeBatchSize = request.maxSynchronousMs ? 1 : batchSize;
      if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 256 || (request.maxSynchronousMs !== undefined && (!Number.isFinite(request.maxSynchronousMs) || request.maxSynchronousMs <= 0)) || !request.layouts.length
        || request.layouts.some(layout => !Number.isFinite(layout.width) || layout.width <= 0)
        || new Set(request.rows.map(row => row.key)).size !== request.rows.length
        || new Set(request.layouts.map(measurementLayoutIdentity)).size !== request.layouts.length) {
        return { status: 'error', reason: 'invalid-request', detail: 'Require unique rows/layouts, positive finite widths and a batch size from 1 to 256.', measurements: [] };
      }
      const wanted = new Set(request.layouts.flatMap(layout => request.rows.map(row => measurementKey(row, measurementLayoutIdentity(layout)))));
      for (const value of request.reuse ?? []) {
        const key = measurementKey(value.row, value.layoutIdentity);
        if (wanted.has(key) && Number.isFinite(value.height) && value.height > 0) measurements.set(key, value);
      }
      host = doc.createElement('div');
      host.inert = true;
      host.setAttribute('aria-hidden', 'true');
      host.dataset.readingMeasurementHost = '';
      Object.assign(host.style, { position: 'fixed', left: '0', top: '0', visibility: 'hidden', pointerEvents: 'none', zIndex: '-1' });
      this.parent.append(host);
      for (let offset = 0; offset < request.rows.length;) {
        const end = Math.min(request.rows.length, offset + activeBatchSize);
        const rows = request.rows.slice(offset, end).filter(row => request.layouts.some(layout => !measurements.has(measurementKey(row, measurementLayoutIdentity(layout)))));
        offset = end;
        if (!rows.length) continue;
        let synchronousMs = 0;
        phase = 'materialize';
        const bodies = await untilAbort(request.materialize(rows, signal), signal);
        if (!bodies.ready) return cancelled();
        if (bodies.value.length !== rows.length) throw new Error('Materializer must return one body per requested row in order.');
        for (const layout of request.layouts) {
          const identity = measurementLayoutIdentity(layout);
          if (rows.every(row => measurements.has(measurementKey(row, identity)))) continue;
          if (signal.aborted) return cancelled();
          phase = 'layout';
          if (request.prepareLayout) {
            const prepared = await untilAbort(request.prepareLayout(layout, signal), signal);
            if (!prepared.ready) return cancelled();
          }
          host.style.width = `${layout.width}px`;
          phase = 'render';
          const renderStarted = view.performance.now();
          rendered ??= request.renderBatch(host, bodies.value, layout, rows);
          phase = 'readiness';
          for (const row of rows) rendered.elements.get(row.key)?.getBoundingClientRect();
          synchronousMs += view.performance.now() - renderStarted;
          const ready = await untilAbort(Promise.all([
            ...layout.fonts.map(({ font, text }) => doc.fonts.load(font, text).then(() => { if (!doc.fonts.check(font, text)) throw new Error(`Requested font unavailable: ${font}`); })),
            ...[...host.querySelectorAll('img')].map(image => imageReady(image, signal)),
          ]).then(() => doc.fonts.ready), signal);
          if (!ready.ready) return cancelled();
          phase = 'geometry';
          const geometryStarted = view.performance.now();
          const boxes = rows.map(row => {
            const element = rendered!.elements.get(row.key);
            if (!element || !host!.contains(element)) throw new Error(`Missing mounted row: ${row.key}`);
            const box = element.getBoundingClientRect();
            if (!Number.isFinite(box.height) || box.height <= 0 || Math.abs(box.width - layout.width) > 0.05) throw new Error(`Invalid row box: ${row.key}`);
            return { row, layoutIdentity: identity, height: box.height };
          });
          synchronousMs += view.performance.now() - geometryStarted;
          if (signal.aborted) return cancelled();
          for (const box of boxes) measurements.set(measurementKey(box.row, identity), box);
          await yieldToBrowser(view, signal);
        }
        release();
        if (request.maxSynchronousMs) activeBatchSize = Math.max(1, Math.min(batchSize,
          synchronousMs > request.maxSynchronousMs ? Math.floor(activeBatchSize * request.maxSynchronousMs / synchronousMs) : activeBatchSize * 2));
      }
      if (signal.aborted) return cancelled();
      const vectors = request.layouts.map(layout => {
        const layoutIdentity = measurementLayoutIdentity(layout);
        const heights = request.rows.map(row => measurements.get(measurementKey(row, layoutIdentity))!.height);
        return { layoutIdentity, heights, totalHeight: heights.reduce((sum, height) => sum + height, 0), maxRowHeight: heights.reduce((max, height) => Math.max(max, height), 0) };
      });
      return { status: 'complete', measurements: partial(), vectors };
    } catch (error) {
      return signal.aborted ? cancelled() : { status: 'error', reason: phase, detail: error instanceof Error ? error.message : String(error), cause: error, measurements: partial() };
    } finally {
      cleanup();
      signal.removeEventListener('abort', cleanup);
      request.signal?.removeEventListener('abort', abort);
      if (this.active === controller) this.active = undefined;
      if (cleanupError) return { status: 'error', reason: 'render', detail: String(cleanupError), measurements: partial() };
    }
  }
}
