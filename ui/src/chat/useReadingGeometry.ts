import { readingPayloadKey } from './useCompleteReading';
import { nativeReadingCapacity } from './readingCapacity';
import { isReadingPublicationChanged } from '../query/readingPresentation';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ReadingMeasurementService, measurementLayoutIdentity, type MeasurementLayout, type MeasurementRow, type RowMeasurement, type MeasurementRequest, type MeasurementPhase } from './readingMeasurement';
import type { ReadingRow } from './readingProjection';
import type { ReadingContentProps } from './ReadingContent';
import { createReadingRowBatchRenderer } from './renderReadingMeasurementBatch';

type GeometryMembership = ReadonlyMap<string, { rowKey: string; position?: number | null }>;
export type ReadingGeometry = { membership: GeometryMembership; rowMembers: ReadonlyMap<string, readonly string[]>; scope: string; rows: readonly MeasurementRow[]; sizes: readonly number[]; layout: MeasurementLayout; exact: boolean; measured?:ReadonlySet<string>; serial: number; renderProps: (row: ReadingRow, ref?: MeasurementRow) => ReadingContentProps };
export const readingGeometryRowReady=(geometry:ReadingGeometry|null|undefined,key:string)=>Boolean(geometry&&geometry.rows.some(row=>row.key===key)&&(geometry.exact||geometry.measured?.has(key)));
export function readingGeometryDisclosureReady(geometry:ReadingGeometry,key:string):boolean {
  const start=geometry.rows.findIndex(row=>row.key===key);
  if(start<0)return false;
  const endKey=geometry.rows[start].disclosureEnd??key;
  const end=geometry.rows.findIndex(row=>row.key===endKey);
  return end>=start&&(geometry.exact||geometry.rows.slice(start,end+1).every(row=>geometry.measured?.has(row.key)));
}
/** One current width, one compatible complete basis, and reusable current-width facts. */
export function useReadingGeometry(input: {
  scope: string; chrome: number; rows: readonly MeasurementRow[]; parent: HTMLElement | null;
  firstRequiredSourceAt?:number;
  priorityKeys?:readonly string[];
  initialTarget?:{key:string;align:'start'|'end';offset?:number};
  materialize: MeasurementRequest<ReadingRow>['materialize'];
  renderProps: (row: ReadingRow, ref?: MeasurementRow) => ReadingContentProps;
  membership: GeometryMembership; rowMembers: ReadonlyMap<string, readonly string[]>;
  onLayoutChange?: (layout: MeasurementLayout) => void;
  onMeasuring: (rows: readonly MeasurementRow[],priority?:readonly MeasurementRow[]) => void;
  onPrepared: (rows: readonly MeasurementRow[]) => void;
  scale: (from: MeasurementLayout, to: MeasurementLayout) => number;
}) {
  const latest = useRef(input); latest.current = input;
  const traceEnabled=useMemo(()=>new URLSearchParams(window.location.search).get('reading_trace')==='1',[]);
  const trace=useRef({scope:input.scope,mountedAt:performance.now(),attempts:[] as Array<{startMs:number;wallMs:number;rows:number;status:string;phases:Partial<Record<MeasurementPhase,{ms:number;batches:number;rows:number}>>}>,publications:0,completeLogged:false});
  if(trace.current.scope!==input.scope)trace.current={scope:input.scope,mountedAt:performance.now(),attempts:[],publications:0,completeLogged:false};
  const [layout, setLayout] = useState<MeasurementLayout | null>(null);
  const [geometry, setGeometry] = useState<ReadingGeometry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const facts = useRef<readonly RowMeasurement[]>([]);
  const layoutRef = useRef<MeasurementLayout | null>(null);
  const queued = useRef<ReadingGeometry | null>(null);
  const prepared=useRef<ReadingGeometry|null>(null);
  const publicationFrame = useRef<number | null>(null);
  const publish = useRef<(geometry: ReadingGeometry) => void>(() => {});
  const basis = useRef<ReadingGeometry | null>(null);
  const serial = useRef(0);
  const fontGeneration = useRef(0);
  const startedScope = useRef<string | null>(null);
  const activeMeasurement = useRef<AbortController | null>(null);
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
      const snapshot = queued.current ?? prepared.current ?? published.current.geometry;
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
      facts.current = [...facts.current.filter(fact => !replaced.has(fact.row.key)), ...additions.filter(fact=>readingGeometryRowReady(snapshot,fact.row.key))];
      const next = { ...snapshot, sizes, serial: ++serial.current };
      if (snapshot.exact) basis.current = next;
      publish.current(next);
    });
  }, []);
  useEffect(() => () => { if (reportFrame.current !== null) cancelAnimationFrame(reportFrame.current); }, []);
  publish.current = next => {
    const queuedAt=performance.now();
    queued.current = next;
    if (publicationFrame.current !== null) return;
    publicationFrame.current = requestAnimationFrame(() => {
      publicationFrame.current = null;
      const candidate = queued.current; queued.current = null;
      if (!candidate || candidate.scope !== latest.current.scope || !layoutRef.current
        || measurementLayoutIdentity(candidate.layout) !== measurementLayoutIdentity(layoutRef.current)) return;
      const canvas = latest.current.parent?.querySelector<HTMLElement>(':scope > .stream-renderer__virtual-canvas');
      if (!canvas || Math.abs(canvas.getBoundingClientRect().width - candidate.layout.width) > 0.05) return;
      const sizes = [...candidate.sizes];
      const wanted = new Map(candidate.rows.map((row, index) => [row.key, { row, index }]));
      for (const element of latest.current.parent?.querySelectorAll<HTMLElement>('[data-reading-key]') ?? []) {
        const value = wanted.get(element.dataset.readingKey ?? '');
        if (!value || element.getAttribute('aria-busy') === 'true' || element.dataset.readingPayload !== readingPayloadKey(value.row)) continue;
        const box = element.getBoundingClientRect();
        if (box.height > 0 && Math.abs(box.width - candidate.layout.width) <= 0.05) sizes[value.index] = box.height;
      }
      const next = { ...candidate, sizes };
      prepared.current=next;
      latest.current.onPrepared(next.rows); setGeometry(next);
      if(traceEnabled && (trace.current.publications++<8 || next.exact&&!trace.current.completeLogged)){
        if(next.exact)trace.current.completeLogged=true;
        console.info('[mandible:reading-measurement]',JSON.stringify({scope:input.scope,
        mountedAt:trace.current.mountedAt,firstRequiredSourceMs:latest.current.firstRequiredSourceAt===undefined?null:latest.current.firstRequiredSourceAt-trace.current.mountedAt,
        publishedMs:performance.now()-trace.current.mountedAt,publicationRafMs:performance.now()-queuedAt,
        rows:next.rows.length,exact:next.exact,attempts:trace.current.attempts,
        note:'Phase totals overlap: source lookahead, fonts, images and readiness. Times start at Chat geometry hook mount; exclude initial route request.'}));
      }
    });
  };
  useEffect(() => () => { if (publicationFrame.current !== null) cancelAnimationFrame(publicationFrame.current); }, []);
  const wake = useRef<(priorityChanged?:boolean) => void>(() => {});
  useLayoutEffect(() => {
    const parent = input.parent;
    if (!parent) return;
    const canvas = parent.querySelector<HTMLElement>(':scope > .stream-renderer__virtual-canvas');
    if (!canvas) return;
    const update = () => {
      const style = getComputedStyle(parent);
      const width = canvas.getBoundingClientRect().width;
      if (width <= 0) return;
      const profileIdentity = JSON.stringify([style.getPropertyValue('--reading-renderer-version').trim(), style.fontFamily, style.fontSize, style.fontWeight, style.fontStyle, style.lineHeight, style.letterSpacing, document.documentElement.dataset.theme]);
      const next: MeasurementLayout = { width, profileIdentity, responsiveVariant: style.getPropertyValue('--reading-responsive-variant').trim(), styleIdentity: JSON.stringify([fontGeneration.current, profileIdentity]), fonts: [{ font: `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}` }] };
      if (!layoutRef.current || measurementLayoutIdentity(layoutRef.current) !== measurementLayoutIdentity(next)) {
        activeMeasurement.current?.abort();
        latest.current.onLayoutChange?.(next); layoutRef.current = next; setLayout(next);
      }
    };
    const observer = new ResizeObserver(update); observer.observe(canvas); observer.observe(parent);
    const fontsChanged = () => { fontGeneration.current++; update(); };
    const themeObserver = new MutationObserver(update); themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    window.addEventListener('resize', update); document.fonts?.addEventListener('loadingdone', fontsChanged); update();
    return () => { observer.disconnect(); themeObserver.disconnect(); window.removeEventListener('resize', update); document.fonts?.removeEventListener('loadingdone', fontsChanged); };
  }, [input.parent]);
  useEffect(() => {
    facts.current = []; basis.current = null; queued.current = null; prepared.current=null;setGeometry(null); setError(null);
  }, [input.scope]);
  useEffect(() => {
    if (!layout || !input.parent) return;
    const parent = input.parent;
    const controller = new AbortController(); activeMeasurement.current = controller;
    const service = new ReadingMeasurementService(parent);
    const identity = measurementLayoutIdentity(layout);
    facts.current = facts.current.filter(fact => fact.layoutIdentity === identity);
    const compatible = basis.current;
    const held = published.current.geometry?.scope === input.scope ? published.current.geometry : compatible;
    if (held) {
      const scalable = compatible && (compatible.layout.profileIdentity ?? compatible.layout.styleIdentity) === (layout.profileIdentity ?? layout.styleIdentity)
        && JSON.stringify(compatible.layout.fonts) === JSON.stringify(layout.fonts)
        && compatible.rows.length === latest.current.rows.length && compatible.rows.every((row, index) => row.key === latest.current.rows[index].key
          && row.revision === latest.current.rows[index].revision && row.disclosureIdentity === latest.current.rows[index].disclosureIdentity);
      const source = scalable ? compatible : held;
      const ratio = scalable ? latest.current.scale(source.layout, layout) : 1;
      publish.current({ ...source, sizes: source.sizes.map(size => size * ratio), layout, exact: false, measured:new Set(),serial: ++serial.current });
    }
    let running = false;
    let measuringRows:readonly MeasurementRow[]|undefined;
    let completedPlan: readonly MeasurementRow[] | undefined;
    const run = async () => {
      if (running || controller.signal.aborted || completedPlan === latest.current.rows) return;
      running = true; setError(null);
      while (!controller.signal.aborted && completedPlan !== latest.current.rows) {
        const snapshot = latest.current;
        const rows = snapshot.rows;
        measuringRows=rows;
        const byKey=new Map(rows.map((row,index)=>[row.key,{row,index}]));
        const valid=(fact:RowMeasurement)=>{const row=byKey.get(fact.row.key)?.row;return row&&fact.layoutIdentity===identity&&row.revision===fact.row.revision&&row.disclosureIdentity===fact.row.disclosureIdentity;};
        const measured=new Map(facts.current.filter(valid).map(fact=>[fact.row.key,fact]));
        const style=getComputedStyle(parent);
        let lineHeight=parseFloat(style.lineHeight);
        if(!Number.isFinite(lineHeight)){
          const probe=document.createElement('div');probe.textContent='M';parent.append(probe);lineHeight=probe.getBoundingClientRect().height;probe.remove();
        }
        const estimate=Math.max(1,4*lineHeight);
        const previous=queued.current??prepared.current??published.current.geometry;
        const previousRows=new Map(previous?.rows.map((row,index)=>[row.key,{row,size:previous.sizes[index]}])??[]);
        const sizes=rows.map(row=>{
          const fact=measured.get(row.key);if(fact)return fact.height;
          const prior=previousRows.get(row.key);
          return prior&&prior.row.revision===row.revision&&prior.row.disclosureIdentity===row.disclosureIdentity?prior.size:estimate;
        });
        const initialRegion=()=>{
          const target=latest.current.initialTarget;
          if(!target&&published.current.geometry?.scope===input.scope)return [];
          const index=target?byKey.get(target.key)?.index:rows.length-1;
          if(index===undefined||index<0)return [];
          const selected=[rows[index]];
          let covered=sizes[index];
          if(target?.align==='start'){
            let before=0;for(let at=index-1;at>=0&&before<Math.max(0,target.offset??0);at--){selected.push(rows[at]);before+=sizes[at];}
            const height=parent.clientHeight+Math.max(0,-(target.offset??0));
            for(let at=index+1;at<rows.length&&covered<height;at++){selected.push(rows[at]);covered+=sizes[at];}
          }else for(let at=index-1;at>=0&&covered<parent.clientHeight;at--){selected.push(rows[at]);covered+=sizes[at];}
          return selected;
        };
        const priority=()=>{
          const first=initialRegion();
          const requested=latest.current.priorityKeys??[];
          const retained=[...new Set([...first.map(row=>row.key),...requested])];
          const keys=[...retained];
          for(const key of requested){const owner=byKey.get(key);const end=owner?.row.disclosureEnd?byKey.get(owner.row.disclosureEnd):undefined;
            if(owner&&end)keys.push(...rows.slice(owner.index,end.index+1).map(row=>row.key));}
          snapshot.onMeasuring(rows,retained.flatMap(key=>{const ref=byKey.get(key)?.row;return ref?[ref]:[];}));
          return [...new Set(keys)];
        };
        const publishProgress=()=>{
          const region=initialRegion();
          if(region.some(row=>!measured.has(row.key)))return;
          const capacity=nativeReadingCapacity(parent);
          if(sizes.some(height=>height>capacity.maxRowHeight)||sizes.reduce((sum,height)=>sum+height,snapshot.chrome)>capacity.totalHeight)throw new Error('Conversation geometry exceeds this browser’s native scroll capacity.');
          const next:ReadingGeometry={scope:input.scope,membership:snapshot.membership,rowMembers:snapshot.rowMembers,rows,sizes:[...sizes],layout,exact:measured.size===rows.length,
            measured:new Set(measured.keys()),serial:++serial.current,renderProps:snapshot.renderProps};
          if(next.exact)basis.current=next;
          publish.current(next);
        };
        priority();publishProgress();
        startedScope.current = input.scope;
        const phaseStarted=performance.now();
        const phases:Partial<Record<MeasurementPhase,{ms:number;batches:number;rows:number}>>={};
        const attempt={startMs:phaseStarted-trace.current.mountedAt,wallMs:0,rows:rows.length,status:'running',phases};
        if(traceEnabled&&trace.current.scope===input.scope&&trace.current.attempts.length<8)trace.current.attempts.push(attempt);
        const result = await service.measure({ rows, layouts: [layout], materialize: snapshot.materialize,
          renderBatch: createReadingRowBatchRenderer(snapshot.renderProps), reuse: facts.current,
          signal: controller.signal, batchSize: 16, materializeBatchSize: 128,maxSynchronousMs: 8,
          prioritize:priority,onMeasured:additions=>{
            for(const fact of additions){measured.set(fact.row.key,fact);sizes[byKey.get(fact.row.key)!.index]=fact.height;}
            facts.current=[...measured.values()];publishProgress();
          },
          onPhase:traceEnabled?event=>{const total=phases[event.phase]??={ms:0,batches:0,rows:0};total.ms+=event.durationMs;total.batches++;total.rows+=event.rowCount;attempt.wallMs=performance.now()-phaseStarted;}:undefined });
        attempt.wallMs=performance.now()-phaseStarted;attempt.status=result.status;
        if (controller.signal.aborted || !layoutRef.current || measurementLayoutIdentity(layoutRef.current) !== identity) break;
        facts.current = result.measurements;
        if (result.status !== 'complete') {
          if (result.status === 'error' && result.reason === 'materialize' && isReadingPublicationChanged(result.cause)) {
            if (rows !== latest.current.rows) continue;
            break;
          }
          if(result.status==='cancelled'&&!controller.signal.aborted)continue;
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
    let startTimer: ReturnType<typeof setTimeout> | null = null;
    wake.current = priorityChanged => {
      const rows=latest.current.rows;
      const missingPriority=priorityChanged&&(latest.current.priorityKeys??[]).some(key=>!facts.current.some(fact=>fact.row.key===key&&fact.layoutIdentity===identity));
      if(running&&measuringRows&&(missingPriority||rows.length<measuringRows.length||measuringRows.some((row,index)=>row.key!==rows[index].key||row.revision!==rows[index].revision||row.disclosureIdentity!==rows[index].disclosureIdentity)))service.cancel();
      else if (startTimer === null) void run();
    };
    if (startedScope.current === input.scope) startTimer = setTimeout(() => { startTimer = null; void run(); }, 120);
    else void run();
    return () => {
      if (startTimer !== null) clearTimeout(startTimer);
      controller.abort(); if (activeMeasurement.current === controller) activeMeasurement.current = null;
      service.dispose(); wake.current = () => {};
    };
  }, [layout, input.parent, input.scope]);
  useEffect(() => { wake.current(); }, [input.rows]);
  const prioritySignature=JSON.stringify(input.priorityKeys??[]);
  useEffect(()=>{wake.current(true);},[prioritySignature]);
  return { geometry: geometry?.scope === input.scope ? geometry : null, error, layout, reportHeight, retry: () => wake.current() };
}
