import { operationDefinition } from './operation-registry.js';
import { expandInlineActivities } from './model.js';
import { activityTargetKey, activityObservationTargets } from './activity-targets.js';
import { toolObservation } from './tool-observation.js';
import { operationPhrase, operationState, substantiveToolResult } from './tool-operation.js';
import type { ActivityFacts } from '../conversations/conversation-index.js';
import { compactToolOperation, compactToolRunFacts } from './tool-presentation.js';
import { operationObservationForTool, presentationForObservation } from './tool-observation.js';
import type { ActivityItem, ActivityKind } from '../parsers/types.js';
import type { DisplayActivityItem, ToolCallActivity } from './types.js';
import { plainActivityHeader } from './activity-text.js';
import { classifyTool, presentTool, toolRunFacts, mergeToolRunFacts, summarizeToolRunFacts, type ToolRunFact, type PresentationIcon } from './tool-presentation.js';

const ACTIVITY_LABELS: Record<ActivityKind, string> = {
  'reasoning-summary': 'Thought', thinking: 'Thought',
  'tool-progress': 'Tool progress', 'tool-summary': 'Tool summary',
  status: 'Status', information: 'Information', diagnostic: 'Diagnostic',
};

export function plainActivityParts(item: ActivityItem): string[] {
  return item.parts
    .map((part) => plainActivityHeader(part.text).trim())
    .filter(Boolean);
}

