import type { ReadingDisclosures } from '../presentation/reading-disclosures.js';
import type { DisplayActivityItem, ToolCallActivity } from '../presentation/types.js';
import type { DisplayFragmentCoordinate } from '../presentation/fragments.js';
import type { PresentationIcon } from '../presentation/tool-presentation.js';
import type { ToolPresentation } from '../presentation/tool-presentation.js';
import type { ActivityRunFacts } from '../presentation/activity-presentation.js';
import type { PersistedBlockSource } from '../presentation/types.js';
import type { ConversationBlock } from '../parsers/types.js';
import type { CanonicalChatItemEvent } from '../presentation/types.js';

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
export type DisplayPositionFacts = {
  position: number;
  revision: string;
  speaker: 'user' | 'assistant' | 'system';
  handoffKeys: string[];
  assistantResponse?: import("../parsers/assistant-response.js").AssistantResponseMembership;
  executionKey?: string;
  turnId?: string;
  usage?: { key: string; input: number; output: number };
};
export type IndexedDisplayFragment = DisplayFragmentDescriptor & {
  disclosures?: ReadingDisclosures;
  speaker: 'user' | 'assistant' | 'system';
  activity: DisplayActivityItem | null;
  summary_from_source: boolean;
  summary_eligible?: boolean;
  has_details: boolean;
};
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
    const item = block.metadata.chat_item;
    if (!item) return [];
    const intentId = block.metadata.client_intent_id;
    const usage = block.metadata.token_usage;
    return [{ type: 'chat:item' as const, item, ...(intentId ? { intentId, displayKey: `intent:${intentId}` } : {}),
      ...(usage && Number.isFinite(usage.input) && Number.isFinite(usage.output) ? { usage: { key: typeof block.metadata.provider_message_id === 'string' ? block.metadata.provider_message_id : `record:${item.identity.source_record_ordinal}`, input: usage.input, output: usage.output } } : {}),
      source: { ...(block.details_loaded === undefined ? {} : { detailsLoaded: block.details_loaded, defaultVisible: true }), ...(typeof block.metadata.display_has_body === 'boolean' ? { hasBody: block.metadata.display_has_body } : {}), ...(block.timestamp ? { timestamp: block.timestamp } : {}), ...(block.dag_uuid ? { dagUuid: block.dag_uuid } : {}), blockId: `cblk:${conversationId}:${block.position}`, position: block.position,
        ...(block.parentPosition === null ? {} : { parentBlockId: `cblk:${conversationId}:${block.parentPosition}` }) } }];
  });
}

/** Source indexing and summary hydration preserve the default lazy renderer's visible status evidence. */
export function defaultDisplayEventsFromBlocks(blocks: Parameters<typeof displayEventsFromBlocks>[0], conversationId: string): CanonicalChatItemEvent[] {
  return displayEventsFromBlocks(blocks.map(block => ({ ...block, details_loaded: false,
    metadata: block.metadata.source_event_type === 'reasoning_summary' ? {...block.metadata, display_has_body: block.content.split(/\r?\n/).map(line => line.trim()).filter(Boolean).length > 1} : block.metadata,
  })), conversationId);
}

export function displaySummaryMembers(members: readonly IndexedDisplayFragment[]): readonly IndexedDisplayFragment[] {
  const contributors = members.filter(member => member.summary_eligible !== false);
  return contributors.length ? contributors : members;
}
