// @vitest-environment jsdom
import { act, cleanup, render } from './helpers/dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useReadingViewport } from '../ui/src/chat/useReadingViewport';
import type { ReadingRow, ReadingRevealResult } from '../ui/src/chat/readingProjection';
import { readReadingState, writeReadingState } from '../ui/src/chat/readingState';

const boundary = vi.hoisted(() => ({ options: null as any, engine: null as any, calls: [] as string[] }));
vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: (options: any) => {
  boundary.options = options;
  return boundary.engine;
} }));
let viewport: ReturnType<typeof useReadingViewport>;
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
const coordinate = { conversationId: 'conv', positionSpaceId: 'space', position: 42 };
const rows: ReadingRow[] = [{ key: 'exact-row', kind: 'content', protectedPositions: [42], items: [], nodes: [], sources: [{ blockId: 'cblk:conv:42', position: 42 }], actionGroup: { key: 'scope', start: 0, end: 99 }, disclosureOwner: null }];
const geometry = { membership: new Map<string, { rowKey: string; position?: number | null }>([['exact-row', { rowKey: 'exact-row', position: 42 }]]), rowMembers: new Map<string, readonly string[]>([['exact-row', ['exact-row']]]), scope: 'conv', rows: rows.map(row => ({ key: row.key, revision: '1' })), sizes: [100], exact: true, serial: 1, layout: { width: 600, styleIdentity: 'test', fonts: [] }, renderProps: () => ({} as any) };
const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 600, width: 600, x: 0, y: top, toJSON: () => ({}) } as DOMRect);
function Harness({ prepare, space = 'space', scope = 'conv', initializing = false, vector = geometry, disclosures = {}, clearance = 123 }: { clearance?: number; disclosures?: Record<string, boolean>; vector?: typeof geometry; scope?: string; initializing?: boolean; prepare: Parameters<typeof useReadingViewport>[0]['prepare']; space?: string;  }) {
  viewport = useReadingViewport({ scope, initializing, positionSpaceId: space, geometry: vector, protectedKeys: new Set(),
    disclosures, clearance, onInput: () => {}, onApplied: () => {}, onRange: () => {}, prepare });
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
  Object.defineProperty(scroller, 'clientHeight', { value: 400 });
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
    measure: () => {}, getOffsetForIndex: () => [300, 'start'],
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
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('restores an explicit collapse and preserves saved positive disclosure intent', () => {
  writeReadingState('conv', { version: 4, positionSpaceId: 'space', following: false, anchor: { ...coordinate, kind: 'source' },
    disclosures: { 'group:thought': false, 'activity:tool': true } });
  expect(readReadingState('conv')?.disclosures).toEqual({ 'group:thought': false, 'activity:tool': true });
  localStorage.setItem('mandible:chat-reading:conv', JSON.stringify({ version: 2, positionSpaceId: 'space', following: false,
    anchor: coordinate, disclosures: ['activity:tool'] }));
  expect(readReadingState('conv')?.disclosures).toEqual({ 'activity:tool': true });
});

it('prepares, materializes and aligns once, then requires measured visibility and settlement', async () => {
  const prepare = vi.fn(async () => ({ status: 'prepared' as const, rowKey: 'exact-row' }));
  render(<Harness prepare={prepare} />);
  const { target } = connect();
  const focus = vi.spyOn(target, 'focus');
  let result: ReadingRevealResult | undefined;
  await act(async () => { void viewport.reveal({ token: 'exact', target: coordinate }).then(value => { result = value; }); });
  expect(prepare).toHaveBeenCalledWith(coordinate, expect.any(AbortSignal), 'exact');
  expect(boundary.calls).toEqual(['cancel', 'index']);
  await frame();
  expect(boundary.calls).toEqual(['cancel', 'index', 'cancel', 'offset']);
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


it('coalesces geometry while native scrolling and restores the current reader through the public engine offset', () => {
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
  boundary.engine.isScrolling = false;
  act(() => boundary.options.onChange(boundary.engine));
  expect(rebuild).toHaveBeenCalledOnce();
  expect(scroller.scrollTop).toBe(850);
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
  Object.defineProperty(scroller, 'clientHeight', { value: 400 }); Object.defineProperty(scroller, 'scrollHeight', { value: 1400 });
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
  Object.defineProperty(scroller, 'clientHeight', { value: 400 }); Object.defineProperty(scroller, 'scrollHeight', { value: 1400 });
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
