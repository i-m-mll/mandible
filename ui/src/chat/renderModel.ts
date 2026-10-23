import { useMemo } from 'preact/hooks';
import { chatItemIdentityKey } from '../../../src/conversation-control/provider-live';
import type {
  AssistantEvent,
  CanonicalChatItemEvent,
  ContentBlock,
  DisplayGroup,
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
  ToolCallActivity,
  ThinkingBlockActivity,
  UserEvent,
} from '../components/stream-renderer/types';
import type { ProviderDirectiveActivity } from '../components/stream-renderer/types';
import { splitProviderDirectives } from '../components/message-blocks/providerDirectives';
import type { ActivityItem, ChatItem, MessageItem, PlanItem, ToolCallItem } from '../../../src/parsers/types';

export type StreamState = {
  nodes: RenderNode[];
  initEvent: SystemInitEvent | null;
  resultEvent: ResultEvent | null;
};

let turnIndexCounter = 0;
export const TOOL_RESULT_EXCERPT_CHARS = 12000;

function chatItemText(item: MessageItem | PlanItem | ToolCallItem | ActivityItem): string {
  return item.parts.map((part) => part.text).join('\n');
}

/** Empty status and thought transport records are hidden only in Chat. */
export function isRoutineActivityStatus(item: ActivityItem): boolean {
  return ['status', 'thinking', 'reasoning-summary'].includes(item.activity_kind)
    && (item.severity === undefined || item.severity === 'info')
    && (item.execution_outcome === undefined || item.execution_outcome === 'unknown')
    && item.parts.every((part) => part.text.trim() === '');
}

export function chatItemStableKey(item: ChatItem): string {
  return chatItemIdentityKey(item, { allowTranscriptCoordinates: true })!;
}

