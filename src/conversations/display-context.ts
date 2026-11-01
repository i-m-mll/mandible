import type { DisplayActivityItem, ToolCallActivity } from '../presentation/types.js';
import type { DisplayFragmentCoordinate } from '../presentation/fragments.js';
import type { PresentationIcon } from '../presentation/tool-presentation.js';
import type { ToolPresentation } from '../presentation/tool-presentation.js';
import type { ActivityRunFacts } from '../presentation/activity-presentation.js';
import type { PersistedBlockSource } from '../presentation/types.js';
import type { ConversationBlock } from '../parsers/types.js';
import type { CanonicalChatItemEvent } from '../presentation/types.js';
import { projectDisplayFragments } from '../presentation/fragments.js';
import { presentActivityItems, activityDetailLines } from '../presentation/activity-presentation.js';

export const DISPLAY_CONTEXT_VERSION = 1;
export type { DisplayFragmentCoordinate };
export type DisplayFragmentDescriptor = {
  id: string;
  coordinate: DisplayFragmentCoordinate;
  kind: 'content' | 'activity';
  activity_run_id: string | null;
  paired_source_positions: number[];
};
export type DisplayActivityRun = {
  id: string;
  first: DisplayFragmentCoordinate;
  last: DisplayFragmentCoordinate;
  member_count: number;
  presentation: { summary: string; icon: PresentationIcon; hasDisclosure: boolean; defaultExpanded: false; facts: ActivityRunFacts };
};
export type DisplayOwnerShell = {
  fragment_id: string;
  memberKey: string;
  coordinate: DisplayFragmentCoordinate;
  item: Omit<ToolCallActivity, 'input' | 'result'>;
  source: PersistedBlockSource;
  header: ToolPresentation;
  action_scope: { start: number; end: number };
  details?: ToolCallActivity;
};
export type ConversationDisplayContext = {
  version: typeof DISPLAY_CONTEXT_VERSION;
  fragments: DisplayFragmentDescriptor[];
  activity_runs: DisplayActivityRun[];
  aliases: Array<{ position: number; fragment_id: string }>;
  owners: DisplayOwnerShell[];
};
export type IndexedDisplayFragment = DisplayFragmentDescriptor & {
  speaker: 'user' | 'assistant' | 'system';
  activity: DisplayActivityItem | null;
  summary_from_source: boolean;
  has_details: boolean;
};
export type IndexedDisplayContext = {
  fragments: IndexedDisplayFragment[];
  activity_runs: Array<Omit<DisplayActivityRun, 'presentation'> & { members: IndexedDisplayFragment[] }>;
  aliases: ConversationDisplayContext['aliases'];
};
export const displayFragmentId = (coordinate: DisplayFragmentCoordinate): string => `${coordinate.position}:${coordinate.part}`;

export function displayEventsFromBlocks(blocks: readonly {
  position: number; content: string; metadata: ConversationBlock['metadata']; parentPosition: number | null;
}[], conversationId: string): CanonicalChatItemEvent[] {
  return blocks.flatMap(block => {
    const item = block.metadata.chat_item;
    if (!item) return [];
    const intentId = block.metadata.client_intent_id;
    return [{ type: 'chat:item' as const, item, ...(intentId ? { intentId, displayKey: `intent:${intentId}` } : {}),
      source: { blockId: `cblk:${conversationId}:${block.position}`, position: block.position,
        ...(block.parentPosition === null ? {} : { parentBlockId: `cblk:${conversationId}:${block.parentPosition}` }) } }];
  });
}

export function indexDisplayFragments(blocks: readonly Omit<ConversationBlock, 'id' | 'conversation_id'>[],
  conversationId: string, parentPosition: (position: number) => number | null): {
    fragments: IndexedDisplayFragment[]; aliases: Array<{ position: number; owner_position: number; failed: boolean }>;
  } {
  const events = displayEventsFromBlocks(blocks.map(block => ({ ...block, parentPosition: parentPosition(block.position) })), conversationId);
  const fragments = projectDisplayFragments(events, true).flatMap(fragment => {
    if (fragment.position === undefined) return [];
    const node = fragment.node;
    const coordinate = { position: fragment.position, part: fragment.part };
    const activity = node.kind === 'activity' ? node.item : null;
    const presentations = activity ? presentActivityItems([activity]) : [];
    let compact = activity;
    if (activity?.type === 'tool-call-activity') compact = { ...activity, input: '', result: activity.result
      ? { ...activity.result, content: '', fullText: undefined } : null };
    else if (activity?.type === 'thinking-block-activity') compact = { ...activity, content: '' };
    else if (activity?.type === 'provider-directive') compact = { ...activity, directive: activity.directive.kind === 'memory-citation'
      ? { kind: 'memory-citation', citations: [], rolloutIds: [] } : { ...activity.directive } };
    else if (activity?.type === 'activity') compact = { ...activity, parts: [] };
    return [{ id: displayFragmentId(coordinate), coordinate, kind: activity ? 'activity' as const : 'content' as const,
      activity_run_id: null, paired_source_positions: fragment.pairedSourcePositions,
      speaker: node.entity, activity: compact, summary_from_source: activity?.type === 'activity' && activity.parts.some(part => Boolean(part.text.trim())),
      has_details: activityDetailLines(presentations).length > 0 }];
  });
  const aliases = blocks.flatMap(block => {
    const parent = parentPosition(block.position);
    return block.type === 'tool_result' && parent !== null ? [{ position: block.position, owner_position: parent,
      failed: block.metadata.chat_item?.execution_outcome === 'failed' }] : [];
  });
  return { fragments, aliases };
}
