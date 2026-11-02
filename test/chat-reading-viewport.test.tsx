// @vitest-environment jsdom
import { act, cleanup, render } from './helpers/dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useReadingViewport } from '../ui/src/chat/useReadingViewport';
import type { ReadingRow, ReadingRevealResult } from '../ui/src/chat/readingProjection';
import { readReadingState, writeReadingState } from '../ui/src/chat/readingState';
import { readingNavigationObserver, type ReadingNavigationObserver } from '../ui/src/chat/readingNavigationObservation';

const boundary = vi.hoisted(() => ({ options: null as any, engine: null as any, calls: [] as string[] }));
vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: (options: any) => {
  boundary.options = options;
  return boundary.engine;
} }));
let viewport: ReturnType<typeof useReadingViewport>;
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
const coordinate = { conversationId: 'conv', positionSpaceId: 'space', position: 42 };
const rows: ReadingRow[] = [{ key: 'exact-row', kind: 'content', isFinalResponse: false, protectedPositions: [42], items: [], nodes: [], sources: [{ blockId: 'cblk:conv:42', position: 42 }], actionGroup: { key: 'scope', start: 0, end: 99 }, disclosureOwner: null }];
const geometry = { membership: new Map<string, { rowKey: string; position?: number | null }>([['exact-row', { rowKey: 'exact-row', position: 42 }]]), rowMembers: new Map<string, readonly string[]>([['exact-row', ['exact-row']]]), scope: 'conv', rows: rows.map(row => ({ key: row.key, revision: '1' })), sizes: [100], exact: true, serial: 1, layout: { width: 600, styleIdentity: 'test', fonts: [] }, renderProps: () => ({} as any) };
const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 600, width: 600, x: 0, y: top, toJSON: () => ({}) } as DOMRect);
function Harness({ prepare, observeNavigation, space = 'space', scope = 'conv', initializing = false, vector = geometry, disclosures = {}, clearance = 123, onRange = () => {} }: { onRange?: Parameters<typeof useReadingViewport>[0]['onRange']; observeNavigation?: ReadingNavigationObserver; clearance?: number; disclosures?: Record<string, boolean>; vector?: typeof geometry; scope?: string; initializing?: boolean; prepare: Parameters<typeof useReadingViewport>[0]['prepare']; space?: string;  }) {
  viewport = useReadingViewport({ scope, initializing, positionSpaceId: space, geometry: vector, protectedKeys: new Set(),
    disclosures, clearance, onInput: () => {}, onApplied: () => {}, onRange, prepare, observeNavigation });
  return <div ref={viewport.scrollRef} {...viewport.inputHandlers}><div data-target tabIndex={-1}>Exact target</div><input /></div>;
}
async function frame(): Promise<void> {
  await act(async () => {
    const pending = [...frames.values()]; frames.clear();
    pending.forEach(callback => callback(0));
    await Promise.resolve();
  });
}
function connect() {
  const scroller = viewport.scrollRef.current!;
  Object.defineProperty(scroller, 'clientHeight', { value: 400, configurable: true });
  Object.defineProperty(scroller, 'scrollHeight', { value: 1400 });
  scroller.getBoundingClientRect = () => rect(0, 400);
  const target = scroller.querySelector<HTMLElement>('[data-target]')!;
  target.getBoundingClientRect = () => rect(300 - scroller.scrollTop, 100);
  viewport.registerRow('exact-row', target);
  viewport.register({ coordinate, rowKey: 'exact-row', element: target });
  return { scroller, target };
}
beforeEach(() => {
  frames = new Map(); nextFrame = 0; boundary.calls = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  boundary.engine = {
    measure: () => {}, getTotalSize: () => 1400, getOffsetForIndex: () => [300, 'start'], getVirtualItemForOffset: () => ({ index: 0 }),
    isScrolling: false, range: { startIndex: 0, endIndex: 0 },
    isAtEnd: () => viewport.scrollRef.current?.scrollTop === 1000,
    getVirtualItems: () => [{ key: 'exact-row', index: 0, size: 100, start: 300, end: 400 }],
    cancelScroll: () => boundary.calls.push('cancel'),
    scrollToIndex: () => boundary.calls.push('index'),
    scrollToEnd: () => { boundary.calls.push('end'); viewport.scrollRef.current!.scrollTop = 1000; boundary.engine.isScrolling = true; },
    scrollToOffset: (offset: number) => { boundary.calls.push('offset'); viewport.scrollRef.current!.scrollTop = offset; boundary.engine.isScrolling = true; },
  };
  localStorage.clear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.history.replaceState(null, '', '/'); });

