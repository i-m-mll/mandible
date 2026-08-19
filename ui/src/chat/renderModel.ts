import { useMemo } from 'preact/hooks';
import type {
  AssistantEvent,
  ContentBlock,
  DisplayGroup,
  PresetViolationEvent,
  RenderNode,
  RenderNodeAssistantTurn,
  RenderedTurn,
  ResultEvent,
  StreamEvent,
  SyntheticPromptEvent,
  ToolResultContent,
  SystemInitEvent,
  ToolResultContentBlock,
  TranscriptSemanticEvent,
  UserEvent,
} from '../components/stream-renderer/types';

export type StreamState = {
  nodes: RenderNode[];
  initEvent: SystemInitEvent | null;
  resultEvent: ResultEvent | null;
};

let turnIndexCounter = 0;
export const TOOL_RESULT_EXCERPT_CHARS = 12000;

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

export function extractToolResultText(content: ToolResultContent): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
      .map((item) => item.text ?? '')
      .join('\n');
  }
  return '';
}

export function boundToolResultBlock(
  block: ToolResultContentBlock,
  maxChars = TOOL_RESULT_EXCERPT_CHARS,
): ToolResultContentBlock {
  const fullText = extractToolResultText(block.content);
  if (!fullText || fullText.length <= maxChars) {
    return block;
  }

  const excerpt = `${fullText.slice(0, maxChars).trimEnd()}\n\n[Output truncated]`;
  return {
    ...block,
    content: excerpt,
    truncated: true,
    fullText,
    omittedCharacters: fullText.length - maxChars,
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
      const toolUseIds = new Set(pendingAssistant.message.content
        .filter((block) => block.type === 'tool_use')
        .map((block) => block.type === 'tool_use' ? block.id : ''));
      const turn = buildTurn(pendingAssistant, pendingResults);
      nodes.push({
        kind: 'assistant_turn',
        key: turn.id,
        entity: 'assistant',
        turn,
      });
      pendingAssistant = null;
      for (const [toolUseId, result] of pendingResults) {
        if (!toolUseIds.has(toolUseId)) {
          nodes.push({
            kind: 'unmatched_tool_result',
            key: result.source?.blockId ?? `unmatched-result-${nodes.length}`,
            entity: 'system',
            result,
          });
        }
      }
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
    } else if (event.type === 'transcript:semantic') {
      flushPendingTurn();
      const semanticEvent = event as TranscriptSemanticEvent;
      nodes.push({
        kind: 'semantic_event',
        key: semanticEvent.uuid,
        entity: 'system',
        event: semanticEvent,
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
          const resultBlock = block as ToolResultContentBlock;
          const boundedResult = boundToolResultBlock(resultBlock);
          if (pendingAssistant) {
            pendingResults.set(resultBlock.tool_use_id, boundedResult);
          } else {
            nodes.push({
              kind: 'unmatched_tool_result',
              key: resultBlock.source?.blockId ?? userEvent.uuid ?? `unmatched-result-${nodes.length}`,
              entity: 'system',
              result: boundedResult,
            });
          }
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
            persisted: (userEvent.message.content.find((block) => block.type === 'text') as { source?: import('../components/stream-renderer/types').PersistedBlockSource } | undefined)?.source,
          };
        } else {
          flushPendingTurn();
          nodes.push({
            kind: 'user_message',
            key: userEvent.uuid ?? `user-msg-${userMsgIdx++}`,
            entity: 'user',
            text: joinedText,
            source: 'stream',
            persisted: (userEvent.message.content.find((block) => block.type === 'text') as { source?: import('../components/stream-renderer/types').PersistedBlockSource } | undefined)?.source,
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

export function groupMessagesForDisplay(nodes: RenderNode[]): DisplayGroup[] {
  const groups: DisplayGroup[] = [];

  for (const node of nodes) {
    const previous = groups[groups.length - 1];
    if (previous && previous.speaker === node.entity) {
      previous.nodes.push(node);
    } else {
      groups.push({
        id: `${node.entity}-${node.key}`,
        speaker: node.entity,
        nodes: [node],
        meta: {},
      });
    }
  }

  return groups.map((group) => {
    let tokenSum = 0;
    let foundTokens = false;
    let model: string | undefined;

    for (const node of group.nodes) {
      if (node.kind !== 'assistant_turn') {
        continue;
      }
      const message = node.turn.assistantEvent.message;
      const total = computeTotalTokens(message.usage);
      if (total !== undefined) {
        tokenSum += total;
        foundTokens = true;
      }
      model = model ?? message.model;
    }

    return {
      ...group,
      meta: {
        totalTokens: foundTokens ? tokenSum : undefined,
        model,
      },
    };
  });
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

function contentBlockToMarkdown(block: ContentBlock, toolResults?: Map<string, ToolResultContentBlock>): string {
  if (block.type === 'text') {
    return block.text.trim();
  }
  if (block.type === 'thinking') {
    const body = block.thinking.trim();
    return body ? `<details><summary>Thinking</summary>\n\n${body}\n\n</details>` : '';
  }
  if (block.type === 'tool_use') {
    const input = JSON.stringify(block.input, null, 2);
    const result = toolResults?.get(block.id);
    const resultText = result ? extractToolResultText(result.fullText ?? result.content).trim() : '';
    const parts = [
      `**Tool: ${block.name}**`,
      '```json',
      input,
      '```',
    ];
    if (resultText) {
      parts.push('', '**Result**', '```text', resultText, '```');
    }
    return parts.join('\n');
  }
  return '';
}

export function renderNodeToMarkdown(node: RenderNode): string {
  if (node.kind === 'user_message') {
    return `## User\n\n${node.text.trim()}`;
  }
  if (node.kind === 'violation') {
    const preset = node.event.preset_id ? ` for ${node.event.preset_id}` : '';
    return `## System\n\nPreset violation${preset}${node.event.analyzing ? ' is being analyzed.' : '.'}`;
  }
  if (node.kind === 'semantic_event') {
    return `## ${node.event.semantic_kind === 'system' ? 'System' : 'Event'}\n\n${node.event.content.trim()}`;
  }
  if (node.kind === 'unmatched_tool_result') {
    const body = extractToolResultText(node.result.fullText ?? node.result.content).trim();
    return `## ${node.result.is_error ? 'Tool error' : 'Unmatched tool result'}\n\n${body}`;
  }

  const parts = node.turn.assistantEvent.message.content
    .map((block) => contentBlockToMarkdown(block, node.turn.toolResults))
    .filter(Boolean);
  return `## Assistant\n\n${parts.join('\n\n')}`;
}

export function serializeDisplayGroupToMarkdown(group: DisplayGroup): string {
  return group.nodes.map(renderNodeToMarkdown).filter(Boolean).join('\n\n');
}

export function serializeConversationToMarkdown(nodes: RenderNode[]): string {
  return nodes.map(renderNodeToMarkdown).filter(Boolean).join('\n\n---\n\n');
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
  if (blocks.some((block) => block.type === 'plan' && block.text.trim())) {
    return 'Planning';
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
