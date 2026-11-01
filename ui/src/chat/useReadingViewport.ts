import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ConversationSourceCoordinate } from '../query/conversationData';
import type { ReadingRevealCommand, ReadingRevealResult, ReadingRow, ReadingTargetRegistration, ReadingMembership } from './readingProjection';
import { writeReadingState, type ReadingState } from './readingState';

type Engine = Virtualizer<HTMLDivElement, HTMLDivElement>;
type Command = {
  token: string;
  target?: ConversationSourceCoordinate;
  controller: AbortController;
  phase: 'prepare' | 'materialize' | 'align' | 'end';
  end?: boolean;
  rowKey?: string;
  offset?: number;
  finish: (result: ReadingRevealResult) => void;
};

export function useReadingViewport(input: {
  scope: string;
  positionSpaceId: string;
  onInput: () => void;
  commandToken?: string;
  initializing?: boolean;
  clearance: number;
  membership: ReadonlyMap<string, ReadingMembership>;
  rows: readonly ReadingRow[];
  endReached: boolean;
  disclosures: readonly string[];
  prepare: (target: ConversationSourceCoordinate, signal: AbortSignal, token: string) => Promise<
    { status: 'prepared'; rowKey: string } | { status: 'source-unavailable' | 'position-space-changed' | 'not-renderable' }>;
  onRange: (start: number, end: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const current = useRef(input); current.current = input;
  const targets = useRef(new Map<string, ReadingTargetRegistration>());
  const command = useRef<Command | null>(null);
  const completed = useRef<string | undefined>();
  const rowBoxes = useRef(new Map<string, HTMLElement>());
  const lifecycleState = useRef<{ scope: string; value: ReadingState } | null>(null);
  const anchor = useRef<{ rowKey: string; offset: number; following: boolean } | null>(null);
  const lastRange = useRef('');
  const [showLatest, setShowLatest] = useState(false);
  const notify = useRef<() => void>(() => {});
  const settled = useRef(false);
  const frame = useRef<number | null>(null);
  const persist = useCallback((engine: Engine) => {
    const snapshot = current.current;
    if (snapshot.initializing || command.current || !scrollRef.current || !snapshot.scope || (snapshot.commandToken && completed.current !== snapshot.commandToken)) return;
    const rect = scrollRef.current.getBoundingClientRect();
    const first = [...targets.current.values()].filter(target => {
      const box = target.coordinate.conversationId === snapshot.scope && target.coordinate.positionSpaceId === snapshot.positionSpaceId ? target.element?.getBoundingClientRect() : null;
      return box && box.bottom > rect.top && box.top < rect.bottom;
    }).sort((a, b) => a.coordinate.position - b.coordinate.position || Number(b.coordinate.subtarget === 'summary') - Number(a.coordinate.subtarget === 'summary'))[0];
    const visibleRow = [...rowBoxes.current].find(([, element]) => {
      const box = element.getBoundingClientRect();
      return box.bottom > rect.top && box.top < rect.bottom;
    });
    if (visibleRow) anchor.current = { rowKey: visibleRow[0], offset: visibleRow[1].getBoundingClientRect().top - rect.top, following: snapshot.endReached && engine.isAtEnd(1) };
    const state: ReadingState = {
      version: 2, positionSpaceId: snapshot.positionSpaceId, following: snapshot.endReached && engine.isAtEnd(1),
      anchor: first ? { ...first.coordinate, offset: first.element!.getBoundingClientRect().top - rect.top } : null,
      disclosures: snapshot.disclosures.slice(-100),
    };
    lifecycleState.current = { scope: snapshot.scope, value: state };
    writeReadingState(snapshot.scope, state);
  }, []);
  const engine = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: input.rows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: index => input.rows[index].key,
    estimateSize: () => 168,
    overscan: 6,
    initialRect: { width: 600, height: 720 },
    paddingStart: 32,
    paddingEnd: input.clearance,
    anchorTo: 'end',
    followOnAppend: input.endReached ? 'auto' : false,
    scrollEndThreshold: input.endReached ? 1 : -1,
    useScrollendEvent: true,
    directDomUpdates: true,
    onChange(instance) {
      const latest = current.current;
      setShowLatest(previous => {
        const next = !latest.endReached || !instance.isAtEnd(1);
        return previous === next ? previous : next;
      });
      const range = instance.range;
      const rangeKey = `${range?.startIndex}:${range?.endIndex}`;
      if (range && lastRange.current !== rangeKey) {
        lastRange.current = rangeKey;
        latest.onRange(Math.max(0, range.startIndex - 6), Math.min(latest.rows.length - 1, range.endIndex + 6));
      }
      if (!instance.isScrolling && !settled.current) persist(instance);
      settled.current = !instance.isScrolling;
      notify.current();
    },
  });
  const finish = useCallback((status: ReadingRevealResult['status']) => {
    const active = command.current;
    if (!active) return;
    command.current = null;
    completed.current = active.token;
    active.controller.abort();
    engine.cancelScroll();
    active.finish({ token: active.token, status });
  }, [engine]);
  const cancel = useCallback(() => { finish('cancelled'); engine.cancelScroll(); }, [finish, engine]);
  notify.current = () => {
    if (!command.current || frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const active = command.current;
      const scroller = scrollRef.current;
      if (!active || !scroller || active.phase === 'prepare') return;
      if (active.phase === 'end') {
        if (!engine.isScrolling) { finish(engine.isAtEnd(1) ? 'revealed' : 'unsuccessful'); persist(engine); }
        return;
      }
      if (!active.target) { finish('not-renderable'); return; }
      const rowIndex = current.current.rows.findIndex(row => row.key === active.rowKey);
      if (rowIndex < 0) return;
      const registration = targets.current.get(`${active.target.positionSpaceId}:${active.target.position}:${active.target.subtarget ?? ''}`);
      if (registration && registration.element === null) { finish('not-renderable'); return; }
      if (!registration?.element?.isConnected) return;
      const measurement = engine.getVirtualItems().find(item => item.key === active.rowKey);
      if (!measurement || measurement.size <= 0) return;
      const rect = registration.element.getBoundingClientRect();
      const viewport = scroller.getBoundingClientRect();
      if (active.phase === 'materialize') {
        engine.cancelScroll();
        active.offset = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight,
          scroller.scrollTop + rect.top - viewport.top - (active.target.offset ?? 0)));
        active.phase = 'align';
        engine.scrollToOffset(active.offset, { align: 'start', behavior: 'auto' });
        registration.element.focus({ preventScroll: true });
        notify.current();
        return;
      }
      if (engine.isScrolling) return;
      const visible = rect.bottom > viewport.top && rect.top < viewport.bottom;
      const aligned = Math.abs(scroller.scrollTop - (active.offset ?? 0)) <= 1;
      finish(visible && aligned ? 'revealed' : 'unsuccessful');
      persist(engine);
    });
  };
  const reveal = useCallback(async (request: ReadingRevealCommand): Promise<ReadingRevealResult> => {
    cancel();
    return new Promise(resolve => {
      const active: Command = { ...request, controller: new AbortController(), phase: 'prepare', finish: resolve };
      command.current = active;
      const deadline = setTimeout(() => { if (command.current === active) finish('unsuccessful'); }, 10000);
      active.controller.signal.addEventListener('abort', () => clearTimeout(deadline), { once: true });
      if (request.end) {
        active.phase = 'end';
        engine.scrollToEnd({ behavior: 'auto' });
        notify.current();
        return;
      }
      void current.current.prepare(request.target, active.controller.signal, request.token).then(result => {
        if (command.current !== active) return;
        if (result.status !== 'prepared') { finish(result.status); return; }
        active.rowKey = result.rowKey;
        active.phase = 'materialize';
        const index = current.current.rows.findIndex(row => row.key === result.rowKey);
        if (index < 0) { finish('not-renderable'); return; }
        engine.scrollToIndex(index, { align: 'start', behavior: 'auto' });
        notify.current();
      }).catch(() => { if (command.current === active) finish('source-unavailable'); });
    });
  }, [cancel, engine, finish]);
  const register = useCallback((registration: ReadingTargetRegistration) => {
    const key = `${registration.coordinate.positionSpaceId}:${registration.coordinate.position}:${registration.coordinate.subtarget ?? ''}`;
    targets.current.set(key, registration);
    notify.current();
    return () => { if (targets.current.get(key) === registration) targets.current.delete(key); };
  }, []);
  const rowOffset = useCallback((key: string): number | undefined => {
    const row = rowBoxes.current.get(key);
    const scroll = scrollRef.current;
    return row && scroll ? row.getBoundingClientRect().top - scroll.getBoundingClientRect().top : undefined;
  }, []);
  const registerRow = useCallback((key: string, element: HTMLElement) => {
    rowBoxes.current.set(key, element);
    return () => { if (rowBoxes.current.get(key) === element) rowBoxes.current.delete(key); };
  }, []);
  useLayoutEffect(() => {
    notify.current();
    const previous = anchor.current;
    if (!previous || command.current || input.commandToken || input.rows.some(row => row.key === previous.rowKey)) return;
    const member = input.membership.get(previous.rowKey);
    anchor.current = null;
    if (member?.position !== null && member?.position !== undefined) {
      void reveal(previous.following ? { token: `membership:${crypto.randomUUID()}`, end: true } : { token: `membership:${crypto.randomUUID()}`, target: { conversationId: input.scope,
        positionSpaceId: input.positionSpaceId, position: member.position, offset: previous.offset } });
    }
  }, [input.rows, input.membership, input.scope, input.positionSpaceId, input.commandToken, reveal]);
  useEffect(() => {
    const scope = input.scope;
    const save = () => {
      if (current.current.scope === scope) persist(engine);
      else if (lifecycleState.current?.scope === scope) writeReadingState(scope, lifecycleState.current.value);
    };
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', save);
    return () => { save(); cancel(); anchor.current = null; window.removeEventListener('pagehide', save); document.removeEventListener('visibilitychange', save); };
  }, [input.scope, engine, persist, cancel]);
  useEffect(() => { if (!engine.isScrolling) persist(engine); }, [input.disclosures, engine, persist]);
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);
  const inputCancel = useCallback(() => { current.current.onInput(); anchor.current = null; cancel(); }, [cancel]);
  const onKeyDown = useCallback((event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return;
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) inputCancel();
  }, [inputCancel]);
  const onPointerDown = useCallback((event: PointerEvent) => {
    const el = scrollRef.current;
    if (el && (event.target === el || event.clientX >= el.getBoundingClientRect().left + el.clientWidth)) inputCancel();
  }, [inputCancel]);
  useEffect(() => () => cancel(), [input.positionSpaceId, cancel]);
  return { engine, scrollRef, register, registerRow, rowOffset, reveal, cancel, showLatest,
    inputHandlers: { onWheel: inputCancel, onTouchStart: inputCancel, onKeyDown, onPointerDown } };
}
