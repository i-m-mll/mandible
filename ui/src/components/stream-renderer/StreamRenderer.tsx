// Bug: aa35aeb — Console tab renderer: root component with event parsing and auto-scroll
// Bug: d744dde — P2: chronological RenderNode array replaces insertionIdx interleaving
// Bug: a654b69 — P4: automatic message grouping with TurnGroup + sticky speakers
// Bug: bce7370 — Adapted to use shared message-blocks components

import type { JSX } from 'preact/jsx-runtime';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type {
  AssistantEvent,
  PresetViolationEvent,
  RenderNode,
  RenderNodeAssistantTurn,
  RenderedTurn,
  ResultEvent,
  StreamEvent,
  StreamRendererProps,
  SyntheticPromptEvent,
  SystemInitEvent,
  ToolResultContentBlock,
  UserEvent,
} from './types';
import { MessageGroup } from './MessageGroup';
// FORBIDDEN (Bug: fbca9d5): No StatusBar import — no UI between stream and input.
// Bug: 236d03b — MessageActions import removed; per-block actions now live in MessageGroup.
import { groupByEntity } from '../shared/groupByEntity';
import type { NodeGroup } from '../shared/groupByEntity';
import { PresetViolationBlock } from './PresetViolationBlock';
import { TurnGroup } from '../message-blocks/TurnGroup';
import { GroupFooter } from '../message-blocks/GroupFooter';
import { UserBubble } from '../message-blocks/UserBubble';

// ---- Event parsing hook ----

type StreamState = {
  nodes: RenderNode[];
  initEvent: SystemInitEvent | null;
  resultEvent: ResultEvent | null;
};

let turnIndexCounter = 0;

function buildTurn(
  assistant: AssistantEvent,
  results: Map<string, ToolResultContentBlock>,
): RenderedTurn {
  return {
    id: assistant.uuid ?? assistant.message?.id ?? `turn-idx-${turnIndexCounter++}`,
    assistantEvent: assistant,
    toolResults: new Map(results),
    receivedAt: Date.now(),
  };
}

/** Extract turns from the RenderNode array for helper functions. */
function extractTurns(nodes: RenderNode[]): RenderedTurn[] {
  return nodes
    .filter((n): n is RenderNodeAssistantTurn => n.kind === 'assistant_turn')
    .map((n) => n.turn);
}

function useStreamState(events: StreamEvent[]): StreamState {
  return useMemo(() => {
    // Reset counter per memo computation so IDs are stable across re-renders
    turnIndexCounter = 0;

    const nodes: RenderNode[] = [];
    let initEvent: SystemInitEvent | null = null;
    let resultEvent: ResultEvent | null = null;
    let pendingAssistant: AssistantEvent | null = null;
    const pendingResults = new Map<string, ToolResultContentBlock>();
    let userMsgIdx = 0;

    /** Flush the current pending assistant turn into nodes. */
    function flushPendingTurn(): void {
      if (pendingAssistant) {
        const turn = buildTurn(pendingAssistant, pendingResults);
        nodes.push({
          kind: 'assistant_turn',
          key: turn.id,
          entity: 'assistant',
          turn,
        });
        pendingAssistant = null;
        pendingResults.clear();
      }
    }

    for (const event of events) {
      if (event.type === 'system' && (event as SystemInitEvent).subtype === 'init') {
        initEvent = event as SystemInitEvent;
      } else if (event.type === 'preset:violation') {
        // Bug: 11f4f47 — Violation events flush the pending turn and emit inline
        const violationEvent = event as PresetViolationEvent;
        flushPendingTurn();
        nodes.push({
          kind: 'violation',
          key: violationEvent.localId ?? `violation-${nodes.length}`,
          entity: 'system',
          event: violationEvent,
        });
      } else if (event.type === 'assistant') {
        // Bug: cad4eef — SDK emits multiple assistant events with the same message.id
        // as streaming updates (progressive content blocks). Replace in place instead
        // of flushing, so only the final (most complete) event per message.id is rendered.
        const ae = event as AssistantEvent;
        const newId = ae.message?.id;
        const pendingId = pendingAssistant?.message?.id;

        if (pendingAssistant && newId && pendingId === newId) {
          // Same turn, streaming update — replace, don't flush
          pendingAssistant = ae;
        } else {
          // Different turn — flush previous, start new
          flushPendingTurn();
          pendingAssistant = ae;
        }
      } else if (event.type === 'user') {
        const userEvent = event as UserEvent;
        // Collect text blocks (top-level user prompt) and tool results (mid-turn).
        // Bug: 5183781 — user text events from the real stream (page-refresh-stable)
        // must appear as user bubbles, not just be consumed silently as tool results.
        let hasText = false;
        const textParts: string[] = [];
        for (const block of userEvent.message.content) {
          if (block.type === 'tool_result') {
            pendingResults.set((block as ToolResultContentBlock).tool_use_id, block as ToolResultContentBlock);
          } else if (block.type === 'text' && (block as { type: 'text'; text: string }).text) {
            textParts.push((block as { type: 'text'; text: string }).text);
            hasText = true;
          }
        }
        if (hasText) {
          const joinedText = textParts.join('\n');
          // Bug: bce7370 — Fix 3: Deduplicate user text events against existing
          // synthetic_prompt nodes. The SDK echoes the user prompt back as a real
          // user event, but we already created a synthetic node for it on submission.
          // If a matching synthetic exists, replace it with the real event (preserving
          // position) instead of creating a duplicate.
          const existingSyntheticIdx = nodes.findIndex(
            (n) => n.kind === 'user_message' && n.source === 'synthetic' && n.text === joinedText,
          );
          if (existingSyntheticIdx >= 0) {
            // Replace synthetic with the real stream event, keeping position
            nodes[existingSyntheticIdx] = {
              kind: 'user_message',
              key: userEvent.uuid ?? nodes[existingSyntheticIdx].key,
              entity: 'user',
              text: joinedText,
              source: 'stream',
            };
          } else {
            // No matching synthetic — emit user_message node
            flushPendingTurn();
            nodes.push({
              kind: 'user_message',
              key: userEvent.uuid ?? `user-msg-${userMsgIdx++}`,
              entity: 'user',
              text: joinedText,
              source: 'stream',
            });
          }
        }
        // If only tool_results (no text), silently accumulate in pendingResults — no visible node
      } else if (event.type === 'result') {
        resultEvent = event as ResultEvent;
      } else if (event.type === 'synthetic_prompt') {
        // Bug: db5e986 — optimistic user prompt display
        const sp = event as SyntheticPromptEvent;
        flushPendingTurn();
        nodes.push({
          kind: 'user_message',
          key: `sp-${sp.localId}`,
          entity: 'user',
          text: sp.text,
          source: 'synthetic',
        });
      }
      // Unknown event types (stream_event, system:compact_boundary, etc.) are silently ignored
    }

    // Flush the final pending turn
    flushPendingTurn();

    return { nodes, initEvent, resultEvent };
  }, [events]);
}

