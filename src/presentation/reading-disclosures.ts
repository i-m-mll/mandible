import type { ContentBlock, RenderNode } from './types.js';

export function readingContentBlockDisclosureKey(turnId: string, block: ContentBlock, index: number): string {
  return block.contentKey ?? (block.type === 'tool_use' ? `tool:${block.id}` : `${turnId}:${block.type}:${index}`);
}
export type ReadingRenderContext = { streaming?: boolean; lastAssistantTurnId?: string };
export const readingThinkingDefaultExpanded = (turnId: string | undefined, context: ReadingRenderContext): boolean =>
  Boolean(context.streaming && turnId === context.lastAssistantTurnId);
export const readingToolExecutionActive = (active: boolean | undefined, context: ReadingRenderContext): boolean => Boolean(active && context.streaming);
export type ReadingDisclosures = {
  keys: readonly string[]; prefixes: readonly string[];
  thinkingDefaults?: readonly { key: string; turnId?: string }[];
};
export function readingNodeDisclosures(node: RenderNode): ReadingDisclosures {
  switch (node.kind) {
    case 'activity': {
      const key = `activity:${node.key}`;
      return { keys: [key], prefixes: [], ...(node.item.type === 'thinking-block-activity' ? { thinkingDefaults: [{ key, turnId: node.item.turnId }] } : {}) };
    }
    case 'semantic_event': return { keys: [`semantic:${node.key}`], prefixes: [] };
    case 'unmatched_tool_result': return { keys: [`unmatched-tool-result:${node.key}`], prefixes: [] };
    case 'user_message': return { keys: [], prefixes: [`${node.key}:`] };
    case 'assistant_turn': return {
      keys: node.turn.assistantEvent.message.content.map((block, index) => readingContentBlockDisclosureKey(node.turn.id, block, index)), prefixes: [`${node.key}:`],
      thinkingDefaults: node.turn.assistantEvent.message.content.flatMap((block, index) => block.type === 'thinking'
        ? [{ key: readingContentBlockDisclosureKey(node.turn.id, block, index), turnId: node.turn.id }] : []),
    };
    case 'transcript_boundary': return { keys: [], prefixes: [] };
  }
}
export function readingDisclosureState(disclosures: ReadingDisclosures | undefined, expanded: Readonly<Record<string, boolean>>, context: ReadingRenderContext = {}): Array<[string, boolean]> {
  if (!disclosures) return [];
  const states = new Map(Object.entries(expanded).filter(([key]) => disclosures.keys.includes(key) || disclosures.prefixes.some(prefix => key.startsWith(prefix))));
  for (const item of disclosures.thinkingDefaults ?? []) states.set(item.key, expanded[item.key] ?? readingThinkingDefaultExpanded(item.turnId, context));
  return [...states].sort(([left], [right]) => left.localeCompare(right));
}
