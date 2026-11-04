import { CollapsiblePanel } from '../../../ui/src/components/shared/CollapsiblePanel';
import { OverflowTopFade } from '../../../ui/src/components/shared/OverflowFade';
import { appearanceCssVariables, DEFAULT_APPEARANCE_SETTINGS } from '../../../ui/src/appearance-settings';
import { render } from 'preact';
import { useCallback, useMemo, useState } from 'preact/hooks';
import { useReadingGeometry } from '../../../ui/src/chat/useReadingGeometry';
import { useReadingViewport } from '../../../ui/src/chat/useReadingViewport';
import { ReadingRowView, ReadingRowBody } from '../../../ui/src/chat/ReadingRowView';
import { MeasuredReadingBox, ReadingRowStrip } from '../../../ui/src/chat/ReadingRowWindow';
import type { ReadingRow } from '../../../ui/src/chat/readingProjection';
import type { ReadingContentProps } from '../../../ui/src/chat/ReadingContent';
import { ReadingMeasurementService } from '../../../ui/src/chat/readingMeasurement';
import { createReadingRowBatchRenderer } from '../../../ui/src/chat/renderReadingMeasurementBatch';
import { captureReadingDomAnchor, readingDomAnchorOffset } from '../../../ui/src/chat/readingDomAnchor';

const capped = new URLSearchParams(location.search).has('cap');
const counterfactual = new URLSearchParams(location.search).has('absolute');
const noop = () => {};
const bodies: ReadingRow[] = Array.from({ length: 81 }, (_, index) => {
  const key = `row:${index}`;
  const source = { blockId: `block:${index}`, position: index };
  const tool = index === 51 || index === 79;
  const text = index === 46 || index === 50 || index === 78 ? 'A stable reading point stays beside the same content as natural text wraps. '.repeat(210)
    : index === 49 ? 'A user bubble may reflow before its body replaces a pending box. '.repeat(30) : `Neighbor ${index}: ordinary source content.`;
  return { key, revision: '1', kind: index === 45 ? 'activity-summary' : 'content', isFinalResponse: false, protectedPositions: [index], items: [],
    ...(index === 45 ? { activityGroup: { expanded: true, items: [], presentation: { summary: 'Nested tool activity', icon: 'terminal', hasDisclosure: true, defaultExpanded: false } } } : {}),
    nodes: index === 49 ? [{ kind: 'user_message', key, entity: 'user', text, source: 'synthetic', persisted: source }]
      : [{ kind: 'assistant_turn', key, entity: 'assistant', turn: { id: key, assistantEvent: {
        type: 'assistant', session_id: 'frame-fixture', parent_tool_use_id: null,
        message: { role: 'assistant', content: tool ? [{ type: 'tool_use', id: key, name: 'Bash', input: { command: 'Inspect the stable tool below wrapping prose' }, source }] : [{ type: 'text', text, source }] },
      }, toolResults: new Map() } }],
    sources: [source], actionGroup: { key, start: index, end: index }, disclosureOwner: null,
  };
});
const rows = bodies.slice(0, 80).map(row => ({ key: row.key, revision: '1' }));
const props = (row: ReadingRow): ReadingContentProps => ({ events: [], streaming: false, row, expandedBlocks: {}, setBlockExpanded: noop,
  preparing: false, onActivityGroupExpandedChange: noop, primaryActions: [
    { id: 'copy', title: 'Copy all', label: 'Copy all', icon: 'copyMessage', onAction: noop },
    { id: 'open', title: 'Open turn', label: 'Open turn', icon: 'menu', onAction: noop },
  ] });
const rowMembers = new Map(rows.map(row => [row.key, [row.key]]));
const membership = new Map(rows.map((row, position) => [row.key, { rowKey: row.key, position }]));
let frozen = false;
let viewport: ReturnType<typeof useReadingViewport>;
let geometry: ReturnType<typeof useReadingGeometry>;
let setProtected: (keys: ReadonlySet<string>) => void;
let hydrate: () => void;
let setCap: (width: number) => void;
let appendTail: () => void;
let beginLayout = noop;
let holdPreparation = false;
let releasePreparation: (() => void) | null = null;
const fixtureDisclosures = {};
const scrollWrites: Array<{ wanted: number; actual: number }> = [];