it('distinguishes a settled alignment failure from a preparation deadline without changing results', async () => {
  const observe = vi.fn<ReadingNavigationObserver>();
  const prepare = vi.fn(async () => ({ status: 'prepared' as const, rowKey: 'exact-row' }));
  const view = render(<Harness prepare={prepare} observeNavigation={observe} />);
  const { scroller } = connect();
  let aligned!: Promise<ReadingRevealResult>;
  await act(async () => { aligned = viewport.reveal({ token: 'source', target: coordinate, origin: 'source-navigation' }); });
  scroller.scrollTop = 100;
  boundary.engine.isScrolling = false;
  act(() => boundary.options.onChange(boundary.engine));
  await frame();
  expect(await aligned).toEqual({ token: 'source', status: 'unsuccessful' });
  expect(observe).toHaveBeenLastCalledWith(expect.objectContaining({ event: 'terminal', token: 'source', origin: 'source-navigation', target: coordinate,
    terminal: expect.objectContaining({ reason: 'settled-target', phase: 'align', wantedOffset: 300, scrollTop: 100, targetConnected: true, scrolling: false }) }));

  vi.useFakeTimers();
  view.rerender(<Harness prepare={() => new Promise(() => {})} observeNavigation={observe} />);
  const expired = viewport.reveal({ token: 'disclosure', target: coordinate, origin: 'disclosure-pin', preserveReaderPin: true });
  await act(async () => { vi.advanceTimersByTime(10000); });
  expect(await expired).toEqual({ token: 'disclosure', status: 'unsuccessful' });
  expect(observe).toHaveBeenLastCalledWith(expect.objectContaining({ event: 'terminal', token: 'disclosure', origin: 'disclosure-pin',
    terminal: expect.objectContaining({ reason: 'deadline', phase: 'prepare' }) }));
});

it('keeps diagnostics opt-in and bounds console observation', () => {
  const output = vi.spyOn(console, 'info').mockImplementation(() => {});
  expect(readingNavigationObserver()).toBeUndefined();
  expect(output).not.toHaveBeenCalled();
  window.history.replaceState(null, '', '/?reading_trace=1');
  const observe = readingNavigationObserver()!;
  const observation = { event: 'notice' as const, token: 'owned', scope: 'conv', positionSpaceId: 'space', status: 'unsuccessful' as const,
    currentScope: 'next-conv', currentPositionSpaceId: 'next-space', currentToken: 'next-command', origin: 'source-navigation' as const };
  for (let index = 0; index < 100; index++) observe(observation);
  expect(output.mock.calls.length).toBeGreaterThan(0);
  expect(output.mock.calls.length).toBeLessThan(100);
  expect(JSON.parse(String(output.mock.calls[0][1]))).toMatchObject({ scope: 'conv', currentScope: 'next-conv', token: 'owned', currentToken: 'next-command' });
});

it('observes obsolete and input-cancelled commands without publishing a later deadline', async () => {
  vi.useFakeTimers();
  const observe = vi.fn<ReadingNavigationObserver>();
  render(<Harness prepare={() => new Promise(() => {})} observeNavigation={observe} />);
  const { scroller } = connect();
  const obsolete = viewport.reveal({ token: 'old', target: coordinate, origin: 'source-navigation' });
  const current = viewport.reveal({ token: 'new', target: coordinate, origin: 'source-navigation' });
  scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -50, bubbles: true }));
  expect(await obsolete).toEqual({ token: 'old', status: 'cancelled' });
  expect(await current).toEqual({ token: 'new', status: 'cancelled' });
  await act(async () => { vi.advanceTimersByTime(10000); });
  expect(observe.mock.calls.map(([record]) => [record.event, record.token, record.status])).toEqual([
    ['start', 'old', undefined], ['terminal', 'old', 'cancelled'], ['start', 'new', undefined], ['terminal', 'new', 'cancelled'],
  ]);
});

