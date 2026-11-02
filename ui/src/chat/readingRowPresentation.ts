import type { ReadingRow } from './readingProjection';
export function isCompactReadingRow(row: { kind?: ReadingRow['kind']; nodes?: ReadingRow['nodes'] }): boolean {
  if (row.kind === 'activity-summary') return true;
  if (row.kind !== 'content' || !row.nodes?.length) return false;
  return row.nodes.every(node => node.kind === 'transcript_boundary' || node.kind === 'activity' || node.kind === 'semantic_event' || node.kind === 'unmatched_tool_result'
    || (node.kind === 'assistant_turn' && node.turn.assistantEvent.message.content.every(block => block.type === 'tool_use' || block.type === 'thinking')));
}
