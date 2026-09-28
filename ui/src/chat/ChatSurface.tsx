import type { JSX } from 'preact/jsx-runtime';
import {
  defaultRangeExtractor,
  observeElementRect,
  useVirtualizer,
  type Range,
  type Rect,
  type Virtualizer,
} from '@tanstack/react-virtual';
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ConsoleBackendType, ConsolePermissionDecision, ConsolePermissionRequest } from '../api';
import type {
  ContentBlock,
  DisplayGroup,
  RenderNode,
  StreamRendererProps,
} from '../components/stream-renderer/types';
import { MessageGroup } from '../components/stream-renderer/MessageGroup';
import { MessageActions } from '../components/shared/MessageActions';
import { DetailPaneOverlayContext } from '../components/shared/DetailPaneShell';
import { TurnGroup } from '../components/message-blocks/TurnGroup';
import { GroupFooter } from '../components/message-blocks/GroupFooter';
import { UserBubble } from '../components/message-blocks/UserBubble';
import { SemanticEventBlock, UnmatchedToolResultBlock } from '../components/message-blocks/SemanticEventBlock';
import { ActivityGroup, ActivityRow } from '../components/message-blocks/ActivityBlock';
import { PermissionApprovalCard } from '../components/console/PermissionApprovalCard';
import { VerticalArrowIcon } from '../components/icons/VerticalArrowIcon';
import { openMarkdownDocument } from './markdownActions';
import type {
  ConversationHistoryLoadResult,
  ConversationNavigationCommand,
  ConversationNavigationResult,
  ConversationTranscriptConsumer,
} from '../query/conversationData';
import {
  deriveLiveLabel,
  deriveTokenCount,
  extractTurns,
  formatElapsed,
  groupActivityItemsForDisplay,
  groupMessagesForDisplay,
  serializeDisplayGroupToMarkdown,
  useStreamState,
} from './renderModel';

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
};

const ESTIMATED_ROW_HEIGHT = 168;
const FOLLOW_THRESHOLD_PX = 80;
const JUMP_RETURN_SECONDS = 2;
const MANUAL_RETURN_PX_PER_SECOND = 600;
const INITIAL_VIRTUAL_RECT = { width: 600, height: 720 };

function estimateVirtualRow(index: number, items: VirtualItem[]): number {
  if (items[index]?.kind === 'history') return 40;
  return ESTIMATED_ROW_HEIGHT;
}

function observeChatElementRect(
  instance: Virtualizer<HTMLDivElement, HTMLDivElement>,
  notify: (rect: Rect) => void,
): ReturnType<typeof observeElementRect> {
  return observeElementRect(instance, (rect) => notify({
    width: rect.width || INITIAL_VIRTUAL_RECT.width,
    height: rect.height || INITIAL_VIRTUAL_RECT.height,
  }));
}

/**
 * The follow threshold answers whether appends should stick to the tail. This
 * separate visibility threshold hides the button for a one-page displacement
 * and shows it only when returning manually would take roughly two seconds.
 */
export function shouldShowJumpToLatest(distancePx: number, viewportHeight: number): boolean {
  return distancePx > Math.max(viewportHeight * 1.25, JUMP_RETURN_SECONDS * MANUAL_RETURN_PX_PER_SECOND);
}

type VirtualItem =
  | { kind: 'group'; id: string; group: DisplayGroup }
  | { kind: 'history'; id: string; state: HistoryRowState }
  | { kind: 'live'; id: string }
  | { kind: 'permission'; id: string };

type HistoryLoadState = 'idle' | 'loading' | 'retry';
type HistoryRowState = { kind: 'gap'; start: number; end: number; loadState: HistoryLoadState };

type ReadingAnchor = {
  version: 1;
  itemId: string;
  blockId: string | null;
  position: number | null;
  viewportOffset: number;
  followingTail: boolean;
};

function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore private-mode and SSR storage failures.
  }
}

function parseReadingAnchor(value: string | null): ReadingAnchor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<ReadingAnchor>;
    return parsed.version === 1
      && typeof parsed.itemId === 'string'
      && (typeof parsed.blockId === 'string' || parsed.blockId === null)
      && (typeof parsed.position === 'number' || parsed.position === null)
      && typeof parsed.viewportOffset === 'number'
      && Number.isFinite(parsed.viewportOffset)
      && typeof parsed.followingTail === 'boolean'
      ? parsed as ReadingAnchor
      : null;
  } catch {
    return null;
  }
}

function blockId(turnId: string, block: ContentBlock, index: number): string {
  if (block.type === 'tool_use') {
    return `${turnId}:tool:${block.id}`;
  }
  return `${turnId}:${block.type}:${index}`;
}

