import { readingMemberKeys, readingSpeaker } from '../../../src/conversations/reading-context';
import { Icon } from '../components/icons/Icon';
import type { JSX } from 'preact/jsx-runtime';
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ConsoleBackendType, ConsolePermissionDecision, ConsolePermissionRequest } from '../api';
import { exportConversationBlocks } from '../api';
import type { CanonicalChatItemEvent, PersistedBlockSource, StreamRendererProps } from '../components/stream-renderer/types';
import { MessageLinkContext, type MessagePrimaryAction } from '../components/shared/MessageActions';
import { DetailPaneOverlayContext } from '../components/shared/DetailPaneShell';
import type { ConversationNavigationCommand, ConversationNavigationResult, ConversationTranscriptConsumer, ConversationSourceCoordinate } from '../query/conversationData';
import { projectReadingRows, type ReadingRow, type ReadingTargetRegistration } from './readingProjection';
import { ReadingRowBody, ReadingRowFrame } from './ReadingRowView';
import { useReadingViewport } from './useReadingViewport';
import { readReadingState } from './readingState';
import { openMarkdownSource } from './markdownActions';
import { buildStreamState, serializeDisplayGroupToMarkdown } from './renderModel';
export type ChatSurfaceProps = StreamRendererProps & {
  showEmpty?: boolean;
  activePermissionRequest?: ConsolePermissionRequest | null;
  permissionBackendType?: ConsoleBackendType;
  onPermissionRespond?: (id: string, decision: ConsolePermissionDecision) => void | Promise<void>;
  unmaterializedAfterCount?: number;
  onJumpToLatest?: () => void | Promise<void>;
  jumpingToLatest?: boolean;
  transcript?: ConversationTranscriptConsumer;
  navigationTarget?: ConversationNavigationCommand | null;
  onNavigationResult?: (result: ConversationNavigationResult) => void;
  selectedBlockIds?: ReadonlySet<string>;
  selectMode?: boolean;
  onToggleBlockSelect?: (blockId: string, shiftKey: boolean) => void;
  onFork?: (dagUuid: string) => void;
  onResume?: (dagUuid: string) => void;
  onCreatedTaskNavigate?: (providerSessionId: string) => void | Promise<void>;
  onExpandDetails?: (sources: readonly PersistedBlockSource[]) => void | Promise<void>;
  onCopyMessageLink?: (blockId: string) => void;
};


type BoxProps = { row: ReadingRow; index: number; measure: (node: HTMLDivElement | null) => void;
  register: (target: ReadingTargetRegistration) => () => void; registerRow: (key: string, element: HTMLElement) => () => void; scope: string; space: string;
  children: JSX.Element; };
function MeasuredReadingBox({ row, index, measure, register, registerRow, scope, space, children }: BoxProps): JSX.Element {
  const element = useRef<HTMLDivElement | null>(null);
  const setNode = useCallback((node: HTMLDivElement | null) => { element.current = node; measure(node); }, [measure]);
  useLayoutEffect(() => {
    const box = element.current;
    if (!box) return;
    const disposeRow = registerRow(row.key, box);
    const dispose = row.sources.map(source => {
      if (source.position === undefined) return () => {};
      const exact = row.kind === 'activity-summary' ? box : [...box.querySelectorAll<HTMLElement>('[data-block-id]')].find(node => node.dataset.blockId === source.blockId) ?? null;
      if (exact) exact.tabIndex = -1;
      const coordinate = { conversationId: scope, positionSpaceId: space, position: source.position };
      const clearDefault = row.activityGroup?.expanded ? () => {} : register({ rowKey: row.key, coordinate, element: exact });
      const clearSubtarget = register({ rowKey: row.key, coordinate: { ...coordinate, subtarget: row.kind === 'activity-summary' ? 'summary' : `source:${source.position}` }, element: exact });
      return () => { clearDefault(); clearSubtarget(); };
    });
    return () => { disposeRow(); dispose.forEach(dispose => dispose()); };
  }, [row, scope, space, register, registerRow, children]);
  return <ReadingRowFrame row={row} index={index} elementRef={setNode}>{children}</ReadingRowFrame>;
}
const boundDisclosures = (value: Record<string, boolean>): Record<string, boolean> => Object.fromEntries(Object.entries(value).slice(-100));