function Harness() {
  const [cap, changeCap] = useState(0); setCap = changeCap;
  const [parent, setParent] = useState<HTMLDivElement | null>(null);
  const [protectedKeys, protect] = useState<ReadonlySet<string>>(new Set()); setProtected = protect;
  const [hydrated, setHydrated] = useState(false); hydrate = () => setHydrated(true);
  const [userExpanded, setUserExpanded] = useState(false);
  const [toolExpanded, setToolExpanded] = useState(false);
  const [tailExpanded, setTailExpanded] = useState(false);
  const [appended, setAppended] = useState(false); appendTail = () => setAppended(true);
  const [expanded, setExpanded] = useState(true);
  const activeRows = useMemo(() => [...rows, ...(appended ? [{ key: 'row:80', revision: '1' }] : [])].filter(row => expanded || !['row:46', 'row:47', 'row:48'].includes(row.key)).map(row => row.key === 'row:45' ? { ...row, revision: String(expanded), disclosureEnd: expanded ? 'row:48' : 'row:45' } : row.key === 'row:49' ? { ...row, revision: String(userExpanded) } : row.key === 'row:51' ? { ...row, revision: String(toolExpanded) } : row.key === 'row:79' ? { ...row, revision: String(tailExpanded) } : row), [expanded, userExpanded, toolExpanded, tailExpanded, appended]);
  geometry = useReadingGeometry({ scope: 'frame-fixture', parent, rows: activeRows, chrome: 48, membership, rowMembers, renderProps: row => ({ ...props(row), expandedBlocks: { 'row:49:message': userExpanded, 'tool:row:51': toolExpanded, 'tool:row:79': tailExpanded } }),
    onMeasuring: noop, onPrepared: noop, onLayoutChange: () => beginLayout(), scale: () => 0.7,
    materialize: async (wanted, signal) => {
      if (frozen) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      return wanted.map(row => { const body = bodies[Number(row.key.split(':')[1])]; return body.activityGroup ? { ...body, revision: row.revision, activityGroup: { ...body.activityGroup, expanded } } : body; });
    } });
  viewport = useReadingViewport({ scope: 'frame-fixture', positionSpaceId: 'space', onInput: noop, clearance: 16, geometry: geometry.geometry,
    protectedKeys, disclosures: fixtureDisclosures, prepareRows: async (_rows,signal) => {
      if(holdPreparation)await new Promise<void>(resolve=>{const done=()=>{signal.removeEventListener('abort',done);releasePreparation=null;resolve();};releasePreparation=done;signal.addEventListener('abort',done,{once:true});});
      return !signal.aborted;
    }, prepare: async () => ({ status: 'not-renderable' }), onApplied: noop, onRange: noop });
  beginLayout = viewport.beginLayout;
  const connect = useCallback((node: HTMLDivElement | null) => {
    viewport.scrollRef.current = node; setParent(node);
    if (node) {
      const native = node.scrollTo.bind(node);
      node.scrollTo = ((options: ScrollToOptions) => { native(options); scrollWrites.push({ wanted: options.top ?? node.scrollTop, actual: node.scrollTop }); }) as typeof node.scrollTo;
    }
  }, []);
  const items = viewport.engine.getVirtualItems();
  return <div className="stream-renderer" style={appearanceCssVariables({ ...DEFAULT_APPEARANCE_SETTINGS, chatStreamMaxWidthPx: cap })}><div ref={connect} className="stream-renderer__scroll" {...viewport.inputHandlers}>
    <div className="stream-renderer__virtual-canvas" style={{ height: `${viewport.engine.getTotalSize()}px` }}>
      <ReadingRowStrip items={items} endOffset={counterfactual ? undefined : viewport.endOffset}>{item => {
        const ref = viewport.rows[item.index]; const body = bodies[Number(ref.key.split(':')[1])];
        const row = body.activityGroup ? { ...body, revision: ref.revision, activityGroup: { ...body.activityGroup, expanded: ref.revision === 'true' } } : body;
        const pending = row.key === 'row:49' && !hydrated;
        const box = <MeasuredReadingBox key={row.key} row={pending ? undefined : row} index={item.index} pendingHeight={item.size} measurement={ref}
          reportHeight={geometry.reportHeight} register={viewport.register} registerRow={viewport.registerRow} scope="frame-fixture" space="space">
          {pending ? null : <ReadingRowBody {...props(row)} expandedBlocks={{ 'row:49:message': row.key === 'row:49' && ref.revision === 'true', 'tool:row:51': row.key === 'row:51' && ref.revision === 'true', 'tool:row:79': row.key === 'row:79' && ref.revision === 'true' }} setBlockExpanded={(key, next, sources, trigger) => { viewport.pinDisclosure(row.key, trigger); if (row.key === 'row:49') setUserExpanded(next); else if (row.key === 'row:79') setTailExpanded(next); else setToolExpanded(next); }} onActivityGroupExpandedChange={(next, trigger) => {
            viewport.pinDisclosure(row.key, trigger); setExpanded(next);
          }} />}
        </MeasuredReadingBox>;
        return counterfactual ? <div key={row.key} style={{ position: 'absolute', insetInline: 0, top: `${item.start - (items[0]?.start ?? 0)}px` }}>{box}</div> : box;
      }}</ReadingRowStrip>
    </div>
  </div><OverflowTopFade scroller={parent} contentStart={viewport.engine.options.paddingStart ?? 0} className="stream-renderer__top-fade" /></div>;
}
window.addEventListener('error', event => { document.title = `fixture-error:${btoa(String(event.error?.stack ?? event.message))}`; });
document.title = 'frame-start';
render(<Harness />, document.getElementById('root')!);
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
async function until(check: () => boolean, name: string) {
  document.body.dataset.framePhase = name;
  for (let count = 0; count < 240; count++) { if (check()) return; await frame(); }
  throw new Error(`Did not reach ${name}`);
}
function boxes() { return new Map([...viewport.scrollRef.current!.querySelectorAll<HTMLElement>('.stream-renderer__virtual-canvas [data-reading-key]')].map(row => [row.dataset.readingKey!, row])); }
function adjacency() {
  const mounted = [...boxes().values()].sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index));
  return mounted.slice(1).flatMap((row, index) => Number(row.dataset.index) === Number(mounted[index].dataset.index) + 1
    ? [{ first: mounted[index].dataset.readingKey, second: row.dataset.readingKey, gap: row.getBoundingClientRect().top - mounted[index].getBoundingClientRect().bottom }] : []);
}
void (async () => {
  await until(() => !!viewport.appliedGeometry?.exact, 'initial exact geometry');
  const scroller = viewport.scrollRef.current!;
  const pane = document.getElementById('root')!;
  const samples: Array<Record<string, unknown>> = [];
  if(!counterfactual){
  scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }));
  viewport.engine.scrollToIndex(45, { align: 'start', behavior: 'auto' });
  await until(() => boxes().has('row:45'), 'disclosure parent');
  scroller.scrollTop -= 100; scroller.dispatchEvent(new Event('scroll')); scroller.dispatchEvent(new Event('scrollend'));
  await until(() => !viewport.engine.isScrolling, 'disclosure reader settlement');
  const parentHeader = boxes().get('row:45')!.querySelector<HTMLButtonElement>('.compact-activity__row')!;
  const disclosureBottom = () => { const key = viewport.rows.find(row => row.key === 'row:45')?.disclosureEnd ?? 'row:45'; const mounted = boxes().get(key); if (mounted) return mounted.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top; const index = viewport.rows.findIndex(row => row.key === key); return 32 + viewport.appliedGeometry!.sizes.slice(0, index + 1).reduce((sum, value) => sum + value, 0) - scroller.scrollTop; };
  const visualPositions=new WeakMap<Element,number>();
  let visualMoved=false;
  const observeVisual=()=>{const layer=scroller.querySelector('[data-reading-visual-overlay]');for(const element of layer?.children??[]){const top=element.getBoundingClientRect().top;const previous=visualPositions.get(element);if(previous!==undefined&&Math.abs(top-previous)>0.5)visualMoved=true;visualPositions.set(element,top);}return layer;};
  for (let turn = 0; turn < 6; turn++) {
    const expanded = turn % 2 === 1; const desiredBottom = disclosureBottom();
    const previousRows=viewport.rows;const previousExtent=viewport.engine.getTotalSize();
    if(turn===1)holdPreparation=true;
    const writesBefore = scrollWrites.length; parentHeader.focus({ preventScroll: true }); parentHeader.click();
    if(turn===1){
      await until(()=>releasePreparation!==null,'replacement disclosure source readiness');
      if(viewport.rows!==previousRows||viewport.engine.getTotalSize()!==previousExtent)throw new Error('Disclosure reserved target geometry before its bodies were prepared');
      holdPreparation=false;releasePreparation!();
    }
    for (let count = 0; count < 120; count++) {
      await frame();
      observeVisual();
      samples.push({ phase: 'disclosure', bottom: disclosureBottom(), desiredBottom, scrollTop: scroller.scrollTop, maxScroll: scroller.scrollHeight - scroller.clientHeight,
        adjacency: adjacency(), write: scrollWrites.length > writesBefore ? scrollWrites.at(-1) : undefined, count: viewport.rows.length });
      if (document.activeElement !== parentHeader) throw new Error(`Disclosure stole focus from its header turn=${turn} connected=${parentHeader.isConnected} active=${document.activeElement?.outerHTML.slice(0,200)} row=${boxes().has('row:45')}`);
      if (viewport.appliedGeometry?.exact && viewport.rows.length === (expanded ? 80 : 77) && !viewport.engine.isScrolling) break;
      if (count === 119) throw new Error('Disclosure transaction did not finish');
    }
    if(turn===0)await until(()=>!observeVisual(),'disclosure visual completion');
  }
  if(typeof Element.prototype.animate==='function'&&!matchMedia('(prefers-reduced-motion: reduce)').matches&&!visualMoved)throw new Error('Disclosure visual copies never moved');
  scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }));
  if(observeVisual())throw new Error('Native input retained disclosure visual copies');
  hydrate(); viewport.engine.scrollToIndex(viewport.rows.findIndex(row => row.key === 'row:49'), { align: 'start', behavior: 'auto' });
  await until(() => !!boxes().get('row:49')?.querySelector('.user-bubble button[aria-expanded]'), 'bounded user message');
  await until(() => !viewport.engine.isScrolling, 'user disclosure reader settlement');
  const userBubble = () => boxes().get('row:49')!.querySelector<HTMLElement>('.user-bubble')!;
  const foldedHeight = userBubble().getBoundingClientRect().height;
  for (const expanded of [true, false]) {
    const desired = userBubble().getBoundingClientRect().bottom - scroller.getBoundingClientRect().top;
    userBubble().querySelector<HTMLButtonElement>('button')!.click();
    await until(() => viewport.appliedGeometry?.exact === true && viewport.rows.find(row => row.key === 'row:49')?.revision === String(expanded), 'user disclosure exact geometry');
    const actual = userBubble().getBoundingClientRect().bottom - scroller.getBoundingClientRect().top;
    if (Math.abs(actual - desired) > 0.5) throw new Error(`User disclosure bottom moved ${actual - desired}`);
    if (expanded && userBubble().getBoundingClientRect().height <= foldedHeight * 2) throw new Error('Long user message did not reveal full content');
  }
  scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }));
  viewport.engine.scrollToIndex(viewport.rows.findIndex(row => row.key === 'row:51'), { align: 'start', behavior: 'auto' });
  await until(() => !!boxes().get('row:51')?.querySelector('[data-reading-disclosure]'), 'tool payload');
  await until(() => !viewport.engine.isScrolling, 'tool payload reader settlement');
  const toolPayload = () => boxes().get('row:51')!.querySelector<HTMLElement>('[data-reading-disclosure]')!;
  for (const expanded of [true, false]) {
    const desired = toolPayload().getBoundingClientRect().bottom - scroller.getBoundingClientRect().top;
    toolPayload().querySelector<HTMLButtonElement>('button[aria-expanded]')!.click();
    await until(() => viewport.appliedGeometry?.exact === true && viewport.rows.find(row => row.key === 'row:51')?.revision === String(expanded), 'tool payload exact geometry');
    const actual = toolPayload().getBoundingClientRect().bottom - scroller.getBoundingClientRect().top;
    if (Math.abs(actual - desired) > 0.5) throw new Error(`Tool payload bottom moved ${actual - desired}`);
  }
  }
  scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }));
  viewport.engine.scrollToIndex(50, { align: 'start', behavior: 'auto' });
  await until(() => boxes().has('row:50'), 'middle row');
  scroller.scrollTop += 250; scroller.dispatchEvent(new Event('scroll')); scroller.dispatchEvent(new Event('scrollend'));
  await until(() => !viewport.engine.isScrolling, 'reader settlement'); viewport.captureReaderAnchor();
  const anchor = captureReadingDomAnchor(scroller, boxes(), rowMembers, 16)!;
  if (!anchor.point) throw new Error('Expected a real captured glyph');
  const original = boxes().get(anchor.key)!;
  const glyphY = () => { const row = boxes().get(anchor.key)!; return row.getBoundingClientRect().top - scroller.getBoundingClientRect().top + readingDomAnchorOffset(anchor, row); };
  const desired = glyphY();
  const readerWritesBefore = scrollWrites.length;
  frozen = true;
  for (let step = 0; step < 120; step++) {
    await frame();
    samples.push({ phase: 'reader', cap: getComputedStyle(scroller).getPropertyValue('--chat-stream-max-width'), contentWidth: scroller.firstElementChild!.getBoundingClientRect().width, scrollTop: scroller.scrollTop, rowTop: boxes().get(anchor.key)!.getBoundingClientRect().top, pointOffset: readingDomAnchorOffset(anchor, boxes().get(anchor.key)!), layoutWidth: viewport.appliedGeometry?.layout.width, width: pane.getBoundingClientRect().width, rowHeight: boxes().get(anchor.key)!.getBoundingClientRect().height, glyph: glyphY(), desired, adjacency: adjacency(), write: scrollWrites.length > readerWritesBefore ? scrollWrites.at(-1) : undefined, protected: boxes().has('row:5'), pending: boxes().get('row:49')?.getAttribute('aria-busy') === 'true' });
    if (step === 20) setProtected(new Set(['row:5']));
    if (step === 40) hydrate();
    if (step === 60) setProtected(new Set());
    if (capped) setCap(400 - (step < 60 ? step : 120 - step));
    else pane.style.width = `${500 - (step < 60 ? step : 120 - step)}.203125px`;
  }
  if(counterfactual){document.title=btoa(JSON.stringify({counterfactual,capped,samples}));return;}
  await frame();
  if (boxes().get(anchor.key) !== original) throw new Error('Protected range change remounted the reader DOM');
  // Native input owns its new position; pending provisional work cannot restore the old glyph.
  scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 80, bubbles: true }));
  scroller.scrollTop += 80; scroller.dispatchEvent(new Event('scroll'));
  const nativeTop = scroller.scrollTop;
  if (capped) setCap(390); else pane.style.width = '490.203125px'; await frame();
  const afterNative = scroller.scrollTop;
  scroller.dispatchEvent(new Event('scrollend')); await until(() => !viewport.engine.isScrolling, 'native settlement');
  await viewport.reveal({ token: 'tail', end: true });
  await until(() => boxes().has('row:79'), 'tail row');
  for (let step = 0; step < 100; step++) {
    await frame();
    samples.push({ phase: 'tail', width: pane.getBoundingClientRect().width, endGap: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
      tailGap: scroller.getBoundingClientRect().bottom - boxes().get('row:79')!.getBoundingClientRect().bottom - 16,
      adjacency: adjacency(), write: scrollWrites.at(-1) });
    if (capped) setCap(390 - (step < 50 ? step : 100 - step));
    else pane.style.width = `${490 - (step < 50 ? step : 100 - step)}.203125px`;
  }
  await frame();
  frozen = false;
  const tailBottom = boxes().get('row:79')!.getBoundingClientRect().bottom;
  boxes().get('row:79')!.querySelector<HTMLButtonElement>('[aria-expanded]')!.click();
  await until(() => viewport.appliedGeometry?.exact === true && viewport.rows.find(row => row.key === 'row:79')?.revision === 'true', 'tail disclosure settles');
  if (!counterfactual && Math.abs(boxes().get('row:79')!.getBoundingClientRect().bottom - tailBottom) > 0.5) throw new Error('Tail disclosure moved its bottom');
  appendTail();
  await until(() => viewport.appliedGeometry?.exact === true && boxes().has('row:80') && viewport.engine.isAtEnd(1), 'following resumes after disclosure on append');
  const tailBeforeInput = boxes().get('row:79')!.getBoundingClientRect().top;
  const topBeforeInput = scroller.scrollTop;
  scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -80, bubbles: true }));
  scroller.scrollTop -= 80; scroller.dispatchEvent(new Event('scroll'));
  const tailNativeTop = scroller.scrollTop;
  if (capped) setCap(388); else pane.style.width = '488.203125px'; await frame();
  const tailAfterInput = boxes().get('row:79')!.getBoundingClientRect().top;
  const tailNativeAfter = scroller.scrollTop;
  const assetLayout = geometry.geometry!.layout;
  const asset = document.createElement('canvas'); asset.width = 300; asset.height = 700;
  const assetRow: ReadingRow = { ...bodies[49], key: 'asset-row', nodes: [{ kind: 'user_message', key: 'asset-message', entity: 'user', source: 'synthetic', text: `![Tall image](${asset.toDataURL()})` }] };
  const measureAsset = new ReadingMeasurementService(scroller);
  const renderer = createReadingRowBatchRenderer(props);
  let initialAssetHeight = 0;
  const measuredAsset = await measureAsset.measure({ rows: [{ key: assetRow.key, revision: '1' }], layouts: [assetLayout], materialize: async () => [assetRow], renderBatch: (...args) => {
    const batch = renderer(...args); initialAssetHeight = args[0].querySelector('.user-bubble__content')!.getBoundingClientRect().height; return batch;
  } });
  if (measuredAsset.status !== 'complete') throw new Error(`Asset measurement failed: ${measuredAsset.status}`);
  const visibleAsset = document.createElement('div'); visibleAsset.style.width = `${assetLayout.width}px`; scroller.append(visibleAsset);
  render(<ReadingRowView {...props(assetRow)} />, visibleAsset);
  await until(() => !!visibleAsset.querySelector<HTMLImageElement>('img')?.complete && !!visibleAsset.querySelector('.user-bubble button[aria-expanded]'), 'asset crosses user preview bound');
  const settledAssetHeight = visibleAsset.querySelector<HTMLElement>('[data-reading-key]')!.getBoundingClientRect().height;
  const assetCap = 18 * parseFloat(getComputedStyle(document.documentElement).fontSize);
  if (initialAssetHeight >= assetCap || visibleAsset.querySelector('.user-bubble__content')!.getBoundingClientRect().height <= assetCap) throw new Error('Image did not cross the folded preview boundary');
  if (Math.abs(measuredAsset.vectors[0].heights[0] - settledAssetHeight) > 0.05) throw new Error(`Asset footer missing from accepted geometry: ${measuredAsset.vectors[0].heights[0]} versus ${settledAssetHeight}`);
  render(null, visibleAsset); visibleAsset.remove(); measureAsset.dispose();
  const panelHost = document.createElement('div'); Object.assign(panelHost.style, { position: 'fixed', width: '320px', top: '0', right: '0' }); document.body.append(panelHost);
  const drawPanel = (height: number) => render(<CollapsiblePanel title={<span />} expanded onExpandedChange={noop}><div style={{ height }}><input /></div></CollapsiblePanel>, panelHost);
  drawPanel(1200);
  const panelToggle = panelHost.querySelector<HTMLButtonElement>('button[aria-controls]')!;
  const panelScroller = document.getElementById(panelToggle.getAttribute('aria-controls')!)!;
  const faded = (edge: 'before' | 'after') => Number(getComputedStyle(panelScroller.parentElement!, `::${edge}`).opacity);
  await until(() => faded('before') === 0 && faded('after') === 1, 'common panel only fades below at top');
  panelScroller.scrollTop = (panelScroller.scrollHeight - panelScroller.clientHeight) / 2;
  await until(() => faded('before') === 1 && faded('after') === 1, 'common panel fades both overflowing edges');
  panelScroller.scrollTop = panelScroller.scrollHeight;
  await until(() => faded('before') === 1 && faded('after') === 0, 'common panel only fades above at bottom');
  const panelInput = panelHost.querySelector('input')!; panelInput.focus({ preventScroll: true });
  drawPanel(60);
  await until(() => faded('before') === 0 && faded('after') === 0, 'common panel clears fades after content shrinks');
  if (document.activeElement !== panelInput) throw new Error('Common panel overflow reconciliation replaced focused content');
  render(null, panelHost); panelHost.remove();
  document.title = btoa(JSON.stringify({ counterfactual, capped, samples, nativeTop, afterNative, anchorKey: anchor.key, anchorOffset: anchor.point.offset,
    tailNativeTop, tailNativeAfter, tailIntentDrift: tailAfterInput - tailBeforeInput - (topBeforeInput - tailNativeTop) }));
})().catch(error => { document.title = `fixture-error:${btoa(String(error.stack ?? error))}`; });
