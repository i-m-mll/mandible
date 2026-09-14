import type { JSX } from 'preact/jsx-runtime';
import { observeElementRect, useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ConsoleBackendType, ConsolePermissionDecision, ConsolePermissionRequest } from '../api';
import type {
  ContentBlock,
  DisplayGroup,
  RenderNode,
  StreamRendererProps,
} from '../components/stream-renderer/types';
import {
  assistantTurnBoundaryKinds,
  chatBoundaryClasses,
  MessageGroup,
} from '../components/stream-renderer/MessageGroup';
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
  | { kind: 'live'; id: string }
  | { kind: 'permission'; id: string };

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

function measureVirtualRow(element: Element): number {
  const height = element.getBoundingClientRect().height;
  return height > 0 ? Math.ceil(height) : ESTIMATED_ROW_HEIGHT;
}

function requestedScrollBehavior(smooth: boolean): ScrollBehavior {
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  return smooth && !reducedMotion ? 'smooth' : 'auto';
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
  const overlayContext = useContext(DetailPaneOverlayContext);
  const registerScrollOwner = overlayContext?.registerScrollOwner;
  const storageScope = sessionInfo?.sessionId ?? 'default';
  const scrollStorageKey = `mandible:chat-scroll:${storageScope}`;

  const [viewportHeight, setViewportHeight] = useState(720);
  const [distanceFromBottom, setDistanceFromBottom] = useState(0);
  const [expandedBlocks, setExpandedBlocks] = useState<Record<string, boolean>>({});
  const handledNavigationKeyRef = useRef<string | null>(null);
  const pendingFocusRef = useRef<{ blockId: string | null; itemId: string } | null>(null);
  const restoredScrollScopeRef = useRef<string | null>(null);

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
    if (activePermissionRequest && onPermissionRespond) {
      groupedItems.push({ kind: 'permission', id: `permission:${activePermissionRequest.id}` });
    }
    return groupedItems;
  }, [activePermissionRequest, groups, onPermissionRespond, streaming]);

  const getItemKey = useCallback((index: number) => items[index]?.id ?? index, [items]);
  const initialOffset = useMemo(() => {
    const storedTop = Number(storageGet(scrollStorageKey));
    return Number.isFinite(storedTop) && storedTop > 0
      ? storedTop
      : Math.max(0, items.length * ESTIMATED_ROW_HEIGHT - 720);
  }, [items.length, scrollStorageKey]);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    measureElement: measureVirtualRow,
    getItemKey,
    initialOffset,
    initialRect: { width: 600, height: 720 },
    observeElementRect: (instance, notify) => observeElementRect(instance, (rect) => notify({
      width: rect.width || 600,
      height: rect.height || 720,
    })),
    overscan: 6,
    anchorTo: 'end',
    followOnAppend: 'auto',
    scrollEndThreshold: FOLLOW_THRESHOLD_PX,
  });
  const virtualItems = virtualizer.getVirtualItems();
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

  const setScrollNode = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node;
    registerScrollOwner?.(node);
    if (node) setViewportHeight(node.clientHeight || 720);
  }, [registerScrollOwner]);

  useLayoutEffect(() => {
    if (!scrollRef.current || restoredScrollScopeRef.current === scrollStorageKey || items.length === 0) return;
    restoredScrollScopeRef.current = scrollStorageKey;
    const storedTop = Number(storageGet(scrollStorageKey));
    if (Number.isFinite(storedTop) && storedTop > 0) {
      virtualizer.scrollToOffset(storedTop, { behavior: 'auto' });
    } else if (!navigationTarget) {
      virtualizer.scrollToEnd({ behavior: 'auto' });
    }
  }, [items.length, navigationTarget, scrollStorageKey, virtualizer]);

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
      targetFound = itemIndex >= 0;
    }
    if (!targetFound) return;

    const behavior = requestedScrollBehavior(navigationTarget.smooth);
    handledNavigationKeyRef.current = navigationTarget.key;
    pendingFocusRef.current = navigationTarget.kind === 'initial' || navigationTarget.kind === 'latest'
      ? null
      : { blockId: navigationTarget.blockId ?? null, itemId: items[itemIndex].id };
    if (navigationTarget.kind === 'initial' || navigationTarget.kind === 'latest') {
      virtualizer.scrollToEnd({ behavior });
    } else {
      virtualizer.scrollToIndex(itemIndex, { align: 'center', behavior });
    }
    setDistanceFromBottom(navigationTarget.kind === 'initial' || navigationTarget.kind === 'latest'
      ? 0
      : virtualizer.getDistanceFromEnd());
    storageSet(scrollStorageKey, String(el.scrollTop));
  }, [items, navigationTarget, scrollStorageKey, virtualizer]);

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
    if (!target) return;
    if (pending.blockId && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'center', behavior: 'auto' });
    }
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
    pendingFocusRef.current = null;
    storageSet(scrollStorageKey, String(el.scrollTop));
  }, [scrollStorageKey, virtualItems]);

  function handleScroll(): void {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const nextViewportHeight = el.clientHeight || viewportHeight;
    setViewportHeight(nextViewportHeight);
    setDistanceFromBottom(Math.max(0, el.scrollHeight - el.scrollTop - nextViewportHeight));
    storageSet(scrollStorageKey, String(el.scrollTop));
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
    storageSet(scrollStorageKey, String(el.scrollTop));
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
            className={`message-block-wrapper contextual-action-owner ${chatBoundaryClasses('prose')}`}
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
          <div key={node.key} className={`message-block-wrapper ${chatBoundaryClasses('activity')}`} data-block-id={source.blockId}>
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
          <div key={node.key} className={`message-block-wrapper ${chatBoundaryClasses('activity')}`} data-block-id={source?.blockId}>
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
          <div key={node.key} className={`message-block-wrapper ${chatBoundaryClasses('activity')}`} data-block-id={source?.blockId}>
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
        const boundaries = assistantTurnBoundaryKinds(turn);
        const boundaryClass = boundaries ? chatBoundaryClasses(boundaries.start, boundaries.end) : '';

        return (
          <div
            key={node.key}
            className={`${isSelected ? 'stream-turn-node stream-turn--selected' : 'stream-turn-node'}${boundaryClass ? ` ${boundaryClass}` : ''}`}
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
              className={`message-block-wrapper ${chatBoundaryClasses('activity')}`}
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

  return (
    <div className="stream-renderer">
      <div
        ref={setScrollNode}
        className="stream-renderer__scroll"
        onScroll={handleScroll}
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