export function ChatSurface(props: ChatSurfaceProps): JSX.Element {
  const { events, transcript, onNavigationResult } = props;
  const navigationTarget = transcript?.command ?? props.navigationTarget;
  const scope = transcript?.conversationId ?? props.sessionInfo?.sessionId ?? 'default';
  const space = transcript?.positionSpaceId ?? '';
  const overlay = useContext(DetailPaneOverlayContext);
  const initialState = useMemo(() => readReadingState(scope), [scope]);
  const [expandedBlocks, setExpandedBlocks] = useState<Record<string, boolean>>(() => initialState?.positionSpaceId === space ? initialState.disclosures : {});
  const [notice, setNotice] = useState<string | null>(null);
  const projection = useMemo(() => projectReadingRows({ events, conversationId: scope, positionSpaceId: space,
    readingContext: transcript?.readingContext ?? new Map(), displayContext: transcript?.displayContext,
    expanded: expandedBlocks, streaming: props.streaming }), [events, scope, space, transcript?.readingContext, transcript?.displayContext, expandedBlocks, props.streaming]);
  const readingRows = useMemo<ReadingRow[]>(() => props.activePermissionRequest && props.onPermissionRespond
    ? [...projection.rows, { key: `permission:${props.activePermissionRequest.id}`, kind: 'permission', protectedPositions: [], items: [], nodes: [], sources: [], actionGroup: { key: 'permission', start: null, end: null }, disclosureOwner: null, turnStart: true, turnEnd: true }] : projection.rows, [projection.rows, props.activePermissionRequest, props.onPermissionRespond]);
  const latest = useRef({ projection, transcript, props }); latest.current = { projection, transcript, props };
  const waiting = useRef(new Set<() => void>());
  const protectedRegions = useRef<Array<{ start: number; end: number }>>([]);
  const demand = useRef<{ key: string; pending: boolean } | null>(null);
  const waitFor = useCallback((test: () => boolean, signal: AbortSignal): Promise<boolean> => {
    if (signal.aborted) return Promise.resolve(false);
    if (test()) return Promise.resolve(true);
    return new Promise(resolve => {
      const done = (value: boolean) => { waiting.current.delete(check); signal.removeEventListener('abort', abort); resolve(value); };
      const check = () => { if (test()) done(true); };
      const abort = () => done(false);
      waiting.current.add(check); signal.addEventListener('abort', abort, { once: true });
    });
  }, []);
  const prepare = useCallback(async (target: ConversationSourceCoordinate, signal: AbortSignal, token: string) => {
    const current = latest.current;
    if (current.transcript?.positionSpaceId !== target.positionSpaceId) return { status: 'position-space-changed' as const };
    if (!current.projection.membership.has(target.position)) {
      const result = await current.transcript?.replaceAround(target, signal, token);
      if (result !== 'loaded' && result !== 'covered') return { status: result === 'position-space-changed' ? 'position-space-changed' as const : 'source-unavailable' as const };
      await waitFor(() => Boolean(latest.current.transcript?.activeWindow && target.position >= latest.current.transcript.activeWindow.start && target.position <= latest.current.transcript.activeWindow.end), signal);
    }
    if (signal.aborted) return { status: 'source-unavailable' as const };
    const member = latest.current.projection.membership.get(target.position);
    if (!member) return { status: 'not-renderable' as const };
    if (target.subtarget === 'summary') return { status: 'prepared' as const, rowKey: member.summaryRowKey ?? member.rowKey };
    setExpandedBlocks(current => boundDisclosures({ ...current, ...Object.fromEntries(member.disclosurePath.map(owner => [`group:${owner}`, true])), [`reveal:${target.position}`]: true }));
    await latest.current.transcript?.prepareDetails(member.detailSources.filter(source => source.detailsLoaded === false), signal);
    await waitFor(() => {
      const member = latest.current.projection.membership.get(target.position);
      return Boolean(member && member.disclosurePath.length === 0 && member.detailSources.every(source => source.detailsLoaded !== false));
    }, signal);
    const prepared = latest.current.projection.membership.get(target.position);
    return prepared ? { status: 'prepared' as const, rowKey: prepared.rowKey } : { status: 'not-renderable' as const };
  }, [waitFor]);
  const onRange = useCallback((start: number, end: number) => {
    const { projection, transcript, props } = latest.current;
    if (!transcript) return;
    const regions = projection.rows.slice(start, end + 1).flatMap(row => row.protectedPositions.map(position => ({ start: position, end: position })));
    const focused = document.activeElement;
    const selection = document.getSelection();
    const boxes = [focused, selection?.anchorNode, selection?.focusNode].flatMap(node => {
      const element = node instanceof Element ? node : node?.parentElement;
      const box = element?.closest<HTMLElement>('[data-reading-key]');
      return box ? [box] : [];
    });
    for (const box of boxes) {
      const row = projection.rows[Number(box.dataset.index)];
      if (row) regions.push(...row.sources.flatMap(source => source.position === undefined ? [] : [{ start: source.position, end: source.position }]));
    }
    for (const blockId of props.selectedBlockIds ?? []) {
      const position = Number(blockId.slice(blockId.lastIndexOf(':') + 1));
      if (Number.isSafeInteger(position) && projection.membership.has(position)) regions.push({ start: position, end: position });
    }
    const active = transcript.activeWindow;
    // Lazy owner shells have source identities outside the retained history span.
    // Their bodies are protected by display context, independently of history retention.
    const retainedRegions = active ? regions.filter(region => region.start >= active.start && region.end <= active.end) : [];
    protectedRegions.current = retainedRegions;
    transcript.protect(retainedRegions);
    const direction = start === 0 && transcript.hasOlder ? 'older' : end >= projection.rows.length - 1 && transcript.hasNewer ? 'newer' : null;
    if (!direction || transcript.historyLoading || (transcript.command && projection.rows.length > 0)) return;
    const key = `${transcript.activeWindow?.start}:${transcript.activeWindow?.end}:${direction}`;
    if (demand.current?.pending || demand.current?.key === key) return;
    demand.current = { key, pending: true };
    queueMicrotask(() => {
      void Promise.resolve(direction === 'older' ? transcript.loadOlder() : transcript.loadNewer()).then(result => {
        if (demand.current?.key === key) demand.current.pending = false;
        if (result === 'busy' || result === 'cancelled') demand.current = null;
      });
    });
  }, []);
  const disclosures = expandedBlocks;
  const viewport = useReadingViewport({ scope, positionSpaceId: space, onInput: () => latest.current.transcript?.cancelNavigation(), commandToken: navigationTarget?.key, initializing: transcript?.navigationPending, clearance: Math.max(16, overlay?.scrollClearance ?? 0), membership: projection.viewMembership, rows: readingRows, endReached: !transcript?.hasNewer, disclosures, prepare, onRange });
  useLayoutEffect(() => {
    for (const check of [...waiting.current]) check();
    onRange(viewport.engine.range?.startIndex ?? 0, viewport.engine.range?.endIndex ?? 0);
  }, [projection, transcript?.activeWindow, transcript?.hasOlder, transcript?.hasNewer, transcript?.command, onRange, viewport.engine]);
  const setScrollNode = useCallback((node: HTMLDivElement | null) => { viewport.scrollRef.current = node; }, [viewport.scrollRef]);
  useEffect(() => {
    overlay?.registerScrollOwner(viewport.scrollRef.current);
    return () => overlay?.registerScrollOwner(null);
  }, [overlay?.registerScrollOwner]);
  useEffect(() => {
    const protect = () => onRange(viewport.engine.range?.startIndex ?? 0, viewport.engine.range?.endIndex ?? 0);
    const scroller = viewport.scrollRef.current;
    document.addEventListener('selectionchange', protect);
    scroller?.addEventListener('focusin', protect);
    return () => { document.removeEventListener('selectionchange', protect); scroller?.removeEventListener('focusin', protect); };
  }, [onRange, viewport.engine]);
  const handled = useRef<string | null>(null);
  useEffect(() => { handled.current = null; demand.current = null; setNotice(null); const saved = readReadingState(scope); setExpandedBlocks(saved?.positionSpaceId === space ? saved.disclosures : {}); }, [scope, space]);
  useEffect(() => {
    if (!navigationTarget || handled.current === navigationTarget.key) return;
    if (!projection.rows.length) {
      if ((navigationTarget.kind === 'initial' || navigationTarget.kind === 'latest') && transcript?.total !== 0) return;
      if (navigationTarget.kind !== 'initial' && navigationTarget.kind !== 'latest') {
        handled.current = navigationTarget.key;
        onNavigationResult?.({ key: navigationTarget.key, status: 'not-renderable' });
        return;
      }
    }
    handled.current = navigationTarget.key;
    setNotice(null);

    const target = navigationTarget.target;
    const end = navigationTarget.kind === 'latest' || navigationTarget.kind === 'initial';
    if (!target && !end) { onNavigationResult?.({ key: navigationTarget.key, status: 'not-renderable' }); return; }
    void viewport.reveal(end ? { token: navigationTarget.key, end: true } : { token: navigationTarget.key, target: target! }).then(result => {
      if (result.status !== 'revealed' && result.status !== 'cancelled') setNotice(`Reading target: ${result.status}.`);
      onNavigationResult?.({ key: result.token, status: result.status });
    });
  }, [navigationTarget, projection, viewport.reveal, viewport.engine, viewport.cancel, onNavigationResult]);

  const setBlockExpanded = useCallback((key: string, value: boolean, sources: readonly (PersistedBlockSource | undefined)[] = []) => {
    if (value) void latest.current.props.onExpandDetails?.(sources.filter((source): source is PersistedBlockSource => source?.detailsLoaded === false));
    setExpandedBlocks(current => current[key] === value && !sources.some(source => current[`reveal:${source?.position}`]) ? current : boundDisclosures({ ...current, ...Object.fromEntries(sources.filter(Boolean).map(source => [`reveal:${source!.position}`, false])), [key]: value }));
  }, []);
  const exportRow = useCallback(async (row: ReadingRow) => {
    const current = latest.current;
    const run = current.projection.actionRuns.get(row.actionGroup.key);
    if (!run) throw new Error('The action scope is no longer available.');
    const serialize = (events: readonly CanonicalChatItemEvent[]) => serializeDisplayGroupToMarkdown({
      id: run.group.key, nodes: buildStreamState([...events], true).nodes,
      speaker: readingSpeaker(events[0]?.item.role ?? 'assistant'), meta: {},
    });
    if (run.group.start === null || !current.transcript?.positionSpaceId) return serialize(run.events);
    const provisional = run.events.filter(event => event.source?.position === undefined);
    const result = await exportConversationBlocks(scope, { format: 'markdown', speaker_run_start: run.group.start,
      expected_position_space_id: current.transcript.positionSpaceId });
    const covered = new Set(result.covered_member_keys);
    const pending = provisional.filter(event => !readingMemberKeys(event.item,
      event.intentId ?? (event.displayKey?.startsWith('intent:') ? event.displayKey.slice(7) : undefined)).some(key => covered.has(key)));
    return [result.content, serialize(pending)].filter(Boolean).join('\n\n');
  }, [scope]);
  const actions = useMemo(() => new Map(projection.rows.map(row => {
    const turnId = projection.actionRuns.get(row.actionGroup.key)?.events.find(event => event.item.role === 'assistant' && event.item.identity.native_turn_id)?.item.identity.native_turn_id
      ?? [...row.nodes, ...(row.activityGroup?.items ?? [])].flatMap(node => node.kind === 'assistant_turn' ? [node.turn.id]
        : node.kind === 'activity' && node.item.type !== 'activity' ? [node.item.turnId] : []).find((id): id is string => id !== undefined);
    return [row.key, [
    { id: 'copy-group', title: 'Copy all', label: 'Copy all messages', icon: 'copyMessage' as const, onAction: () => {
      const content = exportRow(row);
      const copy = typeof ClipboardItem !== 'undefined' && navigator.clipboard.write
        ? navigator.clipboard.write([new ClipboardItem({ 'text/plain': content.then(text => new Blob([text], { type: 'text/plain' })) })])
        : content.then(text => navigator.clipboard.writeText(text));
      void copy.catch(() => setNotice('Could not copy messages.'));
    } },
    { id: 'open-group-markdown', title: 'Open markdown', label: 'Open turn as markdown', icon: 'openMarkdown' as const,
      onAction: () => { void openMarkdownSource(exportRow(row)).catch(() => setNotice('Could not open turn.')); } },
    ...(props.onSelectMessageInfo && turnId ? [{
      id: 'select-group', title: props.selectedMessageId === turnId ? 'Deselect' : 'Select',
      label: props.selectedMessageId === turnId ? 'Deselect turn' : 'Select turn',
      icon: props.selectedMessageId === turnId ? 'messageSelected' as const : 'selectMessage' as const,
      onAction: () => props.onSelectMessageInfo!(turnId!),
    }] : []),
  ] as MessagePrimaryAction[]] as const;
  })), [projection.rows, projection.actionRuns, exportRow, props.onSelectMessageInfo, props.selectedMessageId]);
  const revealDisclosure = (row: ReadingRow, next: boolean) => {
    const position = row.sources[0]?.position;
    const offset = viewport.rowOffset(row.key) ?? 0;
    setExpandedBlocks(current => boundDisclosures({ ...current, [`group:${row.disclosureOwner}`]: next }));
    if (position !== undefined) void viewport.reveal({ token: `disclosure:${crypto.randomUUID()}`, target: { conversationId: scope, positionSpaceId: space, position, offset,
      subtarget: 'summary' } }).then(result => { if (result.status !== 'revealed' && result.status !== 'cancelled') setNotice(`Reading target: ${result.status}.`); });
  };
  const jump = () => { viewport.cancel(); if (props.onJumpToLatest) void props.onJumpToLatest(); else void viewport.reveal({ token: `latest:${crypto.randomUUID()}`, end: true }); };
  return <MessageLinkContext.Provider value={props.onCopyMessageLink ?? null}>
    <div className="stream-renderer">
      <div ref={setScrollNode} className="stream-renderer__scroll" tabIndex={0} aria-label="Conversation" {...viewport.inputHandlers}>
        <div ref={viewport.engine.containerRef} className="stream-renderer__virtual-canvas">
          {viewport.engine.getVirtualItems().map(item => {
            const row = readingRows[item.index];
            if (!row) return null;
            return <MeasuredReadingBox key={row.key} row={row} index={item.index} measure={viewport.engine.measureElement} register={viewport.register} registerRow={viewport.registerRow} scope={scope} space={space}>
              <ReadingRowBody {...props} row={row} expandedBlocks={expandedBlocks} setBlockExpanded={setBlockExpanded}
                preparing={row.sources.some(source => expandedBlocks[`reveal:${source.position}`])}
                primaryActions={actions.get(row.key) ?? []} lastAssistantTurnId={projection.lastAssistantTurnId}
                onActivityGroupExpandedChange={next => revealDisclosure(row, next)} />
            </MeasuredReadingBox>;
          })}
        </div>
        {!readingRows.length && <div className="stream-renderer__empty">{props.showEmpty ? props.emptyLabel ?? 'No messages yet' : 'Loading conversation…'}</div>}
      </div>
      {events.some(event => event.type === 'chat:item' && event.persistencePending) && <div role="status">Some content is awaiting confirmation from saved history.</div>}
      {notice && <div className="stream-renderer__history-error" role="alert">{notice}<button type="button" onClick={() => { demand.current = null; setNotice(null); onRange(0, projection.rows.length - 1); }}>Retry</button></div>}
      {viewport.showLatest && <button type="button" className="chat-circle-action stream-renderer__scroll-btn" aria-label="Jump to latest" title="Jump to latest" disabled={props.jumpingToLatest} aria-busy={props.jumpingToLatest ? "true" : "false"} onClick={jump}><Icon name="jumpToLatest" /></button>}
    </div>
  </MessageLinkContext.Provider>;
}
