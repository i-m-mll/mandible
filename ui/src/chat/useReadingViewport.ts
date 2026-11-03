import { defaultRangeExtractor, useVirtualizer, type Virtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ConversationSourceCoordinate } from '../query/conversationData';
import type { ReadingRevealCommand, ReadingRevealResult, ReadingTargetRegistration } from './readingProjection';
import type { ReadingBodyDemand } from './readingBodyDemand';
import type { ReadingGeometry } from './useReadingGeometry';
import { captureDisclosureDomAnchor, captureReadingDomAnchor, readingDomAnchorOffset, type ReadingDomAnchor } from './readingDomAnchor';
import { writeReadingState, type ReadingState, type ReadingRestore } from './readingState';
import type { ReadingNavigationObservation, ReadingNavigationObserver, ReadingNavigationOrigin } from './readingNavigationObservation';

const targetCoordinateKey = (target: ConversationSourceCoordinate): string => JSON.stringify([
  target.conversationId, target.positionSpaceId, target.position, target.subtarget ?? null,
]);
const targetRegistrationKey = (target: ConversationSourceCoordinate, rowKey: string): string => JSON.stringify([rowKey, targetCoordinateKey(target)]);
const attainableRowOffset = (offset: number, size: number, viewport: number) => Math.max(1 - size, Math.min(offset, Math.max(0, viewport - 1)));
const disclosureRevision = (row: import('./readingMeasurement').MeasurementRow | undefined) => JSON.stringify([row?.revision, row?.disclosureIdentity, row?.disclosureEnd]);
type Engine = Virtualizer<HTMLDivElement, HTMLDivElement>;
export type ReadingSummaryTarget = { rowKey: string; disclosureOwner: string };
type Command = {
  token: string;
  origin?: ReadingNavigationOrigin;
  scope: string;
  positionSpaceId: string;
  summary?: ReadingSummaryTarget;
  target?: ConversationSourceCoordinate;
  controller: AbortController;
  phase: 'prepare' | 'materialize' | 'align' | 'end' | 'row';
  end?: boolean;
  preserveReaderPin?: boolean;
  rowKey?: string;
  offset?: number;
  finish: (result: ReadingRevealResult) => void;
};

