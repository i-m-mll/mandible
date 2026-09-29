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
  PersistedBlockSource,
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
import { ThinkingBlock } from '../components/message-blocks/ThinkingBlock';
import { ToolUseBlock } from '../components/message-blocks/ToolUseBlock';
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
  onExpandDetails?: (sources: readonly PersistedBlockSource[]) => void | Promise<void>;
};

const ESTIMATED_ROW_HEIGHT = 168;
const MIN_CANONICAL_POSITION_HEIGHT = 1;
const FOLLOW_THRESHOLD_PX = 80;
const JUMP_RETURN_SECONDS = 2;
const MANUAL_RETURN_PX_PER_SECOND = 600;
const INITIAL_VIRTUAL_RECT = { width: 600, height: 720 };

function estimateVirtualRow(
  index: number,
  items: VirtualItem[],
  measuredGroupSizes: Readonly<Record<string, number>>,
): number {
  const item = items[index];
  if (item?.kind === 'history') return item.state.extentHeight;
  if (item?.kind === 'group') return measuredGroupSizes[item.id] ?? item.estimatedSize;
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
  | { kind: 'group'; id: string; group: DisplayGroup; estimatedSize: number }
  | { kind: 'history'; id: string; state: HistoryRowState }
  | { kind: 'live'; id: string }
  | { kind: 'permission'; id: string };

type HistoryLoadState = 'idle' | 'loading' | 'retry';
type HistoryRowState = {
  kind: 'gap';
  key: string;
  start: number;
  end: number;
  extentHeight: number;
  loadState: HistoryLoadState;
};

function historyPositionAtOffset(
  state: HistoryRowState,
  rowStart: number,
  rowSize: number,
  offset: number,
): number {
  const span = state.end - state.start + 1;
  const fraction = Math.max(0, Math.min(1, (offset - rowStart) / Math.max(1, rowSize)));
  return Math.min(state.end, state.start + Math.floor(fraction * span));
}

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

function tailReadingAnchor(itemId: string): ReadingAnchor {
  return {
    version: 1,
    itemId,
    blockId: null,
    position: null,
    viewportOffset: 0,
    followingTail: true,
  };
}

function blockId(turnId: string, block: ContentBlock, index: number): string {
  if (block.type === 'tool_use') {
    return `${turnId}:tool:${block.id}`;
  }
  return `${turnId}:${block.type}:${index}`;
}

function measureVirtualRow(element: Element, entry?: ResizeObserverEntry): number {
  const observedHeight = entry?.borderBoxSize?.[0]?.blockSize;
  const height = typeof observedHeight === 'number'
    ? observedHeight
    : element.getBoundingClientRect().height;
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

function missingPositionRanges(
  total: number,
  intervals: readonly { start: number; end: number }[],
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let next = 0;
  for (const interval of intervals) {
    const start = Math.max(0, Math.min(total, interval.start));
    const end = Math.min(total - 1, interval.end);
    if (end < start) continue;
    if (start > next) ranges.push({ start: next, end: start - 1 });
    next = Math.max(next, end + 1);
    if (next >= total) break;
  }
  if (next < total) ranges.push({ start: next, end: total - 1 });
  return ranges.filter((range) => range.start <= range.end);
}

function renderNodeBlockIdAtPosition(node: RenderNode, position: number): string | null {
  if (node.kind === 'user_message') {
    return node.persisted?.position === position ? node.persisted.blockId : null;
  }
  if (node.kind === 'semantic_event') {
    return node.event.source.position === position ? node.event.source.blockId : null;
  }
  if (node.kind === 'unmatched_tool_result') {
    const source = node.result.source;
    return source?.position === position ? source.blockId : null;
  }
  if (node.kind === 'activity') {
    return node.source?.position === position ? node.source.blockId : null;
  }
  const content = node.turn.assistantEvent.message.content.find((block) => block.source?.position === position);
  if (content?.source) return content.source.blockId;
  const result = Array.from(node.turn.toolResults.values()).find((candidate) => (
    candidate.source?.position === position
  ));
  return result?.source?.blockId ?? null;
}

function hasMemberRef(element: HTMLElement, blockId: string): boolean {
  return element.dataset.memberRefs?.split(/\s+/).includes(blockId) ?? false;
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
  onExpandDetails,
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
  const userScrollIntentRef = useRef(false);
  const userScrollAwayFromTailRef = useRef(false);
  const lastUserScrollTopRef = useRef<number | null>(null);
  const scrollEndCleanupRef = useRef<(() => void) | null>(null);
  const [historyLoadStates, setHistoryLoadStates] = useState<Record<string, HistoryLoadState>>({});
  const [measuredGroupSizesByScope, setMeasuredGroupSizesByScope] = useState<{
    scope: string;
    sizes: Readonly<Record<string, number>>;
  }>({ scope: '', sizes: {} });
  const [expandedBlocks, setExpandedBlocks] = useState<Record<string, boolean>>({});
  const handledNavigationKeyRef = useRef<string | null>(null);
  const pendingFocusRef = useRef<{ key: string; blockId: string | null; itemId: string } | null>(null);
  const restoredScrollScopeRef = useRef<string | null>(null);
  const pendingReadingAnchorRef = useRef<ReadingAnchor | null>(null);
  const readingAnchorRef = useRef<ReadingAnchor | null>(null);
  const itemIdentitySignatureRef = useRef<string | null>(null);
  const inFlightHistoryRef = useRef(new Map<string, Promise<void>>());
  const historyScope = JSON.stringify([
    storageScope,
    transcript?.conversationId ?? null,
    transcript?.sourceVersionId ?? null,
  ]);
  const expansionOwnerScope = JSON.stringify([storageScope, transcript?.conversationId ?? null]);
  const extentScope = JSON.stringify([
    storageScope,
    transcript?.conversationId ?? null,
  ]);
  const historyScopeRef = useRef(historyScope);
  historyScopeRef.current = historyScope;
  const historyStateScopeRef = useRef(historyScope);
  const expansionOwnerScopeRef = useRef(expansionOwnerScope);
  const extentScopeRef = useRef(extentScope);
  extentScopeRef.current = extentScope;
  const groups = useMemo(() => {
    const intervals = transcript?.loadedIntervals;
    if (!intervals || intervals.length <= 1) return groupMessagesForDisplay(nodes);
    const sections: RenderNode[][] = [];
    let current: RenderNode[] = [];
    let currentInterval = -1;
    for (const node of nodes) {
      const position = renderNodePosition(node, null);
      const interval = position === null
        ? currentInterval
        : intervals.findIndex((range) => position >= range.start && position <= range.end);
      if (current.length > 0 && interval !== currentInterval) {
        sections.push(current);
        current = [];
      }
      current.push(node);
      currentInterval = interval;
    }
    if (current.length > 0) sections.push(current);
    return sections.flatMap(groupMessagesForDisplay);
  }, [nodes, transcript?.loadedIntervals]);
  const displayEntriesByGroup = useMemo(() => new Map(groups.map((group) => (
    [group.id, groupActivityItemsForDisplay(group.nodes)] as const
  ))), [groups]);
  const turns = useMemo(() => extractTurns(nodes), [nodes]);
  const liveLabel = deriveLiveLabel(turns, streaming);
  const tokenCount = deriveTokenCount(turns);
  const hasContent = nodes.length > 0;
  const hasPermissionCard = Boolean(activePermissionRequest && onPermissionRespond);
  const measuredGroupSizes = measuredGroupSizesByScope.scope === extentScope
    ? measuredGroupSizesByScope.sizes
    : {};
  const structureHeights = useMemo(() => {
    if (!transcript?.structure || transcript.structure.total !== transcript.total) return null;
    const prefix = new Float64Array(transcript.total + 1);
    for (const row of transcript.structure.rows) {
      const base = row.type === 'user_message' ? 110
        : row.type === 'assistant_message' ? 155
        : row.type === 'thinking' ? 55
        : row.type === 'tool_use' || row.type === 'tool_result' ? 42
        : 48;
      const size = Math.min(90, Math.log2(1 + Math.max(0, row.record_length)) * 4);
      prefix[row.position + 1] = Math.max(MIN_CANONICAL_POSITION_HEIGHT, Math.round(base + size));
    }
    for (let i = 0; i < transcript.total; i += 1) prefix[i + 1] += prefix[i];
    return prefix;
  }, [transcript?.structure, transcript?.total]);
  const estimatedRangeHeight = useCallback((start: number, end: number) =>
    structureHeights
      ? structureHeights[end + 1] - structureHeights[start]
      : (end - start + 1) * ESTIMATED_ROW_HEIGHT,
  [structureHeights]);

  const items = useMemo<VirtualItem[]>(() => {
    const groupPositions = groups.map((group) => group.nodes
        .map((node) => renderNodePosition(node, null))
        .find((candidate): candidate is number => candidate !== null) ?? Number.MAX_SAFE_INTEGER);
    const groupIntervals = groupPositions.map((position) => transcript?.loadedIntervals.findIndex((interval) => (
      position >= interval.start && position <= interval.end
    )) ?? -1);
    const contentItems: Array<{ item: VirtualItem; position: number }> = groups.map((group, index) => {
      const position = groupPositions[index];
      const intervalIndex = groupIntervals[index];
      const interval = intervalIndex >= 0 ? transcript?.loadedIntervals[intervalIndex] : undefined;
      const nextPosition = groupIntervals[index + 1] === intervalIndex
        ? groupPositions[index + 1]
        : interval?.end === undefined ? position + 1 : interval.end + 1;
      const spanStart = groupIntervals[index - 1] === intervalIndex ? position : interval?.start ?? position;
      const estimatedSize = interval
        ? Math.max(1, estimatedRangeHeight(spanStart, Math.max(spanStart, nextPosition) - 1))
        : ESTIMATED_ROW_HEIGHT;
      return {
        item: { kind: 'group', id: group.id, group, estimatedSize },
        position,
      };
    });
    const groupedItems: VirtualItem[] = [];
    if (transcript) {
      const missingRanges = missingPositionRanges(transcript.total, transcript.loadedIntervals);
      const gaps: Array<{ item: VirtualItem; position: number }> = missingRanges.map((range) => {
        const key = `gap:${range.start}:${range.end}`;
        const scopeKey = `${historyScope}:${key}`;
        return {
          item: {
            kind: 'history',
            id: `history:${scopeKey}`,
            state: {
              kind: 'gap',
              key: scopeKey,
              start: range.start,
              end: range.end,
              extentHeight: estimatedRangeHeight(range.start, range.end),
              loadState: historyLoadStates[scopeKey] ?? 'idle',
            },
          },
          position: range.start,
        };
      });
      const positionedItems = [...contentItems, ...gaps].sort((left, right) => {
        const positionOrder = left.position - right.position;
        if (positionOrder !== 0) return positionOrder;
        if (left.item.kind !== right.item.kind) return left.item.kind === 'history' ? -1 : 1;
        return left.item.id.localeCompare(right.item.id);
      });
      groupedItems.push(...positionedItems.map(({ item }) => item));
    } else {
      groupedItems.push(...contentItems.map(({ item }) => item));
    }
    if (streaming) {
      groupedItems.push({ kind: 'live', id: 'stream-live-tail' });
    }
    if (activePermissionRequest && onPermissionRespond) {
      groupedItems.push({ kind: 'permission', id: `permission:${activePermissionRequest.id}` });
    }
    return groupedItems;
  }, [
    activePermissionRequest,
    estimatedRangeHeight,
    groups,
    historyLoadStates,
    historyScope,
    onPermissionRespond,
    streaming,
    transcript,
  ]);

  const getItemKey = useCallback((index: number) => items[index]?.id ?? index, [items]);
  const extractVirtualRows = useCallback((range: Range): number[] => defaultRangeExtractor(range), []);
  const getScrollElement = useCallback(() => scrollRef.current, []);
  const initialEstimatedExtent = items.reduce((sum, item) => (
    sum + (item.kind === 'history'
      ? item.state.extentHeight
      : item.kind === 'group' && measuredGroupSizes[item.id]
        ? measuredGroupSizes[item.id]
        : item.kind === 'group' ? item.estimatedSize : ESTIMATED_ROW_HEIGHT)
  ), 0);
  const recordMeasuredGroupSize = useCallback((key: string, size: number) => {
    setMeasuredGroupSizesByScope((current) => {
      if (extentScopeRef.current !== extentScope) return current;
      const sizes = current.scope === extentScope ? current.sizes : {};
      if (sizes[key] === size) return current;
      return { scope: extentScope, sizes: { ...sizes, [key]: size } };
    });
  }, [extentScope]);
  const measureVirtualItem = useCallback((element: HTMLDivElement, entry?: ResizeObserverEntry) => {
    const size = measureVirtualRow(element, entry);
    if (element.dataset.virtualKind === 'group') {
      const key = element.dataset.virtualKey;
      if (key) recordMeasuredGroupSize(key, size);
    }
    return size;
  }, [recordMeasuredGroupSize]);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: items.length,
    getScrollElement,
    estimateSize: (index) => estimateVirtualRow(index, items, measuredGroupSizes),
    measureElement: measureVirtualItem,
    getItemKey,
    initialOffset: Math.max(0, initialEstimatedExtent - 720),
    initialRect: INITIAL_VIRTUAL_RECT,
    observeElementRect: observeChatElementRect,
    rangeExtractor: extractVirtualRows,
    overscan: 4,
    anchorTo: followingTail ? 'end' : 'start',
    followOnAppend: followingTail ? 'auto' : false,
    scrollEndThreshold: FOLLOW_THRESHOLD_PX,
  });
  // A newly materialized group can be much taller than its structure estimate.
  // Correct the viewport only when that entire row is above the reading edge;
  // measuring a row that spans the edge must not move an upward-scrolling user.
  // Keep TanStack's backward-scroll suppression for later remeasurements.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => (
    item.end <= (instance.scrollElement?.scrollTop ?? instance.scrollOffset ?? 0) + instance.scrollAdjustments
    && (!instance.itemSizeCache.has(item.key) || instance.scrollDirection !== 'backward')
  );
  const virtualItems = virtualizer.getVirtualItems();
  useLayoutEffect(() => {
    items.forEach((item, index) => {
      if (item.kind === 'history') {
        virtualizer.resizeItem(index, Math.max(1, Math.round(item.state.extentHeight)));
      }
    });
  }, [items, virtualizer]);
  const estimatedUnmaterializedDistance = transcript
    ? 0
    : Math.max(0, unmaterializedAfterCount) * ESTIMATED_ROW_HEIGHT;
  const showJumpToLatest = shouldShowJumpToLatest(
    Math.max(distanceFromBottom, estimatedUnmaterializedDistance),
    viewportHeight,
  );
  const requestHistory = useCallback((
    key: string,
    load: () => ConversationHistoryLoadResult | Promise<ConversationHistoryLoadResult>,
  ): Promise<void> => {
    const current = inFlightHistoryRef.current.get(key);
    if (current) return current;
    const scope = historyScope;
    setHistoryLoadStates((states) => ({ ...states, [key]: 'loading' }));
    const promise = Promise.resolve()
      .then(load)
      .then(
        (): HistoryLoadState => 'retry',
        (): HistoryLoadState => 'retry',
      )
      .then((nextState) => {
        if (inFlightHistoryRef.current.get(key) !== promise) return;
        inFlightHistoryRef.current.delete(key);
        if (historyScopeRef.current !== scope) {
          setHistoryLoadStates({});
          return;
        }
        setHistoryLoadStates((states) => ({ ...states, [key]: nextState }));
      });
    inFlightHistoryRef.current.set(key, promise);
    return promise;
  }, [historyScope]);

  const findAnchorItemIndex = useCallback((anchor: Pick<ReadingAnchor, 'itemId' | 'blockId' | 'position'>): number => {
    if (anchor.blockId) {
      const blockIndex = items.findIndex((item) => item.kind === 'group'
        && item.group.nodes.some((node) => renderNodeContainsBlock(node, anchor.blockId!)));
      if (blockIndex >= 0) return blockIndex;
    }
    if (anchor.position !== null) {
      const positionIndex = items.findIndex((item) => item.kind === 'group'
        && item.group.nodes.some((node) => renderNodeBlockIdAtPosition(node, anchor.position!) !== null));
      if (positionIndex >= 0) return positionIndex;
      const gapIndex = items.findIndex((item) => item.kind === 'history'
        && anchor.position! >= item.state.start && anchor.position! <= item.state.end);
      if (gapIndex >= 0) return gapIndex;
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
    const blockCandidates = row
      ? Array.from(row.querySelectorAll<HTMLElement>('[data-block-id], [data-member-refs]'))
      : [];
    const visibleBlock = blockCandidates.find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.bottom > scrollRect.top && rect.top < scrollRect.bottom;
    }) ?? blockCandidates[0] ?? null;
    const blockIdValue = visibleBlock?.dataset.blockId
      ?? visibleBlock?.dataset.memberRefs?.trim().split(/\s+/).find(Boolean)
      ?? null;
    const node = item.kind === 'group'
      ? item.group.nodes.find((candidate) => !blockIdValue || renderNodeContainsBlock(candidate, blockIdValue))
      : undefined;
    const historyPosition = item.kind === 'history'
      ? historyPositionAtOffset(item.state, virtualItem.start, virtualItem.size, offset)
      : null;
    const anchor: ReadingAnchor = {
      version: 1,
      itemId: item.id,
      blockId: blockIdValue,
      position: node
        ? renderNodePosition(node, blockIdValue)
        : historyPosition,
      viewportOffset: visibleBlock
        ? visibleBlock.getBoundingClientRect().top - scrollRect.top
        : item.kind === 'history' && historyPosition !== null
          ? virtualItem.start + estimatedRangeHeight(item.state.start, historyPosition - 1) - offset
        : virtualItem.start - offset,
      followingTail: followingTailOverride ?? followingTail,
    };
    readingAnchorRef.current = anchor;
    storageSet(scrollStorageKey, JSON.stringify(anchor));
    return anchor;
  }, [estimatedRangeHeight, followingTail, items, scrollStorageKey, virtualizer]);

  const restoreReadingAnchor = useCallback((anchor: ReadingAnchor): boolean => {
    const el = scrollRef.current;
    if (!el) return false;
    const requestAnchorPosition = () => {
      if (anchor.position === null || !transcript) return;
      const key = `anchor:${anchor.position}`;
      if ((historyLoadStates[key] ?? 'idle') === 'idle') {
        void requestHistory(key, () => transcript.loadAround(anchor.position!));
      }
    };
    const itemIndex = findAnchorItemIndex(anchor);
    if (itemIndex < 0) {
      requestAnchorPosition();
      return false;
    }
    const item = items[itemIndex];
    const hasSavedBlock = Boolean(anchor.blockId && item.kind === 'group'
      && item.group.nodes.some((node) => renderNodeContainsBlock(node, anchor.blockId!)));
    const positionBlockId = !hasSavedBlock && item.kind === 'group' && anchor.position !== null
      ? item.group.nodes.map((node) => renderNodeBlockIdAtPosition(node, anchor.position!))
        .find((candidate): candidate is string => candidate !== null) ?? null
      : null;
    const resolvedBlockId = hasSavedBlock ? anchor.blockId : positionBlockId;
    if (anchor.blockId && !resolvedBlockId) {
      requestAnchorPosition();
      return false;
    }
    const resolvedAnchor: ReadingAnchor = {
      ...anchor,
      itemId: item.id,
      blockId: resolvedBlockId,
    };
    if (resolvedAnchor.itemId !== anchor.itemId || resolvedAnchor.blockId !== anchor.blockId) {
      readingAnchorRef.current = resolvedAnchor;
      storageSet(scrollStorageKey, JSON.stringify(resolvedAnchor));
    }
    if (item.kind === 'history' && anchor.position !== null) {
      const measurement = virtualizer.measurementsCache[itemIndex];
      if (!measurement) return false;
      const currentOffset = measurement.start
        + estimatedRangeHeight(item.state.start, anchor.position - 1) - el.scrollTop;
      const delta = currentOffset - resolvedAnchor.viewportOffset;
      if (Math.abs(delta) >= 0.5) {
        const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
        pendingReadingAnchorRef.current = resolvedAnchor;
        virtualizer.scrollToOffset(Math.max(0, Math.min(maxScrollTop, el.scrollTop + delta)), { behavior: 'auto' });
        return false;
      }
      pendingReadingAnchorRef.current = null;
      return true;
    }
    const row = Array.from(el.querySelectorAll<HTMLElement>('[data-virtual-key]'))
      .find((candidate) => candidate.dataset.virtualKey === item.id);
    if (!row) {
      pendingReadingAnchorRef.current = resolvedAnchor;
      virtualizer.scrollToIndex(itemIndex, { align: 'start', behavior: 'auto' });
      return false;
    }
    const target = resolvedAnchor.blockId
      ? Array.from(row.querySelectorAll<HTMLElement>('[data-block-id]'))
        .find((candidate) => candidate.dataset.blockId === resolvedAnchor.blockId)
        ?? Array.from(row.querySelectorAll<HTMLElement>('[data-member-refs]'))
          .find((candidate) => hasMemberRef(candidate, resolvedAnchor.blockId!))
      : row;
    if (!target) return false;
    const currentOffset = resolvedAnchor.blockId
      ? target.getBoundingClientRect().top - el.getBoundingClientRect().top
      : (virtualizer.getVirtualItems().find((candidate) => candidate.index === itemIndex)?.start ?? el.scrollTop) - el.scrollTop;
    const delta = currentOffset - resolvedAnchor.viewportOffset;
    if (Math.abs(delta) >= 0.5) {
      const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
      const targetScrollTop = Math.max(0, Math.min(maxScrollTop, el.scrollTop + delta));
      if (Math.abs(targetScrollTop - el.scrollTop) >= 0.5) {
        pendingReadingAnchorRef.current = resolvedAnchor;
        virtualizer.scrollToOffset(targetScrollTop, { behavior: 'auto' });
        return false;
      }
    }
    pendingReadingAnchorRef.current = null;
    return true;
  }, [estimatedRangeHeight, findAnchorItemIndex, historyLoadStates, items, requestHistory, scrollStorageKey, transcript, virtualizer]);

  // Chat disclosures are transient reading state. A new conversation or page
  // refresh starts from each block's declared default instead of reviving old
  // tool/thinking expansion choices from browser storage.
  // Reset scroll state before the stored-anchor layout effect below. A passive
  // reset runs after that restoration and would erase the anchor it just read.
  useLayoutEffect(() => {
    setExpandedBlocks({});
    setHistoryLoadStates({});
    pendingReadingAnchorRef.current = null;
    readingAnchorRef.current = null;
    userScrollIntentRef.current = false;
    userScrollAwayFromTailRef.current = false;
    lastUserScrollTopRef.current = null;
    inFlightHistoryRef.current.clear();
  }, [storageScope]);

  useEffect(() => {
    if (historyStateScopeRef.current === historyScope) return;
    historyStateScopeRef.current = historyScope;
    setHistoryLoadStates({});
  }, [historyScope]);

  useEffect(() => {
    if (expansionOwnerScopeRef.current === expansionOwnerScope) return;
    expansionOwnerScopeRef.current = expansionOwnerScope;
    setExpandedBlocks({});
  }, [expansionOwnerScope]);

  const setScrollNode = useCallback((node: HTMLDivElement | null) => {
    scrollEndCleanupRef.current?.();
    scrollEndCleanupRef.current = null;
    scrollRef.current = node;
    registerScrollOwner?.(node);
    if (node) {
      const handleScrollEnd = () => {
        userScrollIntentRef.current = false;
        userScrollAwayFromTailRef.current = false;
        lastUserScrollTopRef.current = null;
      };
      node.addEventListener('scrollend', handleScrollEnd);
      scrollEndCleanupRef.current = () => node.removeEventListener('scrollend', handleScrollEnd);
      setViewportHeight(node.clientHeight || 720);
    }
  }, [registerScrollOwner]);

  useLayoutEffect(() => {
    if (!scrollRef.current || restoredScrollScopeRef.current === scrollStorageKey || items.length === 0) return;
    restoredScrollScopeRef.current = scrollStorageKey;
    const storedAnchor = parseReadingAnchor(storageGet(scrollStorageKey));
    if (navigationTarget) return;
    if (storedAnchor) {
      readingAnchorRef.current = storedAnchor;
      if (storedAnchor.followingTail) {
        pendingReadingAnchorRef.current = null;
        setFollowingTail(true);
        virtualizer.scrollToEnd({ behavior: 'auto' });
      } else {
        pendingReadingAnchorRef.current = storedAnchor;
        setFollowingTail(false);
        restoreReadingAnchor(storedAnchor);
      }
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
    if (navigationTarget.kind === 'latest') {
      pendingReadingAnchorRef.current = null;
      userScrollIntentRef.current = false;
      const tailAnchor = tailReadingAnchor(items.at(-1)?.id ?? 'tail');
      readingAnchorRef.current = tailAnchor;
      storageSet(scrollStorageKey, JSON.stringify(tailAnchor));
    }
    pendingFocusRef.current = navigationTarget.kind === 'initial' || navigationTarget.kind === 'latest'
      ? null
      : { key: navigationTarget.key, blockId: navigationTarget.blockId ?? null, itemId: items[itemIndex].id };
    setFollowingTail(navigationTarget.kind === 'latest'
      || (navigationTarget.kind === 'initial' && !transcript?.hasNewer));
    if (navigationTarget.kind === 'initial' || navigationTarget.kind === 'latest') {
      virtualizer.scrollToEnd({ behavior });
      onNavigationResult?.({ key: navigationTarget.key, status: 'revealed' });
    } else {
      virtualizer.scrollToIndex(itemIndex, { align: 'center', behavior });
    }
    setDistanceFromBottom(navigationTarget.kind === 'initial' || navigationTarget.kind === 'latest'
      ? 0
      : virtualizer.getDistanceFromEnd());
  }, [items, navigationTarget, onNavigationResult, scrollStorageKey, transcript?.hasNewer, virtualizer]);

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
    if (userScrollIntentRef.current) {
      pendingReadingAnchorRef.current = null;
      return;
    }
    restoreReadingAnchor(pending);
  }, [distanceFromBottom, expandedBlocks, items, navigationTarget, restoreReadingAnchor, virtualItems]);

  useLayoutEffect(() => {
    const signature = items.map((item) => item.kind === 'history'
      ? `${item.id}:${Math.round(item.state.extentHeight)}`
      : `${item.id}:${item.kind === 'group' ? measuredGroupSizes[item.id] ?? 0 : 0}`)
      .join('\0');
    const previous = itemIdentitySignatureRef.current;
    itemIdentitySignatureRef.current = signature;
    if (previous === null || previous === signature || navigationTarget) return;
    if (userScrollIntentRef.current) return;
    const anchor = readingAnchorRef.current;
    if (!anchor || anchor.followingTail) return;
    pendingReadingAnchorRef.current = anchor;
    restoreReadingAnchor(anchor);
  }, [items, measuredGroupSizes, navigationTarget, restoreReadingAnchor]);

  useEffect(() => {
    if (!transcript) return;
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
      if (!userScrollIntentRef.current) {
        const anchor = captureReadingAnchor();
        if (anchor && !anchor.followingTail) pendingReadingAnchorRef.current = anchor;
      }
      void requestHistory(key, load);
    };
    for (const item of items) {
      if (item.kind !== 'history') continue;
      const { start, end, key, loadState } = item.state;
      const row = rendered.find((candidate) => items[candidate.index]?.id === item.id);
      if (!row || loadState !== 'idle'
          || row.end < scrollStart - prefetchDistance
          || row.start > scrollEnd + prefetchDistance) continue;
      const visibleStart = Math.max(row.start, scrollStart);
      const visibleEnd = Math.min(row.end, scrollEnd);
      const targetOffset = visibleStart <= visibleEnd
        ? (visibleStart + visibleEnd) / 2
        : row.start > scrollEnd ? row.start : row.end;
      const rowHeight = Math.max(1, row.end - row.start);
      const fraction = Math.max(0, Math.min(1, (targetOffset - row.start) / rowHeight));
      const position = Math.max(start, Math.min(end, Math.floor(start + fraction * (end - start + 1))));
      requestWithAnchor(key, () => transcript.loadAround(position));
      return;
    }
  }, [
    captureReadingAnchor,
    distanceFromBottom,
    historyLoadStates,
    items,
    requestHistory,
    transcript,
    virtualItems,
    viewportHeight,
    virtualizer,
  ]);

  function handleUserScrollIntent(awayFromTail = false): void {
    // Direct scroll input supersedes a deferred virtual-row restore. The ensuing
    // scroll event captures the new anchor before data can change.
    userScrollIntentRef.current = true;
    userScrollAwayFromTailRef.current = awayFromTail;
    lastUserScrollTopRef.current = scrollRef.current?.scrollTop ?? null;
    pendingReadingAnchorRef.current = null;
    setFollowingTail(false);
    setHistoryLoadStates((states) => {
      const pending = Object.entries(states).filter(([, state]) => state === 'loading');
      return pending.length === Object.keys(states).length ? states : Object.fromEntries(pending);
    });
  }

  function handleUserScrollPointer(event: PointerEvent): void {
    if (event.target === event.currentTarget) handleUserScrollIntent();
  }

  function handleUserScrollKey(event: KeyboardEvent): void {
    const target = event.target;
    if (event.defaultPrevented || (target instanceof HTMLElement
        && (target.isContentEditable || target.matches('input, textarea, select')))) return;
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
      handleUserScrollIntent(['ArrowUp', 'PageUp', 'Home'].includes(event.key));
    }
  }

  function handleScroll(): void {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const nextViewportHeight = el.clientHeight || viewportHeight;
    const nextDistance = Math.max(0, el.scrollHeight - el.scrollTop - nextViewportHeight);
    const userScrollIntent = userScrollIntentRef.current;
    setViewportHeight(nextViewportHeight);
    setDistanceFromBottom(nextDistance);
    if (pendingReadingAnchorRef.current && !userScrollIntent) return;
    if (!userScrollIntent) return;
    pendingReadingAnchorRef.current = null;
    const movingDown = lastUserScrollTopRef.current === null || el.scrollTop >= lastUserScrollTopRef.current;
    lastUserScrollTopRef.current = el.scrollTop;
    const nextFollowingTail = nextDistance <= FOLLOW_THRESHOLD_PX
      && movingDown
      && !userScrollAwayFromTailRef.current
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

  function requestExpandedDetails(sources: readonly (PersistedBlockSource | undefined)[]): void {
    const unloaded = [...new Map(sources
      .filter((source): source is PersistedBlockSource => source?.detailsLoaded === false)
      .map((source) => [source.blockId, source])).values()];
    if (unloaded.length > 0) void onExpandDetails?.(unloaded);
  }

  function setBlockExpanded(
    id: string,
    expanded: boolean,
    sources: readonly (PersistedBlockSource | undefined)[] = [],
  ): void {
    const anchor = captureReadingAnchor();
    if (anchor) pendingReadingAnchorRef.current = anchor;
    if (expanded) requestExpandedDetails(sources);
    setExpandedBlocks((current) => {
      return { ...current, [id]: expanded };
    });
  }

  const detailRefreshScopeRef = useRef({ owner: expansionOwnerScope, source: historyScope });
  useEffect(() => {
    const previous = detailRefreshScopeRef.current;
    detailRefreshScopeRef.current = { owner: expansionOwnerScope, source: historyScope };
    if (previous.owner !== expansionOwnerScope || previous.source === historyScope) return;

    // Resolve already-expanded individual rows from the exact display entries
    // used below, including inline activities extracted from assistant turns.
    const sourcesByKey = new Map<string, PersistedBlockSource[]>();
    const add = (key: string, sources: Array<PersistedBlockSource | undefined>) => {
      const available = sources.filter((source): source is PersistedBlockSource => Boolean(source));
      if (available.length > 0) sourcesByKey.set(key, available);
    };
    const addNode = (node: RenderNode) => {
      if (node.kind === 'activity') {
        add(`activity:${node.key}`, [
          node.source,
          node.item.type === 'tool-call-activity' ? node.item.result?.source : undefined,
        ]);
      } else if (node.kind === 'unmatched_tool_result') {
        add(`unmatched-tool-result:${node.key}`, [node.result.source]);
      } else if (node.kind === 'assistant_turn') {
        node.turn.assistantEvent.message.content.forEach((block, index) => {
          add(blockId(node.turn.id, block, index), [
            block.source,
            block.type === 'tool_use' ? node.turn.toolResults.get(block.id)?.source : undefined,
          ]);
        });
      }
    };
    for (const entries of displayEntriesByGroup.values()) {
      for (const entry of entries) {
        if (entry.kind === 'node') addNode(entry.node);
        else entry.nodes.forEach(addNode);
      }
    }
    const expandedSources = Object.entries(expandedBlocks)
      .filter(([, expanded]) => expanded)
      .flatMap(([key]) => sourcesByKey.get(key) ?? []);
    requestExpandedDetails(expandedSources);
  }, [displayEntriesByGroup, expandedBlocks, expansionOwnerScope, historyScope, onExpandDetails]);

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

  function renderNodeBody(node: RenderNode, memberRef?: string): JSX.Element | null {
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
        const disclosureKey = `unmatched-tool-result:${node.key}`;
        return (
          <div key={node.key} className="message-block-wrapper" data-block-id={source?.blockId}>
            <UnmatchedToolResultBlock
              result={node.result}
              expanded={expandedBlocks[disclosureKey]}
              onExpandedChange={(next) => setBlockExpanded(disclosureKey, next, [source])}
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

      case 'activity': {
        const source = node.source;
        const sourceBlockId = source?.blockId
          ?? (node.item.type === 'provider-directive' ? node.item.blockId ?? undefined : undefined);
        const disclosureKey = `activity:${node.key}`;
        const defaultExpanded = node.item.type === 'thinking-block-activity'
          && streaming
          && node.item.turnId === lastAssistantTurnId;
        const expanded = expandedBlocks[disclosureKey] ?? defaultExpanded;
        let activity: JSX.Element;
        if (node.item.type === 'tool-call-activity') {
          const resultSource = node.item.result?.source;
          activity = (
            <ToolUseBlock
              toolName={node.item.name}
              toolKind={node.item.toolKind}
              toolUseId={node.item.id}
              input={node.item.input}
              result={node.item.result}
              defaultExpanded={false}
              expanded={expanded}
              onExpandedChange={(next) => setBlockExpanded(disclosureKey, next, [source, resultSource])}
              resultSelected={resultSource ? selectedBlockIds?.has(resultSource.blockId) : false}
              selectMode={selectMode}
              onToggleResultSelect={resultSource && onToggleBlockSelect
                ? (shiftKey) => onToggleBlockSelect(resultSource.blockId, shiftKey)
                : undefined}
              onForkResult={resultSource?.dagUuid && onFork ? () => onFork(resultSource.dagUuid!) : undefined}
              onResumeResult={resultSource?.dagUuid && onResume ? () => onResume(resultSource.dagUuid!) : undefined}
            />
          );
        } else if (node.item.type === 'thinking-block-activity') {
          activity = (
            <ThinkingBlock
              content={node.item.content}
              defaultCollapsed={!defaultExpanded}
              expanded={expanded}
              detailsAvailable={source?.detailsLoaded === false}
              onExpandedChange={(next) => setBlockExpanded(disclosureKey, next, [source])}
            />
          );
        } else {
          activity = (
            <ActivityRow
              item={node.item}
              expanded={expanded}
              detailsAvailable={source?.detailsLoaded === false}
              onExpandedChange={(next) => setBlockExpanded(disclosureKey, next, [source])}
              onCreatedTaskNavigate={onCreatedTaskNavigate}
            />
          );
        }
        return (
          <div key={node.key} className="message-block-wrapper" data-block-id={sourceBlockId} data-member-refs={memberRef}>
            {activity}
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
              onBlockExpandedChange={(contentBlock, index, expanded, relatedSources = []) => (
                setBlockExpanded(blockId(turn.id, contentBlock, index), expanded, [contentBlock.source, ...relatedSources])
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
        {(displayEntriesByGroup.get(group.id) ?? []).map((entry) => {
          if (entry.kind === 'node') return renderNodeBody(entry.node);
          const memberRefs = entry.nodes.map((node) => node.source?.blockId
            ?? (node.item.type === 'provider-directive' ? node.item.blockId : null)
            ?? node.key);
          const groupDisclosureKey = `activity-group:${entry.key}`;
          const defaultGroupExpanded = expandedBlocks[entry.key] ?? (streaming && entry.nodes.some((node) => (
            node.item.type === 'thinking-block-activity' && node.item.turnId === lastAssistantTurnId
          )));
          return (
            <div
              key={entry.key}
              className="message-block-wrapper"
              data-member-refs={[...new Set(memberRefs)].join(' ')}
            >
              <ActivityGroup
                items={entry.nodes.map((node) => node.item)}
                memberRefs={memberRefs}
                renderMember={(_, index) => renderNodeBody(entry.nodes[index], memberRefs[index])}
                expanded={expandedBlocks[groupDisclosureKey] ?? defaultGroupExpanded}
                onExpandedChange={(next) => setBlockExpanded(groupDisclosureKey, next)}
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
      return (
        <div
          className="stream-renderer__history-state"
          style={{ height: `${state.extentHeight}px`, boxSizing: 'border-box' }}
          aria-hidden="true"
        />
      );
    }
    return (
      <div
        className="stream-renderer__history-state"
        style={{ height: `${state.extentHeight}px`, boxSizing: 'border-box' }}
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
        onWheel={(event) => handleUserScrollIntent(event.deltaY < 0)}
        onTouchMove={() => handleUserScrollIntent()}
        onKeyDown={handleUserScrollKey}
      >
        <div className="stream-renderer__virtual-canvas" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          {virtualItems.map((virtualItem) => {
            const item = items[virtualItem.index];
            if (!item) return null;
            return (
              <div
                key={virtualItem.key}
                ref={item.kind === 'history' ? undefined : virtualizer.measureElement}
                className="stream-renderer__virtual-row"
                data-index={virtualItem.index}
                data-virtual-key={item.id}
                data-virtual-kind={item.kind}
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
