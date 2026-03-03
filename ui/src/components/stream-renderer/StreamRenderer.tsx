// Bug: aa35aeb — Console tab renderer: root component with event parsing and auto-scroll

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type {
  AssistantEvent,
  RenderedTurn,
  ResultEvent,
  StreamEvent,
  StreamRendererProps,
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
      }
      // Unknown event types (stream_event, system:compact_boundary, etc.) are silently ignored
    }

    // Flush the final pending turn
    if (pendingAssistant) {
      turns.push(buildTurn(pendingAssistant, pendingResults));
    }

    return { turns, initEvent, resultEvent };
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
  const { turns, initEvent, resultEvent } = useStreamState(events);
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

  if (events.length === 0) {
    return (
      <div className="stream-renderer">
        <div className="stream-renderer__empty">
          {streaming ? 'Waiting for events…' : 'No events'}
        </div>
        <StatusBar streaming={streaming} {...statusBarProps} />
      </div>
    );
  }

  return (
    <div className="stream-renderer">
      <div
        ref={scrollRef}
        className="stream-renderer__scroll"
        onScroll={handleScroll}
      >
        {turns.map((turn, i) => (
          <MessageGroup
            key={turn.id}
            turn={turn}
            isStreaming={streaming && i === turns.length - 1}
          />
        ))}
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
