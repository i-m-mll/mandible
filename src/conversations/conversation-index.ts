import type { ActivityKind } from '../parsers/types.js';
import type { ExecutionFacts } from '../presentation/execution-presentation.js';
import type { ToolCategory } from '../presentation/tool-presentation.js';
import type { ReadingDisclosures } from '../presentation/reading-disclosures.js';
import type { AssistantResponseMembership } from '../parsers/assistant-response.js';

/** Body-free semantic facts shared by ingestion, conversion and presentation. */
export type ActivityFacts = {
  kind: 'tool' | 'thinking' | 'directive-memory' | 'directive-thread' | 'activity';
  activityKind?: ActivityKind;
  severity?: 'info' | 'warning' | 'error';
  outcome?: 'success' | 'failed' | 'cancelled' | 'unknown';
  status?: string;
  toolName?: string;
  toolKind?: string;
  turnId?: string;
  failed?: boolean;
  running?: boolean;
  execution?: ExecutionFacts;
  operations?: Array<{ category: ToolCategory; count: number; names: string[] }>;
};
export type PositionFacts = {
  position: number; revision: string; speaker: 'user' | 'assistant' | 'system'; handoffKeys: string[];
  assistantResponse?: AssistantResponseMembership; executionKey?: string; turnId?: string;
  usage?: { key: string; input: number; output: number };
};
export type FragmentFacts = {
  id: string; coordinate: { position: number; part: string }; kind: 'content' | 'activity';
  speaker: PositionFacts['speaker']; activity_run_id: string | null; paired_source_positions: number[];
  activity: ActivityFacts | null; disclosures?: ReadingDisclosures;
  summary_from_source: boolean; summary_eligible?: boolean; has_details: boolean;
};
export type PresentationIndexBatch = {
  positions: PositionFacts[]; fragments: FragmentFacts[];
  aliases: Array<{ position: number; owner_position: number; failed: boolean }>;
};
