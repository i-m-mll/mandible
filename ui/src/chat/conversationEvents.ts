import type { ConversationBlock } from '../api';
import type {
  AssistantEvent,
  StreamEvent,
  ToolResultContentBlock,
} from '../components/stream-renderer/types';

export function deriveStreamingState(events: StreamEvent[]): boolean {
  const last = events[events.length - 1];
  if (!last) return false;
  if (last.type === 'result') return false;
  if (last.type === 'assistant') {
    const assistantEvent = last as AssistantEvent;
    if (assistantEvent.message.stop_reason) return false;
  }
  return true;
}

export function flushPendingSSE(
  pendingSSERef: { current: StreamEvent[] },
  setStreamEvents: (fn: (prev: StreamEvent[]) => StreamEvent[]) => void,
  setStreaming: (v: boolean) => void,
): void {
  const pending = pendingSSERef.current;
  pendingSSERef.current = [];
  if (pending.length === 0) return;
  setStreamEvents((prev) => {
    const newEvents = pending.filter((pe) => {
      const peJson = JSON.stringify(pe);
      return !prev.some((existing) => JSON.stringify(existing) === peJson);
    });
    const merged = newEvents.length > 0 ? [...prev, ...newEvents] : prev;
    setStreaming(deriveStreamingState(merged));
    return merged;
  });
}

export function computeLiveTail(
  historyEvents: StreamEvent[],
  memEvents: StreamEvent[],
): StreamEvent[] {
  const historyAssistantCount = historyEvents.filter((e) => e.type === 'assistant').length;

  if (historyAssistantCount === 0) {
    return memEvents;
  }

  let assistantsSeen = 0;
  let tailStart = memEvents.length;

  for (let i = 0; i < memEvents.length; i++) {
    if (memEvents[i].type === 'assistant') {
      assistantsSeen++;
    }
    if (assistantsSeen === historyAssistantCount) {
      tailStart = i + 1;
      while (tailStart < memEvents.length) {
        const next = memEvents[tailStart];
        if (next.type === 'user' && 'message' in next) {
          const content = (next as { message: { content?: unknown[] } }).message.content;
          if (Array.isArray(content) && content.every((b) => (
            typeof b === 'object' && b !== null && (b as Record<string, unknown>).type === 'tool_result'
          ))) {
            tailStart++;
            continue;
          }
        }
        break;
      }
      break;
    }
  }

  return memEvents.slice(tailStart);
}

function parseMetadata(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function conversationBlocksToStreamEvents(
  providerSessionId: string,
  blocks: Pick<ConversationBlock, 'id' | 'type' | 'content' | 'metadata_json'>[],
): StreamEvent[] {
  const events: StreamEvent[] = [];
  let assistantBlocks: Array<Record<string, unknown>> = [];
  let assistantTurnStartId: string | null = null;
  let assistantUsage: Record<string, unknown> | undefined;

  const flushAssistant = () => {
    if (assistantBlocks.length === 0) return;
    events.push({
      type: 'assistant',
      uuid: assistantTurnStartId ?? undefined,
      session_id: providerSessionId,
      parent_tool_use_id: null,
      message: {
        id: assistantTurnStartId ?? undefined,
        role: 'assistant',
        content: assistantBlocks as Array<{ type: string; [key: string]: unknown }>,
        usage: assistantUsage,
      },
    });
    assistantBlocks = [];
    assistantTurnStartId = null;
    assistantUsage = undefined;
  };

  const pushAssistantBlock = (blockId: string, contentBlock: Record<string, unknown>) => {
    if (!assistantTurnStartId) {
      assistantTurnStartId = blockId;
    }
    assistantBlocks.push(contentBlock);
  };

  for (const block of blocks) {
    const metadata = parseMetadata(block.metadata_json);

    if (block.type === 'user_message') {
      flushAssistant();
      events.push({
        type: 'user',
        uuid: block.id,
        session_id: providerSessionId,
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [{ type: 'text', text: block.content }],
        },
      });
      continue;
    }

    if (block.type === 'assistant_message') {
      if (!assistantUsage && metadata.token_usage && typeof metadata.token_usage === 'object') {
        const tokenUsage = metadata.token_usage as Record<string, unknown>;
        assistantUsage = {
          input_tokens: tokenUsage.input ?? tokenUsage.input_tokens,
          output_tokens: tokenUsage.output ?? tokenUsage.output_tokens,
          cache_read_input_tokens: tokenUsage.cache_read ?? tokenUsage.cache_read_input_tokens,
          cache_creation_input_tokens: tokenUsage.cache_creation ?? tokenUsage.cache_creation_input_tokens,
        };
      }
      pushAssistantBlock(block.id, { type: 'text', text: block.content });
      continue;
    }

    if (block.type === 'thinking') {
      pushAssistantBlock(block.id, { type: 'thinking', thinking: block.content });
      continue;
    }

    if (block.type === 'plan') {
      pushAssistantBlock(block.id, { type: 'plan', text: block.content });
      continue;
    }

    if (block.type === 'tool_use') {
      pushAssistantBlock(block.id, {
        type: 'tool_use',
        id: String(metadata.tool_id ?? `tool-${events.length}`),
        name: String(metadata.tool_name ?? 'tool'),
        input: (metadata.tool_input as Record<string, unknown> | undefined) ?? {},
      });
      continue;
    }

    if (block.type === 'tool_result') {
      const toolResult: ToolResultContentBlock = {
        type: 'tool_result',
        tool_use_id: String(metadata.tool_id ?? ''),
        content: block.content,
      };
      events.push({
        type: 'user',
        uuid: block.id,
        session_id: providerSessionId,
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [toolResult],
        },
      });
      continue;
    }
  }

  flushAssistant();

  if (events.length > 0) {
    events.push({
      type: 'result',
      session_id: providerSessionId,
      subtype: 'success',
      duration_ms: 0,
      duration_api_ms: 0,
      is_error: false,
      num_turns: 0,
      result: '',
      cost_usd: 0,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
    } as unknown as StreamEvent);
  }
  return events;
}
