import type { JSX } from 'preact/jsx-runtime';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { RenderNode, StreamRendererProps } from '../components/stream-renderer/types';
import { MessageGroup } from '../components/stream-renderer/MessageGroup';
import { PresetViolationBlock } from '../components/stream-renderer/PresetViolationBlock';
import { groupByEntity } from '../components/shared/groupByEntity';
import type { NodeGroup } from '../components/shared/groupByEntity';
import { TurnGroup } from '../components/message-blocks/TurnGroup';
import { GroupFooter } from '../components/message-blocks/GroupFooter';
import { UserBubble } from '../components/message-blocks/UserBubble';
import {
  computeTotalTokens,
  deriveLiveLabel,
  deriveTokenCount,
  extractTurns,
  formatElapsed,
  useStreamState,
} from './renderModel';

export type ChatSurfaceProps = StreamRendererProps;

export function ChatSurface({
  events,
  streaming,
  elapsedSeconds,
  emptyLabel,
  onSelectMessageInfo,
  selectedMessageId,
}: ChatSurfaceProps): JSX.Element {
  const { nodes } = useStreamState(events);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [userScrolled, setUserScrolled] = useState(false);

  useEffect(() => {
    if (!streaming || userScrolled) {
      return;
    }
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [events.length, streaming, userScrolled]);

  function handleScroll(): void {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 80;
    setUserScrolled(!atBottom);
  }

  function handleJumpToBottom(): void {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
    setUserScrolled(false);
  }

  const turns = extractTurns(nodes);
  const liveLabel = deriveLiveLabel(turns, streaming);
  const tokenCount = deriveTokenCount(turns);
  const hasContent = nodes.length > 0;

  if (!hasContent) {
    return (
      <div className="stream-renderer">
        <div className="stream-renderer__empty">
          {emptyLabel ?? (streaming ? 'Starting...' : 'No events')}
        </div>
      </div>
    );
  }

  const groups = groupByEntity(nodes, (n) => n.entity, (n) => n.key);

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
          <UserBubble key={node.key} text={node.text} />
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
            style={{ position: 'relative' }}
          >
            <MessageGroup
              turn={turn}
              isStreaming={isLastStreamingTurn}
              isThinking={isThinking}
            />
          </div>
        );
      }

      default:
        return null;
    }
  }

  function collectGroupText(group: NodeGroup<RenderNode>): string {
    const parts: string[] = [];
    for (const node of group.nodes) {
      if (node.kind === 'user_message') {
        parts.push(node.text);
      } else if (node.kind === 'assistant_turn') {
        for (const block of node.turn.assistantEvent.message.content) {
          if (block.type === 'text' && block.text) parts.push(block.text);
        }
      }
    }
    return parts.join('\n\n');
  }

  const rendered = groups.map((group) => {
    const isShort = group.nodes.length <= 2;
    let aggregateTokens: number | undefined;
    if (group.entity === 'assistant' && group.nodes.length > 1) {
      let sum = 0;
      let found = false;
      for (const node of group.nodes) {
        if (node.kind === 'assistant_turn') {
          const total = computeTotalTokens(node.turn.assistantEvent.message.usage);
          if (total !== undefined) {
            sum += total;
            found = true;
          }
        }
      }
      if (found) aggregateTokens = sum;
    }

    const footer = group.entity === 'assistant' && group.nodes.length > 1 ? (
      <GroupFooter
        totalTokens={aggregateTokens}
        onCopyAll={() => { navigator.clipboard.writeText(collectGroupText(group)).catch(() => {}); }}
      />
    ) : undefined;

    return (
      <TurnGroup
        key={group.id}
        speaker={group.entity}
        isShort={isShort}
        footer={footer}
      >
        {group.nodes.map(renderNodeBody)}
      </TurnGroup>
    );
  });

  return (
    <div className="stream-renderer">
      <div
        ref={scrollRef}
        className="stream-renderer__scroll"
        onScroll={handleScroll}
      >
        {rendered}
        {streaming && (
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
        )}
      </div>
      {userScrolled && streaming && (
        <button
          type="button"
          className="stream-renderer__scroll-btn"
          onClick={handleJumpToBottom}
        >
          Jump to bottom ↓
        </button>
      )}
    </div>
  );
}
