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
  sessionInfo?: StreamRendererProps['sessionInfo'],
): {
  model?: string;
  totalCostUsd?: number;
  numTurns?: number;
  durationMs?: number;
  error?: string;
} {
  const model = sessionInfo?.model ?? initEvent?.model;

  if (!resultEvent) {
    return { model };
  }

  if (resultEvent.is_error) {
    return {
      model,
      totalCostUsd: resultEvent.total_cost_usd,
      numTurns: resultEvent.num_turns,
      durationMs: resultEvent.duration_ms,
      error: resultEvent.errors?.join('; '),
    };
  }

  return {
    model,
    totalCostUsd: resultEvent.total_cost_usd,
    numTurns: resultEvent.num_turns,
    durationMs: resultEvent.duration_ms,
  };
}

// ---- Root component ----

export function StreamRenderer({
  events,
  streaming,
  sessionInfo,
}: StreamRendererProps): JSX.Element {
  const { turns, initEvent, resultEvent, syntheticPrompts, streamUserMessages } = useStreamState(events);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [userScrolled, setUserScrolled] = useState(false);

  // Track when streaming started so we can show elapsed time in the StatusBar.
  // streamStartTimeRef records the wall-clock ms when streaming first became active.
  const streamStartTimeRef = useRef<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState<number | undefined>(undefined);

  // When streaming begins, record start time; clear on completion.
  useEffect(() => {
    if (streaming) {
      if (streamStartTimeRef.current === null) {
        streamStartTimeRef.current = Date.now();
      }
      // Tick every second to update the displayed elapsed time.
      const interval = setInterval(() => {
        if (streamStartTimeRef.current !== null) {
          setElapsedSeconds(Math.floor((Date.now() - streamStartTimeRef.current) / 1000));
        }
      }, 1000);
      // Compute immediately so the first render shows 0s rather than undefined.
      setElapsedSeconds(Math.floor((Date.now() - streamStartTimeRef.current) / 1000));
      return () => clearInterval(interval);
    } else {
      // Streaming ended — keep the final elapsed snapshot but stop ticking.
      streamStartTimeRef.current = null;
    }
  }, [streaming]);

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

  const statusBarProps = deriveStatusBarProps(streaming, initEvent, resultEvent, sessionInfo);

  // Bug: db5e986 — treat synthetic prompts as real content so "No events" is
  // not shown after the user submits a message but before the assistant replies.
  const hasContent = events.length > 0 || syntheticPrompts.length > 0 || streamUserMessages.length > 0;

  if (!hasContent) {
    return (
      <div className="stream-renderer">
        <div className="stream-renderer__empty">
          {streaming ? 'Starting…' : 'No events'}
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
        <div key={`um-${um.id}`} className="user-prompt-bubble">
          <div className="user-prompt-bubble__label">You</div>
          <div className="user-prompt-bubble__text">{um.text}</div>
        </div>,
      );
      umIdx++;
    }
    // Emit all synthetic prompts whose insertionIdx === i
    while (spIdx < syntheticPrompts.length && syntheticPrompts[spIdx].insertionIdx === i) {
      const sp = syntheticPrompts[spIdx];
      nodes.push(
        <div key={`sp-${sp.localId}`} className="user-prompt-bubble">
          <div className="user-prompt-bubble__label">You</div>
          <div className="user-prompt-bubble__text">{sp.text}</div>
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
      nodes.push(
        <MessageGroup
          key={turn.id}
          turn={turn}
          isStreaming={isLastStreamingTurn}
          isThinking={isThinking}
        />,
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
