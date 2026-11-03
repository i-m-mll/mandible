import { readingMemberKeys, readingSpeaker } from '../../../src/conversations/reading-context';
import { DetailPaneNotice } from '../components/shared/DetailPaneNotice';
import { OverflowTopFade } from '../components/shared/OverflowFade';
import { AppearanceSettingsContext } from '../appearance-settings';
import { Icon } from '../components/icons/Icon';
import type { JSX } from 'preact/jsx-runtime';
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ConsoleBackendType, ConsolePermissionDecision, ConsolePermissionRequest } from '../api';
import { exportConversationBlocks } from '../api';
import type { CanonicalChatItemEvent, PersistedBlockSource, StreamRendererProps } from '../components/stream-renderer/types';
import { MessageLinkContext } from '../components/shared/MessageActions';
import { DetailPaneOverlayContext } from '../components/shared/DetailPaneShell';
import type { ConversationNavigationCommand, ConversationNavigationResult, ConversationTranscriptConsumer, ConversationSourceCoordinate } from '../query/conversationData';
import { projectReadingRows, type ReadingRow, type ReadingProjection } from './readingProjection';
import { ReadingRowBody } from './ReadingRowView';
import { MeasuredReadingBox, ReadingRowStrip } from './ReadingRowWindow';
import { readingRowPrimaryActions, readingRowTurnId } from './readingRowActions';
import { useCompleteReading, readingPayloadKey } from './useCompleteReading';
import { useReadingGeometry } from './useReadingGeometry';
import { getReadingResizeScale } from './readingResizeProfile';
import { useReadingViewport, type ReadingSummaryTarget } from './useReadingViewport';
import { readingNavigationObserver, type ReadingNavigationOrigin } from './readingNavigationObservation';
import { readingNavigationFailureMessage } from './readingNavigationMessage';
import { readReadingState, type ReadingRestore } from './readingState';
import { openMarkdownSource } from './markdownActions';
import { buildStreamState, serializeDisplayGroupToMarkdown } from './renderModel';
export type ChatSurfaceProps = StreamRendererProps & {
  showEmpty?: boolean;
  readingRestore?: ReadingRestore;
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
  onExpandDetails?: (sources: readonly PersistedBlockSource[]) => void | Promise<void>;
  onCopyMessageLink?: (blockId: string) => void;
};


const emptyProjection: ReadingProjection = { rows: [], membership: new Map(), viewMembership: new Map(), actionRuns: new Map() };
const boundDisclosures = (value: Record<string, boolean>): Record<string, boolean> => Object.fromEntries(Object.entries(value).slice(-100));