// FORBIDDEN (Bug: fbca9d5): deriveStatusBarProps removed — no StatusBar in chat stream.

function deriveLiveLabel(turns: RenderedTurn[], streaming: boolean): string | undefined {
  if (!streaming) {
    return undefined;
  }
  const lastTurn = turns[turns.length - 1];
  if (!lastTurn) {
    return 'Waiting for reply';
  }
  const blocks = lastTurn.assistantEvent.message.content;
  if (blocks.some((block) => block.type === 'thinking' && block.thinking.trim())) {
    return 'Thinking';
  }
  if (blocks.some((block) => block.type === 'tool_use')) {
    return 'Using tools';
  }
  if (blocks.some((block) => block.type === 'text' && block.text.trim())) {
    return 'Responding';
  }
  return 'Working';
}

/** Bug: cad4eef — Compute per-turn token count for display.
 *  Bug: bce7370 — Fix 6: Exclude cache_creation and cache_read tokens from the
 *  displayed count. These represent the system prompt/context cache size (e.g.,
 *  ~21K tokens from CLAUDE.md presets), not the actual tokens consumed for THIS
 *  turn. Showing input_tokens + output_tokens gives a meaningful per-turn number. */
function computeTotalTokens(usage: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | undefined): number | undefined {
  if (!usage) return undefined;
  return (usage.input_tokens ?? 0)
    + (usage.output_tokens ?? 0);
}

/** Bug: 4891ce4 — Extract token count from the last assistant event's usage for inline display. */
function deriveTokenCount(turns: RenderedTurn[]): number | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const usage = turns[i].assistantEvent.message.usage;
    const total = computeTotalTokens(usage);
    if (total !== undefined) return total;
  }
  return undefined;
}

/** Bug: 4891ce4 — Format elapsed seconds as "Xs" or "Xm Ys". */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

// ---- Root component ----

export function StreamRenderer({
  events,
  streaming,
  elapsedSeconds,
  emptyLabel,
  sessionInfo,
  onSelectMessageInfo,
  selectedMessageId,
}: StreamRendererProps): JSX.Element {
  const { nodes } = useStreamState(events);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [userScrolled, setUserScrolled] = useState(false);

  // Auto-scroll to bottom when new events arrive while streaming
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

  // Bug: d744dde — nodes array is the single source of truth for content presence
  const hasContent = nodes.length > 0;

  if (!hasContent) {
    return (
      <div className="stream-renderer">
        <div className="stream-renderer__empty">
          {emptyLabel ?? (streaming ? 'Starting\u2026' : 'No events')}
        </div>
        {/* FORBIDDEN (Bug: fbca9d5): No StatusBar here — no UI between stream and input. */}
      </div>
    );
  }

  // Bug: a654b69 — P4: group consecutive same-entity nodes for TurnGroup layout
  const groups = groupByEntity(nodes, (n) => n.entity, (n) => n.key);

  // Precompute the key of the last assistant_turn node for isLastStreamingTurn
  let lastAssistantKey: string | null = null;
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (nodes[i].kind === 'assistant_turn') {
      lastAssistantKey = nodes[i].key;
      break;
    }
  }

  /** Render a single node's body content (no speaker badge — that's at the group level). */
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

        // Bug: 236d03b — Fix 5: Group-level MessageActions removed; per-block
        // MessageActions now live inside MessageGroup. The group-level copy
        // moves to GroupFooter's always-visible copy button (for multi-block turns).
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

  /** Collect all copyable text from a group's nodes. */
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

    // Bug: 35edd3d — Aggregate token count across all assistant turns in the group
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
        {/* Bug: 4891ce4 — Inline streaming indicator at bottom of chat stream.
            Shows pulsing dot, status label, token count, and elapsed timer.
            Only visible when agent is actively working. */}
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
      {/* FORBIDDEN (Bug: fbca9d5): No StatusBar here — no UI between stream and input. */}
    </div>
  );
}