function toolValueText(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return fallback;
  }
}

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
  let pendingCanonicalTurnId: string | undefined;
  let pendingCanonicalRowKey: string | undefined;
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
        key: pendingCanonicalRowKey ?? turn.id,
        entity: 'assistant',
        turn,
      });
      pendingAssistant = null;
      pendingCanonicalTurnId = undefined;
      pendingCanonicalRowKey = undefined;
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

  function attachResultToPriorTurn(
    toolId: string,
    result: ToolResultContentBlock,
    parentBlockId?: string,
  ): boolean {
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const node = nodes[index];
      if (node.kind !== 'assistant_turn') continue;
      const hasCall = node.turn.assistantEvent.message.content.some(
        (block) => block.type === 'tool_use'
          && block.id === toolId
          && (!parentBlockId || block.source?.blockId === parentBlockId),
      );
      if (!hasCall) continue;
      node.turn.toolResults.set(toolId, result);
      return true;
    }
    return false;
  }

  let boundarySegment = 0;
  for (const event of events) {
    if (event.type === 'chat:item') {
      const canonical = event as CanonicalChatItemEvent;
      const item = canonical.item;
      const key = canonical.displayKey ?? chatItemStableKey(item);
      const source = canonical.source;
      const turnId = item.identity.native_turn_id;
      const turnEventId = turnId ?? key;
      if (pendingAssistant && pendingCanonicalTurnId && turnId && pendingCanonicalTurnId !== turnId) {
        flushPendingTurn();
      }

      if (item.type === 'message' && item.role === 'user') {
        flushPendingTurn();
        nodes.push({ kind: 'user_message', key, entity: 'user', text: chatItemText(item), source: 'stream', persisted: source });
      } else if (item.type === 'message' && item.role === 'system') {
        flushPendingTurn();
        nodes.push({
          kind: 'semantic_event',
          key,
          entity: 'system',
          event: {
            type: 'transcript:semantic',
            uuid: key,
            session_id: item.identity.session_id,
            semantic_kind: 'system',
            content: chatItemText(item),
            label: item.provenance.source_event_type,
            is_error: item.execution_outcome === 'failed',
            source: source ?? { blockId: key },
          },
        });
      } else if (item.type === 'message' || item.type === 'plan') {
        if (!pendingAssistant) {
          pendingAssistant = {
            type: 'assistant',
            uuid: turnEventId,
            session_id: item.identity.session_id,
            parent_tool_use_id: null,
            message: { id: turnEventId, role: 'assistant', content: [] },
          };
          pendingCanonicalTurnId = turnId;
          pendingCanonicalRowKey = key;
        }
        pendingAssistant.message.content.push(item.type === 'plan'
          ? { type: 'plan', text: chatItemText(item), source, contentKey: key }
          : {
              type: 'text',
              text: chatItemText(item),
              source,
              contentKey: key,
              sourceIdentity: {
                provider: item.identity.provider,
                sessionId: item.identity.session_id,
                turnId: item.identity.native_turn_id,
              },
            });
      } else if (item.type === 'tool-call') {
        const toolItem = item as ToolCallItem;
        const toolId = toolItem.tool_id ?? toolItem.identity.native_tool_id ?? key;
        if (toolItem.phase === 'call') {
          if (!pendingAssistant) {
            pendingAssistant = {
              type: 'assistant',
              uuid: turnEventId,
              session_id: item.identity.session_id,
              parent_tool_use_id: null,
              message: { id: turnEventId, role: 'assistant', content: [] },
            };
            pendingCanonicalTurnId = turnId;
          pendingCanonicalRowKey = key;
          }
          pendingAssistant.message.content.push({
            type: 'tool_use',
            id: toolId,
            name: toolItem.tool_name ?? toolItem.tool_kind ?? 'tool',
            toolKind: toolItem.tool_kind,
            input: toolItem.input === undefined ? '' : toolValueText(toolItem.input, ''),
            sourceIdentity: {
              provider: item.identity.provider,
              sessionId: item.identity.session_id,
              turnId: item.identity.native_turn_id,
            },
            source,
            contentKey: key,
            executionActive: canonical.executionActive,
          });
          if (toolItem.output !== undefined) pendingResults.set(toolId, boundToolResultBlock({
            type: 'tool_result', tool_use_id: toolId, content: toolValueText(toolItem.output, ''),
            is_error: toolItem.execution_outcome === 'failed',
          }));
        } else {
          const result = boundToolResultBlock({
            type: 'tool_result',
            tool_use_id: toolId,
            content: toolValueText(toolItem.output, chatItemText(toolItem)),
            is_error: toolItem.execution_outcome === 'failed',
            source,
          });
          if (pendingAssistant) pendingResults.set(toolId, result);
          else if (attachResultToPriorTurn(toolId, result, source?.parentBlockId)) {
            // Exact tool identity repairs results separated from their call by
            // an intervening activity item without changing transcript order.
          } else if (source?.parentBlockId) {
            // The verified parent is outside this bounded retained window.
            // Loading the preceding window materializes the complete pair.
          } else {
            nodes.push({ kind: 'unmatched_tool_result', key, entity: 'system', result });
          }
        }
      } else if (item.type === 'activity') {
        if (isRoutineActivityStatus(item) && source?.detailsLoaded !== false) continue;
        if (isRoutineActivityStatus(item) && source?.hasBody === false) continue;
        flushPendingTurn();
        nodes.push({ kind: 'activity', key, entity: item.activity_kind === 'diagnostic' || item.severity === 'error' || item.execution_outcome === 'failed' ? item.role : 'assistant', item, source });
      }
    } else if (event.type === 'transcript:boundary') {
      flushPendingTurn();
      boundarySegment += 1;
      nodes.push({ kind: 'transcript_boundary', key: `gap:${boundarySegment}`, entity: 'system' });
    } else if (event.type === 'system' && (event as SystemInitEvent).subtype === 'init') {
      initEvent = event as SystemInitEvent;
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
        flushPendingTurn();
        nodes.push({
          kind: 'user_message',
          key: userEvent.uuid ?? `user-msg-${userMsgIdx++}`,
          entity: 'user', text: joinedText, source: 'stream',
          persisted: (userEvent.message.content.find((block) => block.type === 'text') as { source?: import('../components/stream-renderer/types').PersistedBlockSource } | undefined)?.source,
        });
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

export const MAX_DISPLAY_GROUP_NODES = 12;

function activityEdges(node: RenderNode): { starts: boolean; ends: boolean } {
  const parts = expandInlineActivities([node]);
  return { starts: parts[0]?.kind === 'activity', ends: parts.at(-1)?.kind === 'activity' };
}

export function groupMessagesForDisplay(nodes: RenderNode[]): DisplayGroup[] {
  const runs: Array<{ speaker: DisplayGroup['speaker']; nodes: RenderNode[] }> = [];

  for (const node of nodes) {
    if (node.kind === 'transcript_boundary') {
      runs.push({ speaker: 'system', nodes: [] });
      continue;
    }
    const previous = runs[runs.length - 1];
    if (previous && previous.speaker === node.entity) {
      previous.nodes.push(node);
    } else {
      runs.push({ speaker: node.entity, nodes: [node] });
    }
  }

  const groups = runs.flatMap((run): DisplayGroup[] => {
    const units: RenderNode[][] = [];
    let previousEndsInActivity = false;
    for (const node of run.nodes) {
      const edges = activityEdges(node);
      const previous = units.at(-1);
      if (edges.starts && previousEndsInActivity && previous) {
        previous.push(node);
      } else {
        units.push([node]);
      }
      previousEndsInActivity = edges.ends;
    }
    const reversedChunks: RenderNode[][] = [];
    let chunk: RenderNode[] = [];
    for (let index = units.length - 1; index >= 0; index -= 1) {
      const unit = units[index];
      if (chunk.length > 0 && chunk.length + unit.length > MAX_DISPLAY_GROUP_NODES) {
        reversedChunks.push(chunk);
        chunk = [];
      }
      chunk = [...unit, ...chunk];
    }
    if (chunk.length > 0) reversedChunks.push(chunk);
    const chunks = reversedChunks.reverse();
    return chunks.map((chunk) => ({
      id: `${run.speaker}-${chunk.at(-1)!.key}`,
      speaker: run.speaker,
      nodes: chunk,
      meta: {},
    }));
  });

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

export type ActivityDisplayEntry =
  | { kind: 'node'; node: RenderNode }
  | { kind: 'activity-group'; key: string; nodes: Array<Extract<RenderNode, { kind: 'activity' }>> };

function expandInlineActivities(nodes: readonly RenderNode[]): RenderNode[] {
  const expanded: RenderNode[] = [];
  for (const node of nodes) {
    if (node.kind !== 'assistant_turn') {
      expanded.push(node);
      continue;
    }

    const blocks = node.turn.assistantEvent.message.content;
    const hasInlineActivity = blocks.some((block) => block.type === 'tool_use'
      || block.type === 'thinking'
      || (block.type === 'text' && splitProviderDirectives(block.text).some((segment) => segment.kind === 'activity')));
    if (!hasInlineActivity) {
      expanded.push(node);
      continue;
    }

    let fragmentBlocks: ContentBlock[] = [];
    let fragmentIndex = 0;
    let directiveIndex = 0;
    const flushFragment = (): void => {
      if (fragmentBlocks.length === 0) return;
      const fragment = fragmentBlocks;
      fragmentBlocks = [];
      expanded.push({
        ...node,
        key: fragment[0].contentKey ?? `${node.key}:fragment:${fragmentIndex++}`,
        turn: {
          ...node.turn,
          assistantEvent: {
            ...node.turn.assistantEvent,
            message: { ...node.turn.assistantEvent.message, content: fragment },
          },
        },
      });
    };

    blocks.forEach((block, blockIndex) => {
      if (block.type === 'tool_use') {
        flushFragment();
        const item: ToolCallActivity = {
          type: 'tool-call-activity',
          id: block.id,
          name: block.name,
          toolKind: block.toolKind,
          input: block.input,
          result: node.turn.toolResults.get(block.id) ?? null,
          turnId: block.sourceIdentity
            ? block.sourceIdentity.turnId
            : node.turn.assistantEvent.message.id ?? node.turn.assistantEvent.uuid,
          sessionId: node.turn.assistantEvent.session_id,
          sourceIdentity: block.sourceIdentity,
          executionActive: block.executionActive && !node.turn.toolResults.has(block.id),
        };
        expanded.push({
          kind: 'activity',
          key: block.contentKey ?? `tool-call:${block.id}`,
          entity: 'assistant',
          item,
          source: block.source,
        });
        return;
      }

      if (block.type === 'thinking') {
        if (!block.thinking.trim() && block.source?.detailsLoaded !== false) return;
        flushFragment();
        const item: ThinkingBlockActivity = {
          type: 'thinking-block-activity',
          content: block.thinking,
          turnId: node.turn.assistantEvent.message.id ?? node.turn.assistantEvent.uuid,
          sessionId: node.turn.assistantEvent.session_id,
        };
        expanded.push({
          kind: 'activity',
          key: `thinking:${node.turn.id}:${block.source?.blockId ?? blockIndex}`,
          entity: 'assistant',
          item,
          source: block.source,
        });
        return;
      }

      if (block.type !== 'text') {
        fragmentBlocks.push(block);
        return;
      }
      const segments = splitProviderDirectives(block.text);
      if (!segments.some((segment) => segment.kind === 'activity')) {
        fragmentBlocks.push(block);
        return;
      }

      let ownsSource = true;
      for (const segment of segments) {
        if (segment.kind === 'text') {
          if (!segment.content.trim()) continue;
          fragmentBlocks.push({
            ...block,
            text: segment.content,
            source: ownsSource ? block.source : undefined,
          });
          ownsSource = false;
          continue;
        }
        flushFragment();
        const item: ProviderDirectiveActivity = {
          type: 'provider-directive',
          directive: segment.directive,
          turnId: block.sourceIdentity
            ? block.sourceIdentity.turnId
            : node.turn.assistantEvent.message.id ?? node.turn.assistantEvent.uuid,
          sessionId: node.turn.assistantEvent.session_id,
          provider: block.sourceIdentity?.provider,
          blockId: block.source?.blockId ?? null,
          sequence: directiveIndex,
        };
        const source = ownsSource ? block.source : undefined;
        ownsSource = false;
        expanded.push({
          kind: 'activity',
          key: `provider-directive:${node.turn.id}:${block.source?.blockId ?? blockIndex}:${directiveIndex++}`,
          entity: 'assistant',
          item,
          source,
        });
      }
    });
    flushFragment();
  }
  return expanded;
}

/** Groups every consecutive activity run without crossing visible prose or speaker boundaries. */
export function groupActivityItemsForDisplay(nodes: RenderNode[]): ActivityDisplayEntry[] {
  nodes = expandInlineActivities(nodes);
  const entries: ActivityDisplayEntry[] = [];
  let index = 0;
  while (index < nodes.length) {
    const node = nodes[index];
    if (node.kind !== 'activity') {
      entries.push({ kind: 'node', node });
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < nodes.length) {
      const next = nodes[end];
      if (next.kind !== 'activity') break;
      end += 1;
    }
    const run = nodes.slice(index, end) as Array<Extract<RenderNode, { kind: 'activity' }>>;
    if (run.length < 2) entries.push({ kind: 'node', node });
    else entries.push({ kind: 'activity-group', key: `activity:${node.key}`, nodes: run });
    index = end;
  }
  return entries;
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
  if (node.kind === 'transcript_boundary') return '';
  if (node.kind === 'user_message') {
    return `## User\n\n${node.text.trim()}`;
  }
  if (node.kind === 'semantic_event') {
    return `## ${node.event.semantic_kind === 'system' ? 'System' : 'Event'}\n\n${node.event.content.trim()}`;
  }
  if (node.kind === 'unmatched_tool_result') {
    const body = extractToolResultText(node.result.fullText ?? node.result.content).trim();
    return `## ${node.result.is_error ? 'Tool error' : 'Unmatched tool result'}\n\n${body}`;
  }
  if (node.kind === 'activity') {
    if (node.item.type !== 'activity') return '';
    const body = chatItemText(node.item).trim();
    const status = [node.item.status, node.item.execution_outcome].filter(Boolean).join(' · ');
    return `## Activity: ${node.item.activity_kind}${status ? ` (${status})` : ''}\n\n${body}`;
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
