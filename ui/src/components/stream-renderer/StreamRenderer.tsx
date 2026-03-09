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
    let initEvent: SystemInitEvent | null = null;
    let resultEvent: ResultEvent | null = null;
    let pendingAssistant: AssistantEvent | null = null;
    const pendingResults = new Map<string, ToolResultContentBlock>();

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
        // Index tool results by tool_use_id for O(1) lookup
        for (const block of userEvent.message.content) {
          if (block.type === 'tool_result') {
            pendingResults.set(block.tool_use_id, block);
          }
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

    return { turns, initEvent, resultEvent, syntheticPrompts };
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
  const { turns, initEvent, resultEvent, syntheticPrompts } = useStreamState(events);
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

  const statusBarProps = deriveStatusBarProps(streaming, initEvent, resultEvent, sessionInfo);

  // Bug: db5e986 — treat synthetic prompts as real content so "No events" is
  // not shown after the user submits a message but before the assistant replies.
  const hasContent = events.length > 0 || syntheticPrompts.length > 0;

  if (!hasContent) {
    return (
      <div className="stream-renderer">
        <div className="stream-renderer__empty">
          {streaming ? 'Waiting for events…' : 'No events'}
        </div>
        <StatusBar streaming={streaming} {...statusBarProps} />
      </div>
    );
  }

  // Build an interleaved list of nodes: synthetic user bubbles inserted at
  // their recorded position (just before the assistant turn they precede).
  const nodes: JSX.Element[] = [];
  // Track which synthetic prompts have already been emitted
  let spIdx = 0;
  for (let i = 0; i <= turns.length; i++) {
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
      nodes.push(
        <MessageGroup
          key={turn.id}
          turn={turn}
          isStreaming={streaming && i === turns.length - 1}
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
      <StatusBar streaming={streaming} {...statusBarProps} />
    </div>
  );
}
