// Bug: aa35aeb — Console tab renderer: root component with event parsing and auto-scroll

import type { JSX } from 'preact/jsx-runtime';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type {
  AssistantEvent,
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

// ---- Event parsing hook ----

type StreamState = {
  turns: RenderedTurn[];
  initEvent: SystemInitEvent | null;
  resultEvent: ResultEvent | null;
  /** Synthetic user prompts, in-order, interleaved with turns by insertionIdx. */
  syntheticPrompts: Array<{ localId: string; text: string; insertionIdx: number }>;
  /** User text messages from the real stream (survive page refresh), interleaved by insertionIdx. */
  streamUserMessages: Array<{ id: string; text: string; insertionIdx: number }>;
};

function buildTurn(
  assistant: AssistantEvent,
  results: Map<string, ToolResultContentBlock>,
): RenderedTurn {
  return {
    id: assistant.uuid ?? `turn-${Math.random().toString(36).slice(2)}`,
    assistantEvent: assistant,
    toolResults: new Map(results),
  };
}

function useStreamState(events: StreamEvent[]): StreamState {
  return useMemo(() => {
    const turns: RenderedTurn[] = [];
    const syntheticPrompts: StreamState['syntheticPrompts'] = [];
    const streamUserMessages: StreamState['streamUserMessages'] = [];
    let initEvent: SystemInitEvent | null = null;
    let resultEvent: ResultEvent | null = null;
    let pendingAssistant: AssistantEvent | null = null;
    const pendingResults = new Map<string, ToolResultContentBlock>();
    let userMsgIdx = 0;

    for (const event of events) {
      if (event.type === 'system' && (event as SystemInitEvent).subtype === 'init') {
        initEvent = event as SystemInitEvent;
      } else if (event.type === 'assistant') {
        // Flush previous turn before starting a new one
        if (pendingAssistant) {
          turns.push(buildTurn(pendingAssistant, pendingResults));
          pendingResults.clear();
        }
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
          // Record insertion point: just before the next assistant turn (turns.length at this moment)
          streamUserMessages.push({
            id: userEvent.uuid ?? `user-msg-${userMsgIdx++}`,
            text: textParts.join('\n'),
            insertionIdx: turns.length,
          });
        }
      } else if (event.type === 'result') {
        resultEvent = event as ResultEvent;
      } else if (event.type === 'synthetic_prompt') {
        // Bug: db5e986 — optimistic user prompt display: record insertion point so
        // the bubble is rendered just before the next assistant turn.
        const sp = event as SyntheticPromptEvent;
        syntheticPrompts.push({ localId: sp.localId, text: sp.text, insertionIdx: turns.length });
      }
      // Unknown event types (stream_event, system:compact_boundary, etc.) are silently ignored
    }

    // Flush the final pending turn
    if (pendingAssistant) {
      turns.push(buildTurn(pendingAssistant, pendingResults));
    }

    return { turns, initEvent, resultEvent, syntheticPrompts, streamUserMessages };
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

// ---- Root component ----

export function StreamRenderer({
  events,
  streaming,
  elapsedSeconds,
  emptyLabel,
  sessionInfo,
}: StreamRendererProps): JSX.Element {
  const { turns, initEvent, resultEvent, syntheticPrompts, streamUserMessages } = useStreamState(events);
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

  const liveLabel = deriveLiveLabel(turns, streaming);
  const statusBarProps = deriveStatusBarProps(
    streaming,
    initEvent,
    resultEvent,
    liveLabel,
    sessionInfo,
  );

  // Bug: db5e986 — treat synthetic prompts as real content so "No events" is
  // not shown after the user submits a message but before the assistant replies.
  const hasContent = events.length > 0 || syntheticPrompts.length > 0 || streamUserMessages.length > 0;

  if (!hasContent) {
    return (
      <div className="stream-renderer">
        <div className="stream-renderer__empty">
          {emptyLabel ?? (streaming ? 'Starting…' : 'No events')}
        </div>
        <StatusBar streaming={streaming} elapsedSeconds={elapsedSeconds} {...statusBarProps} />
      </div>
    );
  }

  // Build an interleaved list of nodes: user bubbles (both stream-based and synthetic)
  // inserted at their recorded position (just before the assistant turn they precede).
  const nodes: JSX.Element[] = [];
  // Track which prompts/messages have already been emitted
  let spIdx = 0;
  let umIdx = 0;
  for (let i = 0; i <= turns.length; i++) {
    // Emit all stream user messages whose insertionIdx === i
    // Bug: 5183781 — render user text events from the real stream as bubbles
    while (umIdx < streamUserMessages.length && streamUserMessages[umIdx].insertionIdx === i) {
      const um = streamUserMessages[umIdx];
      nodes.push(
        <div key={`um-${um.id}`} className="stream-turn stream-turn--user">
          <div className="stream-turn__speaker">
            <span className="stream-turn__badge">You</span>
          </div>
          <div className="stream-turn__body">
            <div className="user-prompt-bubble">
              <div className="user-prompt-bubble__text">{um.text}</div>
            </div>
          </div>
        </div>,
      );
      umIdx++;
    }
    // Emit all synthetic prompts whose insertionIdx === i
    while (spIdx < syntheticPrompts.length && syntheticPrompts[spIdx].insertionIdx === i) {
      const sp = syntheticPrompts[spIdx];
      nodes.push(
        <div key={`sp-${sp.localId}`} className="stream-turn stream-turn--user">
          <div className="stream-turn__speaker">
            <span className="stream-turn__badge">You</span>
          </div>
          <div className="stream-turn__body">
            <div className="user-prompt-bubble">
              <div className="user-prompt-bubble__text">{sp.text}</div>
            </div>
          </div>
        </div>,
      );
      spIdx++;
    }
    if (i < turns.length) {
      const turn = turns[i];
      const isLastStreamingTurn = streaming && i === turns.length - 1;
      // Show "thinking…" indicator when the streaming turn contains a thinking block
      const isThinking =
        isLastStreamingTurn &&
        turn.assistantEvent.message.content.some((b) => b.type === 'thinking');

      // Collect text content for copy action
      const turnTextParts: string[] = [];
      for (const block of turn.assistantEvent.message.content) {
        if (block.type === 'text' && block.text) turnTextParts.push(block.text);
      }
      const turnText = turnTextParts.join('\n\n');

      nodes.push(
        <div key={turn.id} className="stream-turn stream-turn--assistant" style={{ position: 'relative' }}>
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
        </div>,
      );
    }
  }

  return (
    <div className="stream-renderer">
      <div
        ref={scrollRef}
        className="stream-renderer__scroll"
        onScroll={handleScroll}
      >
        {nodes}
        {streaming && (
          <div className="stream-live-indicator" aria-live="polite">
            <span className="stream-live-indicator__dot" aria-hidden="true" />
            <span className="stream-live-indicator__label">
              {liveLabel ?? 'Working'}
              {elapsedSeconds !== undefined ? ` ${elapsedSeconds}s` : ''}
            </span>
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
