import type { ContentBlock, RenderNode } from './types.js';

export function readingContentBlockDisclosureKey(turnId: string, block: ContentBlock, index: number): string {
  return block.contentKey ?? (block.type === 'tool_use' ? `tool:${block.id}` : `${turnId}:${block.type}:${index}`);
}

export type ReadingDisclosures = { keys: readonly string[]; prefixes: readonly string[] };
export function readingNodeDisclosures(node: RenderNode): ReadingDisclosures {
  switch (node.kind) {
    case 'activity': return { keys: [`activity:${node.key}`], prefixes: [] };
    case 'semantic_event': return { keys: [`semantic:${node.key}`], prefixes: [] };
    case 'unmatched_tool_result': return { keys: [`unmatched-tool-result:${node.key}`], prefixes: [] };
    case 'user_message': return { keys: [], prefixes: [`${node.key}:`] };
    case 'assistant_turn': return { keys: node.turn.assistantEvent.message.content.map((block, index) => readingContentBlockDisclosureKey(node.turn.id, block, index)), prefixes: [`${node.key}:`] };
    case 'transcript_boundary': return { keys: [], prefixes: [] };
  }
}
export function readingDisclosureState(disclosures: ReadingDisclosures | undefined, expanded: Readonly<Record<string, boolean>>): Array<[string, boolean]> {
  return disclosures ? Object.entries(expanded).filter(([key]) => disclosures.keys.includes(key) || disclosures.prefixes.some(prefix => key.startsWith(prefix)))
    .sort(([left], [right]) => left.localeCompare(right)) : [];
}
