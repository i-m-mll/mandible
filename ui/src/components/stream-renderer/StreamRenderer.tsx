// Bug: aa35aeb — Console tab renderer: root component with event parsing and auto-scroll
// Bug: d744dde — P2: chronological RenderNode array replaces insertionIdx interleaving

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
import { StatusBar } from './StatusBar';
import { MessageActions } from '../shared/MessageActions';
import { PresetViolationBlock } from './PresetViolationBlock';

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
        // Flush previous turn before starting a new one
        flushPendingTurn();
        pendingAssistant = event as AssistantEvent;
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
          // User text message: flush pending turn, emit user_message node
          flushPendingTurn();
          nodes.push({
            kind: 'user_message',
            key: userEvent.uuid ?? `user-msg-${userMsgIdx++}`,
            entity: 'user',
            text: textParts.join('\n'),
            source: 'stream',
          });
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

// ---- StatusBar data derivation ----

function deriveStatusBarProps(
  streaming: boolean,
  initEvent: SystemInitEvent | null,
  resultEvent: ResultEvent | null,
  liveLabel: string | undefined,
  sessionInfo?: StreamRendererProps['sessionInfo'],
): {
  model?: string;
  totalCostUsd?: number;
  numTurns?: number;
  durationMs?: number;
  error?: string;
  liveLabel?: string;
  backend?: string;
  modelOptions?: string[];
  modelSaving?: boolean;
  onChangeModel?: (model: string) => void | Promise<void>;
} {
  const model = sessionInfo?.model ?? initEvent?.model;
  const backend = sessionInfo?.backend;
  const shared = {
    backend,
    modelOptions: sessionInfo?.modelOptions,
    modelSaving: sessionInfo?.modelSaving,
    onChangeModel: sessionInfo?.onChangeModel,
  };

  if (!resultEvent) {
    return { model, liveLabel, ...shared };
  }

  if (resultEvent.is_error) {
    return {
      model,
      totalCostUsd: resultEvent.total_cost_usd,
      numTurns: resultEvent.num_turns,
      durationMs: resultEvent.duration_ms,
      error: resultEvent.errors?.join('; '),
      liveLabel,
      ...shared,
    };
  }

  return {
    model,
    totalCostUsd: resultEvent.total_cost_usd,
    numTurns: resultEvent.num_turns,
    durationMs: resultEvent.duration_ms,
    liveLabel,
    ...shared,
  };
}

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

/** Bug: 4891ce4 — Extract token count from the last assistant event's usage for inline display. */
function deriveTokenCount(turns: RenderedTurn[]): number | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const usage = turns[i].assistantEvent.message.usage;
    if (usage) {
      return usage.input_tokens + usage.output_tokens;
    }
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
}: StreamRendererProps): JSX.Element {
  const { nodes, initEvent, resultEvent } = useStreamState(events);
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
  const statusBarProps = deriveStatusBarProps(
    streaming,
    initEvent,
    resultEvent,
    liveLabel,
    sessionInfo,
  );

  // Bug: d744dde — nodes array is the single source of truth for content presence
  const hasContent = nodes.length > 0;

  if (!hasContent) {
    return (
      <div className="stream-renderer">
        <div className="stream-renderer__empty">
          {emptyLabel ?? (streaming ? 'Starting\u2026' : 'No events')}
        </div>
        <StatusBar streaming={streaming} elapsedSeconds={elapsedSeconds} {...statusBarProps} />
      </div>
    );
  }

  // Precompute the index of the last assistant_turn node for isLastStreamingTurn
  let lastAssistantIdx = -1;
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (nodes[i].kind === 'assistant_turn') {
      lastAssistantIdx = i;
      break;
    }
  }

  // Bug: d744dde — Render loop: flat .map() over chronological RenderNode array
  const rendered = nodes.map((node, idx) => {
    switch (node.kind) {
      case 'user_message':
        return (
          <div key={node.key} className="stream-turn stream-turn--user">
            <div className="stream-turn__speaker">
              <span className="stream-turn__badge">You</span>
            </div>
            <div className="stream-turn__body">
              <div className="user-prompt-bubble">
                <div className="user-prompt-bubble__text">{node.text}</div>
              </div>
            </div>
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
        const isLastStreamingTurn = streaming && idx === lastAssistantIdx;
        // Show "thinking..." indicator when the streaming turn contains a thinking block
        const isThinking =
          isLastStreamingTurn &&
          turn.assistantEvent.message.content.some((b) => b.type === 'thinking');

        // Collect text content for copy action
        const turnTextParts: string[] = [];
        for (const block of turn.assistantEvent.message.content) {
          if (block.type === 'text' && block.text) turnTextParts.push(block.text);
        }
        const turnText = turnTextParts.join('\n\n');

        return (
          <div key={node.key} className="stream-turn stream-turn--assistant" style={{ position: 'relative' }}>
            <div className="stream-turn__speaker">
              <span className="stream-turn__badge">Assistant</span>
            </div>
            <div className="stream-turn__body">
              <MessageGroup
                turn={turn}
                isStreaming={isLastStreamingTurn}
                isThinking={isThinking}
              />
            </div>
            <MessageActions
              onCopy={() => { navigator.clipboard.writeText(turnText).catch(() => {}); }}
            />
          </div>
        );
      }

      default:
        return null;
    }
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
      <StatusBar streaming={streaming} elapsedSeconds={elapsedSeconds} {...statusBarProps} />
    </div>
  );
}