/** Only an authored leading heading supplies a reasoning title. */
export function presentReasoning(parts: readonly string[]): { summary: string; details: string[]; hasBody: boolean } {
  const nonempty = parts.map(part => part.trim()).filter(Boolean);
  const first = nonempty[0] ?? '';
  const heading = /^(?:\*\*([^\n]+?)\*\*|__([^\n]+?)__|#{1,6}[ \t]+([^\n]+?))[ \t]*(?:\r?\n|$)/.exec(first);
  const summary = heading ? plainActivityHeader(heading[1] ?? heading[2] ?? heading[3]).trim() : 'Thought';
  const remainder = heading ? first.slice(heading[0].length).trim() : first;
  const details = [remainder, ...nonempty.slice(1)].filter(Boolean).map(plainActivityHeader);
  return { summary, details, hasBody: details.length > 0 };
}

export type ActivityDetail = string
  | { kind: 'citation'; ref: string; note: string | null }
  | { kind: 'chat-reference'; providerSessionId: string };

export function activityState(item: DisplayActivityItem): string[] {
  if (item.type === 'provider-directive') return [];
  if (item.type === 'tool-call-activity') {
    const evidence=item.executionEvidence ?? item.result?.source?.toolExecution;
    const state=operationState(evidence?.state,item.result ? {failed:activityToolObservation(item).result?.failed,is_error:item.result.is_error} : undefined,item.executionActive);
    return state==='failed' ? ['Failed'] : state==='cancelled' ? ['Cancelled'] : state==='ongoing' ? ['Running'] : [];
  }
  if (item.type === 'thinking-block-activity') return [];
  return [
    item.severity && item.severity !== 'info' ? item.severity : undefined,
    item.execution_outcome && item.execution_outcome !== 'unknown' ? item.execution_outcome : undefined,
    item.status,
  ].filter((value): value is string => Boolean(value));
}

function activityDetails(item: DisplayActivityItem, parts: readonly string[]): ActivityDetail[] {
  if (item.type === 'provider-directive') {
    if (item.directive.kind === 'memory-citation') {
      return [
        ...item.directive.citations.map((citation) => ({ kind: 'citation' as const, ...citation })),
        ...item.directive.rolloutIds.map((id) => ({ kind: 'chat-reference' as const, providerSessionId: id })),
      ];
    }
    return [];
  }
  if (item.type === 'tool-call-activity') return [];
  if (item.type === 'thinking-block-activity') return presentReasoning([item.content]).details;
  if (item.activity_kind === 'thinking' || item.activity_kind === 'reasoning-summary') return presentReasoning(item.parts.map(part => part.text)).details;
  const details = [...parts.slice(1)];
  if (item.tool_name) details.push(`Tool: ${item.tool_name}`);
  if (item.elapsed_ms !== undefined) details.push(`${item.elapsed_ms.toLocaleString()} ms`);
  return details;
}

export type ActivityPresentation = {
  summary: string;
  details: ActivityDetail[];
  members: DisplayActivityItem[];
};

/** Fold adjacent exact-visible duplicates without changing canonical membership. */
function activitySummary(item: DisplayActivityItem, parts: readonly string[], state: readonly string[]): string {
  if (item.type === 'provider-directive') {
    return item.directive.kind === 'memory-citation' ? 'Used memory' : 'Created thread';
  }
  if (item.type === 'tool-call-activity') {
    const observation=activityToolObservation(item);
    if(item.operations && !observation.header.operation) {const label=summarizeToolRunFacts(item.operations).join('; ');return label.charAt(0).toUpperCase()+label.slice(1);}
    return operationPhrase(observation.header,operationState(item.executionEvidence?.state ?? item.result?.source?.toolExecution?.state,item.result ? {failed:observation.result?.failed,is_error:item.result.is_error} : undefined,item.executionActive),observation.result);
  }
  if (item.type === 'thinking-block-activity') return presentReasoning([item.content]).summary;
  if (item.activity_kind === 'thinking' || item.activity_kind === 'reasoning-summary') return presentReasoning(item.parts.map(part => part.text)).summary;
  const base = parts[0] ?? ACTIVITY_LABELS[item.activity_kind];
  return [...new Set([base, ...state])].join(' · ');
}

export function presentActivityItems(items: readonly DisplayActivityItem[]): ActivityPresentation[] {
  const presentations: ActivityPresentation[] = [];
  for (const item of items) {
    const parts = item.type === 'activity' ? plainActivityParts(item)
      : item.type === 'thinking-block-activity' ? item.content.split('\n').map((part) => part.trim()).filter(Boolean)
        : [];
    const state = activityState(item);
    presentations.push({
      summary: activitySummary(item, parts, state),
      details: activityDetails(item, parts),
      members: [item],
    });
  }
  return presentations;
}

export function activityDetailLines(
  presentations: readonly ActivityPresentation[],
  includeMemberLabels = false,
): ActivityDetail[] {
  return presentations.flatMap((presentation, index) => {
    const item = presentation.members[0];
    if (includeMemberLabels && item) {
      if (item.type === 'thinking-block-activity' || item.type === 'tool-call-activity') return presentation.details;
      return [presentation.summary, ...presentation.details];
    }
    return index === 0 ? presentation.details : [presentation.summary, ...presentation.details];
  });
}

export type ActivityRunFacts = {
  memberCount: number; unified: boolean; firstSummary: string; firstIcon: PresentationIcon;
  states: string[]; toolStates: string[]; tools: ToolRunFact[]; hasThinkingTool: boolean;
  labels: Array<{key:string;label:string;count:number}>; hasDetails: boolean;
};
function activityToolObservation(item:ToolCallActivity) {
  const context=item.operationContext ?? item.result?.source?.toolOperation;
  const input=context?.input;
  return toolObservation(context?.name ?? item.name,typeof input==='string' || (input && typeof input==='object' && !Array.isArray(input)) ? input as Record<string,unknown> | string : item.input,context?.kind ?? item.toolKind,item.result ? {text:item.result.fullText ?? (typeof item.result.content==='string' ? item.result.content : item.result.content.filter(block=>block.type==='text').map(block=>block.text).join('\n')),content:item.result.content,frame:item.result.source?.toolFrame,native:item.result.presentation,failed:item.result.is_error} : undefined,item.header);
}
function activityHasDetails(item:DisplayActivityItem):boolean {
  if(item.type==='thinking-block-activity') return presentReasoning([item.content]).hasBody;
  if(item.type==='activity' && ['thinking','reasoning-summary'].includes(item.activity_kind)) return presentReasoning(item.parts.map(part=>part.text)).hasBody;
  if(item.type==='tool-call-activity') {
    const observation=activityToolObservation(item);
    return observation.header.hasDetails ?? Boolean(observation.result && substantiveToolResult(observation.result));
  }
  return false;
}
export function activitySemanticFacts(item: DisplayActivityItem): ActivityFacts {
  if(item.type==='tool-call-activity') {
    const observation=operationObservationForTool(item);
    return {kind:'tool',toolName:item.name,toolKind:item.toolKind,turnId:item.turnId,hasResult:Boolean(item.result),
      failed:observation.execution.state==='failed',running:observation.execution.state==='ongoing',observation};
  }
  if (item.type === 'thinking-block-activity') return {kind:'thinking',turnId:item.turnId,summary:presentReasoning([item.content]).summary};
  if (item.type === 'provider-directive') return {kind:item.directive.kind === 'memory-citation' ? 'directive-memory' : 'directive-thread',turnId:item.turnId};
  return {kind:'activity',activityKind:item.activity_kind,severity:item.severity,outcome:item.execution_outcome,status:item.status,
    ...(item.local_command ? {localCommandStream:item.local_command.stream} : {}),
    summary:activitySummary(item,plainActivityParts(item),activityState(item))};
}
export function semanticActivityState(item: ActivityFacts): string[] {
  return item.kind === 'tool' ? [item.observation?.execution.state==='cancelled'?'Cancelled':undefined,(item.observation?item.observation.execution.state==='failed':item.failed) ? 'Failed' : undefined,(item.observation?item.observation.execution.state==='ongoing':item.running) ? 'Running' : undefined].filter((value):value is string=>Boolean(value))
    : item.kind === 'activity' ? [item.severity && item.severity !== 'info' ? item.severity : undefined,
      item.outcome && item.outcome !== 'unknown' ? item.outcome : undefined,item.status].filter((value):value is string=>Boolean(value)) : [];
}
export function semanticToolOperations(item:ActivityFacts):NonNullable<ActivityFacts['operations']> {
  return item.operations??toolRunFacts([{name:item.toolName??'',toolKind:item.toolKind,execution:item.execution}]).map(compactToolOperation);
}
export function semanticActivitySummary(item: ActivityFacts): string {
  if(item.summary !== undefined)return item.summary;
  if(item.kind==='tool'&&item.observation) return operationPhrase(presentationForObservation(item.observation,item.toolKind),item.observation.execution.state);
  if(item.kind==='tool') {const text=summarizeToolRunFacts(compactToolRunFacts(semanticToolOperations(item))).join('; '); return text.charAt(0).toUpperCase()+text.slice(1);}
  if(item.kind==='thinking')return 'Thought';
  if(item.kind==='directive-memory')return 'Used memory';
  if(item.kind==='directive-thread')return 'Created thread';
  return [...new Set([ACTIVITY_LABELS[item.activityKind!],...semanticActivityState(item)])].join(' · ');
}
export function semanticActivityIcon(item: ActivityFacts): PresentationIcon {
  if(item.localCommandStream)return 'workSettings';
  if(item.kind==='tool'&&item.observation) return presentationForObservation(item.observation,item.toolKind).icon;
  if(item.kind==='tool') return compactToolRunFacts(semanticToolOperations(item))[0]?.presentation.icon ?? 'monitor';
  if(item.kind==='thinking')return 'thought';
  if(item.kind==='directive-memory')return 'history';
  if(item.kind==='directive-thread')return 'chat';
  return item.activityKind==='thinking'||item.activityKind==='reasoning-summary' ? 'thought'
    :item.activityKind==='tool-progress'||item.activityKind==='tool-summary' ? 'terminal'
    :item.activityKind==='information' ? 'info' :item.activityKind==='diagnostic' ? 'issues' :'monitor';
}
export const semanticActivityUnified = (item: ActivityFacts): boolean => item.kind !== 'activity' || ['thinking','reasoning-summary'].includes(item.activityKind!);
export function semanticActivityRunFacts(items: readonly ActivityFacts[]): ActivityRunFacts {
  const labels = new Map<string,{key:string;label:string;count:number}>();
  const add = (key:string,label:string) => { const prior=labels.get(key); if(prior) prior.count++; else labels.set(key,{key,label,count:1}); };
  for(const item of items) {
    if(item.kind==='tool')continue;
    if(item.kind==='thinking'||(item.kind==='activity'&&['thinking','reasoning-summary'].includes(item.activityKind!)))add('thought','thought');
    else if(item.kind==='directive-memory')add('memory','used memory');
    else if(item.kind==='directive-thread')add('chat-reference','created thread');
    else {const summary=semanticActivitySummary(item);add(item.activityKind+':'+summary.charAt(0).toLowerCase()+summary.slice(1),summary.charAt(0).toLowerCase()+summary.slice(1));}
  }
  const tools=items.filter(item=>item.kind==='tool');
  return {memberCount:items.length,unified:items.some(semanticActivityUnified),firstSummary:items[0]?semanticActivitySummary(items[0]):'',
    firstIcon:items[0]?semanticActivityIcon(items[0]):'monitor',states:[...new Set(items.flatMap(semanticActivityState))],
    toolStates:[...new Set(tools.flatMap(semanticActivityState))],tools:tools.reduce<ToolRunFact[]>((facts,item)=>mergeToolRunFacts(facts,item.observation ? toolRunFacts([{name:item.observation.nativeName??item.toolName??'',header:presentationForObservation(item.observation,item.toolKind),state:item.observation.execution.state}]) : compactToolRunFacts(semanticToolOperations(item))),[]),
    hasThinkingTool:tools.some(item=>classifyTool(item.toolName ?? '')==='think'),labels:[...labels.values()],
    hasDetails:items.some(semanticActivityUnified)||items.length>1};
}
export function activityRunFacts(items:readonly DisplayActivityItem[]):ActivityRunFacts {
  const facts=semanticActivityRunFacts(items.map(activitySemanticFacts));
  return {...facts,hasDetails:items.some(activityHasDetails)||activityDetailLines(presentActivityItems(items)).length>0};
}
export function mergeActivityRunFacts(left:ActivityRunFacts,right:ActivityRunFacts):ActivityRunFacts {
  if(!left.memberCount)return right;if(!right.memberCount)return left;
  const labels=new Map(left.labels.map(label=>[label.key,{...label}]));
  for(const label of right.labels){const prior=labels.get(label.key);if(prior)prior.count+=label.count;else labels.set(label.key,{...label});}
  return {...left, memberCount:left.memberCount+right.memberCount,unified:left.unified||right.unified,
    states:[...new Set([...left.states,...right.states])],toolStates:[...new Set([...left.toolStates,...right.toolStates])],
    tools:mergeToolRunFacts(left.tools,right.tools),hasThinkingTool:left.hasThinkingTool||right.hasThinkingTool,labels:[...labels.values()],hasDetails:true};
}
export function presentActivityRunFacts(facts:ActivityRunFacts):{summary:string;icon:PresentationIcon;hasDisclosure:boolean;defaultExpanded:false} {
  let summary=facts.firstSummary;
  if(facts.memberCount>1){
    if(!facts.unified)summary=[...new Set([...facts.firstSummary.split(' · '),...facts.states])].join(' · ');
    else {
      const labels=facts.labels.filter(label=>label.key!=='thought'||!facts.hasThinkingTool).map(label=>label.key==='chat-reference'&&label.count>1?'created threads':label.label);
      const states=facts.tools.filter(fact=>fact.state==='failed'||fact.state==='cancelled').map(fact=>`${fact.count} ${operationDefinition(fact.operation)?.noun??'tool call'}${fact.count===1?'':'s'} ${fact.state}`);
      const text=[...summarizeToolRunFacts(facts.tools),...labels,...states].join('; ');summary=text.charAt(0).toUpperCase()+text.slice(1);
    }
  }
  return {summary,icon:facts.firstIcon,hasDisclosure:facts.hasDetails,defaultExpanded:false};
}
export function summarizeActivityRun(items:readonly DisplayActivityItem[],_presentations:readonly ActivityPresentation[]):string {
  return presentActivityRunFacts(activityRunFacts(items)).summary;
}

export function activityIconName(item: DisplayActivityItem): PresentationIcon {
  if(item.type==='activity'&&item.local_command)return 'workSettings';
  if (item.type === 'provider-directive') return item.directive.kind === 'memory-citation' ? 'history' : 'chat';
  if (item.type === 'tool-call-activity' && item.operations?.length) return item.operations[0].presentation.icon;
  if (item.type === 'tool-call-activity') return item.execution?.kind === 'command' ? 'toolExecute' : (item.header ?? presentTool(item.name, item.input, item.toolKind)).icon;
  if (item.type === 'thinking-block-activity') return 'thought';
  if (item.activity_kind === 'thinking' || item.activity_kind === 'reasoning-summary') return 'thought';
  if (item.activity_kind === 'tool-progress' || item.activity_kind === 'tool-summary') return 'terminal';
  if (item.activity_kind === 'information') return 'info';
  if (item.activity_kind === 'diagnostic') return 'issues';
  return 'monitor';
}

/** Targets demanded by the same materialized production rows used for visible and measured bodies. */
export function activityTargetsFromReadingRows(rows:readonly import('./reading.js').ReadingRow[]):import('./activity-targets.js').ActivityTarget[] {
  const targets:import('./activity-targets.js').ActivityTarget[]=[];
  for(const row of rows)for(const node of expandInlineActivities(row.activityGroup?.items??row.nodes)) {
    if(node.kind!=='activity')continue;
    const item=node.item;
    if(item.type==='tool-call-activity')targets.push(...activityObservationTargets(operationObservationForTool(item)));
    else if(item.type==='provider-directive') {
      if(item.directive.kind==='created-thread')targets.push(item.directive.identity==='threadId'
        ?{kind:'thread',provider:'codex',sessionId:item.directive.providerSessionId}
        :{kind:'pending-thread',provider:'codex',clientThreadId:item.directive.providerSessionId});
      else for(const sessionId of item.directive.rolloutIds)targets.push({kind:'thread',provider:'codex',sessionId});
    }
  }
  return [...new Map(targets.map(target=>[activityTargetKey(target),target])).values()];
}