it('restores an explicit collapse and preserves saved positive disclosure intent', () => {
  writeReadingState('conv', { version: 4, positionSpaceId: 'space', following: false, anchor: { ...coordinate, kind: 'source' },
    disclosures: { 'group:thought': false, 'activity:tool': true } });
  expect(readReadingState('conv')?.disclosures).toEqual({ 'group:thought': false, 'activity:tool': true });
  localStorage.setItem('mandible:chat-reading:conv', JSON.stringify({ version: 2, positionSpaceId: 'space', following: false,
    anchor: coordinate, disclosures: ['activity:tool'] }));
  expect(readReadingState('conv')?.disclosures).toEqual({ 'activity:tool': true });
});

it('aligns an already-mounted prepared target without an intermediate index seek, then requires settlement', async () => {
  const prepare = vi.fn(async () => ({ status: 'prepared' as const, rowKey: 'exact-row' }));
  render(<Harness prepare={prepare} />);
  const { target } = connect();
  const focus = vi.spyOn(target, 'focus');
  let result: ReadingRevealResult | undefined;
  await act(async () => { void viewport.reveal({ token: 'exact', target: coordinate }).then(value => { result = value; }); });
  expect(prepare).toHaveBeenCalledWith(coordinate, expect.any(AbortSignal), 'exact', undefined);
  expect(boundary.calls).toEqual(['cancel', 'cancel', 'offset']);
  await frame();
  expect(boundary.calls).toEqual(['cancel', 'cancel', 'offset']);
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  await frame();
  expect(result).toBeUndefined();
  boundary.engine.isScrolling = false;
  act(() => boundary.options.onChange(boundary.engine));
  await frame();
  expect(result).toEqual({ token: 'exact', status: 'revealed' });
  await frame();
  expect(boundary.calls.filter(call => call === 'offset')).toHaveLength(1);
});

it('cancels preparation and engine reconciliation on direct input while preserving editable keys', async () => {
  let complete!: (value: { status: 'prepared'; rowKey: string }) => void;
  let signal!: AbortSignal;
  render(<Harness prepare={(_target, activeSignal) => { signal = activeSignal; return new Promise(done => { complete = done; }); }} />);
  const { scroller } = connect();
  const result = viewport.reveal({ token: 'cancel', target: coordinate });
  scroller.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect(signal.aborted).toBe(false);
  scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -50, bubbles: true }));
  expect(signal.aborted).toBe(true);
  expect(await result).toEqual({ token: 'cancel', status: 'cancelled' });
  complete({ status: 'prepared', rowKey: 'exact-row' });
  await frame();
  expect(boundary.calls).not.toContain('index');
  expect(boundary.calls).not.toContain('offset');
});

it('persists settled logical state and keeps composer clearance with adapter-owned following', () => {
  render(<Harness prepare={async () => ({ status: 'not-renderable' })} />);
  const { scroller } = connect();
  const write = vi.spyOn(Storage.prototype, 'setItem'); write.mockClear();
  expect(boundary.options.followOnAppend).toBe(false);
  expect(boundary.options.paddingEnd).toBe(123);
  boundary.engine.isScrolling = true;
  for (let index = 0; index < 4; index++) act(() => boundary.options.onChange(boundary.engine));
  expect(write).not.toHaveBeenCalled();
  scroller.scrollTop = 250;
  boundary.engine.isScrolling = false;
  act(() => boundary.options.onChange(boundary.engine));
  expect(write).toHaveBeenCalledOnce();
  expect(JSON.parse(write.mock.calls[0][1])).toMatchObject({ version: 4, following: false, anchor: { kind: 'row', rowKey: 'exact-row', memberKey: 'exact-row', position: 42, offset: 50 } });
});

it('terminates a prepared but non-renderable target without aligning nearby content', async () => {
  render(<Harness prepare={async () => ({ status: 'prepared', rowKey: 'exact-row' })} />);
  connect();
  viewport.register({ coordinate, rowKey: 'exact-row', element: null });
  const result = viewport.reveal({ token: 'hidden', target: coordinate });
  await act(async () => { await Promise.resolve(); });
  await frame();
  expect(await result).toEqual({ token: 'hidden', status: 'not-renderable' });
  expect(boundary.calls).not.toContain('offset');
});

