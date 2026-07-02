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
import { PresetViolationBlock } from '../components/stream-renderer/PresetViolationBlock';
import { MessageActions } from '../components/shared/MessageActions';
import { TurnGroup } from '../components/message-blocks/TurnGroup';
import { GroupFooter } from '../components/message-blocks/GroupFooter';
import { UserBubble } from '../components/message-blocks/UserBubble';
import { PermissionApprovalCard } from '../components/console/PermissionApprovalCard';
import { ContextUsageRing } from './ContextUsageRing';
import type { ChatUsageSummary } from './contextUsage';
import {
  deriveLiveLabel,
  deriveTokenCount,
  extractTurns,
  formatElapsed,
  groupMessagesForDisplay,
  serializeConversationToMarkdown,
  serializeDisplayGroupToMarkdown,
  useStreamState,
} from './renderModel';

export type ChatSurfaceProps = StreamRendererProps & {
  activePermissionRequest?: ConsolePermissionRequest | null;
  permissionBackendType?: ConsoleBackendType;
  onPermissionRespond?: (id: string, decision: ConsolePermissionDecision) => void | Promise<void>;
  usageSummary?: ChatUsageSummary;
  onUsageOpen?: () => void;
};

const ESTIMATED_ROW_HEIGHT = 168;
const VIRTUAL_OVERSCAN = 6;
const FOLLOW_THRESHOLD_PX = 80;

type VirtualItem =
  | { kind: 'group'; id: string; group: DisplayGroup }
  | { kind: 'live'; id: string };

type VirtualLayout = {
  totalHeight: number;
  offsets: number[];
  start: number;
  end: number;
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

function readExpandState(key: string): Record<string, boolean> {
  const raw = storageGet(key);
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, boolean> : {};
  } catch {
    return {};
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

function openMarkdownDocument(markdown: string): void {
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener,noreferrer');
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
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
  usageSummary,
  onUsageOpen,
}: ChatSurfaceProps): JSX.Element {
  const { nodes } = useStreamState(events);
  const scrollRef = useRef<HTMLDivElement>(null);
  const storageScope = sessionInfo?.sessionId ?? 'default';
  const scrollStorageKey = `mandible:chat-scroll:${storageScope}`;
  const expandStorageKey = `mandible:chat-expanded:${storageScope}`;

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(720);
  const [isFollowing, setIsFollowing] = useState(true);
  const [rowHeights, setRowHeights] = useState<Record<string, number>>({});
  const [expandedBlocks, setExpandedBlocks] = useState<Record<string, boolean>>(() => (
    readExpandState(expandStorageKey)
  ));

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

  useEffect(() => {
    setExpandedBlocks(readExpandState(expandStorageKey));
  }, [expandStorageKey]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const storedTop = Number(storageGet(scrollStorageKey) ?? 0);
    if (Number.isFinite(storedTop) && storedTop > 0) {
      el.scrollTop = storedTop;
      setScrollTop(storedTop);
      const atBottom = storedTop + el.clientHeight >= el.scrollHeight - FOLLOW_THRESHOLD_PX;
      setIsFollowing(atBottom);
    }
    setViewportHeight(el.clientHeight || 720);
  }, [scrollStorageKey]);

  useEffect(() => {
    if (!streaming || !isFollowing) {
      return;
    }
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = layout.totalHeight;
      setScrollTop(el.scrollTop);
    }
  }, [items.length, layout.totalHeight, streaming, isFollowing]);

  function handleScroll(): void {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const nextScrollTop = el.scrollTop;
    const nextViewportHeight = el.clientHeight || viewportHeight;
    const atBottom = nextScrollTop + nextViewportHeight >= el.scrollHeight - FOLLOW_THRESHOLD_PX;
    setScrollTop(nextScrollTop);
    setViewportHeight(nextViewportHeight);
    setIsFollowing(atBottom);
    storageSet(scrollStorageKey, String(nextScrollTop));
  }

  function handleJumpToBottom(): void {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = layout.totalHeight;
      setScrollTop(el.scrollTop);
      storageSet(scrollStorageKey, String(el.scrollTop));
    }
    setIsFollowing(true);
  }

  function setBlockExpanded(id: string, expanded: boolean): void {
    setExpandedBlocks((current) => {
      const next = { ...current, [id]: expanded };
      storageSet(expandStorageKey, JSON.stringify(next));
      return next;
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
      case 'user_message':
        return (
          <div key={node.key} className="message-block-wrapper">
            <UserBubble text={node.text} />
            <MessageActions onCopy={() => copyText(node.text)} />
          </div>
        );

      case 'violation':
        return (
          <PresetViolationBlock
            key={node.key}
            analyzing={node.event.analyzing}
            presetId={node.event.preset_id}
            subagentSessionId={node.event.subagent_session_id}
          />
        );

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
        isShort={group.nodes.length <= 2}
        footer={footer}
      >
        {group.nodes.map(renderNodeBody)}
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
  const conversationMarkdown = serializeConversationToMarkdown(nodes);

  return (
    <div className="stream-renderer">
      <div className="stream-renderer__toolbar" aria-label="Conversation export actions">
        <ContextUsageRing usage={usageSummary} size="sm" onClick={onUsageOpen} />
        <button
          type="button"
          className="stream-renderer__toolbar-btn"
          onClick={() => copyText(conversationMarkdown)}
        >
          Copy markdown
        </button>
        <button
          type="button"
          className="stream-renderer__toolbar-btn"
          onClick={() => openMarkdownDocument(conversationMarkdown)}
        >
          Open markdown
        </button>
      </div>
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
                onMeasure={(height) => {
                  setRowHeights((current) => (
                    current[item.id] === height ? current : { ...current, [item.id]: height }
                  ));
                }}
              >
                {item.kind === 'group' ? renderGroup(item.group) : renderLiveIndicator()}
              </VirtualRow>
            );
          })}
        </div>
        {activePermissionRequest && onPermissionRespond && (
          <TurnGroup speaker="system" isShort>
            <PermissionApprovalCard
              request={activePermissionRequest}
              backendType={permissionBackendType}
              onRespond={onPermissionRespond}
            />
          </TurnGroup>
        )}
      </div>
      {!isFollowing && (
        <button
          type="button"
          className="stream-renderer__scroll-btn"
          onClick={handleJumpToBottom}
        >
          Jump to latest
        </button>
      )}
    </div>
  );
}
