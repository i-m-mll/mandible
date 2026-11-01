import type { DisplayActivityItem, ToolCallActivity } from '../presentation/types.js';
import type { DisplayFragmentCoordinate } from '../presentation/fragments.js';
import type { PresentationIcon } from '../presentation/tool-presentation.js';
import type { ToolPresentation } from '../presentation/tool-presentation.js';
import type { ActivityRunFacts } from '../presentation/activity-presentation.js';
import type { PersistedBlockSource } from '../presentation/types.js';

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
  coordinate: DisplayFragmentCoordinate;
  item: Omit<ToolCallActivity, 'input' | 'result'>;
  source: PersistedBlockSource;
  header: ToolPresentation;
  action_scope: { start: number; end: number };
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
