import { render } from 'preact';
import { useCallback, useMemo, useState } from 'preact/hooks';
import { useReadingGeometry } from '../../../ui/src/chat/useReadingGeometry';
import { useReadingViewport } from '../../../ui/src/chat/useReadingViewport';
import { ReadingRowBody } from '../../../ui/src/chat/ReadingRowView';
import { MeasuredReadingBox, ReadingRowStrip } from '../../../ui/src/chat/ReadingRowWindow';
import type { ReadingRow } from '../../../ui/src/chat/readingProjection';
import type { ReadingContentProps } from '../../../ui/src/chat/ReadingContent';
import { captureReadingDomAnchor, readingDomAnchorOffset } from '../../../ui/src/chat/readingDomAnchor';

const counterfactual = new URLSearchParams(location.search).has('absolute');
const noop = () => {};
const bodies: ReadingRow[] = Array.from({ length: 80 }, (_, index) => {
  const key = `row:${index}`;
  const source = { blockId: `block:${index}`, position: index };
  const tool = index === 51 || index === 79;
  const text = index === 46 || index === 50 || index === 78 ? 'A stable reading point stays beside the same content as natural text wraps. '.repeat(210)
    : index === 49 ? 'A user bubble may reflow before its body replaces a pending box. '.repeat(8) : `Neighbor ${index}: ordinary source content.`;
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
const rows = bodies.map(row => ({ key: row.key, revision: '1' }));
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
let disclose: (expanded: boolean) => void;
let beginLayout = noop;
let disclosureExpected = 80;
let disclosureResult: string | undefined;
const scrollWrites: Array<{ wanted: number; actual: number }> = [];

function Harness() {
  const [parent, setParent] = useState<HTMLDivElement | null>(null);
  const [protectedKeys, protect] = useState<ReadonlySet<string>>(new Set()); setProtected = protect;
  const [hydrated, setHydrated] = useState(false); hydrate = () => setHydrated(true);
  const [expanded, setExpanded] = useState(true); disclose = setExpanded;
  const activeRows = useMemo(() => rows.filter(row => expanded || !['row:46', 'row:47', 'row:48'].includes(row.key)).map(row => row.key === 'row:45' ? { ...row, revision: String(expanded) } : row), [expanded]);
  geometry = useReadingGeometry({ scope: 'frame-fixture', parent, rows: activeRows, chrome: 48, membership, rowMembers, renderProps: props,
    onMeasuring: noop, onPrepared: noop, onLayoutChange: () => beginLayout(), scale: () => 0.7,
    materialize: async (wanted, signal) => {
      if (frozen) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      return wanted.map(row => { const body = bodies[Number(row.key.split(':')[1])]; return body.activityGroup ? { ...body, revision: row.revision, activityGroup: { ...body.activityGroup, expanded } } : body; });
    } });
  viewport = useReadingViewport({ scope: 'frame-fixture', positionSpaceId: 'space', onInput: noop, clearance: 16, geometry: geometry.geometry,
    protectedKeys, disclosures: {}, prepare: async (target, signal) => {
      if (target.position !== 45) return { status: 'not-renderable' };
      await until(() => signal.aborted || (!!viewport.appliedGeometry?.exact && viewport.rows.length === disclosureExpected), 'prepared disclosure');
      return signal.aborted ? { status: 'source-unavailable' } : { status: 'prepared', rowKey: 'row:45' };
    }, onApplied: noop, onRange: noop });
  beginLayout = viewport.beginLayout;
  const connect = useCallback((node: HTMLDivElement | null) => {
    viewport.scrollRef.current = node; setParent(node);
    if (node) {
      const native = node.scrollTo.bind(node);
      node.scrollTo = ((options: ScrollToOptions) => { native(options); scrollWrites.push({ wanted: options.top ?? node.scrollTop, actual: node.scrollTop }); }) as typeof node.scrollTo;
    }
  }, []);
  const items = viewport.engine.getVirtualItems();
  return <div className="stream-renderer"><div ref={connect} className="stream-renderer__scroll" {...viewport.inputHandlers}>
    <div className="stream-renderer__virtual-canvas" style={{ height: `${viewport.engine.getTotalSize()}px` }}>
      <ReadingRowStrip items={items} endOffset={counterfactual ? undefined : viewport.endOffset}>{item => {
        const ref = viewport.rows[item.index]; const body = bodies[Number(ref.key.split(':')[1])];
        const row = body.activityGroup ? { ...body, revision: ref.revision, activityGroup: { ...body.activityGroup, expanded } } : body;
        const pending = row.key === 'row:49' && !hydrated;
        const box = <MeasuredReadingBox key={row.key} row={pending ? undefined : row} index={item.index} pendingHeight={item.size} measurement={ref}
          reportHeight={geometry.reportHeight} register={viewport.register} registerRow={viewport.registerRow} scope="frame-fixture" space="space">
          {pending ? null : <ReadingRowBody {...props(row)} onActivityGroupExpandedChange={(next, trigger) => {
            const offset = trigger!.getBoundingClientRect().top - viewport.scrollRef.current!.getBoundingClientRect().top;
            viewport.pinDisclosure(row.key, trigger); disclosureExpected = next ? 80 : 77; disclosureResult = undefined; disclose(next);
            void viewport.reveal({ token: `disclosure:${next}`, preserveReaderPin: true, target: { conversationId: 'frame-fixture', positionSpaceId: 'space', position: 45, subtarget: 'summary', offset } }).then(result => { disclosureResult = result.status; });
          }} />}
        </MeasuredReadingBox>;
        return counterfactual ? <div key={row.key} style={{ position: 'absolute', insetInline: 0, top: `${item.start - (items[0]?.start ?? 0)}px` }}>{box}</div> : box;
      }}</ReadingRowStrip>
    </div>
  </div></div>;
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
  scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }));
  viewport.engine.scrollToIndex(45, { align: 'start', behavior: 'auto' });
  await until(() => boxes().has('row:45'), 'disclosure parent');
  scroller.scrollTop -= 100; scroller.dispatchEvent(new Event('scroll')); scroller.dispatchEvent(new Event('scrollend'));
  await until(() => !viewport.engine.isScrolling, 'disclosure reader settlement');
  const parentHeader = boxes().get('row:45')!.querySelector<HTMLButtonElement>('.compact-activity__row')!;
  for (let turn = 0; turn < 6; turn++) {
    const expanded = turn % 2 === 1; const desiredHeader = parentHeader.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    const writesBefore = scrollWrites.length; parentHeader.focus(); parentHeader.click();
    for (let count = 0; count < 120; count++) {
      await frame();
      samples.push({ phase: 'disclosure', header: parentHeader.getBoundingClientRect().top - scroller.getBoundingClientRect().top, desiredHeader,
        adjacency: adjacency(), write: scrollWrites.length > writesBefore ? scrollWrites.at(-1) : undefined, count: viewport.rows.length });
      if (document.activeElement !== parentHeader) throw new Error('Disclosure stole focus from its header');
      if (viewport.appliedGeometry?.exact && viewport.rows.length === (expanded ? 80 : 77) && disclosureResult === 'revealed') break;
      if (count === 119) throw new Error('Disclosure transaction did not finish');
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
    samples.push({ phase: 'reader', width: pane.getBoundingClientRect().width, rowHeight: boxes().get(anchor.key)!.getBoundingClientRect().height, glyph: glyphY(), desired, adjacency: adjacency(), write: scrollWrites.length > readerWritesBefore ? scrollWrites.at(-1) : undefined, protected: boxes().has('row:5'), pending: boxes().get('row:49')?.getAttribute('aria-busy') === 'true' });
    if (step === 20) setProtected(new Set(['row:5']));
    if (step === 40) hydrate();
    if (step === 60) setProtected(new Set());
    pane.style.width = `${500 - (step < 60 ? step : 120 - step)}.203125px`;
  }
  await frame();
  if (boxes().get(anchor.key) !== original) throw new Error('Protected range change remounted the reader DOM');
  // Native input owns its new position; pending provisional work cannot restore the old glyph.
  scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 80, bubbles: true }));
  scroller.scrollTop += 80; scroller.dispatchEvent(new Event('scroll'));
  const nativeTop = scroller.scrollTop;
  pane.style.width = '490.203125px'; await frame();
  const afterNative = scroller.scrollTop;
  scroller.dispatchEvent(new Event('scrollend')); await until(() => !viewport.engine.isScrolling, 'native settlement');
  await viewport.reveal({ token: 'tail', end: true });
  await until(() => boxes().has('row:79'), 'tail row');
  for (let step = 0; step < 100; step++) {
    await frame();
    samples.push({ phase: 'tail', width: pane.getBoundingClientRect().width, endGap: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
      tailGap: scroller.getBoundingClientRect().bottom - boxes().get('row:79')!.getBoundingClientRect().bottom - 16,
      adjacency: adjacency(), write: scrollWrites.at(-1) });
    pane.style.width = `${490 - (step < 50 ? step : 100 - step)}.203125px`;
  }
  await frame();
  const tailBeforeInput = boxes().get('row:79')!.getBoundingClientRect().top;
  const topBeforeInput = scroller.scrollTop;
  scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -80, bubbles: true }));
  scroller.scrollTop -= 80; scroller.dispatchEvent(new Event('scroll'));
  const tailNativeTop = scroller.scrollTop;
  pane.style.width = '488.203125px'; await frame();
  const tailAfterInput = boxes().get('row:79')!.getBoundingClientRect().top;
  document.title = btoa(JSON.stringify({ counterfactual, samples, nativeTop, afterNative, anchorKey: anchor.key, anchorOffset: anchor.point.offset,
    tailNativeTop, tailNativeAfter: scroller.scrollTop, tailIntentDrift: tailAfterInput - tailBeforeInput - (topBeforeInput - tailNativeTop) }));
})().catch(error => { document.title = `fixture-error:${btoa(String(error.stack ?? error))}`; });