it('keeps old-scope cleanup from overwriting the next conversation during restoration', () => {
  const prepare = async () => ({ status: 'not-renderable' as const });
  const view = render(<Harness prepare={prepare} />); connect();
  boundary.engine.isScrolling = true; act(() => boundary.options.onChange(boundary.engine));
  boundary.engine.isScrolling = false; act(() => boundary.options.onChange(boundary.engine));
  const previous = localStorage.getItem('mandible:chat-reading:conv');
  const next = JSON.stringify({ version: 2, positionSpaceId: 'other-space', following: false, anchor: { conversationId: 'other', positionSpaceId: 'other-space', position: 9, subtarget: 'summary', offset: 20 }, disclosures: ['owner:9'] });
  localStorage.setItem('mandible:chat-reading:other', next);
  view.rerender(<Harness prepare={prepare} scope="other" space="other-space" initializing />);
  expect(localStorage.getItem('mandible:chat-reading:conv')).toBe(previous);
  expect(localStorage.getItem('mandible:chat-reading:other')).toBe(next);
});


it('coalesces geometry while native scrolling and preserves mounted DOM alignment despite a different engine prefix', () => {
  const prepare = async () => ({ status: 'not-renderable' as const });
  const view = render(<Harness prepare={prepare} />);
  const { scroller } = connect();
  const rebuild = vi.spyOn(boundary.engine, 'measure'); rebuild.mockClear(); boundary.calls = [];
  boundary.engine.isScrolling = true;
  view.rerender(<Harness prepare={prepare} vector={{ ...geometry, serial: 2 }} />);
  view.rerender(<Harness prepare={prepare} vector={{ ...geometry, serial: 3 }} />);
  expect(rebuild).not.toHaveBeenCalled();
  scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 50, bubbles: true }));
  scroller.scrollTop = 250;
  boundary.engine.getOffsetForIndex = () => [900, 'start'];
  boundary.engine.getVirtualItems = () => [{ key: 'exact-row', index: 0, size: 100, start: 900, end: 1000 }];
  boundary.engine.isScrolling = false;
  act(() => boundary.options.onChange(boundary.engine));
  expect(rebuild).toHaveBeenCalledOnce();
  expect(scroller.scrollTop).toBe(250);
  expect(boundary.calls.filter(call => call === 'offset')).toHaveLength(1);
});

it('preserves the logical row through a verified handoff and a shorter replacement', () => {
  const prepare = async () => ({ status: 'not-renderable' as const });
  boundary.engine.getVirtualItems = () => [{ key: 'exact-row', index: 0, size: 1200, start: 300, end: 1500 }];
  const before = { ...geometry, sizes: [1200], rowMembers: new Map([['exact-row', ['native-live-member']]]) };
  const view = render(<Harness prepare={prepare} vector={before} />);
  const { scroller } = connect();
  scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, bubbles: true }));
  scroller.scrollTop = 1100;
  act(() => boundary.options.onChange(boundary.engine));
  boundary.engine.getOffsetForIndex = () => [900, 'start'];
  view.rerender(<Harness prepare={prepare} vector={{ ...geometry, serial: 2,
    rows: [{ key: 'canonical-summary', revision: 'saved' }], membership: new Map([['native-live-member', { rowKey: 'canonical-summary' }]]) }} />);
  expect(scroller.scrollTop).toBeGreaterThanOrEqual(900);
  expect(scroller.scrollTop).toBeLessThan(1000);
});


