import type { ComponentChildren } from 'preact';
import type { JSX } from 'preact/jsx-runtime';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ConsoleBackendType, ConsolePermissionDecision, ConsolePermissionRequest } from '../api';
import type {
  ContentBlock,
  DisplayGroup,
  RenderNode,
  StreamRendererProps,
} from '../components/stream-renderer/types';
import { MessageGroup } from '../components/stream-renderer/MessageGroup';
import { MessageActions } from '../components/shared/MessageActions';
import { TurnGroup } from '../components/message-blocks/TurnGroup';
import { GroupFooter } from '../components/message-blocks/GroupFooter';
import { UserBubble } from '../components/message-blocks/UserBubble';
import { SemanticEventBlock, UnmatchedToolResultBlock } from '../components/message-blocks/SemanticEventBlock';
import { ActivityGroup, ActivityRow } from '../components/message-blocks/ActivityBlock';
import { PermissionApprovalCard } from '../components/console/PermissionApprovalCard';
import { openMarkdownDocument } from './markdownActions';
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
  activePermissionRequest?: ConsolePermissionRequest | null;
  permissionBackendType?: ConsoleBackendType;
  onPermissionRespond?: (id: string, decision: ConsolePermissionDecision) => void | Promise<void>;
  unmaterializedAfterCount?: number;
  onJumpToLatest?: () => void | Promise<void>;
  jumpingToLatest?: boolean;
  navigationTarget?: {
    key: string;
    kind: 'initial' | 'latest' | 'block' | 'turn' | 'position';
    turnId: string | null;
    blockId?: string | null;
    smooth: boolean;
  } | null;
  selectedBlockIds?: ReadonlySet<string>;
  selectMode?: boolean;
  onToggleBlockSelect?: (blockId: string, shiftKey: boolean) => void;
  onFork?: (dagUuid: string) => void;
  onResume?: (dagUuid: string) => void;
};

const ESTIMATED_ROW_HEIGHT = 168;
const VIRTUAL_OVERSCAN = 6;
const FOLLOW_THRESHOLD_PX = 80;
const JUMP_RETURN_SECONDS = 2;
const MANUAL_RETURN_PX_PER_SECOND = 600;

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
  | { kind: 'live'; id: string };

type VirtualLayout = {
  totalHeight: number;
  offsets: number[];
  start: number;
  end: number;
};

type LayoutSnapshot = {
  ids: string[];
  offsets: number[];
  heights: number[];
  scrollTop: number;
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

function blockId(turnId: string, block: ContentBlock, index: number): string {
  if (block.type === 'tool_use') {
    return `${turnId}:tool:${block.id}`;
  }
  return `${turnId}:${block.type}:${index}`;
}

function useVirtualLayout(
  items: VirtualItem[],
  heights: Record<string, number>,
  scrollTop: number,
  viewportHeight: number,
): VirtualLayout {
  return useMemo(() => {
    const offsets: number[] = [];
    let totalHeight = 0;

    for (const item of items) {
      offsets.push(totalHeight);
      totalHeight += heights[item.id] ?? ESTIMATED_ROW_HEIGHT;
    }

    let start = 0;
    while (
      start < items.length &&
      offsets[start] + (heights[items[start].id] ?? ESTIMATED_ROW_HEIGHT) < scrollTop
    ) {
      start += 1;
    }

    let end = start;
    const lowerBound = scrollTop + viewportHeight;
    while (end < items.length && offsets[end] < lowerBound) {
      end += 1;
    }

    return {
      totalHeight,
      offsets,
      start: Math.max(0, start - VIRTUAL_OVERSCAN),
      end: Math.min(items.length, end + VIRTUAL_OVERSCAN),
    };
  }, [heights, items, scrollTop, viewportHeight]);
}

function VirtualRow({
  top,
  onMeasure,
  children,
}: {
  top: number;
  onMeasure: (height: number) => void;
  children: ComponentChildren;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return undefined;
    }

    const measure = () => {
      const height = el.getBoundingClientRect().height;
      if (height > 0) {
        onMeasure(Math.ceil(height));
      }
    };

    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(el);
    return () => observer?.disconnect();
  }, [children, onMeasure]);

  return (
    <div ref={ref} className="stream-renderer__virtual-row" style={{ top: `${top}px` }}>
      {children}
    </div>
  );
}