function measureVirtualRow(element: Element): number {
  const height = element.getBoundingClientRect().height;
  return height > 0 ? Math.ceil(height) : ESTIMATED_ROW_HEIGHT;
}

function requestedScrollBehavior(smooth: boolean): ScrollBehavior {
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  return smooth && !reducedMotion ? 'smooth' : 'auto';
}

function renderNodeContainsBlock(node: RenderNode, targetBlockId: string): boolean {
  if (node.key === targetBlockId) return true;
  if (node.kind === 'user_message') return node.persisted?.blockId === targetBlockId;
  if (node.kind === 'semantic_event') return node.event.source.blockId === targetBlockId;
  if (node.kind === 'unmatched_tool_result') return node.result.source?.blockId === targetBlockId;
  if (node.kind !== 'assistant_turn') return node.source?.blockId === targetBlockId;
  return node.turn.assistantEvent.message.content.some((block) => block.source?.blockId === targetBlockId)
    || Array.from(node.turn.toolResults.values()).some((result) => result.source?.blockId === targetBlockId);
}

function renderNodePosition(node: RenderNode, targetBlockId: string | null): number | null {
  if (node.kind === 'user_message') return node.persisted?.position ?? null;
  if (node.kind === 'semantic_event') return node.event.source.position ?? null;
  if (node.kind === 'unmatched_tool_result') return node.result.source?.position ?? null;
  if (node.kind === 'activity') return node.source?.position ?? null;
  if (targetBlockId) {
    const content = node.turn.assistantEvent.message.content.find((block) => block.source?.blockId === targetBlockId);
    if (content?.source?.position !== undefined) return content.source.position;
    const result = Array.from(node.turn.toolResults.values()).find((candidate) => candidate.source?.blockId === targetBlockId);
    if (result?.source?.position !== undefined) return result.source.position;
  }
  return node.turn.assistantEvent.message.content.find((block) => block.source?.position !== undefined)?.source?.position ?? null;
}