it('saves and restores a logical row before its distant body arrives without opening disclosures', async () => {
  const prepare = vi.fn(async () => ({ status: 'not-renderable' as const }));
  const disclosures = { 'group:activity': false };
  const view = render(<Harness prepare={prepare} disclosures={disclosures} />);
  let scroller = viewport.scrollRef.current!;
  Object.defineProperty(scroller, 'clientHeight', { value: 400, configurable: true }); Object.defineProperty(scroller, 'scrollHeight', { value: 1400 });
  scroller.scrollTop = 250;
  boundary.engine.isScrolling = true; act(() => boundary.options.onChange(boundary.engine));
  boundary.engine.isScrolling = false; act(() => boundary.options.onChange(boundary.engine));
  const saved = readReadingState('conv')!;
  expect(saved.anchor).toEqual({ kind: 'row', rowKey: 'exact-row', memberKey: 'exact-row', position: 42, offset: 50 });
  view.unmount();
  boundary.engine.getOffsetForIndex = () => [900, 'start'];
  boundary.engine.getVirtualItems = () => [{ key: 'exact-row', index: 0, size: 100, start: 900, end: 1000 }];
  render(<Harness prepare={prepare} disclosures={saved.disclosures} initializing />);
  scroller = viewport.scrollRef.current!;
  Object.defineProperty(scroller, 'clientHeight', { value: 400, configurable: true }); Object.defineProperty(scroller, 'scrollHeight', { value: 1400 });
  if (saved.anchor?.kind !== 'row') throw new Error('Expected local row anchor.');
  const restored = viewport.reveal({ token: 'local-restore', restore: { positionSpaceId: saved.positionSpaceId, anchor: saved.anchor } });
  boundary.engine.isScrolling = false; act(() => boundary.options.onChange(boundary.engine));
  await frame();
  expect(await restored).toEqual({ token: 'local-restore', status: 'revealed' });
  expect(scroller.scrollTop).toBe(850);
  expect(prepare).not.toHaveBeenCalled();
  expect(readReadingState('conv')?.disclosures).toEqual(disclosures);
});


it('keeps a follower at the end when composer clearance changes without moving an active reader', () => {
  const prepare = async () => ({ status: 'not-renderable' as const });
  const view = render(<Harness prepare={prepare} />);
  const { scroller } = connect(); scroller.scrollTop = 1000;
  boundary.calls = [];
  view.rerender(<Harness prepare={prepare} clearance={200} />);
  expect(boundary.calls.filter(call => call === 'end')).toHaveLength(1);
  scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -50, bubbles: true }));
  scroller.scrollTop = 250; boundary.engine.isScrolling = false;
  act(() => boundary.options.onChange(boundary.engine));
  view.rerender(<Harness prepare={prepare} clearance={250} />);
  expect(boundary.calls.filter(call => call === 'end')).toHaveLength(1);
  expect(scroller.scrollTop).toBe(250);
});


