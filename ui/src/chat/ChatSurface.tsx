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
  ConversationNavigationCommand,
  ConversationNavigationResult,
  ConversationTranscriptConsumer,
} from '../query/conversationData';
import {
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
// Match --space-7: the virtualizer must include the top inset in its offsets.
const SCROLL_TOP_INSET_PX = 32;
const HISTORY_WINDOW_POSITIONS = 500;
const HISTORY_WINDOW_BEFORE = Math.floor((HISTORY_WINDOW_POSITIONS - 1) / 2);
const MIN_CANONICAL_POSITION_HEIGHT = 1;
const FOLLOW_THRESHOLD_PX = 1;
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
  | { kind: 'permission'; id: string };

type HistoryRowState = {
  kind: 'gap';
  key: string;
  start: number;
  end: number;
  extentHeight: number;
};

function historyPositionAtOffset(
  state: HistoryRowState,
  rowStart: number,
  offset: number,
  prefix: Float64Array | null,
): number {
  const local = Math.max(0, Math.min(state.extentHeight - 1, offset - rowStart));
  if (!prefix) return Math.min(state.end, state.start + Math.floor(local / ESTIMATED_ROW_HEIGHT));
  const absolute = prefix[state.start] + local;
  let low = state.start;
  let high = state.end;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (prefix[middle] <= absolute) low = middle;
    else high = middle - 1;
  }
  return low;
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
  if (block.contentKey) return block.contentKey;
  if (block.type === 'tool_use') {
    return `tool:${block.id}`;
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
  if (node.kind === 'transcript_boundary') return false;
  if (node.key === targetBlockId) return true;
  if (node.kind === 'user_message') return node.persisted?.blockId === targetBlockId;
  if (node.kind === 'semantic_event') return node.event.source.blockId === targetBlockId;
  if (node.kind === 'unmatched_tool_result') return node.result.source?.blockId === targetBlockId;
  if (node.kind !== 'assistant_turn') return node.source?.blockId === targetBlockId;
  return node.turn.assistantEvent.message.content.some((block) => block.source?.blockId === targetBlockId)
    || Array.from(node.turn.toolResults.values()).some((result) => result.source?.blockId === targetBlockId);
}

function renderNodePosition(node: RenderNode, targetBlockId: string | null): number | null {
  if (node.kind === 'transcript_boundary') return null;
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
  if (node.kind === 'transcript_boundary') return null;
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
  const scrollElementId = `chat-scroll-${storageScope.replace(/[^A-Za-z0-9_-]/g, '-')}`;

  const [viewportHeight, setViewportHeight] = useState(720);
  const [distanceFromBottom, setDistanceFromBottom] = useState(0);
  const [followingTail, setFollowingTail] = useState(false);
  const [historyFailure, setHistoryFailure] = useState<{ position: number; message: string } | null>(null);
  const [historyRevision, setHistoryRevision] = useState(0);
  const inFlightHistoryRef = useRef(new Map<number, { start: number; end: number; controller: AbortController }>());
  const attemptedHistoryRef = useRef(new Set<number>());
  const waitingHistoryRef = useRef(new Set<number>());
  const lastTranscriptRef = useRef(transcript);
  const coverageSignatureRef = useRef('');
  const previousScrollTopRef = useRef<number | null>(null);
  const previousScrollHeightRef = useRef<number | null>(null);
  const previousViewportHeightRef = useRef<number | null>(null);
  const userScrollIntentRef = useRef<'toward-tail' | 'away' | null>(null);
  const scrollDirectionRef = useRef<'up' | 'down'>('up');
  const tailIntentRef = useRef(false);
  const scrollbarTrackRef = useRef<HTMLDivElement>(null);
  const scrollbarThumbRef = useRef<HTMLDivElement>(null);
  const scrollbarDragRef = useRef<{
    pointerId: number;
    pointerY: number;
    grabOffset: number;
    thumbHeight: number;
  } | null>(null);
  const finishScrollbarDragRef = useRef<(event?: PointerEvent) => void>(() => {});
  const [scrollbarDragging, setScrollbarDragging] = useState(false);
  const [measuredGroupSizesByScope, setMeasuredGroupSizesByScope] = useState<{
    scope: string;
    sizes: Readonly<Record<string, number>>;
  }>({ scope: '', sizes: {} });
  const [expandedBlocks, setExpandedBlocks] = useState<Record<string, boolean>>({});
  const handledNavigationKeyRef = useRef<string | null>(null);
  const pendingFocusRef = useRef<{ key: string; blockId: string | null; itemId: string } | null>(null);
  const restoredScrollScopeRef = useRef<string | null>(null);
  const pendingReadingAnchorRef = useRef<ReadingAnchor | null>(null);
  const streamUpdateAnchorRef = useRef<ReadingAnchor | null>(null);
  const currentReadingAnchorRef = useRef<ReadingAnchor | null>(null);
  const lastMeasuredSizesRef = useRef(measuredGroupSizesByScope);
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
  const hasPendingPersistence = events.some((event) => event.type === 'chat:item' && event.persistencePending);
  const [showPendingPersistence, setShowPendingPersistence] = useState(false);
  useEffect(() => {
    setShowPendingPersistence(false);
    if (!hasPendingPersistence) return;
    const timer = window.setTimeout(() => setShowPendingPersistence(true), 10000);
    return () => window.clearTimeout(timer);
  }, [hasPendingPersistence, expansionOwnerScope]);
  const hasContent = nodes.length > 0;
  const hasPermissionCard = Boolean(activePermissionRequest && onPermissionRespond);
  const measuredGroupSizes = measuredGroupSizesByScope.scope === extentScope
    ? measuredGroupSizesByScope.sizes
    : {};
  const structureHeights = useMemo(() => {
    if (!transcript?.structure || transcript.structure.total !== transcript.total) return null;
    const prefix = new Float64Array(transcript.total + 1);
    let activityParent: number | null = null;
    let activityRun = false;
    for (const row of transcript.structure.rows) {
      const message = row.type === 'user_message' || row.type === 'assistant_message';
      const activity = row.type === 'tool_use' || row.type === 'thinking';
      const base = row.type === 'user_message' ? 110 : 155;
      const size = Math.min(90, Math.log2(1 + Math.max(0, row.record_length)) * 4);
      // Most structural records are invisible or merge into a nearby activity.
      // Give them a locator without charging a full visible row to the scrollbar.
      prefix[row.position + 1] = message ? Math.round(base + size)
        : activity ? activityRun && activityParent === row.parent_position ? 2 : 64
          : MIN_CANONICAL_POSITION_HEIGHT;
      if (message) activityRun = false;
      else if (activity) {
        activityRun = true;
        activityParent = row.parent_position;
      }
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
        return {
          item: {
            kind: 'history',
            id: `history:${historyScope}:${key}`,
            state: {
              kind: 'gap',
              key,
              start: range.start,
              end: range.end,
              extentHeight: estimatedRangeHeight(range.start, range.end),
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
    if (activePermissionRequest && onPermissionRespond) {
      groupedItems.push({ kind: 'permission', id: `permission:${activePermissionRequest.id}` });
    }
    return groupedItems;
  }, [
    activePermissionRequest,
    estimatedRangeHeight,
    groups,
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
  const syncScrollbar = useCallback(() => {
    const scroll = scrollRef.current;
    const track = scrollbarTrackRef.current;
    const thumb = scrollbarThumbRef.current;
    if (!scroll || !track || !thumb || !track.parentElement) return;
    const scrollRect = scroll.getBoundingClientRect();
    const parentRect = track.parentElement.getBoundingClientRect();
    track.style.top = `${scrollRect.top - parentRect.top}px`;
    track.style.height = `${scrollRect.height}px`;
    const maxTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    track.style.display = maxTop > 0 ? '' : 'none';
    if (maxTop <= 0) return;
    const drag = scrollbarDragRef.current;
    const thumbHeight = drag?.thumbHeight ?? Math.min(scrollRect.height,
      Math.max(30, scrollRect.height * scroll.clientHeight / scroll.scrollHeight));
    const travel = Math.max(0, scrollRect.height - thumbHeight);
    let progress = Math.max(0, Math.min(1, scroll.scrollTop / maxTop));
    if (drag) {
      const thumbTop = drag.pointerY - scrollRect.top - drag.grabOffset;
      // Subpixel pointer coordinates can leave a visually bottomed thumb many
      // content pixels short in a long transcript. Snap only at track edges.
      const edge = Math.min(1, travel / 2);
      progress = thumbTop <= edge ? 0
        : thumbTop >= travel - edge ? 1
          : thumbTop / travel;
    }
    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translate3d(0, ${progress * travel}px, 0)`;
    thumb.setAttribute('aria-valuenow', String(Math.round(progress * 1000)));
    thumb.setAttribute('aria-valuetext', `${Math.round(progress * 100)}%`);
    if (drag) {
      const target = progress * maxTop;
      if (Math.abs(scroll.scrollTop - target) >= 0.5) scroll.scrollTop = target;
    }
  }, []);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: items.length,
    getScrollElement,
    estimateSize: (index) => estimateVirtualRow(index, items, measuredGroupSizes),
    measureElement: measureVirtualItem,
    getItemKey,
    initialOffset: Math.max(0, initialEstimatedExtent - 720),
    initialRect: INITIAL_VIRTUAL_RECT,
    paddingStart: SCROLL_TOP_INSET_PX,
    observeElementRect: observeChatElementRect,
    rangeExtractor: extractVirtualRows,
    overscan: 4,
    directDomUpdates: true,
    anchorTo: scrollbarDragging ? 'start' : 'end',
    followOnAppend: followingTail && !scrollbarDragging ? 'auto' : false,
    scrollEndThreshold: followingTail && !scrollbarDragging ? FOLLOW_THRESHOLD_PX : -1,
    onChange: syncScrollbar,
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    if (scrollbarDragRef.current !== null) return false;
    const readingPoint = (instance.scrollElement?.scrollTop ?? instance.scrollOffset ?? 0)
      + instance.scrollAdjustments;
    // First measurements replace an estimate; later growth only moves the
    // reading point when the entire old row is above it, even while moving up.
    return instance.itemSizeCache.has(item.key)
      ? item.end <= readingPoint
      : item.start < readingPoint;
  };
  const virtualItems = virtualizer.getVirtualItems();
  const estimatedUnmaterializedDistance = transcript
    ? 0
    : Math.max(0, unmaterializedAfterCount) * ESTIMATED_ROW_HEIGHT;
  const showJumpToLatest = shouldShowJumpToLatest(
    Math.max(distanceFromBottom, estimatedUnmaterializedDistance),
    viewportHeight,
  );
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
    if (followingTailOverride === true) {
      const anchor = tailReadingAnchor(items.at(-1)?.id ?? 'tail');
      storageSet(scrollStorageKey, JSON.stringify(anchor));
      currentReadingAnchorRef.current = anchor;
      return anchor;
    }
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
      ? historyPositionAtOffset(item.state, virtualItem.start, offset, structureHeights)
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
    storageSet(scrollStorageKey, JSON.stringify(anchor));
    currentReadingAnchorRef.current = anchor;
    return anchor;
  }, [estimatedRangeHeight, followingTail, items, scrollStorageKey, structureHeights, virtualizer]);

  const restoreReadingAnchor = useCallback((
    anchor: ReadingAnchor,
    mode: 'normal' | 'mounted' | 'pending' = 'normal',
  ): boolean => {
    const el = scrollRef.current;
    if (!el) return false;
    const itemIndex = findAnchorItemIndex(anchor);
    const item = itemIndex < 0 ? null : items[itemIndex];
    const measurement = itemIndex < 0 ? null : virtualizer.measurementsCache[itemIndex];
    const row = item ? Array.from(el.querySelectorAll<HTMLElement>('[data-virtual-key]'))
      .find((candidate) => candidate.dataset.virtualKey === item.id) : null;
    const target = row && anchor.blockId
      ? Array.from(row.querySelectorAll<HTMLElement>('[data-block-id]'))
        .find((candidate) => candidate.dataset.blockId === anchor.blockId)
        ?? Array.from(row.querySelectorAll<HTMLElement>('[data-member-refs]'))
          .find((candidate) => hasMemberRef(candidate, anchor.blockId!))
      : row;
    if (mode === 'pending' && target && item?.kind === 'group' && !virtualizer.itemSizeCache.has(item.id)) {
      return false;
    }
    if (mode === 'mounted') {
      if (!anchor.blockId || !target) return false;
      const targetRect = target.getBoundingClientRect();
      const viewportRect = el.getBoundingClientRect();
      if (targetRect.bottom <= viewportRect.top || targetRect.top >= viewportRect.bottom) return false;
    }
    const currentOffset = target
      ? target.getBoundingClientRect().top - el.getBoundingClientRect().top
      : item?.kind === 'history' && measurement && anchor.position !== null
        ? measurement.start + estimatedRangeHeight(item.state.start, anchor.position - 1) - el.scrollTop
        : measurement ? measurement.start - el.scrollTop
          : anchor.position !== null && structureHeights
            ? structureHeights[anchor.position] - el.scrollTop
            : null;
    if (currentOffset === null) return false;
    const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    // Reveal an unmounted destination before applying its saved position
    // within the row. A tall message may span several viewports; applying
    // that intra-message offset to its estimate would leave it unmounted.
    const requestedTop = item?.kind === 'history' || (item?.kind === 'group' && !target)
      ? el.scrollTop + currentOffset
      : el.scrollTop + currentOffset - anchor.viewportOffset;
    const targetTop = Math.max(0, Math.min(maxScrollTop, requestedTop));
    if (Math.abs(targetTop - el.scrollTop) >= 0.5) el.scrollTo({ top: targetTop, behavior: 'auto' });
    if (mode === 'mounted') return true;
    pendingReadingAnchorRef.current = item?.kind === 'history'
      || (item?.kind === 'group' && (!target || !virtualizer.itemSizeCache.has(item.id)))
      ? anchor : null;
    return pendingReadingAnchorRef.current === null;
  }, [estimatedRangeHeight, findAnchorItemIndex, items, structureHeights, virtualizer]);

  // Chat disclosures are transient reading state. A new conversation or page
  // refresh starts from each block's declared default instead of reviving old
  // tool/thinking expansion choices from browser storage.
  // Reset scroll state before the stored-anchor layout effect below. A passive
  // reset runs after that restoration and would erase the anchor it just read.
  useLayoutEffect(() => {
    setExpandedBlocks({});
    pendingReadingAnchorRef.current = null;
    streamUpdateAnchorRef.current = null;
    currentReadingAnchorRef.current = null;
    tailIntentRef.current = false;
    previousScrollTopRef.current = null;
    previousScrollHeightRef.current = null;
    previousViewportHeightRef.current = null;
    userScrollIntentRef.current = null;
  }, [storageScope]);

  useEffect(() => {
    attemptedHistoryRef.current.clear();
    waitingHistoryRef.current.clear();
    coverageSignatureRef.current = '';
    setHistoryFailure(null);
    return () => {
      for (const request of inFlightHistoryRef.current.values()) request.controller.abort();
      inFlightHistoryRef.current.clear();
    };
  }, [historyScope]);

  useEffect(() => {
    if (expansionOwnerScopeRef.current === expansionOwnerScope) return;
    expansionOwnerScopeRef.current = expansionOwnerScope;
    setExpandedBlocks({});
  }, [expansionOwnerScope]);

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
      if (storedAnchor.followingTail) {
        pendingReadingAnchorRef.current = null;
        tailIntentRef.current = true;
        setFollowingTail(true);
        scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'auto' });
      } else {
        pendingReadingAnchorRef.current = storedAnchor;
        currentReadingAnchorRef.current = storedAnchor;
        tailIntentRef.current = false;
        setFollowingTail(false);
        restoreReadingAnchor(storedAnchor);
      }
    } else if (!navigationTarget) {
      tailIntentRef.current = !transcript?.hasNewer;
      setFollowingTail(!transcript?.hasNewer);
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'auto' });
    }
  }, [items.length, navigationTarget, restoreReadingAnchor, scrollStorageKey, transcript?.hasNewer]);

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
        item.kind === 'group' && item.group.nodes.some((node) => node.kind === 'assistant_turn'
          ? node.turn.id === navigationTarget.turnId : node.key === navigationTarget.turnId)
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

    const behavior = navigationTarget.kind === 'latest' || navigationTarget.kind === 'initial'
      ? 'auto' : requestedScrollBehavior(navigationTarget.smooth);
    handledNavigationKeyRef.current = navigationTarget.key;
    if (navigationTarget.kind === 'latest') {
      pendingReadingAnchorRef.current = null;
      const tailAnchor = tailReadingAnchor(items.at(-1)?.id ?? 'tail');
      storageSet(scrollStorageKey, JSON.stringify(tailAnchor));
      currentReadingAnchorRef.current = tailAnchor;
    }
    tailIntentRef.current = navigationTarget.kind === 'latest'
      || (navigationTarget.kind === 'initial' && !transcript?.hasNewer);
    pendingFocusRef.current = navigationTarget.kind === 'initial' || navigationTarget.kind === 'latest'
      ? null
      : { key: navigationTarget.key, blockId: navigationTarget.blockId ?? null, itemId: items[itemIndex].id };
    setFollowingTail(navigationTarget.kind === 'latest'
      || (navigationTarget.kind === 'initial' && !transcript?.hasNewer));
    if (navigationTarget.kind === 'initial' || navigationTarget.kind === 'latest') {
      el.scrollTo({ top: el.scrollHeight, behavior });
      onNavigationResult?.({ key: navigationTarget.key, status: 'revealed' });
    } else {
      const measurement = virtualizer.measurementsCache[itemIndex];
      if (measurement) el.scrollTo({ top: Math.max(0, measurement.start - el.clientHeight / 2), behavior });
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
    if (!pending || navigationTarget || scrollbarDragRef.current) return;
    restoreReadingAnchor(pending, 'pending');
  }, [items, navigationTarget, restoreReadingAnchor, virtualItems]);

  useLayoutEffect(() => {
    const anchor = streamUpdateAnchorRef.current;
    streamUpdateAnchorRef.current = null;
    if (!anchor || navigationTarget || scrollbarDragRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    if (anchor.followingTail) {
      if (!transcript?.hasNewer) el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
    } else if (!items.some((item) => item.id === anchor.itemId)) {
      restoreReadingAnchor(anchor);
    }
  }, [items, navigationTarget, restoreReadingAnchor, transcript?.hasNewer]);

  useLayoutEffect(() => {
    const measurementsChanged = lastMeasuredSizesRef.current !== measuredGroupSizesByScope;
    lastMeasuredSizesRef.current = measuredGroupSizesByScope;
    if (!measurementsChanged) return;
    if (tailIntentRef.current || navigationTarget || scrollbarDragRef.current || userScrollIntentRef.current) return;
    const anchor = currentReadingAnchorRef.current;
    if (anchor?.followingTail === false) restoreReadingAnchor(anchor, 'mounted');
  }, [measuredGroupSizesByScope, navigationTarget, restoreReadingAnchor]);

  const pinTailToViewport = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !tailIntentRef.current || navigationTarget || scrollbarDragRef.current || transcript?.hasNewer
        || (transcript?.unmaterializedAfterCount ?? unmaterializedAfterCount) > 0) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight > FOLLOW_THRESHOLD_PX) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
    }
  }, [navigationTarget, transcript?.hasNewer, transcript?.unmaterializedAfterCount, unmaterializedAfterCount]);

  useLayoutEffect(pinTailToViewport, [items, virtualItems, pinTailToViewport]);

  useLayoutEffect(() => () => {
    const el = scrollRef.current;
    if (!el || navigationTarget || scrollbarDragRef.current) return;
    streamUpdateAnchorRef.current = tailIntentRef.current
      ? tailReadingAnchor(items.at(-1)?.id ?? 'tail')
      : currentReadingAnchorRef.current?.followingTail === false
        ? currentReadingAnchorRef.current
        : captureReadingAnchor(false);
  }, [captureReadingAnchor, items, navigationTarget, transcript?.hasNewer, transcript?.unmaterializedAfterCount, unmaterializedAfterCount]);

  useEffect(() => {
    if (!transcript) return;
    const el = scrollRef.current;
    if (!el) return;
    if (lastTranscriptRef.current !== transcript) {
      for (const start of waitingHistoryRef.current) attemptedHistoryRef.current.delete(start);
      waitingHistoryRef.current.clear();
      lastTranscriptRef.current = transcript;
    }
    const coverage = transcript.loadedIntervals.map((range) => `${range.start}:${range.end}`).join(',');
    if (coverageSignatureRef.current !== coverage) {
      coverageSignatureRef.current = coverage;
      attemptedHistoryRef.current.clear();
      waitingHistoryRef.current.clear();
    }
    const scrollStart = el.scrollTop;
    const scrollEnd = scrollStart + el.clientHeight;
    const before = el.clientHeight * 6;
    const after = el.clientHeight * 6;
    const candidates: Array<{ position: number; distance: number }> = [];
    const demandRanges: Array<{ start: number; end: number }> = [];
    // The read-ahead buffer spans pixels, so inspect the full measured layout.
    // DOM overscan is a row count and can stop before a nearby gap.
    for (const row of virtualizer.measurementsCache) {
      const item = items[row.index];
      if (item?.kind !== 'history' || row.end < scrollStart - before || row.start > scrollEnd + after) continue;
      const state = item.state;
      demandRanges.push({
        start: historyPositionAtOffset(state, row.start, Math.max(row.start, scrollStart - before), structureHeights),
        end: historyPositionAtOffset(state, row.start, Math.min(row.end - 1, scrollEnd + after), structureHeights),
      });
      const visibleCenter = (scrollStart + scrollEnd) / 2;
      const sample = Math.max(row.start, Math.min(row.end - 1, visibleCenter));
      let position = historyPositionAtOffset(state, row.start, sample, structureHeights);
      if (row.end <= scrollStart) position = Math.max(state.start, state.end - HISTORY_WINDOW_BEFORE);
      else if (row.start >= scrollEnd) position = Math.min(state.end, state.start + HISTORY_WINDOW_BEFORE);
      candidates.push({ position, distance: Math.max(0, row.start - scrollEnd, scrollStart - row.end) });
      if (row.start < scrollStart && row.end > scrollEnd) {
        const leadPixel = scrollDirectionRef.current === 'up' ? scrollStart - before : scrollEnd + after;
        const leadPosition = historyPositionAtOffset(state, row.start, leadPixel, structureHeights);
        if (Math.abs(leadPosition - position) > HISTORY_WINDOW_BEFORE) candidates.push({ position: leadPosition, distance: el.clientHeight });
      }
    }
    candidates.sort((left, right) => left.distance - right.distance);
    const desired = candidates.slice(0, 2);
    if (historyFailure && !desired.some((candidate) => candidate.position === historyFailure.position)) {
      setHistoryFailure(null);
    }
    for (const [key, request] of inFlightHistoryRef.current) {
      if (demandRanges.some((range) => request.end >= range.start && request.start <= range.end)) continue;
      request.controller.abort();
      inFlightHistoryRef.current.delete(key);
      attemptedHistoryRef.current.delete(key);
    }
    for (const candidate of desired) {
      if (inFlightHistoryRef.current.size >= 2) break;
      if (inFlightHistoryRef.current.size && [...inFlightHistoryRef.current.values()].some((request) =>
        candidate.position >= request.start && candidate.position <= request.end)) continue;
      const start = Math.max(0, candidate.position - HISTORY_WINDOW_BEFORE);
      if (attemptedHistoryRef.current.has(start) || historyFailure?.position === candidate.position) continue;
      attemptedHistoryRef.current.add(start);
      const controller = new AbortController();
      const request = { start, end: Math.min(transcript.total - 1, start + HISTORY_WINDOW_POSITIONS - 1), controller };
      inFlightHistoryRef.current.set(start, request);
      void Promise.resolve().then(() => transcript.loadAround(candidate.position, HISTORY_WINDOW_POSITIONS, controller.signal)).then((result) => {
        if (inFlightHistoryRef.current.get(start) !== request) return;
        if (result === 'failed') setHistoryFailure({ position: candidate.position, message: 'Could not load this part of the conversation.' });
        else if (result === 'cancelled') {
          attemptedHistoryRef.current.delete(start);
        } else if (result === 'busy' || result === 'covered') waitingHistoryRef.current.add(start);
      }, (cause) => {
        if (inFlightHistoryRef.current.get(start) !== request || controller.signal.aborted) return;
        setHistoryFailure({ position: candidate.position, message: cause instanceof Error ? cause.message : String(cause) });
      }).finally(() => {
        if (inFlightHistoryRef.current.get(start) !== request) return;
        inFlightHistoryRef.current.delete(start);
        setHistoryRevision((revision) => revision + 1);
      });
    }
  }, [
    distanceFromBottom,
    historyFailure,
    historyRevision,
    items,
    structureHeights,
    transcript,
    virtualItems,
    virtualizer,
  ]);

  function handleUserScrollIntent(towardTail = false): void {
    pendingReadingAnchorRef.current = null;
    pendingFocusRef.current = null;
    userScrollIntentRef.current = towardTail ? 'toward-tail' : 'away';
    if (!towardTail) {
      tailIntentRef.current = false;
      setFollowingTail(false);
    }
  }

  function handleScrollbarPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !scrollRef.current || !scrollbarThumbRef.current) return;
    const thumbRect = scrollbarThumbRef.current.getBoundingClientRect();
    const onThumb = scrollbarThumbRef.current.contains(event.target as Node);
    scrollbarDragRef.current = {
      pointerId: event.pointerId,
      pointerY: event.clientY,
      grabOffset: onThumb ? event.clientY - thumbRect.top : thumbRect.height / 2,
      thumbHeight: thumbRect.height,
    };
    handleUserScrollIntent();
    setFollowingTail(false);
    setScrollbarDragging(true);
    scrollbarTrackRef.current?.setPointerCapture(event.pointerId);
    syncScrollbar();
    event.preventDefault();
    event.stopPropagation();
  }

  finishScrollbarDragRef.current = (event?: PointerEvent) => {
    const drag = scrollbarDragRef.current;
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    scrollbarDragRef.current = null;
    setScrollbarDragging(false);
    pendingReadingAnchorRef.current = null;
    const scroll = scrollRef.current;
    const atLatest = !!scroll && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 1
      && !transcript?.hasNewer
      && (transcript?.unmaterializedAfterCount ?? unmaterializedAfterCount) === 0;
    setFollowingTail(atLatest);
    tailIntentRef.current = atLatest;
    captureReadingAnchor(atLatest);
    syncScrollbar();
  };

  useLayoutEffect(() => {
    const move = (event: PointerEvent) => {
      const drag = scrollbarDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag.pointerY = event.clientY;
      syncScrollbar();
    };
    const release = (event: PointerEvent) => finishScrollbarDragRef.current(event);
    const releaseOnBlur = () => finishScrollbarDragRef.current();
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
    window.addEventListener('lostpointercapture', release, true);
    window.addEventListener('blur', releaseOnBlur);
    return () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
      window.removeEventListener('lostpointercapture', release, true);
      window.removeEventListener('blur', releaseOnBlur);
      scrollbarDragRef.current = null;
    };
  }, [syncScrollbar]);

  useLayoutEffect(() => { syncScrollbar(); });
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      // A shelf or delayed persistence notice can resize the viewport without
      // changing any rows. Preserve deliberate tail intent at that boundary.
      pinTailToViewport();
      if (scroll.clientHeight > 0) setViewportHeight(scroll.clientHeight);
      syncScrollbar();
    });
    observer.observe(scroll);
    const canvas = scroll.querySelector('.stream-renderer__virtual-canvas');
    if (canvas) observer.observe(canvas);
    return () => observer.disconnect();
  }, [pinTailToViewport, syncScrollbar]);

  function handleScrollbarKey(event: KeyboardEvent): void {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const page = scroll.clientHeight;
    const delta = event.key === 'ArrowUp' ? -40
      : event.key === 'ArrowDown' ? 40
        : event.key === 'PageUp' ? -page
          : event.key === 'PageDown' ? page : null;
    if (delta === null && event.key !== 'Home' && event.key !== 'End') return;
    handleUserScrollIntent(delta !== null ? delta > 0 : event.key === 'End');
    scroll.scrollTop = event.key === 'Home' ? 0
      : event.key === 'End' ? scroll.scrollHeight : scroll.scrollTop + (delta ?? 0);
    syncScrollbar();
    event.preventDefault();
  }

  function handleScrollbarWheel(event: WheelEvent): void {
    const scroll = scrollRef.current;
    if (!scroll) return;
    handleUserScrollIntent(event.deltaY > 0);
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroll.clientHeight : 1;
    scroll.scrollBy({ top: event.deltaY * scale, behavior: 'auto' });
    event.preventDefault();
  }

  function handleUserScrollKey(event: KeyboardEvent): void {
    const target = event.target;
    if (event.defaultPrevented || (target instanceof HTMLElement
        && (target.isContentEditable || target.matches('input, textarea, select')))) return;
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
      handleUserScrollIntent(['ArrowDown', 'PageDown', 'End', ' '].includes(event.key));
    }
  }

  function handleScroll(): void {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const nextViewportHeight = el.clientHeight || viewportHeight;
    const nextDistance = Math.max(0, el.scrollHeight - el.scrollTop - nextViewportHeight);
    const previous = previousScrollTopRef.current;
    const previousHeight = previousScrollHeightRef.current;
    const viewportChanged = previousViewportHeightRef.current !== null
      && previousViewportHeightRef.current !== nextViewportHeight;
    if (!viewportChanged && el.scrollTop === 0 && nextDistance > FOLLOW_THRESHOLD_PX) tailIntentRef.current = false;
    if (previous !== null && el.scrollTop < previous && previousHeight === el.scrollHeight
        && !viewportChanged && nextDistance > FOLLOW_THRESHOLD_PX) tailIntentRef.current = false;
    if (previous !== null && el.scrollTop !== previous) {
      scrollDirectionRef.current = el.scrollTop < previous ? 'up' : 'down';
    }
    previousScrollTopRef.current = el.scrollTop;
    previousScrollHeightRef.current = el.scrollHeight;
    previousViewportHeightRef.current = nextViewportHeight;
    setViewportHeight(nextViewportHeight);
    setDistanceFromBottom(nextDistance);
    if (userScrollIntentRef.current === 'toward-tail'
        && previousHeight === el.scrollHeight && previous !== null && el.scrollTop > previous
        && nextDistance <= FOLLOW_THRESHOLD_PX) tailIntentRef.current = true;
    const nextFollowingTail = scrollbarDragRef.current === null
      && tailIntentRef.current
      && !transcript?.hasNewer
      && (transcript?.unmaterializedAfterCount ?? unmaterializedAfterCount) === 0;
    setFollowingTail(nextFollowingTail);
    if (!scrollbarDragRef.current && !pendingReadingAnchorRef.current
        && (userScrollIntentRef.current !== null || previousHeight === el.scrollHeight || tailIntentRef.current)) {
      captureReadingAnchor(tailIntentRef.current);
    }
    userScrollIntentRef.current = null;
    syncScrollbar();
  }

  function handleJumpToBottom(): void {
    if (onJumpToLatest) {
      void onJumpToLatest();
      return;
    }
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
    setDistanceFromBottom(0);
    tailIntentRef.current = !transcript?.hasNewer;
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
      case 'transcript_boundary': return null;
      case 'user_message': {
        const source = node.persisted;
        return (
          <div
            key={node.key}
            className="message-block-wrapper contextual-action-owner"
            data-block-id={source?.blockId}
          >
            <UserBubble text={node.text} provider={sessionInfo?.backend} />
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
              active={Boolean(node.item.executionActive && streaming)}
              detailsAvailable={source?.detailsLoaded === false}
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
              detailsAvailable={source?.detailsLoaded === false && source.hasBody !== false}
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
              getDisclosureExpanded={(id, defaultExpanded) => expandedBlocks[`${node.key}:${id}`] ?? defaultExpanded}
              onDisclosureExpandedChange={(id, expanded) => setBlockExpanded(`${node.key}:${id}`, expanded)}
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
                active={streaming && entry.nodes.some((node) => node.item.type === 'tool-call-activity' && node.item.executionActive)}
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

  function renderHistoryRow(state: HistoryRowState): JSX.Element {
    return (
      <div
        className="stream-renderer__history-state"
        style={{ height: `${state.extentHeight}px`, boxSizing: 'border-box' }}
        aria-hidden="true"
      />
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
        id={scrollElementId}
        className="stream-renderer__scroll stream-renderer__scroll--overlay-bar"
        onScroll={handleScroll}
        onWheel={(event) => handleUserScrollIntent(event.deltaY > 0)}
        onTouchMove={() => handleUserScrollIntent()}
        onKeyDown={handleUserScrollKey}
      >
        <div ref={virtualizer.containerRef} className="stream-renderer__virtual-canvas">
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
                data-virtual-kind={item.kind}
                style={{ top: 0 }}
              >
                {item.kind === 'group' && renderGroup(item.group)}
                {item.kind === 'history' && renderHistoryRow(item.state)}
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
      {showPendingPersistence && <div className="stream-renderer__persistence-notice" role="status">Some content is awaiting confirmation from saved history.</div>}
      <div
        ref={scrollbarTrackRef}
        className={`stream-renderer__scrollbar-track${scrollbarDragging ? ' stream-renderer__scrollbar-track--dragging' : ''}`}
        onPointerDown={handleScrollbarPointerDown}
        onWheel={handleScrollbarWheel}
      >
        <div
          ref={scrollbarThumbRef}
          className="stream-renderer__scrollbar-thumb"
          role="scrollbar"
          tabIndex={0}
          aria-label="Conversation scroll position"
          aria-controls={scrollElementId}
          aria-orientation="vertical"
          aria-valuemin={0}
          aria-valuemax={1000}
          aria-valuenow={0}
          onKeyDown={handleScrollbarKey}
        />
      </div>
      {historyFailure && (
        <div className="stream-renderer__history-error" role="alert">
          <span>{historyFailure.message}</span>
          <button type="button" onClick={() => {
            const start = Math.max(0, historyFailure.position - HISTORY_WINDOW_BEFORE);
            attemptedHistoryRef.current.delete(start);
            waitingHistoryRef.current.delete(start);
            setHistoryFailure(null);
            setHistoryRevision((revision) => revision + 1);
          }}>Retry</button>
        </div>
      )}
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
