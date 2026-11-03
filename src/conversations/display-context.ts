import type { ToolCallActivity } from '../presentation/types.js';
import type { DisplayFragmentCoordinate } from '../presentation/fragments.js';
import type { PresentationIcon } from '../presentation/tool-presentation.js';
import type { ToolPresentation } from '../presentation/tool-presentation.js';
import { presentReasoning, type ActivityRunFacts } from '../presentation/activity-presentation.js';
import type { PersistedBlockSource } from '../presentation/types.js';
import type { ConversationBlock } from '../parsers/types.js';
import type { CanonicalChatItemEvent } from '../presentation/types.js';
import { displayChatItem, isEmptyCompletionMetadata } from '../presentation/model.js';

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
export type { PositionFacts as DisplayPositionFacts, FragmentFacts as IndexedDisplayFragment } from './conversation-index.js';
import type { FragmentFacts as IndexedDisplayFragment } from './conversation-index.js';
export type IndexedDisplayContext = {
  fragments: IndexedDisplayFragment[];
  activity_runs: Array<Omit<DisplayActivityRun, 'presentation'> & { members: IndexedDisplayFragment[] }>;
  aliases: ConversationDisplayContext['aliases'];
};
export const displayFragmentId = (coordinate: DisplayFragmentCoordinate): string => `${coordinate.position}:${coordinate.part}`;

export function displayEventsFromBlocks(blocks: readonly {
  position: number; content: string; timestamp?: string | null; details_loaded?: boolean; dag_uuid?: string | null; metadata: ConversationBlock['metadata'] & { display_has_body?: boolean }; parentPosition: number | null;
}[], conversationId: string): CanonicalChatItemEvent[] {
  return blocks.flatMap(block => {
    const canonicalItem = block.metadata.chat_item;
    if (!canonicalItem) return [];
    const item = displayChatItem(canonicalItem, block.metadata);
    const intentId = block.metadata.client_intent_id;
    const usage = block.metadata.token_usage;
    const hasBody = block.metadata.display_has_body ?? (item.type === 'activity' && item.provenance.source_event_type === 'task_complete'
      ? !isEmptyCompletionMetadata(item, false, usage ?? block.metadata.usage_telemetry) : undefined);
    return [{ type: 'chat:item' as const, item, ...(intentId ? { intentId, displayKey: `intent:${intentId}` } : {}),
      ...(usage && Number.isFinite(usage.input) && Number.isFinite(usage.output) ? { usage: { key: typeof block.metadata.provider_message_id === 'string' ? block.metadata.provider_message_id : `record:${item.identity.source_record_ordinal}`, input: usage.input, output: usage.output } } : {}),
      source: { ...(block.metadata.display_tool_frame ? {toolFrame:block.metadata.display_tool_frame} : {}), ...(block.details_loaded === undefined ? {} : { detailsLoaded: block.details_loaded, defaultVisible: true }), ...(hasBody === undefined ? {} : { hasBody }), ...(block.timestamp ? { timestamp: block.timestamp } : {}), ...(block.dag_uuid ? { dagUuid: block.dag_uuid } : {}), blockId: `cblk:${conversationId}:${block.position}`, position: block.position,
        ...(block.parentPosition === null ? {} : { parentBlockId: `cblk:${conversationId}:${block.parentPosition}` }) } }];
  });
}

/** Source indexing and summary hydration preserve the default lazy renderer's visible status evidence. */
export function defaultDisplayEventsFromBlocks(blocks: Parameters<typeof displayEventsFromBlocks>[0], conversationId: string): CanonicalChatItemEvent[] {
  return displayEventsFromBlocks(blocks.map(block => ({ ...block, details_loaded: false,
    metadata: block.metadata.source_event_type === 'reasoning_summary' ? {...block.metadata, display_has_body: presentReasoning([block.content]).hasBody} : block.metadata,
  })), conversationId);
}

export function displaySummaryMembers(members: readonly IndexedDisplayFragment[]): readonly IndexedDisplayFragment[] {
  const contributors = members.filter(member => member.summary_eligible !== false);
  return contributors.length ? contributors : members;
}
