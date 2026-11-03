import { indexKeyString, legacyIndexKeyRecipe } from './index-keys.js';
import { activitySemanticFacts } from '../presentation/activity-presentation.js';
import type { ActivityKind } from '../parsers/types.js';
import type { ExecutionFacts } from '../presentation/execution-presentation.js';
import type { ToolCategory } from '../presentation/tool-presentation.js';
import type { ReadingDisclosures } from '../presentation/reading-disclosures.js';
import type { AssistantResponseMembership } from '../parsers/assistant-response.js';

export type OperationFacts = {category:ToolCategory;count:number;names:string[];nativeName?:string;otherKind?:'function'|'custom'};

/** Body-free semantic facts shared by ingestion, conversion and presentation. */
export type ActivityFacts = {
  kind: 'tool' | 'thinking' | 'directive-memory' | 'directive-thread' | 'activity';
  activityKind?: ActivityKind;
  severity?: 'info' | 'warning' | 'error';
  outcome?: 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  status?: string;
  /** Ephemeral authored summary, supplied only after source hydration. */
  summary?: string;
  toolName?: string;
  toolKind?: string;
  turnId?: string;
  hasResult?: boolean;
  executionActive?: boolean;
  failed?: boolean;
  running?: boolean;
  execution?: ExecutionFacts;
  operations?: OperationFacts[];
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

export type LegacyIndexedDisplayFragment = Omit<FragmentFacts,'activity'> & {activity: import('../presentation/types.js').DisplayActivityItem | null};

/** Used only by the one-time old-format converter. */
export function legacyDisplayIndexBatch(input: {positions: PositionFacts[];fragments: LegacyIndexedDisplayFragment[];aliases: PresentationIndexBatch['aliases']},conversationId:string): IndexWriteBatch {
  const recipe=(key:string)=>{const result=legacyIndexKeyRecipe(key,conversationId);if(indexKeyString(result,conversationId)!==key)throw new Error('Lossy legacy Chat identity');return result;};
  return {aliases:input.aliases,positions:input.positions.map(({handoffKeys,assistantResponse,executionKey,...position})=>({...position,handoff:handoffKeys.map(recipe),
    ...(assistantResponse?{response:{identity:recipe(assistantResponse.key),classification:assistantResponse.classification}}:{}),...(executionKey?{execution:recipe(executionKey)}:{})})),
    fragments:input.fragments.map(({activity,disclosures,...fragment})=>({...fragment,activity:activity?compactActivityFacts(activity):null,
      ...(disclosures?{disclosureRecipes:{keys:disclosures.keys.map(recipe),prefixes:disclosures.prefixes.map(recipe),...(disclosures.thinkingDefaults?{thinkingDefaults:disclosures.thinkingDefaults.map(({key,turnId})=>({key:recipe(key),turnId}))}:{})}}:{})}))};
}

export function compactActivityFacts(item: import('../presentation/types.js').DisplayActivityItem): ActivityFacts {
  const {summary: _summary,...facts}=activitySemanticFacts(item);
  return facts;
}

export type IndexKeyRecipe =
  | {kind:'native';value:string;prefix?:string;suffix?:string}
  | {kind:'source';position:number;prefix?:string;suffix?:string}
  | {kind:'intent';id:string}
  | {kind:'identity';provider:string;sessionId:string;itemKind:string;basis:'item'|'tool'|'turn'|'record';nativeId?:string;recordOrdinal?:number;contentIndex:number|null;prefix?:string;suffix?:string}
  | {kind:'execution';provider:string;sessionId:string;nativeId:string}
  | {kind:'response-record';provider:string;sessionId:string;recordOrdinal:number}
  | {kind:'response-native';provider:string;sessionId:string;turnId:string|null;nativeId:string|null};
export type IndexWritePosition = Omit<PositionFacts,'handoffKeys'|'assistantResponse'|'executionKey'> & {
  handoff:IndexKeyRecipe[];response?:{identity:IndexKeyRecipe;classification:NonNullable<PositionFacts['assistantResponse']>['classification']};execution?:IndexKeyRecipe;
};
export type IndexWriteFragment = Omit<FragmentFacts,'disclosures'> & {disclosureRecipes?: {
  keys:IndexKeyRecipe[];prefixes:IndexKeyRecipe[];thinkingDefaults?:Array<{key:IndexKeyRecipe;turnId?:string}>;
}};
export type IndexWriteBatch = {positions:IndexWritePosition[];fragments:IndexWriteFragment[];aliases:PresentationIndexBatch['aliases']};