export function ChatSurface({
  events,
  streaming,
  elapsedSeconds,
  emptyLabel,
  onSelectMessageInfo,
  selectedMessageId,
  sessionInfo,
  activePermissionRequest,
  permissionBackendType = 'sdk',
  onPermissionRespond,
  unmaterializedAfterCount = 0,
  onJumpToLatest,
  jumpingToLatest = false,
  navigationTarget = null,
  selectedBlockIds,
  selectMode = false,
  onToggleBlockSelect,
  onFork,
  onResume,
}: ChatSurfaceProps): JSX.Element {
  const { nodes } = useStreamState(events);
  const scrollRef = useRef<HTMLDivElement>(null);
  const storageScope = sessionInfo?.sessionId ?? 'default';
  const scrollStorageKey = `mandible:chat-scroll:${storageScope}`;

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(720);
  const [isFollowing, setIsFollowing] = useState(true);
  const [distanceFromBottom, setDistanceFromBottom] = useState(0);
  const [rowHeights, setRowHeights] = useState<Record<string, number>>({});
  const [expandedBlocks, setExpandedBlocks] = useState<Record<string, boolean>>({});
  const scrollTopRef = useRef(0);
  const isFollowingRef = useRef(true);
  const rowHeightsRef = useRef<Record<string, number>>({});
  const handledNavigationKeyRef = useRef<string | null>(null);
  const pendingExactBlockRef = useRef<string | null>(null);
  const previousLayoutRef = useRef<LayoutSnapshot | null>(null);
  const skipAnchorReconciliationRef = useRef(false);

  const groups = useMemo(() => groupMessagesForDisplay(nodes), [nodes]);
  const turns = useMemo(() => extractTurns(nodes), [nodes]);
  const liveLabel = deriveLiveLabel(turns, streaming);
  const tokenCount = deriveTokenCount(turns);
  const hasContent = nodes.length > 0;
  const hasPermissionCard = Boolean(activePermissionRequest && onPermissionRespond);

  const items = useMemo<VirtualItem[]>(() => {
    const groupedItems: VirtualItem[] = groups.map((group) => ({
      kind: 'group',
      id: group.id,
      group,
    }));
    if (streaming) {
      groupedItems.push({ kind: 'live', id: 'stream-live-tail' });
    }
    return groupedItems;
  }, [groups, streaming]);

  const layout = useVirtualLayout(items, rowHeights, scrollTop, viewportHeight);
  const estimatedUnmaterializedDistance = Math.max(0, unmaterializedAfterCount) * ESTIMATED_ROW_HEIGHT;
  const showJumpToLatest = shouldShowJumpToLatest(
    Math.max(distanceFromBottom, estimatedUnmaterializedDistance),
    viewportHeight,
  );

  // Chat disclosures are transient reading state. A new conversation or page
  // refresh starts from each block's declared default instead of reviving old
  // tool/thinking expansion choices from browser storage.
  useEffect(() => {
    setExpandedBlocks({});
  }, [storageScope]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const storedTop = Number(storageGet(scrollStorageKey) ?? 0);
    if (Number.isFinite(storedTop) && storedTop > 0) {
      el.scrollTop = storedTop;
      scrollTopRef.current = storedTop;
      setScrollTop(storedTop);
      const atBottom = storedTop + el.clientHeight >= el.scrollHeight - FOLLOW_THRESHOLD_PX;
      isFollowingRef.current = atBottom;
      setIsFollowing(atBottom);
      setDistanceFromBottom(Math.max(0, el.scrollHeight - storedTop - el.clientHeight));
    }
    setViewportHeight(el.clientHeight || 720);
  }, [scrollStorageKey]);

  useEffect(() => {
    if (!streaming || !isFollowingRef.current) {
      return;
    }
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = layout.totalHeight;
      scrollTopRef.current = el.scrollTop;
      setScrollTop(el.scrollTop);
      setDistanceFromBottom(0);
      storageSet(scrollStorageKey, String(el.scrollTop));
    }
  }, [items.length, layout.totalHeight, scrollStorageKey, streaming, isFollowing]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!navigationTarget) {
      handledNavigationKeyRef.current = null;
      pendingExactBlockRef.current = null;
      return;
    }
    if (!el || handledNavigationKeyRef.current === navigationTarget.key) return;
    let destination = layout.totalHeight;
    let targetFound = navigationTarget.kind === 'initial' || navigationTarget.kind === 'latest';
    if (navigationTarget.kind !== 'initial' && navigationTarget.kind !== 'latest') {
      let itemIndex = navigationTarget.turnId ? items.findIndex((item) => (
        item.kind === 'group' && item.group.nodes.some((node) => node.key === navigationTarget.turnId)
      )) : -1;
      if (itemIndex < 0 && navigationTarget.blockId) {
        itemIndex = items.findIndex((item) => (
          item.kind === 'group' && item.group.nodes.some((node) => {
            if (node.key === navigationTarget.blockId) return true;
            if (node.kind === 'user_message') return node.persisted?.blockId === navigationTarget.blockId;
            if (node.kind === 'semantic_event') return node.event.source.blockId === navigationTarget.blockId;
            if (node.kind === 'unmatched_tool_result') return node.result.source?.blockId === navigationTarget.blockId;
            if (node.kind === 'assistant_turn') {
              const matchedResult = Array.from(node.turn.toolResults.entries())
                .find(([, result]) => result.source?.blockId === navigationTarget.blockId);
              return node.turn.assistantEvent.message.content.some((block) => block.source?.blockId === navigationTarget.blockId)
                || Boolean(matchedResult);
            }
            return false;
          })
        ));
      }
      if (itemIndex >= 0) {
        destination = layout.offsets[itemIndex] ?? 0;
        targetFound = true;
      }
    }
    if (!targetFound) return;

    // Virtual navigation is a controlled two-stage anchor. Keep both the
    // coarse row materialization and exact-block centering instantaneous so a
    // browser animation cannot compete with measurement corrections.
    const behavior: ScrollBehavior = 'auto';
    handledNavigationKeyRef.current = navigationTarget.key;
    skipAnchorReconciliationRef.current = true;
    pendingExactBlockRef.current = navigationTarget.blockId ?? null;
    if (typeof el.scrollTo === 'function') el.scrollTo({ top: destination, behavior });
    else el.scrollTop = destination;
    scrollTopRef.current = el.scrollTop;
    setScrollTop(el.scrollTop);
    const followsTail = navigationTarget.kind === 'initial' || navigationTarget.kind === 'latest';
    isFollowingRef.current = followsTail;
    setIsFollowing(followsTail);
    setDistanceFromBottom(navigationTarget.kind === 'initial' || navigationTarget.kind === 'latest' ? 0 : Math.max(0, layout.totalHeight - destination - viewportHeight));
    storageSet(scrollStorageKey, String(el.scrollTop));
  }, [items, layout.offsets, layout.totalHeight, navigationTarget, scrollStorageKey, viewportHeight]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const blockId = pendingExactBlockRef.current;
    if (!el || !blockId) return;
    const exactBlock = Array.from(el.querySelectorAll<HTMLElement>('[data-block-id]'))
      .find((candidate) => candidate.dataset.blockId === blockId);
    if (!exactBlock) return;
    if (typeof exactBlock.scrollIntoView === 'function') {
      exactBlock.scrollIntoView({ block: 'center', behavior: 'auto' });
    }
    pendingExactBlockRef.current = null;
    scrollTopRef.current = el.scrollTop;
    setScrollTop(el.scrollTop);
    storageSet(scrollStorageKey, String(el.scrollTop));
  }, [layout.end, layout.start, scrollStorageKey]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const previous = previousLayoutRef.current;
    const ids = items.map((item) => item.id);
    let nextScrollTop = scrollTopRef.current;
    const skipReconciliation = skipAnchorReconciliationRef.current;
    skipAnchorReconciliationRef.current = false;

    if (
      el
      && previous
      && !skipReconciliation
      && !isFollowingRef.current
      && (!navigationTarget || handledNavigationKeyRef.current === navigationTarget.key)
      && (previous.ids.length !== ids.length || previous.ids.some((id, index) => ids[index] !== id))
    ) {
      const anchorIndex = previous.ids.findIndex((_, index) => (
        previous.offsets[index] + previous.heights[index] > previous.scrollTop
      ));
      if (anchorIndex >= 0) {
        const newAnchorIndex = ids.indexOf(previous.ids[anchorIndex]);
        if (newAnchorIndex >= 0) {
          const anchorInset = previous.scrollTop - previous.offsets[anchorIndex];
          nextScrollTop = (layout.offsets[newAnchorIndex] ?? 0) + anchorInset;
          if (Math.abs(nextScrollTop - el.scrollTop) > 0.5) {
            el.scrollTop = nextScrollTop;
            scrollTopRef.current = nextScrollTop;
            setScrollTop(nextScrollTop);
            setDistanceFromBottom(Math.max(0, layout.totalHeight - nextScrollTop - (el.clientHeight || viewportHeight)));
            storageSet(scrollStorageKey, String(nextScrollTop));
          }
        }
      }
    }

    previousLayoutRef.current = {
      ids,
      offsets: layout.offsets,
      heights: items.map((item) => rowHeights[item.id] ?? ESTIMATED_ROW_HEIGHT),
      scrollTop: nextScrollTop,
    };
  }, [items, layout.offsets, layout.totalHeight, navigationTarget, rowHeights, scrollStorageKey, viewportHeight]);

  function handleScroll(): void {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const nextScrollTop = el.scrollTop;
    const nextViewportHeight = el.clientHeight || viewportHeight;
    const atBottom = nextScrollTop + nextViewportHeight >= el.scrollHeight - FOLLOW_THRESHOLD_PX;
    const movedUp = nextScrollTop < scrollTopRef.current - 0.5;
    const nextFollowing = movedUp ? false : atBottom;
    scrollTopRef.current = nextScrollTop;
    isFollowingRef.current = nextFollowing;
    setScrollTop(nextScrollTop);
    setViewportHeight(nextViewportHeight);
    setIsFollowing(nextFollowing);
    setDistanceFromBottom(Math.max(0, el.scrollHeight - nextScrollTop - nextViewportHeight));
    storageSet(scrollStorageKey, String(nextScrollTop));
  }

  function handleJumpToBottom(): void {
    if (onJumpToLatest) {
      void onJumpToLatest();
      return;
    }
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = layout.totalHeight;
    scrollTopRef.current = el.scrollTop;
    isFollowingRef.current = true;
    setScrollTop(el.scrollTop);
    setDistanceFromBottom(0);
    storageSet(scrollStorageKey, String(el.scrollTop));
    setIsFollowing(true);
  }

  function handleRowMeasure(itemIndex: number, itemId: string, height: number): void {
    const previousHeight = rowHeightsRef.current[itemId] ?? ESTIMATED_ROW_HEIGHT;
    if (previousHeight === height) return;
    const nextHeights = { ...rowHeightsRef.current, [itemId]: height };
    rowHeightsRef.current = nextHeights;
    setRowHeights(nextHeights);

    const el = scrollRef.current;
    const itemTop = layout.offsets[itemIndex] ?? 0;
    if (!el || isFollowingRef.current || itemTop + previousHeight > scrollTopRef.current) return;
    const adjustedScrollTop = scrollTopRef.current + height - previousHeight;
    el.scrollTop = adjustedScrollTop;
    scrollTopRef.current = adjustedScrollTop;
    setScrollTop(adjustedScrollTop);
    setDistanceFromBottom(Math.max(
      0,
      layout.totalHeight + height - previousHeight - adjustedScrollTop - (el.clientHeight || viewportHeight),
    ));
    storageSet(scrollStorageKey, String(adjustedScrollTop));
  }

  function setBlockExpanded(id: string, expanded: boolean): void {
    setExpandedBlocks((current) => {
      return { ...current, [id]: expanded };
    });
  }

  function copyText(text: string): void {
    navigator.clipboard.writeText(text).catch(() => {});
  }

  let lastAssistantKey: string | null = null;
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (nodes[i].kind === 'assistant_turn') {
      lastAssistantKey = nodes[i].key;
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
        const disclosureKey = `activity:${node.key}`;
        return (
          <div key={node.key} className="message-block-wrapper" data-block-id={source?.blockId}>
            <ActivityRow
              item={node.item}
              expanded={expandedBlocks[disclosureKey] ?? false}
              onExpandedChange={(next) => setBlockExpanded(disclosureKey, next)}
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
        const isLastStreamingTurn = streaming && node.key === lastAssistantKey;
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
              data-member-refs={entry.nodes.map((node) => node.source?.blockId ?? node.key).join(' ')}
            >
              <ActivityGroup
                items={entry.nodes.map((node) => node.item)}
                expanded={expandedBlocks[entry.key] ?? false}
                onExpandedChange={(next) => setBlockExpanded(entry.key, next)}
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

  if (!hasContent && !hasPermissionCard) {
    return (
      <div className="stream-renderer">
        <div className="stream-renderer__empty">
          {emptyLabel ?? (streaming ? 'Starting...' : 'No events')}
        </div>
      </div>
    );
  }

  const visibleItems = items.slice(layout.start, layout.end);
  return (
    <div className="stream-renderer">
      <div
        ref={scrollRef}
        className="stream-renderer__scroll"
        onScroll={handleScroll}
      >
        <div className="stream-renderer__virtual-canvas" style={{ height: `${layout.totalHeight}px` }}>
          {visibleItems.map((item, offset) => {
            const itemIndex = layout.start + offset;
            return (
              <VirtualRow
                key={item.id}
                top={layout.offsets[itemIndex] ?? 0}
                onMeasure={(height) => handleRowMeasure(itemIndex, item.id, height)}
              >
                {item.kind === 'group' ? renderGroup(item.group) : renderLiveIndicator()}
              </VirtualRow>
            );
          })}
        </div>
        {activePermissionRequest && onPermissionRespond && (
          <TurnGroup speaker="system">
            <PermissionApprovalCard
              request={activePermissionRequest}
              backendType={permissionBackendType}
              onRespond={onPermissionRespond}
            />
          </TurnGroup>
        )}
      </div>
      {showJumpToLatest && (
        <button
          type="button"
          className="stream-renderer__scroll-btn"
          onClick={handleJumpToBottom}
          disabled={jumpingToLatest}
        >
          {jumpingToLatest ? 'Loading latest…' : 'Jump to latest'}
        </button>
      )}
    </div>
  );
}
