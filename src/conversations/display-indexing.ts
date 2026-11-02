import { projectExecution } from '../presentation/execution-presentation.js';
import { assistantResponseMembership } from "../parsers/assistant-response.js";
import {isRoutineActivityStatus} from '../presentation/model.js';
import { readingNodeDisclosures } from '../presentation/reading-disclosures.js';
import { createHash } from 'node:crypto';
import { readingMemberKeys, readingSpeaker } from './reading-context.js';
import { defaultDisplayEventsFromBlocks, displayFragmentId, type IndexedDisplayFragment, type DisplayPositionFacts } from './display-context.js';
import { projectDisplayFragments } from '../presentation/fragments.js';
import { presentActivityItems, activityDetailLines } from '../presentation/activity-presentation.js';
import type { ConversationBlock } from '../parsers/types.js';

export function indexDisplayFragments(blocks: readonly Omit<ConversationBlock, 'id' | 'conversation_id'>[],
  conversationId: string, parentPosition: (position: number) => number | null): {
    fragments: IndexedDisplayFragment[]; aliases: Array<{ position: number; owner_position: number; failed: boolean }>; positions: DisplayPositionFacts[];
  } {
  const events = defaultDisplayEventsFromBlocks(blocks.map(block => ({ ...block, parentPosition: parentPosition(block.position) })), conversationId);
  const fragments = projectDisplayFragments(events, true).flatMap(fragment => {
    if (fragment.position === undefined) return [];
    const node = fragment.node;
    const coordinate = { position: fragment.position, part: fragment.part };
    const activity = node.kind === 'activity' ? node.item : null;
    const presentations = activity ? presentActivityItems([activity]) : [];
    let compact = activity;
    if (activity?.type === 'tool-call-activity') compact = { ...activity, execution: projectExecution(activity.name, activity.input, activity.toolKind)?.facts, input: '', result: activity.result
      ? { ...activity.result, content: '', fullText: undefined } : null };
    else if (activity?.type === 'thinking-block-activity') compact = { ...activity, content: '' };
    else if (activity?.type === 'provider-directive') compact = { ...activity, directive: activity.directive.kind === 'memory-citation'
      ? { kind: 'memory-citation', citations: [], rolloutIds: [] } : { ...activity.directive } };
    else if (activity?.type === 'activity') compact = { ...activity, parts: [] };
    return [{ id: displayFragmentId(coordinate), coordinate, kind: activity ? 'activity' as const : 'content' as const,
      activity_run_id: null, paired_source_positions: fragment.pairedSourcePositions,
      summary_eligible: !(activity?.type === 'activity' && isRoutineActivityStatus(activity, node.kind === 'activity' && node.source?.hasBody)),
      speaker: node.entity, disclosures: readingNodeDisclosures(node), activity: compact, summary_from_source: activity?.type === 'activity' && activity.parts.some(part => Boolean(part.text.trim())),
      has_details: activityDetailLines(presentations).length > 0 }];
  });
  const aliases = blocks.flatMap(block => {
    const parent = parentPosition(block.position);
    return block.type === 'tool_result' && parent !== null ? [{ position: block.position, owner_position: parent,
      failed: block.metadata.chat_item?.execution_outcome === 'failed' }] : [];
  });
  const positions = blocks.map(block => {
    const item = block.metadata.chat_item;
    const usage = block.metadata.token_usage;
    return { position: block.position, speaker: readingSpeaker(block.role), revision: createHash('sha256').update(JSON.stringify([
      block.type, block.role, block.content, block.timestamp, block.metadata, parentPosition(block.position),
    ])).digest('hex'), handoffKeys: item ? readingMemberKeys(item, block.metadata.client_intent_id) : [],
      turnId: item?.identity.native_turn_id,
      ...(item ? { assistantResponse: assistantResponseMembership(item) } : {}),
      ...(item?.type === 'tool-call' && (item.tool_id ?? item.identity.native_tool_id) ? {executionKey: JSON.stringify([item.identity.provider, item.identity.session_id, item.tool_id ?? item.identity.native_tool_id])} : {}),
      ...(item && usage && Number.isFinite(usage.input) && Number.isFinite(usage.output)
        ? { usage: { key: typeof block.metadata.provider_message_id === 'string' ? block.metadata.provider_message_id : `record:${item.identity.source_record_ordinal}`,
          input: usage.input, output: usage.output } } : {}) };
  });
  return { fragments, aliases, positions };
}