export function ChatSurface(props: ChatSurfaceProps): JSX.Element {
  const { events, transcript, onNavigationResult } = props;
  const navigationTarget = transcript?.command ?? props.navigationTarget;
  const scope = transcript?.conversationId ?? props.sessionInfo?.sessionId ?? 'default';
  const space = transcript?.positionSpaceId ?? '';
  const observeNavigation = useMemo(() => readingNavigationObserver(), []);
  const appearance = useContext(AppearanceSettingsContext);
  const overlay = useContext(DetailPaneOverlayContext);
  const clearance = Math.max(16, overlay?.scrollClearance ?? 0);
  const handled = useRef<string | null>(null);
  const restoredRow = useRef(false);
  const appliedRows = useRef<readonly import('./readingMeasurement').MeasurementRow[]>([]);
  const focusAfterInitial = useRef<ConversationSourceCoordinate | null>(null);
  const initialState = useMemo(() => readReadingState(scope), [scope]);
  const [expandedBlocks, setExpandedBlocks] = useState<Record<string, boolean>>(() => initialState?.positionSpaceId === space ? initialState.disclosures : {});
  const [protectedRows, setProtectedRows] = useState<ReadonlySet<string>>(new Set());
  const [disclosureRevisions, setDisclosureRevisions] = useState<Record<string, number>>({});
  const [initialVisible, setInitialVisible] = useState(false);
  const [initialNavigationDone, setInitialNavigationDone] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const projection = useMemo(() => transcript ? emptyProjection : projectReadingRows({ events, conversationId: scope, positionSpaceId: space,
    readingContext: new Map(),
    expanded: expandedBlocks, streaming: props.streaming }), [events, scope, space, Boolean(transcript), expandedBlocks, props.streaming]);
  const extraRows = useMemo<Array<ReadingRow & { revision: string }>>(() => props.activePermissionRequest && props.onPermissionRespond
    ? [{ key: `permission:${props.activePermissionRequest.id}`, revision: JSON.stringify(props.activePermissionRequest), kind: 'permission', isFinalResponse: false, protectedPositions: [], items: [], nodes: [], sources: [], actionGroup: { key: 'permission', start: null, end: null }, disclosureOwner: null, turnStart: true, turnEnd: true }] : [], [props.activePermissionRequest, props.onPermissionRespond]);
  const localRestore = !restoredRow.current ? props.readingRestore : undefined;
  const complete = useCompleteReading({ scope, space, events, initial: !initialVisible, targetPosition: localRestore?.anchor.position ?? navigationTarget?.target?.position, targetRowKey: localRestore?.anchor.rowKey, targetMemberKey: localRestore?.anchor.memberKey, targetSummary: navigationTarget?.target?.subtarget === 'summary', sourceVersion: transcript?.sourceVersionId, total: transcript?.total,
    actionIdentity: JSON.stringify([Boolean(props.onSelectMessageInfo), Boolean(props.onCopyMessageLink)]), selectMode: props.selectMode, selectedBlockIds: props.selectedBlockIds, extraRows, expanded: expandedBlocks, disclosureRevisions, streaming: props.streaming, local: projection, enabled: Boolean(transcript) });
  const requiredTarget = localRestore ? undefined : navigationTarget?.target;
  const requiredMember = requiredTarget && requiredTarget.positionSpaceId === space ? complete.plan?.membership.get(requiredTarget.position) : undefined;
  const initialDisclosurePending = Boolean(handled.current !== navigationTarget?.key && requiredMember && requiredTarget?.subtarget !== 'summary'
    && (requiredMember.disclosurePath.length || !expandedBlocks[`reveal:${requiredTarget!.position}`] || requiredMember.detailKeys?.some(key => !expandedBlocks[key])));
  useEffect(() => {
    if (!requiredMember || !requiredTarget || requiredTarget.subtarget === 'summary' || !initialDisclosurePending) return;
    setExpandedBlocks(current => boundDisclosures({ ...current,
      ...Object.fromEntries(requiredMember.disclosurePath.map(owner => [`group:${owner}`, true])), ...Object.fromEntries((requiredMember.detailKeys ?? []).map(key => [key, true])), [`reveal:${requiredTarget.position}`]: true }));
  }, [requiredMember, requiredTarget, initialDisclosurePending]);
  const [scrollNode, setScrollElement] = useState<HTMLDivElement | null>(null);
  const layoutChange = useRef<() => void>(() => {});
  const geometry = useReadingGeometry({ scope: `${scope}:${space}`, chrome: 32 + clearance, onLayoutChange: () => layoutChange.current(), rows: complete.rows, parent: appearance.ready && complete.ready && !initialDisclosurePending ? scrollNode : null,
    materialize: complete.acquireMeasurement, membership: complete.membership, rowMembers: complete.rowMembers, onMeasuring: complete.retainMeasurement, onPrepared: complete.retainGeometry, renderProps: row => ({ ...props, row, expandedBlocks, setBlockExpanded: () => {},
      preparing: row.sources.some(source => expandedBlocks[`reveal:${source.position}`]), primaryActions: readingRowPrimaryActions({ copy: () => {}, open: () => {}, turnId: readingRowTurnId(row, complete.actionRuns), selectedMessageId: props.selectedMessageId, select: props.onSelectMessageInfo }),
      lastAssistantTurnId: complete.lastAssistantTurnId, onActivityGroupExpandedChange: () => {} }), scale: getReadingResizeScale });
  const latest = useRef({ scope, space, projection, transcript, props, complete, geometry }); latest.current = { scope, space, projection, transcript, props, complete, geometry };
  const observeNotice = (origin: ReadingNavigationOrigin, result: import('./readingProjection').ReadingRevealResult, target?: ConversationSourceCoordinate) => {
    observeNavigation?.({ event: 'notice', origin, token: result.token, scope, positionSpaceId: space, target, status: result.status,
      currentScope: latest.current.scope, currentPositionSpaceId: latest.current.space,
      currentToken: (latest.current.transcript?.command ?? latest.current.props.navigationTarget)?.key });
  };
  const waiting = useRef(new Set<() => void>());
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
  const prepare = useCallback(async (target: ConversationSourceCoordinate, signal: AbortSignal, _token: string, summary?: ReadingSummaryTarget) => {
    const current = latest.current;
    if (current.scope !== target.conversationId) return { status: 'not-renderable' as const };
    if (current.transcript?.positionSpaceId !== target.positionSpaceId) return { status: 'position-space-changed' as const };
    if (signal.aborted) return { status: 'source-unavailable' as const };
    const resolve = () => {
      const current = latest.current;
      const member = current.complete.plan ? current.complete.plan.membership.get(target.position) : current.projection.membership.get(target.position);
      if (!member) return null;
      if (!summary) return { member, rowKey: target.subtarget === 'summary' ? member.summaryRowKey ?? member.rowKey : member.rowKey };
      const row = (current.complete.plan?.rows ?? current.projection.rows).find(row => row.key === summary.rowKey);
      const positions = row && ('sourcePositions' in row ? row.sourcePositions : row.sources.map(source => source.position));
      return target.subtarget === 'summary' && row?.kind === 'activity-summary' && row.disclosureOwner === summary.disclosureOwner && positions?.includes(target.position)
        ? { member, rowKey: row.key } : null;
    };
    const resolved = resolve();
    if (!resolved) return { status: 'not-renderable' as const };
    const { member } = resolved;
    if (target.subtarget !== 'summary') setExpandedBlocks(current => current[`reveal:${target.position}`] && member.disclosurePath.length === 0 && (!('detailKeys' in member) || member.detailKeys?.every(key => current[key])) ? current
      : boundDisclosures({ ...current, ...Object.fromEntries(member.disclosurePath.map(owner => [`group:${owner}`, true])), ...Object.fromEntries(('detailKeys' in member ? member.detailKeys ?? [] : []).map(key => [key, true])), [`reveal:${target.position}`]: true }));
    await waitFor(() => {
      if (latest.current.scope !== target.conversationId || latest.current.transcript?.positionSpaceId !== target.positionSpaceId) return true;
      const resolved = resolve();
      if (summary && !resolved) return true;
      const expected = latest.current.complete.rows.find(row => row.key === resolved?.rowKey);
      return Boolean(resolved && (target.subtarget === 'summary' || resolved.member.disclosurePath.length === 0) && expected && latest.current.geometry.geometry?.exact && appliedRows.current.some(row => row.key === expected.key && row.revision === expected.revision && row.disclosureIdentity === expected.disclosureIdentity));
    }, signal);
    if (signal.aborted) return { status: 'source-unavailable' as const };
    if (latest.current.scope !== target.conversationId) return { status: 'not-renderable' as const };
    if (latest.current.transcript?.positionSpaceId !== target.positionSpaceId) return { status: 'position-space-changed' as const };
    const prepared = resolve();
    return prepared ? { status: 'prepared' as const, rowKey: prepared.rowKey } : { status: 'not-renderable' as const };
  }, [waitFor]);
  const onRange = useCallback((demand: import('./readingBodyDemand').ReadingBodyDemand) => latest.current.complete.onRange(demand), []);
  const disclosures = expandedBlocks;
  const viewport = useReadingViewport({ scope, positionSpaceId: space, onInput: () => {
    focusAfterInitial.current = null; restoredRow.current = true;
    const queued = latest.current.transcript?.command ?? latest.current.props.navigationTarget;
    if (queued && handled.current !== queued.key) {
      handled.current = queued.key; latest.current.props.onNavigationResult?.({ key: queued.key, status: 'cancelled' });
    } else if (!queued) handled.current = `initial:${scope}:${space}`;
    setInitialNavigationDone(true); latest.current.transcript?.cancelNavigation();
  }, observeNavigation, commandToken: navigationTarget?.key, initializing: transcript?.navigationPending || !geometry.geometry, clearance, geometry: geometry.geometry, protectedKeys: protectedRows, disclosures, prepare, onApplied: complete.commitGeometry, onRange });
  layoutChange.current = viewport.beginLayout;
  useEffect(() => { if (initialVisible) viewport.captureReaderAnchor(); }, [initialVisible, viewport.appliedGeometry]);
  appliedRows.current = viewport.appliedGeometry ? viewport.rows : [];
  useLayoutEffect(() => {
    for (const check of [...waiting.current]) check();
  }, [projection, complete.plan, geometry.geometry, viewport.rows, viewport.appliedGeometry, transcript?.command, onRange, viewport.engine]);
  const setScrollNode = useCallback((node: HTMLDivElement | null) => { viewport.scrollRef.current = node; setScrollElement(node); }, [viewport.scrollRef]);
  useEffect(() => {
    overlay?.registerScrollOwner(viewport.scrollRef.current);
    return () => overlay?.registerScrollOwner(null);
  }, [overlay?.registerScrollOwner]);
  useEffect(() => {
    const protect = () => {
      const selection = document.getSelection();
      const keys = new Set<string>();
      for (const node of [document.activeElement, selection?.anchorNode, selection?.focusNode]) {
        const element = node instanceof Element ? node : node?.parentElement;
        const key = element?.closest<HTMLElement>('[data-reading-key]')?.dataset.readingKey;
        if (key) keys.add(key);
      }
      for (const id of latest.current.props.selectedBlockIds ?? []) {
        if (!id.startsWith(`cblk:${scope}:`)) continue;
        const position = Number(id.slice(id.lastIndexOf(':') + 1));
        const rowKey = latest.current.complete.plan?.membership.get(position)?.rowKey;
        if (rowKey) keys.add(rowKey);
      }
      setProtectedRows(previous => previous.size === keys.size && [...keys].every(key => previous.has(key)) ? previous : keys);
      latest.current.complete.protect();
    };
    const scroller = viewport.scrollRef.current;
    document.addEventListener('selectionchange', protect);
    scroller?.addEventListener('focusin', protect); protect();
    return () => { document.removeEventListener('selectionchange', protect); scroller?.removeEventListener('focusin', protect); };
  }, [onRange, viewport.engine, props.selectedBlockIds, complete.plan, scope]);
  useEffect(() => { handled.current = null; restoredRow.current = false; setInitialVisible(false); setInitialNavigationDone(false); setDisclosureRevisions({}); setNotice(null); const saved = readReadingState(scope); setExpandedBlocks(saved?.positionSpaceId === space ? saved.disclosures : {}); }, [scope, space]);
  useEffect(() => {
    if (!navigationTarget || handled.current === navigationTarget.key || !geometry.geometry || !viewport.appliedGeometry || (localRestore && !viewport.appliedGeometry?.exact)) return;
    if (!complete.rows.length) {
      if ((navigationTarget.kind === 'initial' || navigationTarget.kind === 'latest') && transcript?.total !== 0) return;
      if (navigationTarget.kind !== 'initial' && navigationTarget.kind !== 'latest') {
        handled.current = navigationTarget.key;
        setInitialNavigationDone(true);
        onNavigationResult?.({ key: navigationTarget.key, status: 'not-renderable' });
        return;
      }
    }
    handled.current = navigationTarget.key;
    setNotice(null);

    const target = navigationTarget.target;
    const restore = localRestore; if (restore) restoredRow.current = true;
    const end = navigationTarget.kind === 'latest' || navigationTarget.kind === 'initial';
    if (!restore && !target && !end) { onNavigationResult?.({ key: navigationTarget.key, status: 'not-renderable' }); return; }
    void viewport.reveal(restore ? { token: navigationTarget.key, restore, origin: 'source-navigation' } : end ? { token: navigationTarget.key, end: true, origin: 'source-navigation' } : { token: navigationTarget.key, target: target!, origin: 'source-navigation' }).then(result => {
      if (result.status !== 'revealed' && result.status !== 'cancelled') { observeNotice('source-navigation', result, target); setNotice(readingNavigationFailureMessage(result.status)); }
      focusAfterInitial.current = result.status === 'revealed' && !restore && !end ? target ?? null : null;
      setInitialNavigationDone(true);
      onNavigationResult?.({ key: result.token, status: result.status });
    });
  }, [navigationTarget, complete.rows, geometry.geometry, viewport.appliedGeometry, localRestore, viewport.reveal, viewport.engine, viewport.cancel, onNavigationResult]);

  useEffect(() => {
    const token = `initial:${scope}:${space}`;
    if (navigationTarget || !geometry.geometry || !viewport.appliedGeometry || initialNavigationDone || handled.current === token) return;
    handled.current = token;
    void viewport.reveal({ token, end: true, origin: 'initial' }).then(() => setInitialNavigationDone(true));
  }, [navigationTarget, geometry.geometry, viewport.appliedGeometry, initialNavigationDone, scope, space, viewport.reveal]);
  useEffect(() => {
    if (initialVisible || !geometry.geometry || !viewport.appliedGeometry || !initialNavigationDone) return;
    const items = viewport.engine.getVirtualItems();
    const hydrated = items.every(item => {
      const ref = viewport.rows[item.index];
      const body = ref && complete.getBody(ref);
      return body && (!('revision' in body) || body.revision === ref.revision);
    });
    if (hydrated && (!viewport.rows.length || items.length > 0)) setInitialVisible(true);
  }, [initialVisible, initialNavigationDone, navigationTarget, geometry.geometry, viewport.appliedGeometry, complete.bodies, viewport.rows, viewport.engine]);

  useEffect(() => {
    if (initialVisible && focusAfterInitial.current) { viewport.focusTarget(focusAfterInitial.current); focusAfterInitial.current = null; }
  }, [initialVisible]);

  const setBlockExpanded = useCallback((key: string, value: boolean, sources: readonly (PersistedBlockSource | undefined)[] = []) => {
    if (value && !latest.current.transcript) void latest.current.props.onExpandDetails?.(sources.filter((source): source is PersistedBlockSource => source?.detailsLoaded === false));
    setExpandedBlocks(current => current[key] === value && !sources.some(source => current[`reveal:${source?.position}`]) ? current : boundDisclosures({ ...current, ...Object.fromEntries(sources.filter(Boolean).map(source => [`reveal:${source!.position}`, false])), [key]: value }));
  }, []);
  const exportRow = useCallback(async (row: ReadingRow) => {
    const current = latest.current;
    const run = current.complete.actionRuns.get(row.actionGroup.key) ?? { group: row.actionGroup, events: [] };
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
  const actions = useMemo(() => new Map([...complete.bodies.entries()].map(([payloadKey, row]) => [payloadKey, readingRowPrimaryActions({
    turnId: readingRowTurnId(row, complete.actionRuns), selectedMessageId: props.selectedMessageId, select: props.onSelectMessageInfo,
    copy: () => {
      const content = exportRow(row);
      const copy = typeof ClipboardItem !== 'undefined' && navigator.clipboard.write
        ? navigator.clipboard.write([new ClipboardItem({ 'text/plain': content.then(text => new Blob([text], { type: 'text/plain' })) })])
        : content.then(text => navigator.clipboard.writeText(text));
      void copy.catch(() => setNotice('Could not copy messages.'));
    },
    open: () => { void openMarkdownSource(exportRow(row)).catch(() => setNotice('Could not open turn.')); },
  })])), [complete.bodies, complete.actionRuns, exportRow, props.onSelectMessageInfo, props.selectedMessageId]);
  const revealDisclosure = (row: ReadingRow, next: boolean, trigger?: HTMLElement) => {
    viewport.pinDisclosure(row.key, trigger);
    setExpandedBlocks(current => boundDisclosures({ ...current, [`group:${row.disclosureOwner}`]: next }));
  };
  const jump = () => {
    restoredRow.current = true; focusAfterInitial.current = null;
    void viewport.reveal({ token: `latest:${crypto.randomUUID()}`, end: true, origin: 'latest' }).then(result => { if (result.status === 'revealed') void latest.current.props.onJumpToLatest?.(); });
  };
  return <MessageLinkContext.Provider value={props.onCopyMessageLink ?? null}>
    <div className="stream-renderer">
      <div ref={setScrollNode} className="stream-renderer__scroll" tabIndex={0} aria-label="Conversation" aria-busy={!initialVisible} {...viewport.inputHandlers}>
        <div className="stream-renderer__virtual-canvas" style={{ height: `${viewport.engine.getTotalSize()}px`, visibility: initialVisible ? 'visible' : 'hidden' }}>
          <ReadingRowStrip items={viewport.engine.getVirtualItems()} endOffset={viewport.endOffset}>{item => {
            const ref = viewport.rows[item.index];
            if (!ref) return null;
            const row = complete.getBody(ref);
            if (!row || ('revision' in row && row.revision !== ref.revision)) return <MeasuredReadingBox key={ref.key} index={item.index} pendingHeight={item.size} measurement={ref} reportHeight={geometry.reportHeight} register={viewport.register} registerRow={viewport.registerRow} scope={scope} space={space} />;
            const bodyProps = viewport.renderProps?.(row);
            const primaryActions = (bodyProps?.primaryActions ?? []).map(action => action.id === 'select-group' ? action
              : { ...action, onAction: actions.get(readingPayloadKey(ref))?.find(current => current.id === action.id)?.onAction ?? action.onAction });
            return <MeasuredReadingBox key={row.key} row={row} index={item.index} pendingHeight={item.size} measurement={ref} reportHeight={geometry.reportHeight} register={viewport.register} registerRow={viewport.registerRow} scope={scope} space={space}>
              <MessageLinkContext.Provider value={bodyProps?.onCopyMessageLink ?? null}><ReadingRowBody {...(bodyProps ?? props)} row={row} expandedBlocks={bodyProps?.expandedBlocks ?? expandedBlocks} setBlockExpanded={(key, next, sources, trigger) => {
                  viewport.pinDisclosure(row.key, trigger);
                  setDisclosureRevisions(current => ({ ...current, [row.key]: (current[row.key] ?? 0) + 1 }));
                  setBlockExpanded(key, next, sources);
                }}
                preparing={bodyProps?.preparing ?? false}
                primaryActions={primaryActions} lastAssistantTurnId={bodyProps?.lastAssistantTurnId}
                onActivityGroupExpandedChange={(next, trigger) => revealDisclosure(row, next, trigger)} /></MessageLinkContext.Provider>
            </MeasuredReadingBox>;
          }}</ReadingRowStrip>
        </div>
        {(!initialVisible || !viewport.rows.length) && props.showEmpty && complete.ready && viewport.appliedGeometry && !complete.rows.length && <div className="stream-renderer__empty">{props.emptyLabel ?? 'No messages yet'}</div>}
      </div>
      <OverflowTopFade scroller={scrollNode} enabled={initialVisible && viewport.rows.length > 0} contentStart={viewport.engine.options.paddingStart ?? 0} className="stream-renderer__top-fade" />
      {appearance.error && !appearance.ready && <DetailPaneNotice severity="error" density="compact" title="Appearance preferences unavailable" source="chat-appearance" actions={<button type="button" className="btn btn--ghost btn--sm" onClick={appearance.retry}>Retry</button>}>{appearance.error}</DetailPaneNotice>}
      {events.some(event => event.type === 'chat:item' && event.persistencePending) && <div role="status">Some content is awaiting confirmation from saved history.</div>}
      {(notice || complete.error || geometry.error) && <div className="stream-renderer__history-error" role="alert">{notice ?? complete.error ?? geometry.error}<button type="button" onClick={() => { setNotice(null); geometry.retry(); void complete.refresh(); }}>Retry</button></div>}
      {viewport.showLatest && <button type="button" className="chat-circle-action stream-renderer__scroll-btn" aria-label="Jump to latest" title="Jump to latest" disabled={props.jumpingToLatest} aria-busy={props.jumpingToLatest ? "true" : "false"} onClick={jump}><Icon name="jumpToLatest" /></button>}
    </div>
  </MessageLinkContext.Provider>;
}