export function ChatSurface({
  events,
  streaming,
  elapsedSeconds,
  emptyLabel,
  showEmpty = true,
  onSelectMessageInfo,
  selectedMessageId,
  sessionInfo,
  activePermissionRequest,
  permissionBackendType = 'sdk',
  onPermissionRespond,
  unmaterializedAfterCount = 0,
  onJumpToLatest,
  jumpingToLatest = false,
  transcript,
  navigationTarget = null,
  onNavigationResult,
  selectedBlockIds,
  selectMode = false,
  onToggleBlockSelect,
  onFork,
  onResume,
  onCreatedTaskNavigate,
}: ChatSurfaceProps): JSX.Element {
  const { nodes } = useStreamState(events);
  const scrollRef = useRef<HTMLDivElement>(null);
  const overlayContext = useContext(DetailPaneOverlayContext);
  const registerScrollOwner = overlayContext?.registerScrollOwner;
  const storageScope = sessionInfo?.sessionId ?? 'default';
  const scrollStorageKey = `mandible:chat-scroll:${storageScope}`;

  const [viewportHeight, setViewportHeight] = useState(720);
  const [distanceFromBottom, setDistanceFromBottom] = useState(0);
  const [followingTail, setFollowingTail] = useState(false);
  const [historyLoadStates, setHistoryLoadStates] = useState<Record<string, HistoryLoadState>>({});
  const [expandedBlocks, setExpandedBlocks] = useState<Record<string, boolean>>({});
  const handledNavigationKeyRef = useRef<string | null>(null);
  const pendingFocusRef = useRef<{ key: string; blockId: string | null; itemId: string } | null>(null);
  const restoredScrollScopeRef = useRef<string | null>(null);
  const pendingReadingAnchorRef = useRef<ReadingAnchor | null>(null);
  const readingAnchorRef = useRef<ReadingAnchor | null>(null);
  const itemIdentitySignatureRef = useRef<string | null>(null);
  const inFlightHistoryRef = useRef<{ promise: Promise<void> } | null>(null);
  const historyScope = JSON.stringify([
    storageScope,
    transcript?.conversationId ?? null,
    transcript?.sourceVersionId ?? null,
  ]);
  const historyScopeRef = useRef(historyScope);
  historyScopeRef.current = historyScope;
  const historyStateScopeRef = useRef(historyScope);

  const groups = useMemo(() => groupMessagesForDisplay(nodes), [nodes]);
  const turns = useMemo(() => extractTurns(nodes), [nodes]);
  const liveLabel = deriveLiveLabel(turns, streaming);
  const tokenCount = deriveTokenCount(turns);
  const hasContent = nodes.length > 0;
  const hasPermissionCard = Boolean(activePermissionRequest && onPermissionRespond);

  const items = useMemo<VirtualItem[]>(() => {
    const contentItems: VirtualItem[] = groups.map((group) => ({
      kind: 'group',
      id: group.id,
      group,
    }));
    const groupedItems: VirtualItem[] = [];
    if (transcript) {
      const gaps: Array<Extract<VirtualItem, { kind: 'history' }>> = [];
      for (let index = 1; index < transcript.loadedIntervals.length; index += 1) {
        const previous = transcript.loadedIntervals[index - 1];
        const next = transcript.loadedIntervals[index];
        if (next.start <= previous.end + 1) continue;
        const start = previous.end + 1;
        const end = next.start - 1;
        const key = `gap:${start}:${end}`;
        gaps.push({
          kind: 'history',
          id: `history:${key}`,
          state: { kind: 'gap', start, end, loadState: historyLoadStates[key] ?? 'idle' },
        });
      }
      for (const item of contentItems) {
        if (item.kind === 'group') {
          const position = item.group.nodes
            .map((node) => renderNodePosition(node, null))
            .find((candidate): candidate is number => candidate !== null);
          while (position !== undefined && gaps[0]?.state.kind === 'gap' && gaps[0].state.end < position) {
            groupedItems.push(gaps.shift()!);
          }
        }
        groupedItems.push(item);
      }
      groupedItems.push(...gaps);
    } else {
      groupedItems.push(...contentItems);
    }
    if (streaming) {
      groupedItems.push({ kind: 'live', id: 'stream-live-tail' });
    }
    if (activePermissionRequest && onPermissionRespond) {
      groupedItems.push({ kind: 'permission', id: `permission:${activePermissionRequest.id}` });
    }
    return groupedItems;
  }, [activePermissionRequest, groups, historyLoadStates, onPermissionRespond, streaming, transcript]);

  const getItemKey = useCallback((index: number) => items[index]?.id ?? index, [items]);
  const extractVirtualRows = useCallback((range: Range): number[] => {
    const indices = new Set(defaultRangeExtractor(range));
    // Keep one truthful discontinuity discoverable without letting a fragmented
    // transcript make the mounted DOM grow with the number of gaps.
    const firstGap = items.findIndex((item) => item.kind === 'history');
    if (firstGap >= 0) indices.add(firstGap);
    return [...indices].sort((left, right) => left - right);
  }, [items]);
  const getScrollElement = useCallback(() => scrollRef.current, []);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: items.length,
    getScrollElement,
    estimateSize: (index) => estimateVirtualRow(index, items),
    measureElement: measureVirtualRow,
    getItemKey,
    initialOffset: Math.max(0, items.length * ESTIMATED_ROW_HEIGHT - 720),
    initialRect: INITIAL_VIRTUAL_RECT,
    observeElementRect: observeChatElementRect,
    rangeExtractor: extractVirtualRows,
    overscan: 4,
    anchorTo: followingTail ? 'end' : 'start',
    followOnAppend: followingTail ? 'auto' : false,
    scrollEndThreshold: FOLLOW_THRESHOLD_PX,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const estimatedUnmaterializedDistance = Math.max(0, unmaterializedAfterCount) * ESTIMATED_ROW_HEIGHT;
  const showJumpToLatest = shouldShowJumpToLatest(
    Math.max(distanceFromBottom, estimatedUnmaterializedDistance),
    viewportHeight,
  );

  const requestHistory = useCallback((
    key: string,
    load: () => ConversationHistoryLoadResult | Promise<ConversationHistoryLoadResult>,
  ): Promise<void> => {
    const current = inFlightHistoryRef.current;
    if (current) return current.promise;
    const scope = historyScope;
    setHistoryLoadStates((states) => ({ ...states, [key]: 'loading' }));
    const promise = Promise.resolve()
      .then(load)
      .then((result) => new Promise<ConversationHistoryLoadResult>((resolve) => {
        window.setTimeout(() => resolve(result), 0);
      }))
      .then(
        (result): HistoryLoadState => (result === 'failed' ? 'retry' : 'idle'),
        (): HistoryLoadState => 'retry',
      )
      .then((nextState) => {
        if (inFlightHistoryRef.current?.promise !== promise) return;
        inFlightHistoryRef.current = null;
        if (historyScopeRef.current !== scope) {
          setHistoryLoadStates({});
          return;
        }
        setHistoryLoadStates((states) => ({ ...states, [key]: nextState }));
      });
    inFlightHistoryRef.current = { promise };
    return promise;
  }, [historyScope]);

  const findAnchorItemIndex = useCallback((anchor: Pick<ReadingAnchor, 'itemId' | 'blockId'>): number => {
    if (anchor.blockId) {
      const blockIndex = items.findIndex((item) => item.kind === 'group'
        && item.group.nodes.some((node) => renderNodeContainsBlock(node, anchor.blockId!)));
      if (blockIndex >= 0) return blockIndex;
    }
    return items.findIndex((item) => item.id === anchor.itemId);
  }, [items]);

  const captureReadingAnchor = useCallback((followingTailOverride?: boolean): ReadingAnchor | null => {
    const el = scrollRef.current;
    if (!el || items.length === 0) return null;
    const offset = el.scrollTop;
    let virtualItem = virtualizer.getVirtualItemForOffset(offset) ?? virtualizer.getVirtualItems()[0];
    if (virtualItem && items[virtualItem.index]?.kind !== 'group') {
      virtualItem = virtualizer.getVirtualItems().find((candidate) => (
        items[candidate.index]?.kind === 'group'
        && candidate.end > offset
        && candidate.start < offset + el.clientHeight
      )) ?? virtualItem;
    }
    if (!virtualItem) return null;
    const item = items[virtualItem.index];
    if (!item) return null;
    const row = Array.from(el.querySelectorAll<HTMLElement>('[data-virtual-key]'))
      .find((candidate) => candidate.dataset.virtualKey === item.id);
    const scrollRect = el.getBoundingClientRect();
    const blocks = row ? Array.from(row.querySelectorAll<HTMLElement>('[data-block-id]')) : [];
    const visibleBlock = blocks.find((block) => block.getBoundingClientRect().bottom > scrollRect.top) ?? blocks[0] ?? null;
    const blockIdValue = visibleBlock?.dataset.blockId ?? null;
    const node = item.kind === 'group'
      ? item.group.nodes.find((candidate) => !blockIdValue || renderNodeContainsBlock(candidate, blockIdValue))
      : undefined;
    const anchor: ReadingAnchor = {
      version: 1,
      itemId: item.id,
      blockId: blockIdValue,
      position: node ? renderNodePosition(node, blockIdValue) : null,
      viewportOffset: visibleBlock
        ? visibleBlock.getBoundingClientRect().top - scrollRect.top
        : virtualItem.start - offset,
      followingTail: followingTailOverride ?? followingTail,
    };
    readingAnchorRef.current = anchor;
    storageSet(scrollStorageKey, JSON.stringify(anchor));
    return anchor;
  }, [followingTail, items, scrollStorageKey, virtualizer]);

  const restoreReadingAnchor = useCallback((anchor: ReadingAnchor): boolean => {
    const el = scrollRef.current;
    if (!el) return false;
    const itemIndex = findAnchorItemIndex(anchor);
    if (itemIndex < 0) {
      if (anchor.position !== null && transcript && !transcript.historyLoading) {
        const key = `anchor:${anchor.position}`;
        if ((historyLoadStates[key] ?? 'idle') === 'idle') {
          void requestHistory(key, () => transcript.loadAround(anchor.position!));
        }
      }
      return false;
    }
    const item = items[itemIndex];
    const row = Array.from(el.querySelectorAll<HTMLElement>('[data-virtual-key]'))
      .find((candidate) => candidate.dataset.virtualKey === item.id);
    if (!row) {
      pendingReadingAnchorRef.current = anchor;
      virtualizer.scrollToIndex(itemIndex, { align: 'start', behavior: 'auto' });
      return false;
    }
    const target = anchor.blockId
      ? Array.from(row.querySelectorAll<HTMLElement>('[data-block-id]'))
        .find((candidate) => candidate.dataset.blockId === anchor.blockId)
      : row;
    if (!target) return false;
    const currentOffset = anchor.blockId
      ? target.getBoundingClientRect().top - el.getBoundingClientRect().top
      : (virtualizer.getVirtualItems().find((candidate) => candidate.index === itemIndex)?.start ?? el.scrollTop) - el.scrollTop;
    const delta = currentOffset - anchor.viewportOffset;
    if (Math.abs(delta) >= 0.5) {
      const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
      const targetScrollTop = Math.max(0, Math.min(maxScrollTop, el.scrollTop + delta));
      if (Math.abs(targetScrollTop - el.scrollTop) >= 0.5) {
        pendingReadingAnchorRef.current = anchor;
        virtualizer.scrollToOffset(targetScrollTop, { behavior: 'auto' });
        return false;
      }
    }
    pendingReadingAnchorRef.current = null;
    return true;
  }, [findAnchorItemIndex, historyLoadStates, items, requestHistory, transcript, virtualizer]);

  // Chat disclosures are transient reading state. A new conversation or page
  // refresh starts from each block's declared default instead of reviving old
  // tool/thinking expansion choices from browser storage.
  useEffect(() => {
    setExpandedBlocks({});
    setHistoryLoadStates({});
    pendingReadingAnchorRef.current = null;
    readingAnchorRef.current = null;
    inFlightHistoryRef.current = null;
  }, [storageScope]);

  useEffect(() => {
    if (historyStateScopeRef.current === historyScope) return;
    historyStateScopeRef.current = historyScope;
    setHistoryLoadStates({});
  }, [historyScope]);

  const setScrollNode = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node;
    registerScrollOwner?.(node);
    if (node) setViewportHeight(node.clientHeight || 720);
  }, [registerScrollOwner]);

  useLayoutEffect(() => {
    if (!scrollRef.current || restoredScrollScopeRef.current === scrollStorageKey || items.length === 0) return;
    restoredScrollScopeRef.current = scrollStorageKey;
    const storedAnchor = parseReadingAnchor(storageGet(scrollStorageKey));
    if (navigationTarget) return;
    if (storedAnchor) {
      readingAnchorRef.current = storedAnchor;
      pendingReadingAnchorRef.current = storedAnchor;
      setFollowingTail(storedAnchor.followingTail && !transcript?.hasNewer);
      restoreReadingAnchor(storedAnchor);
    } else if (!navigationTarget) {
      setFollowingTail(!transcript?.hasNewer);
      virtualizer.scrollToEnd({ behavior: 'auto' });
    }
  }, [items.length, navigationTarget, restoreReadingAnchor, scrollStorageKey, transcript?.hasNewer, virtualizer]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!navigationTarget) {
      handledNavigationKeyRef.current = null;
      pendingFocusRef.current = null;
      return;
    }
    if (!el || handledNavigationKeyRef.current === navigationTarget.key || items.length === 0) return;
    let itemIndex = items.length - 1;
    let targetFound = navigationTarget.kind === 'initial' || navigationTarget.kind === 'latest';
    if (navigationTarget.kind !== 'initial' && navigationTarget.kind !== 'latest') {
      itemIndex = navigationTarget.turnId ? items.findIndex((item) => (
        item.kind === 'group' && item.group.nodes.some((node) => node.key === navigationTarget.turnId)
      )) : -1;
      if (itemIndex < 0 && navigationTarget.blockId) {
        itemIndex = items.findIndex((item) => (
          item.kind === 'group' && item.group.nodes.some((node) => (
            renderNodeContainsBlock(node, navigationTarget.blockId!)
          ))
        ));
      }
      targetFound = itemIndex >= 0;
    }
    if (!targetFound) {
      handledNavigationKeyRef.current = navigationTarget.key;
      onNavigationResult?.({ key: navigationTarget.key, status: 'not-renderable' });
      return;
    }

    const behavior = requestedScrollBehavior(navigationTarget.smooth);
    handledNavigationKeyRef.current = navigationTarget.key;
    pendingFocusRef.current = navigationTarget.kind === 'initial' || navigationTarget.kind === 'latest'
      ? null
      : { key: navigationTarget.key, blockId: navigationTarget.blockId ?? null, itemId: items[itemIndex].id };
    setFollowingTail(
      (navigationTarget.kind === 'initial' || navigationTarget.kind === 'latest')
      && !transcript?.hasNewer,
    );
    if (navigationTarget.kind === 'initial' || navigationTarget.kind === 'latest') {
      virtualizer.scrollToEnd({ behavior });
      onNavigationResult?.({ key: navigationTarget.key, status: 'revealed' });
    } else {
      virtualizer.scrollToIndex(itemIndex, { align: 'center', behavior });
    }
    setDistanceFromBottom(navigationTarget.kind === 'initial' || navigationTarget.kind === 'latest'
      ? 0
      : virtualizer.getDistanceFromEnd());
  }, [items, navigationTarget, onNavigationResult, transcript?.hasNewer, virtualizer]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const pending = pendingFocusRef.current;
    if (!el || !pending) return;
    const row = Array.from(el.querySelectorAll<HTMLElement>('[data-virtual-key]'))
      .find((candidate) => candidate.dataset.virtualKey === pending.itemId);
    if (!row) return;
    const target = pending.blockId
      ? Array.from(row.querySelectorAll<HTMLElement>('[data-block-id]'))
        .find((candidate) => candidate.dataset.blockId === pending.blockId)
      : row;
    if (!target) {
      pendingFocusRef.current = null;
      onNavigationResult?.({ key: pending.key, status: 'not-renderable' });
      return;
    }
    if (pending.blockId && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'center', behavior: 'auto' });
    }
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
    pendingFocusRef.current = null;
    onNavigationResult?.({ key: pending.key, status: 'revealed' });
    captureReadingAnchor(false);
  }, [captureReadingAnchor, onNavigationResult, virtualItems]);

  useLayoutEffect(() => {
    const pending = pendingReadingAnchorRef.current;
    if (!pending || navigationTarget) return;
    restoreReadingAnchor(pending);
  }, [distanceFromBottom, expandedBlocks, items, navigationTarget, restoreReadingAnchor, virtualItems]);

  useLayoutEffect(() => {
    const signature = items.map((item) => item.id).join('\0');
    const previous = itemIdentitySignatureRef.current;
    itemIdentitySignatureRef.current = signature;
    if (previous === null || previous === signature || navigationTarget) return;
    const anchor = readingAnchorRef.current;
    if (!anchor || anchor.followingTail) return;
    pendingReadingAnchorRef.current = anchor;
    restoreReadingAnchor(anchor);
  }, [items, navigationTarget, restoreReadingAnchor]);

  useEffect(() => {
    if (!transcript || transcript.historyLoading || inFlightHistoryRef.current
        || pendingReadingAnchorRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const rendered = virtualizer.getVirtualItems();
    if (rendered.length === 0) return;
    const scrollStart = el.scrollTop;
    const scrollEnd = scrollStart + el.clientHeight;
    const prefetchDistance = Math.max(el.clientHeight * 1.5, 720);
    const requestWithAnchor = (
      key: string,
      load: () => ConversationHistoryLoadResult | Promise<ConversationHistoryLoadResult>,
    ) => {
      const anchor = captureReadingAnchor();
      if (anchor && !anchor.followingTail) pendingReadingAnchorRef.current = anchor;
      void requestHistory(key, load);
    };
    const olderState = historyLoadStates['edge:older'] ?? 'idle';
    const newerState = historyLoadStates['edge:newer'] ?? 'idle';
    if (transcript.hasOlder && olderState === 'idle' && scrollStart <= prefetchDistance) {
      requestWithAnchor('edge:older', transcript.loadOlder);
      return;
    }
    if (transcript.hasNewer && newerState === 'idle'
        && el.scrollHeight - scrollEnd <= prefetchDistance) {
      requestWithAnchor('edge:newer', transcript.loadNewer);
      return;
    }
    for (const item of items) {
      if (item.kind !== 'history') continue;
      const { start, end, loadState } = item.state;
      const row = rendered.find((candidate) => items[candidate.index]?.id === item.id);
      if (!row || loadState !== 'idle'
          || row.end < scrollStart - prefetchDistance
          || row.start > scrollEnd + prefetchDistance) continue;
      const key = `gap:${start}:${end}`;
      requestWithAnchor(key, () => transcript.loadAround(start));
      return;
    }
  }, [captureReadingAnchor, historyLoadStates, items, requestHistory, transcript, virtualItems, virtualizer]);

  function handleUserScrollIntent(): void {
    // Direct scroll input supersedes a deferred virtual-row restore. The ensuing
    // scroll event captures the new anchor before data can change.
    pendingReadingAnchorRef.current = null;
  }

  function handleUserScrollPointer(event: PointerEvent): void {
    if (event.target === event.currentTarget) handleUserScrollIntent();
  }

  function handleUserScrollKey(event: KeyboardEvent): void {
    const target = event.target;
    if (event.defaultPrevented || (target instanceof HTMLElement
        && (target.isContentEditable || target.matches('input, textarea, select')))) return;
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
      handleUserScrollIntent();
    }
  }

  function handleScroll(): void {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const nextViewportHeight = el.clientHeight || viewportHeight;
    const nextDistance = Math.max(0, el.scrollHeight - el.scrollTop - nextViewportHeight);
    setViewportHeight(nextViewportHeight);
    setDistanceFromBottom(nextDistance);
    if (pendingReadingAnchorRef.current) return;
    const nextFollowingTail = nextDistance <= FOLLOW_THRESHOLD_PX
      && !transcript?.hasNewer
      && (transcript?.unmaterializedAfterCount ?? unmaterializedAfterCount) === 0;
    setFollowingTail(nextFollowingTail);
    captureReadingAnchor(nextFollowingTail);
  }

  function handleJumpToBottom(): void {
    if (onJumpToLatest) {
      void onJumpToLatest();
      return;
    }
    const el = scrollRef.current;
    if (!el) return;
    virtualizer.scrollToEnd({ behavior: requestedScrollBehavior(true) });
    setDistanceFromBottom(0);
    setFollowingTail(!transcript?.hasNewer);
    captureReadingAnchor(!transcript?.hasNewer);
  }

  function setBlockExpanded(id: string, expanded: boolean): void {
    const anchor = captureReadingAnchor();
    if (anchor) pendingReadingAnchorRef.current = anchor;
    setExpandedBlocks((current) => {
      return { ...current, [id]: expanded };
    });
  }

  function copyText(text: string): void {
    navigator.clipboard.writeText(text).catch(() => {});
  }

  let lastAssistantTurnId: string | null = null;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (node.kind === 'assistant_turn') {
      lastAssistantTurnId = node.turn.id;
      break;
    }
  }

  function renderNodeBody(node: RenderNode): JSX.Element | null {
    switch (node.kind) {
      case 'user_message': {
        const source = node.persisted;
        return (
          <div
            key={node.key}
            className="message-block-wrapper contextual-action-owner"
            data-block-id={source?.blockId}
          >
            <UserBubble text={node.text} />
            <MessageActions
              onSelect={source && onToggleBlockSelect ? (shiftKey) => onToggleBlockSelect(source.blockId, shiftKey) : undefined}
              isSelected={source ? selectedBlockIds?.has(source.blockId) : false}
              selectMode={selectMode}
              onFork={source?.dagUuid && onFork ? () => onFork(source.dagUuid!) : undefined}
              onResume={source?.dagUuid && onResume ? () => onResume(source.dagUuid!) : undefined}
              dagUuid={source?.dagUuid}
              metadata={{ timestamp: source?.timestamp }}
            />
          </div>
        );
      }

       case 'semantic_event': {
        const source = node.event.source;
        return (
          <div key={node.key} className="message-block-wrapper" data-block-id={source.blockId}>
            <SemanticEventBlock
              kind={node.event.semantic_kind}
              content={node.event.content}
              label={node.event.label}
              isError={node.event.is_error}
            />
            <MessageActions
              onSelect={onToggleBlockSelect ? (shiftKey) => onToggleBlockSelect(source.blockId, shiftKey) : undefined}
              isSelected={selectedBlockIds?.has(source.blockId)}
              selectMode={selectMode}
              metadata={{ timestamp: source.timestamp }}
            />
          </div>
        );
      }

      case 'unmatched_tool_result': {
        const source = node.result.source;
        return (
          <div key={node.key} className="message-block-wrapper" data-block-id={source?.blockId}>
            <UnmatchedToolResultBlock result={node.result} />
            <MessageActions
              onSelect={source && onToggleBlockSelect ? (shiftKey) => onToggleBlockSelect(source.blockId, shiftKey) : undefined}
              isSelected={source ? selectedBlockIds?.has(source.blockId) : false}
              selectMode={selectMode}
              metadata={{ timestamp: source?.timestamp }}
            />
          </div>
        );
      }

      case 'activity': {
        const source = node.source;
        const sourceBlockId = source?.blockId
          ?? (node.item.type === 'provider-directive' ? node.item.blockId ?? undefined : undefined);
        const disclosureKey = `activity:${node.key}`;
        return (
          <div key={node.key} className="message-block-wrapper" data-block-id={sourceBlockId}>
            <ActivityRow
              item={node.item}
              expanded={expandedBlocks[disclosureKey] ?? false}
              onExpandedChange={(next) => setBlockExpanded(disclosureKey, next)}
              onCreatedTaskNavigate={onCreatedTaskNavigate}
            />
            <MessageActions
              onSelect={source && onToggleBlockSelect ? (shiftKey) => onToggleBlockSelect(source.blockId, shiftKey) : undefined}
              isSelected={source ? selectedBlockIds?.has(source.blockId) : false}
              selectMode={selectMode}
              metadata={{ timestamp: source?.timestamp }}
            />
          </div>
        );
      }

      case 'assistant_turn': {
        const { turn } = node;
        const isLastStreamingTurn = streaming && node.turn.id === lastAssistantTurnId;
        const isThinking =
          isLastStreamingTurn &&
          turn.assistantEvent.message.content.some((b) => b.type === 'thinking');
        const isSelected = selectedMessageId === turn.id;
        return (
          <div
            key={node.key}
            className={isSelected ? 'stream-turn-node stream-turn--selected' : 'stream-turn-node'}
          >
            <MessageGroup
              turn={turn}
              isStreaming={isLastStreamingTurn}
              isThinking={isThinking}
              getBlockExpanded={(contentBlock, index, defaultExpanded) => (
                expandedBlocks[blockId(turn.id, contentBlock, index)] ?? defaultExpanded
              )}
              onBlockExpandedChange={(contentBlock, index, expanded) => (
                setBlockExpanded(blockId(turn.id, contentBlock, index), expanded)
              )}
              getDisclosureExpanded={(id, defaultExpanded) => expandedBlocks[`${turn.id}:${id}`] ?? defaultExpanded}
              onDisclosureExpandedChange={(id, expanded) => setBlockExpanded(`${turn.id}:${id}`, expanded)}
              selectedBlockIds={selectedBlockIds}
              selectMode={selectMode}
              onToggleBlockSelect={onToggleBlockSelect}
              onFork={onFork}
              onResume={onResume}
            />
          </div>
        );
      }

      default:
        return null;
    }
  }

  function renderGroup(group: DisplayGroup): JSX.Element {
    const markdown = serializeDisplayGroupToMarkdown(group);
    const firstAssistant = group.nodes.find((node): node is Extract<RenderNode, { kind: 'assistant_turn' }> => (
      node.kind === 'assistant_turn'
    ));
    const footer = markdown ? (
      <GroupFooter
        totalTokens={group.meta.totalTokens}
        onCopyAll={() => copyText(markdown)}
        onOpenMarkdown={() => openMarkdownDocument(markdown)}
        onSelect={firstAssistant && onSelectMessageInfo ? () => onSelectMessageInfo(firstAssistant.turn.id) : undefined}
        isSelected={firstAssistant ? selectedMessageId === firstAssistant.turn.id : false}
      />
    ) : undefined;

    return (
      <TurnGroup
        key={group.id}
        speaker={group.speaker}
        footer={footer}
      >
        {groupActivityItemsForDisplay(group.nodes).map((entry) => {
          if (entry.kind === 'node') return renderNodeBody(entry.node);
          return (
            <div
              key={entry.key}
              className="message-block-wrapper"
              data-member-refs={[...new Set(entry.nodes.map((node) => node.source?.blockId
                ?? (node.item.type === 'provider-directive' ? node.item.blockId : null)
                ?? node.key))].join(' ')}
            >
              <ActivityGroup
                items={entry.nodes.map((node) => node.item)}
                expanded={expandedBlocks[entry.key] ?? false}
                onExpandedChange={(next) => setBlockExpanded(entry.key, next)}
                onCreatedTaskNavigate={onCreatedTaskNavigate}
              />
            </div>
          );
        })}
      </TurnGroup>
    );
  }

  function renderLiveIndicator(): JSX.Element {
    return (
      <div className="stream-live-indicator">
        <span className="stream-live-indicator__dot" />
        <span className="stream-live-indicator__label">{liveLabel ?? 'Working'}</span>
        {tokenCount !== undefined && (
          <span className="stream-live-indicator__tokens">
            {tokenCount.toLocaleString()} tokens
          </span>
        )}
        {elapsedSeconds !== undefined && (
          <span className="stream-live-indicator__timer">
            {formatElapsed(elapsedSeconds)}
          </span>
        )}
      </div>
    );
  }

  function renderHistoryRow(state: HistoryRowState): JSX.Element {
    if (state.loadState !== 'loading') {
      return <div className="stream-renderer__history-state" aria-hidden="true" />;
    }
    return (
      <div
        className="stream-renderer__history-state"
        role="status"
        aria-live="polite"
      >
        Loading history…
      </div>
    );
  }

  if (!hasContent && !hasPermissionCard && !transcript) {
    if (!showEmpty) return <div className="stream-renderer" />;
    return (
      <div className="stream-renderer">
        <div className="stream-renderer__empty">
          {emptyLabel ?? (streaming ? 'Starting...' : 'No events')}
        </div>
      </div>
    );
  }

  return (
    <div className="stream-renderer">
      <div
        ref={setScrollNode}
        className="stream-renderer__scroll"
        onScroll={handleScroll}
        onPointerDown={handleUserScrollPointer}
        onWheel={handleUserScrollIntent}
        onTouchMove={handleUserScrollIntent}
        onKeyDown={handleUserScrollKey}
      >
        <div className="stream-renderer__virtual-canvas" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          {virtualItems.map((virtualItem) => {
            const item = items[virtualItem.index];
            if (!item) return null;
            return (
              <div
                key={virtualItem.key}
                ref={virtualizer.measureElement}
                className="stream-renderer__virtual-row"
                data-index={virtualItem.index}
                data-virtual-key={item.id}
                style={{ top: 0, transform: `translateY(${virtualItem.start}px)` }}
              >
                {item.kind === 'group' && renderGroup(item.group)}
                {item.kind === 'history' && renderHistoryRow(item.state)}
                {item.kind === 'live' && renderLiveIndicator()}
                {item.kind === 'permission' && activePermissionRequest && onPermissionRespond && (
                  <TurnGroup speaker="system">
                    <PermissionApprovalCard
                      request={activePermissionRequest}
                      backendType={permissionBackendType}
                      onRespond={onPermissionRespond}
                    />
                  </TurnGroup>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {showJumpToLatest && (
        <>
          <button
            type="button"
            className="chat-circle-action stream-renderer__scroll-btn"
            onClick={handleJumpToBottom}
            disabled={jumpingToLatest}
            aria-label="Jump to latest"
            aria-busy={jumpingToLatest ? 'true' : 'false'}
            title="Jump to latest"
          >
            <VerticalArrowIcon direction="down" />
          </button>
          {jumpingToLatest && (
            <span className="sr-only" role="status" aria-live="polite">Loading latest…</span>
          )}
        </>
      )}
    </div>
  );
}
