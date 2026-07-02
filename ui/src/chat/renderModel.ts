import { useMemo } from 'preact/hooks';
import type {
  AssistantEvent,
  PresetViolationEvent,
  RenderNode,
  RenderNodeAssistantTurn,
  RenderedTurn,
  ResultEvent,
  StreamEvent,
  SyntheticPromptEvent,
  SystemInitEvent,
  ToolResultContentBlock,
  UserEvent,
} from '../components/stream-renderer/types';

export type StreamState = {
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

export function buildStreamState(events: StreamEvent[]): StreamState {
  turnIndexCounter = 0;

  const nodes: RenderNode[] = [];
  let initEvent: SystemInitEvent | null = null;
  let resultEvent: ResultEvent | null = null;
  let pendingAssistant: AssistantEvent | null = null;
  const pendingResults = new Map<string, ToolResultContentBlock>();
  let userMsgIdx = 0;

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
      const violationEvent = event as PresetViolationEvent;
      flushPendingTurn();
      nodes.push({
        kind: 'violation',
        key: violationEvent.localId ?? `violation-${nodes.length}`,
        entity: 'system',
        event: violationEvent,
      });
    } else if (event.type === 'assistant') {
      const ae = event as AssistantEvent;
      const newId = ae.message?.id;
      const pendingId = pendingAssistant?.message?.id;

      if (pendingAssistant && newId && pendingId === newId) {
        pendingAssistant = ae;
      } else {
        flushPendingTurn();
        pendingAssistant = ae;
      }
    } else if (event.type === 'user') {
      const userEvent = event as UserEvent;
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
        const existingSyntheticIdx = nodes.findIndex(
          (n) => n.kind === 'user_message' && n.source === 'synthetic' && n.text === joinedText,
        );
        if (existingSyntheticIdx >= 0) {
          nodes[existingSyntheticIdx] = {
            kind: 'user_message',
            key: userEvent.uuid ?? nodes[existingSyntheticIdx].key,
            entity: 'user',
            text: joinedText,
            source: 'stream',
          };
        } else {
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
    } else if (event.type === 'result') {
      resultEvent = event as ResultEvent;
    } else if (event.type === 'synthetic_prompt') {
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
  }

  flushPendingTurn();

  return { nodes, initEvent, resultEvent };
}

export function useStreamState(events: StreamEvent[]): StreamState {
  return useMemo(() => buildStreamState(events), [events]);
}

export function extractTurns(nodes: RenderNode[]): RenderedTurn[] {
  return nodes
    .filter((n): n is RenderNodeAssistantTurn => n.kind === 'assistant_turn')
    .map((n) => n.turn);
}

export function computeTotalTokens(
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  } | undefined,
): number | undefined {
  if (!usage) return undefined;
  return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
}

export function deriveLiveLabel(turns: RenderedTurn[], streaming: boolean): string | undefined {
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

export function deriveTokenCount(turns: RenderedTurn[]): number | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const usage = turns[i].assistantEvent.message.usage;
    const total = computeTotalTokens(usage);
    if (total !== undefined) return total;
  }
  return undefined;
}

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}