export function useReadingViewport(input: {
  scope: string;
  positionSpaceId: string;
  onInput: () => void;
  observeNavigation?: ReadingNavigationObserver;
  commandToken?: string;
  initializing?: boolean;
  clearance: number;
  geometry: ReadingGeometry | null;
  protectedKeys: ReadonlySet<string>;
  disclosures: Readonly<Record<string, boolean>>;
  prepare: (target: ConversationSourceCoordinate, signal: AbortSignal, token: string, summary?: ReadingSummaryTarget) => Promise<
    { status: 'prepared'; rowKey: string } | { status: 'source-unavailable' | 'position-space-changed' | 'not-renderable' }>;
  onApplied: (rows: readonly import('./readingMeasurement').MeasurementRow[]) => void;
  onRange: (demand: ReadingBodyDemand) => void;
}) {
  const [applied, setApplied] = useState<ReadingGeometry | null>(null);
  const [indexed, setIndexed] = useState<ReadingGeometry | null>(null);
  const [acknowledged, setAcknowledged] = useState<ReadingGeometry | null>(null);
  const rows = input.geometry && applied?.scope === input.geometry.scope ? applied.rows : [];
  const indices = useMemo(() => new Map(rows.map((row, index) => [row.key, index])), [rows]);
  const pending = useRef<ReadingGeometry | null>(null);
  const restore = useRef<{ kind: 'end' } | { kind: 'row'; key: string; members: readonly string[]; offset: number } | null>(null);
  const readerPin = useRef<ReadingDomAnchor | null>(null);
  const disclosureKey = useRef<string | null>(null);
  const [pinKeys, setPinKeys] = useState<ReadonlySet<string>>(new Set());
  const capturePin = useRef<() => void>(() => {});
  const acknowledge = useRef<() => void>(() => {});
  const readback = useRef<ReadingGeometry | null>(null);
  const drag = useRef(false);
  const following = useRef(true);
  const resumeTailAfter = useRef<ReadingGeometry | null>(null);
  const chromePending = useRef(false);
  const previousClearance = useRef(input.clearance);
  const viewportHeight = useRef<number | null>(null);
  const userScroll = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const current = useRef({ ...input, rows, applied, indexed }); current.current = { ...input, rows, applied, indexed };
  const targets = useRef(new Map<string, ReadingTargetRegistration>());
  const command = useRef<Command | null>(null);
  const completed = useRef<string | undefined>();
  const completedTarget = useRef<{ coordinate: ConversationSourceCoordinate; rowKey: string; token: string } | null>(null);
  const rowBoxes = useRef(new Map<string, HTMLElement>());
  const pinPosition = useCallback((pin: ReadingDomAnchor): number | undefined => {
    const snapshot = current.current.applied; const scroller = scrollRef.current;
    if (!snapshot || !scroller) return;
    if (pin.disclosureEnd) {
      const key = snapshot.rows.find(row => row.key === pin.key)?.disclosureEnd ?? pin.key;
      const mounted = rowBoxes.current.get(key);
      if (mounted) return mounted.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top;
      const index = snapshot.rows.findIndex(row => row.key === key);
      if (index < 0) return;
      let low = 0; let high = engine.getTotalSize();
      let offset = engine.getOffsetForIndex(index, 'start')?.[0] ?? 0;
      while (high - low > 0.05) {
        const item = engine.getVirtualItemForOffset(offset);
        if (!item) return;
        if (item.index === index) return item.key === key ? item.end - scroller.scrollTop : undefined;
        if (item.index < index) low = Math.max(offset, item.end);
        else high = Math.min(offset, item.start);
        offset = (low + high) / 2;
      }
      const item = engine.getVirtualItemForOffset(low);
      return item?.key === key ? item.end - scroller.scrollTop : undefined;
    }
    const row = rowBoxes.current.get(pin.key);
    return row ? row.getBoundingClientRect().top - scroller.getBoundingClientRect().top + readingDomAnchorOffset(pin, row) : undefined;
  }, []);
  const correctLocal = useRef<() => void>(() => {});
  const localObserver = useRef<ResizeObserver | null>(null);
  const lifecycleState = useRef<{ scope: string; value: ReadingState } | null>(null);
  const lastRange = useRef('');
  const publishDemand = useRef<(engine: Engine) => void>(() => {});
  const [showLatest, setShowLatest] = useState(false);
  const notify = useRef<() => void>(() => {});
  const settled = useRef(false);
  const frame = useRef<number | null>(null);
  const persistFrame = useRef<number | null>(null);
  const mountedStart = useCallback((key: string): number | undefined => {
    const row = rowBoxes.current.get(key); const scroller = scrollRef.current;
    return row && scroller ? scroller.scrollTop + row.getBoundingClientRect().top - scroller.getBoundingClientRect().top : undefined;
  }, []);
  const firstVisible = useCallback((engine: Engine) => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const top = scroller.getBoundingClientRect().top;
    const items = engine.getVirtualItems();
    return items.find(item => { const row = rowBoxes.current.get(String(item.key)); return row && row.getBoundingClientRect().bottom > top; })
      ?? items.find(item => item.end > scroller.scrollTop);
  }, []);
  const persist = useCallback((engine: Engine) => {
    const snapshot = current.current;
    if (!snapshot.applied || snapshot.applied !== snapshot.indexed || snapshot.initializing || readback.current || command.current || !scrollRef.current || !snapshot.scope || (snapshot.commandToken && completed.current !== snapshot.commandToken)) return;
    const first = firstVisible(engine);
    const memberKey = first ? snapshot.applied?.rowMembers.get(String(first.key))?.[0] ?? String(first.key) : null;
    const membership = memberKey ? snapshot.applied?.membership.get(memberKey) : undefined;
    const state: ReadingState = {
      version: 4, positionSpaceId: snapshot.positionSpaceId, following: following.current,
      anchor: first && memberKey ? { kind: 'row', rowKey: String(first.key), memberKey, position: membership?.position ?? null, offset: (mountedStart(String(first.key)) ?? first.start) - scrollRef.current.scrollTop } : null,
      disclosures: Object.fromEntries(Object.entries(snapshot.disclosures).slice(-100)),
    };
    lifecycleState.current = { scope: snapshot.scope, value: state };
    writeReadingState(snapshot.scope, state);
  }, [firstVisible, mountedStart]);
  const getItemKey = useCallback((index: number) => rows[index].key, [rows]);
  const estimateSize = useCallback((index: number) => applied!.sizes[index], [applied?.sizes]);
  const rangeExtractor = useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) => {
    const keys = new Set([...input.protectedKeys, ...pinKeys]);
    if (disclosureKey.current) keys.add(disclosureKey.current);
    for (const member of readerPin.current?.members ?? []) {
      const key = applied?.membership.get(member)?.rowKey;
      if (key) keys.add(key);
    }
    return [...new Set([...defaultRangeExtractor(range), ...[...keys].flatMap(key => {
      const index = indices.get(key); return index === undefined ? [] : [index];
    })])].sort((a, b) => a - b);
  }, [input.protectedKeys, pinKeys, indices, applied?.membership]);
  const applyPending = useRef<() => void>(() => {});
  const engine = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    enabled: Boolean(input.geometry),
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey,
    estimateSize,
    overscan: 6,
    rangeExtractor,
    initialRect: { width: 600, height: 720 },
    paddingStart: 32,
    paddingEnd: input.clearance,
    followOnAppend: false,
    scrollEndThreshold: 1,
    useScrollendEvent: true,
    directDomUpdates: false,
    onChange(instance) {
      const height = instance.scrollRect?.height;
      if (height !== undefined) { if (viewportHeight.current !== null && viewportHeight.current !== height) chromePending.current = true; viewportHeight.current = height; }
      if (userScroll.current) { following.current = instance.isAtEnd(1); if (!instance.isScrolling && !drag.current) { userScroll.current = false; capturePin.current(); } }
      setShowLatest(previous => {
        const next = !following.current;
        return previous === next ? previous : next;
      });
      publishDemand.current(instance);
      acknowledge.current();
      if (!instance.isScrolling && !settled.current) persist(instance);
      settled.current = !instance.isScrolling;
      if (!instance.isScrolling && !drag.current) applyPending.current();
      notify.current();
    },
  });
  const finish = useCallback((status: ReadingRevealResult['status'], reason: NonNullable<ReadingNavigationObservation['terminal']>['reason']) => {
    const active = command.current;
    if (!active) return;
    const snapshot = current.current;
    if (snapshot.observeNavigation) {
      const scroller = scrollRef.current;
      const element = active.target && active.rowKey ? targets.current.get(targetRegistrationKey(active.target, active.rowKey))?.element : undefined;
      const rect = element?.getBoundingClientRect();
      const viewport = scroller?.getBoundingClientRect();
      const pin = active.preserveReaderPin ? readerPin.current : null;
      const pinRect = pin?.element?.isConnected ? pin.element.getBoundingClientRect() : undefined;
      snapshot.observeNavigation({ event: 'terminal', origin: active.origin, token: active.token, scope: active.scope, positionSpaceId: active.positionSpaceId,
        target: active.target, summary: active.summary, status, currentScope: snapshot.scope, currentPositionSpaceId: snapshot.positionSpaceId, currentToken: snapshot.commandToken,
        terminal: { reason, phase: active.phase, rowKey: active.rowKey, preserveReaderPin: active.preserveReaderPin, pinOffset: pin?.offset,
          pinRect: pinRect && { top: pinRect.top, bottom: pinRect.bottom }, wantedOffset: active.offset, scrollTop: scroller?.scrollTop,
          maxOffset: scroller ? Math.max(0, scroller.scrollHeight - scroller.clientHeight) : undefined, scrolling: engine.isScrolling,
          targetConnected: Boolean(element?.isConnected), targetRect: rect && { top: rect.top, bottom: rect.bottom }, viewportRect: viewport && { top: viewport.top, bottom: viewport.bottom },
          appliedSerial: snapshot.applied?.serial, indexedSerial: snapshot.indexed?.serial, pendingSerial: pending.current?.serial, readbackSerial: readback.current?.serial } });
    }
    command.current = null;
    completed.current = active.token;
    completedTarget.current = status === 'revealed' && active.target && active.rowKey
      ? { coordinate: active.target, rowKey: active.rowKey, token: active.token } : null;
    active.controller.abort();
    engine.cancelScroll();
    active.finish({ token: active.token, status });
    requestAnimationFrame(() => capturePin.current());
  }, [engine]);
  const cancel = useCallback(() => { completedTarget.current = null; finish('cancelled', 'cancelled'); engine.cancelScroll(); }, [finish, engine]);
  const alignRegistered = useCallback((active: Command, element: HTMLElement, scroller: HTMLElement) => {
    engine.cancelScroll();
    const pin = readerPin.current;
    const target = active.preserveReaderPin && pin && pin.key === active.rowKey && pin.element?.isConnected ? pin.element : element;
    active.offset = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight,
      scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - (active.target?.offset ?? 0)));
    active.phase = 'align';
    engine.scrollToOffset(active.offset, { align: 'start', behavior: 'auto' });
    if (!active.preserveReaderPin) element.focus({ preventScroll: true });
  }, [engine]);
  notify.current = () => {
    if (!command.current || frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const active = command.current;
      const scroller = scrollRef.current;
      if (!active || !scroller || active.phase === 'prepare') return;
      if (active.phase === 'end') {
        const snapshot = current.current;
        if (readback.current || snapshot.applied !== snapshot.indexed || (pending.current && pending.current !== snapshot.applied)) return;
        if (!engine.isScrolling) { finish(engine.isAtEnd(1) ? 'revealed' : 'unsuccessful', 'settled-end'); persist(engine); }
        return;
      }
      if (active.phase === 'row') {
        if (!engine.isScrolling) { finish(Math.abs(scroller.scrollTop - (active.offset ?? 0)) <= 1 ? 'revealed' : 'unsuccessful', 'settled-row'); persist(engine); }
        return;
      }
      if (!active.target) { finish('not-renderable', 'not-renderable'); return; }
      const rowIndex = current.current.rows.findIndex(row => row.key === active.rowKey);
      if (rowIndex < 0) return;
      const registration = targets.current.get(targetRegistrationKey(active.target, active.rowKey!));
      if (registration && registration.element === null) { finish('not-renderable', 'not-renderable'); return; }
      if (!registration?.element?.isConnected) return;
      const measurement = engine.getVirtualItems().find(item => item.key === active.rowKey);
      if (!measurement || measurement.size <= 0) return;
      const rect = registration.element.getBoundingClientRect();
      const viewport = scroller.getBoundingClientRect();
      if (active.phase === 'materialize') {
        alignRegistered(active, registration.element, scroller);
        notify.current();
        return;
      }
      if (engine.isScrolling) return;
      const visible = rect.bottom > viewport.top && rect.top < viewport.bottom;
      const aligned = Math.abs(scroller.scrollTop - (active.offset ?? 0)) <= 1;
      finish(visible && aligned ? 'revealed' : 'unsuccessful', 'settled-target');
      persist(engine);
    });
  };
  const reveal = useCallback(async (request: ((ReadingRevealCommand & { preserveReaderPin?: boolean; summary?: ReadingSummaryTarget }) | { token: string; restore: ReadingRestore }) & { origin?: ReadingNavigationOrigin }): Promise<ReadingRevealResult> => {
    cancel(); if (!('preserveReaderPin' in request && request.preserveReaderPin)) { readerPin.current = null; disclosureKey.current = null; resumeTailAfter.current = null; setPinKeys(new Set()); }
    return new Promise(resolve => {
      const active: Command = { ...request, scope: current.current.scope, positionSpaceId: current.current.positionSpaceId, controller: new AbortController(), phase: 'prepare', finish: resolve };
      command.current = active;
      current.current.observeNavigation?.({ event: 'start', origin: active.origin, token: active.token, scope: active.scope, positionSpaceId: active.positionSpaceId,
        target: active.target, summary: active.summary, currentScope: current.current.scope, currentPositionSpaceId: current.current.positionSpaceId, currentToken: current.current.commandToken });
      const deadline = setTimeout(() => { if (command.current === active) finish('unsuccessful', 'deadline'); }, 10000);
      active.controller.signal.addEventListener('abort', () => clearTimeout(deadline), { once: true });
      if ('restore' in request) {
        following.current = false; userScroll.current = false;
        const snapshot = current.current;
        if (request.restore.positionSpaceId !== snapshot.positionSpaceId) { finish('position-space-changed', 'preparation'); return; }
        const saved = request.restore.anchor;
        const key = snapshot.rows.some(row => row.key === saved.rowKey) ? saved.rowKey : snapshot.applied?.membership.get(saved.memberKey)?.rowKey;
        const index = snapshot.rows.findIndex(row => row.key === key);
        const offset = key ? mountedStart(key) ?? (index >= 0 ? engine.getOffsetForIndex(index, 'start')?.[0] : undefined) : undefined;
        if (offset === undefined || !scrollRef.current) { finish('not-renderable', 'not-renderable'); return; }
        active.phase = 'row'; active.rowKey = key;
        active.offset = Math.max(0, Math.min(scrollRef.current.scrollHeight - scrollRef.current.clientHeight, offset - attainableRowOffset(saved.offset, snapshot.applied!.sizes[index], scrollRef.current.clientHeight)));
        engine.scrollToOffset(active.offset, { align: 'start', behavior: 'auto' }); notify.current(); return;
      }
      following.current = Boolean(request.end);
      userScroll.current = false;
      if (request.end) {
        active.phase = 'end';
        engine.scrollToEnd({ behavior: 'auto' });
        notify.current();
        return;
      }
      void current.current.prepare(request.target, active.controller.signal, request.token, request.summary).then(result => {
        if (command.current !== active) return;
        if (result.status !== 'prepared') { finish(result.status, 'preparation'); return; }
        active.rowKey = result.rowKey;
        active.phase = 'materialize';
        const index = current.current.rows.findIndex(row => row.key === result.rowKey);
        if (index < 0) { finish('not-renderable', 'not-renderable'); return; }
        const registration = targets.current.get(targetRegistrationKey(request.target, result.rowKey));
        if (registration?.element === null) { finish('not-renderable', 'not-renderable'); return; }
        if (registration?.element?.isConnected && scrollRef.current) alignRegistered(active, registration.element, scrollRef.current);
        else engine.scrollToIndex(index, { align: 'start', behavior: 'auto' });
        notify.current();
      }).catch(() => { if (command.current === active) finish('source-unavailable', 'preparation'); });
    });
  }, [cancel, engine, finish, mountedStart, alignRegistered]);
  const schedulePersist = useCallback(() => {
    if (persistFrame.current !== null) return;
    persistFrame.current = requestAnimationFrame(() => { persistFrame.current = null; if (!engine.isScrolling) persist(engine); });
  }, [engine, persist]);
  const register = useCallback((registration: ReadingTargetRegistration) => {
    const key = targetRegistrationKey(registration.coordinate, registration.rowKey);
    targets.current.set(key, registration);
    notify.current(); schedulePersist();
    return () => { if (targets.current.get(key) === registration) targets.current.delete(key); };
  }, [schedulePersist]);
  const rowOffset = useCallback((key: string): number | undefined => {
    const row = rowBoxes.current.get(key);
    const scroll = scrollRef.current;
    return row && scroll ? row.getBoundingClientRect().top - scroll.getBoundingClientRect().top : undefined;
  }, []);
  const pinDisclosure = useCallback((key: string, trigger?: HTMLElement) => {
    const row = rowBoxes.current.get(key); const scroller = scrollRef.current;
    if (!row || !scroller || !trigger || !row.contains(trigger) || !current.current.applied) return;
    cancel(); userScroll.current = false; restore.current = null;
    const boundary = trigger.closest<HTMLElement>('[data-reading-disclosure],details') ?? trigger;
    const visible = captureReadingDomAnchor(scroller, rowBoxes.current, current.current.applied.rowMembers, current.current.clearance);
    const protectedKeys = new Set([...(visible?.protectedKeys ?? []), key]);
    const pin = captureDisclosureDomAnchor(key, row, boundary, scroller, current.current.applied.rowMembers.get(key) ?? [key], protectedKeys);
    pin.disclosureEnd = Boolean(current.current.applied.rows.find(row => row.key === key)?.disclosureEnd);
    pin.disclosureRevision = disclosureRevision(current.current.applied.rows.find(row => row.key === key));
    pin.offset = pinPosition(pin) ?? pin.offset;
    readerPin.current = pin;
    disclosureKey.current = key;
    setPinKeys(protectedKeys);
  }, [cancel, pinPosition]);
  capturePin.current = () => {
    const snapshot = current.current; const scroller = scrollRef.current;
    if (!scroller || !snapshot.applied || command.current || readback.current || userScroll.current || drag.current || engine.isScrolling || following.current || readerPin.current) return;
    const pin = captureReadingDomAnchor(scroller, rowBoxes.current, snapshot.applied.rowMembers, snapshot.clearance);
    if (pin) { readerPin.current = pin; setPinKeys(pin.protectedKeys); }
  };
  correctLocal.current = () => {
    const scroller = scrollRef.current;
    if (!scroller || !current.current.applied || userScroll.current || drag.current || (command.current && command.current.phase !== 'end' && !command.current.preserveReaderPin)) return;
    if (following.current && readerPin.current?.edge !== 'bottom') {
      if (resumeTailAfter.current === current.current.applied) return;
      resumeTailAfter.current = null;
      if (Math.abs(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop) > 0.05) engine.scrollToEnd({ behavior: 'auto' });
      return;
    }
    const pin = readerPin.current; const row = pin && rowBoxes.current.get(pin.key);
    if (!pin || !row) return;
    const delta = (pinPosition(pin) ?? pin.offset) - pin.offset;
    if (Math.abs(delta) > 0.05) engine.scrollToOffset(scroller.scrollTop + delta, { align: 'start', behavior: 'auto' });
  };
  useLayoutEffect(() => { correctLocal.current(); capturePin.current(); });
  const registerRow = useCallback((key: string, element: HTMLElement) => {
    rowBoxes.current.set(key, element);
    if (!localObserver.current && typeof ResizeObserver !== 'undefined') localObserver.current = new ResizeObserver(() => correctLocal.current());
    localObserver.current?.observe(element);
    return () => { localObserver.current?.unobserve(element); if (rowBoxes.current.get(key) === element) rowBoxes.current.delete(key); };
  }, []);
  useEffect(() => () => localObserver.current?.disconnect(), []);
  applyPending.current = () => {
    const next = pending.current;
    if (engine.isScrolling || drag.current || readback.current || (applied && applied !== indexed)) return;
    if (!next || next === applied) {
      if (chromePending.current && !command.current) { chromePending.current = false; if (following.current) engine.scrollToEnd({ behavior: 'auto' }); }
      return;
    }
    chromePending.current = false;
    const scroller = scrollRef.current;
    capturePin.current();
    const first = firstVisible(engine);
    restore.current = applied && applied.scope === next.scope
      ? following.current ? { kind: 'end' }
        : first && scroller ? { kind: 'row', key: String(first.key), members: applied.rowMembers.get(String(first.key)) ?? [String(first.key)], offset: (mountedStart(String(first.key)) ?? first.start) - scroller.scrollTop } : null
      : null;
    pending.current = null;
    setApplied(next);
  };
  useLayoutEffect(() => {
    if (previousClearance.current !== input.clearance) { previousClearance.current = input.clearance; chromePending.current = true; }
    pending.current = input.geometry;
    if (!input.geometry) { setApplied(null); return; }
    applyPending.current();
  }, [input.geometry, input.clearance]);
  useLayoutEffect(() => {
    if (!applied) { setIndexed(null); return; }
    engine.measure();
    // Offset lookup reads the built index; measure() only invalidates it.
    engine.getTotalSize();
    setIndexed(applied);
  }, [applied, engine]);
  useLayoutEffect(() => {
    if (!applied || indexed !== applied) return;
    const saved = restore.current; restore.current = null;
    readback.current = applied;
    if (readerPin.current?.edge === 'bottom' && !command.current && scrollRef.current) {
      const pin = readerPin.current;
      engine.scrollToOffset(scrollRef.current.scrollTop + (pinPosition(pin) ?? pin.offset) - pin.offset, { align: 'start', behavior: 'auto' });
    } else if (following.current && resumeTailAfter.current !== applied && (command.current?.phase === 'end' || (saved?.kind === 'end' && !command.current))) engine.scrollToEnd({ behavior: 'auto' });
    else if (saved?.kind === 'row' && !command.current) {
      const pin = readerPin.current;
      const anchor = pin ?? saved;
      const key = indices.has(anchor.key) ? anchor.key : anchor.members.flatMap(member => applied.membership.get(member)?.rowKey ?? []).find(key => indices.has(key));
      const index = key === undefined ? -1 : indices.get(key)!;
      const row = key ? rowBoxes.current.get(key) : undefined;
      const offset = key ? mountedStart(key) ?? (index >= 0 ? engine.getOffsetForIndex(index, 'start')?.[0] : undefined) : undefined;
      if (offset !== undefined) engine.scrollToOffset(pin && row
        ? offset + readingDomAnchorOffset(pin, row) - pin.offset
        : offset - attainableRowOffset(saved.offset, applied.sizes[index], scrollRef.current?.clientHeight ?? 0), { align: 'start', behavior: 'auto' });
    }
    acknowledge.current();
    requestAnimationFrame(() => acknowledge.current());
    notify.current();
  }, [indexed, applied, engine]);
  acknowledge.current = () => {
    const snapshot = current.current;
    const ready = readback.current;
    const scroller = scrollRef.current;
    if (!ready || ready !== snapshot.applied || ready !== snapshot.indexed || !scroller
      || (engine.scrollOffset !== null && Math.abs(engine.scrollOffset - scroller.scrollTop) > 1)) return;
    // The native offset has been observed: only now may custody follow the new range.
    readback.current = null;
    const pin = readerPin.current;
    if (ready.exact && pin?.edge === 'bottom' && disclosureRevision(ready.rows.find(row => row.key === pin.key)) !== pin.disclosureRevision) {
      const position = pinPosition(pin);
      if (position !== undefined) {
        const wanted = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, scroller.scrollTop + position - pin.offset));
        if (Math.abs(wanted - scroller.scrollTop) > 0.5) {
          readback.current = ready;
          engine.scrollToOffset(wanted, { align: 'start', behavior: 'auto' });
          return;
        }
      }
      readerPin.current = following.current ? null : captureReadingDomAnchor(scroller, rowBoxes.current, ready.rowMembers, snapshot.clearance);
      if (following.current) resumeTailAfter.current = ready;
      setPinKeys(new Set([...(readerPin.current?.protectedKeys ?? []), pin.key]));
    }
    engine.getVirtualItems();
    snapshot.onApplied(ready.rows); setAcknowledged(ready);
    lastRange.current = '';
    publishDemand.current(engine);
    capturePin.current(); applyPending.current();
  };
  publishDemand.current = instance => {
    const snapshot = current.current;
    const vector = snapshot.applied;
    const scroller = scrollRef.current;
    if (!vector || vector.scope !== snapshot.geometry?.scope || vector !== snapshot.indexed || readback.current || !scroller || !instance.range) return;
    const height = scroller.clientHeight;
    if (height <= 0) return;
    const start = Math.max(0, scroller.scrollTop - height);
    const end = Math.min(instance.getTotalSize(), scroller.scrollTop + 2 * height);
    const first = instance.getVirtualItemForOffset(start)?.index;
    const last = instance.getVirtualItemForOffset(end)?.index;
    const required = instance.getVirtualItems().map(item => vector.rows[item.index]).filter(Boolean);
    const prefetch = first === undefined || last === undefined ? [] : vector.rows.slice(first, last + 1);
    const identity = JSON.stringify([snapshot.scope, snapshot.positionSpaceId, vector.serial, first, last, height, required, prefetch]);
    if (identity === lastRange.current) return;
    lastRange.current = identity;
    snapshot.onRange({ vector: vector.rows, required, prefetch, start, end, height });
  };
  useLayoutEffect(() => { publishDemand.current(engine); }, [input.protectedKeys, pinKeys, indexed, applied, engine]);
  useEffect(() => {
    const scope = input.scope;
    const save = () => {
      if (current.current.scope === scope) persist(engine);
      else if (lifecycleState.current?.scope === scope) writeReadingState(scope, lifecycleState.current.value);
    };
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', save);
    return () => { save(); cancel(); window.removeEventListener('pagehide', save); document.removeEventListener('visibilitychange', save); };
  }, [input.scope, engine, persist, cancel]);
  useEffect(() => { if (!engine.isScrolling) persist(engine); }, [input.disclosures, engine, persist]);
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); if (persistFrame.current !== null) cancelAnimationFrame(persistFrame.current); }, []);
  const inputCancel = useCallback(() => { current.current.onInput(); userScroll.current = true; restore.current = null; readerPin.current = null; disclosureKey.current = null; resumeTailAfter.current = null; setPinKeys(new Set()); cancel(); }, [cancel]);
  const onKeyDown = useCallback((event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return;
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) { drag.current = true; inputCancel(); }
  }, [inputCancel]);
  const onPointerDown = useCallback((event: PointerEvent) => {
    const el = scrollRef.current;
    if (el && (event.target === el || event.clientX >= el.getBoundingClientRect().left + el.clientWidth)) { drag.current = true; inputCancel(); }
  }, [inputCancel]);
  useEffect(() => { readerPin.current = null; disclosureKey.current = null; resumeTailAfter.current = null; readback.current = null; setPinKeys(new Set()); following.current = true; userScroll.current = false; return () => cancel(); }, [input.positionSpaceId, input.scope, cancel]);
  useEffect(() => {
    const release = () => { drag.current = false; applyPending.current(); };
    window.addEventListener('pointerup', release); window.addEventListener('pointercancel', release); window.addEventListener('keyup', release); window.addEventListener('blur', release);
    return () => { window.removeEventListener('pointerup', release); window.removeEventListener('pointercancel', release); window.removeEventListener('keyup', release); window.removeEventListener('blur', release); };
  }, []);
  const mounted = engine.getVirtualItems();
  const last = mounted[mounted.length - 1];
  const endOffset = last?.index === rows.length - 1 ? engine.getTotalSize() - last.end : undefined;
  return { captureReaderAnchor: () => capturePin.current(), beginLayout: () => capturePin.current(), pinDisclosure, engine, rows, endOffset, appliedGeometry: acknowledged === applied ? applied : null, focusTarget: (target: ConversationSourceCoordinate) => {
    const owner = completedTarget.current;
    if (!owner || owner.coordinate.conversationId !== current.current.scope || owner.coordinate.positionSpaceId !== current.current.positionSpaceId
      || (current.current.commandToken !== undefined && owner.token !== current.current.commandToken)
      || targetCoordinateKey(owner.coordinate) !== targetCoordinateKey(target)) return;
    targets.current.get(targetRegistrationKey(target, owner.rowKey))?.element?.focus({ preventScroll: true });
  }, renderProps: applied?.renderProps, scrollRef, register, registerRow, rowOffset, reveal, cancel, showLatest,
    inputHandlers: { onWheel: inputCancel, onTouchStart: () => { drag.current = true; inputCancel(); }, onTouchEnd: () => { drag.current = false; applyPending.current(); }, onTouchCancel: () => { drag.current = false; applyPending.current(); }, onKeyDown, onPointerDown } };
}