it.each([false, true])('reveals and focuses the prepared message owner when an inline activity shares its source (activity first: %s)', async activityFirst => {
  const vector = {...geometry, rows: [...geometry.rows, {key: 'memory-row', revision: '1'}], sizes: [100, 100],
    rowMembers: new Map([...geometry.rowMembers, ['memory-row', ['memory-member']]])};
  const prepare = vi.fn<Parameters<typeof useReadingViewport>[0]['prepare']>(async (_target, _signal, _token, summary) => ({status: 'prepared', rowKey: summary?.rowKey ?? 'exact-row'}));
  render(<Harness vector={vector} prepare={prepare} />);
  const {scroller, target} = connect();
  const memory = document.createElement('div'); memory.tabIndex = -1; memory.textContent = 'Used memory'; scroller.append(memory);
  memory.getBoundingClientRect = () => rect(600 - scroller.scrollTop, 100);
  viewport.registerRow('memory-row', memory);
  boundary.engine.getVirtualItems = () => [{key: 'exact-row', index: 0, size: 100, start: 300, end: 400}, {key: 'memory-row', index: 1, size: 100, start: 600, end: 700}];
  let disposeMemory!: () => void;
  const registerMessage = () => viewport.register({coordinate, rowKey: 'exact-row', element: target});
  const registerMemory = () => {disposeMemory = viewport.register({coordinate, rowKey: 'memory-row', element: memory});};
  if (activityFirst) {registerMemory(); registerMessage();} else {registerMessage(); registerMemory();}
  const focusedMessage = vi.spyOn(target, 'focus'); const focusedMemory = vi.spyOn(memory, 'focus');
  let result: ReadingRevealResult | undefined;
  await act(async () => {void viewport.reveal({token: 'message-link', target: coordinate}).then(value => {result = value;});});
  expect(scroller.scrollTop).toBe(300);
  await frame();
  boundary.engine.isScrolling = false; act(() => boundary.options.onChange(boundary.engine)); await frame();
  expect(result).toEqual({token: 'message-link', status: 'revealed'});
  viewport.focusTarget(coordinate);
  expect(document.activeElement).toBe(target);
  expect(focusedMessage).toHaveBeenCalledWith({preventScroll: true});
  expect(focusedMemory).not.toHaveBeenCalled();
  const beforeCleanup = focusedMessage.mock.calls.length;
  disposeMemory(); viewport.focusTarget(coordinate);
  expect(focusedMessage).toHaveBeenCalledTimes(beforeCleanup + 1);
  viewport.cancel(); viewport.focusTarget(coordinate);
  expect(focusedMessage).toHaveBeenCalledTimes(beforeCleanup + 1);

  const summary = { rowKey: 'memory-row', disclosureOwner: 'footer' };
  const summaryCoordinate = { ...coordinate, subtarget: 'summary' };
  viewport.register({ coordinate: summaryCoordinate, rowKey: summary.rowKey, element: memory });
  let disclosed!: Promise<ReadingRevealResult>;
  await act(async () => { disclosed = viewport.reveal({ token: 'disclosure', target: summaryCoordinate, summary, preserveReaderPin: true }); });
  expect(prepare).toHaveBeenLastCalledWith(summaryCoordinate, expect.any(AbortSignal), 'disclosure', summary);
  expect(scroller.scrollTop).toBe(600);
  boundary.engine.isScrolling = false; act(() => boundary.options.onChange(boundary.engine)); await frame();
  expect(await disclosed).toEqual({ token: 'disclosure', status: 'revealed' });
  expect(focusedMemory).not.toHaveBeenCalled();
});

it('fetches a native viewport ahead through variable-height geometry without widening mounted demand', () => {
  const onRange = vi.fn();
  const vector = { ...geometry, serial: 2, rows: Array.from({ length: 30 }, (_, index) => ({ key: `row:${index}`, revision: '1' })),
    sizes: Array.from({ length: 30 }, (_, index) => index < 10 ? 20 : 200) };
  const offsets = vector.sizes.map((_, index) => vector.sizes.slice(0, index).reduce((sum, size) => sum + size, 0));
  boundary.engine.getVirtualItemForOffset = (offset: number) => ({ index: Math.max(0, offsets.findLastIndex(start => start <= offset)) });
  boundary.engine.getVirtualItems = () => [{ key: 'row:11', index: 11, start: 400, end: 600, size: 200 }];
  boundary.engine.range = { startIndex: 11, endIndex: 11 };
  boundary.engine.getTotalSize = () => 4200;
  render(<Harness vector={vector} onRange={onRange} prepare={async () => ({ status: 'not-renderable' })} />);
  const { scroller } = connect();
  scroller.scrollTop = 500;
  act(() => boundary.options.onChange(boundary.engine));
  expect(onRange.mock.lastCall![0]).toMatchObject({ start: 100, end: 1300, height: 400, required: [vector.rows[11]] });
  expect(onRange.mock.lastCall![0].prefetch.map((row: any) => row.key)).toContain('row:5');
  expect(onRange.mock.lastCall![0].prefetch.map((row: any) => row.key)).toContain('row:15');
  const published = onRange.mock.calls.length;
  scroller.scrollTop = 501;
  act(() => boundary.options.onChange(boundary.engine));
  expect(onRange.mock.calls.length).toBe(published);
  scroller.scrollTop = 550;
  act(() => boundary.options.onChange(boundary.engine));
  expect(onRange.mock.calls.length).toBe(published + 1);
  expect(onRange.mock.lastCall![0].required).toEqual([vector.rows[11]]);
  Object.defineProperty(scroller, 'clientHeight', { value: 600, configurable: true });
  act(() => boundary.options.onChange(boundary.engine));
  expect(onRange.mock.lastCall![0]).toMatchObject({ start: 0, end: 1750, height: 600, required: [vector.rows[11]] });
  expect(boundary.options.overscan).toBe(6);
});
