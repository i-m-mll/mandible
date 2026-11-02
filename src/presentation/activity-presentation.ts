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

export type ActivityDetail = string
  | { kind: 'citation'; ref: string; note: string | null }
  | { kind: 'created-thread'; identity: 'threadId' | 'clientThreadId'; providerSessionId: string };

export function activityState(item: DisplayActivityItem): string[] {
  if (item.type === 'provider-directive') return [];
  if (item.type === 'tool-call-activity') {
    return [item.result?.is_error || item.result?.presentation?.failed ? 'Failed' : undefined,item.result?.running || item.result?.presentation?.running ? 'Running' : undefined].filter((value):value is string=>Boolean(value));
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
        ...item.directive.rolloutIds.map((id) => `Task: ${id}`),
      ];
    }
    return [{
      kind: 'created-thread',
      identity: item.directive.identity,
      providerSessionId: item.directive.providerSessionId,
    }];
  }
  if (item.type === 'tool-call-activity') return [];
  if (item.type === 'thinking-block-activity') return item.content.trim() ? [item.content.trim()] : [];
  if (item.activity_kind === 'thinking') return [...parts.slice(1)];
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
    return item.directive.kind === 'memory-citation' ? 'Used memory' : 'Created task';
  }
  if (item.type === 'tool-call-activity') {
    if (item.operations) {const label=summarizeToolRunFacts(item.operations).join('; ');return label.charAt(0).toUpperCase()+label.slice(1);}
    const presentation = item.header ?? presentTool(item.name, item.input, item.toolKind);
    const execution = item.execution ?? presentation.execution;
    return execution?.kind === 'command' ? execution.count === 1 ? 'Ran command' : 'Ran several commands' : presentation.phrase;
  }
  if (item.type === 'thinking-block-activity') return 'Thought';
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
export function activityRunFacts(items: readonly DisplayActivityItem[]): ActivityRunFacts {
  const presentations = presentActivityItems(items);
  const tools = items.filter((item):item is ToolCallActivity => item.type === 'tool-call-activity');
  const labels = new Map<string,{key:string;label:string;count:number}>();
  const add = (key:string,label:string) => { const prior=labels.get(key); if(prior) prior.count++; else labels.set(key,{key,label,count:1}); };
  items.forEach((item,index)=>{
    if(item.type==='tool-call-activity')return;
    if(item.type==='thinking-block-activity'||(item.type==='activity'&&['thinking','reasoning-summary'].includes(item.activity_kind)))add('thought','thought');
    else if(item.type==='provider-directive')add(item.directive.kind==='memory-citation'?'memory':'created-task',item.directive.kind==='memory-citation'?'used memory':'created task');
    else { const summary=presentations[index].summary; const label=summary.charAt(0).toLowerCase()+summary.slice(1); add(item.activity_kind+':'+label,label); }
  });
  return {memberCount:items.length, unified:items.some(item=>item.type!=='activity'||['thinking','reasoning-summary'].includes(item.activity_kind)),
    firstSummary:presentations[0]?.summary??'',firstIcon:items[0]?activityIconName(items[0]):'monitor',
    states:[...new Set(items.flatMap(activityState))], toolStates:[...new Set(tools.flatMap(activityState))],tools:toolRunFacts(tools.map(item=>({name:item.name,toolKind:item.toolKind,input:item.input,execution:item.execution,operations:item.operations}))),
    hasThinkingTool:tools.some(item=>classifyTool(item.name)==='think'),labels:[...labels.values()],
    hasDetails:items.some(item=>item.type!=='activity'||['thinking','reasoning-summary'].includes(item.activity_kind))||activityDetailLines(presentations).length>0};
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
      const labels=facts.labels.filter(label=>label.key!=='thought'||!facts.hasThinkingTool).map(label=>label.key==='created-task'&&label.count>1?'created tasks':label.label);
      const states=facts.toolStates.map(state=>state.charAt(0).toLowerCase()+state.slice(1));
      const text=[...summarizeToolRunFacts(facts.tools),...labels,...states].join('; ');summary=text.charAt(0).toUpperCase()+text.slice(1);
    }
  }
  return {summary,icon:facts.firstIcon,hasDisclosure:facts.hasDetails,defaultExpanded:false};
}
export function summarizeActivityRun(items:readonly DisplayActivityItem[],_presentations:readonly ActivityPresentation[]):string {
  return presentActivityRunFacts(activityRunFacts(items)).summary;
}

export function activityIconName(item: DisplayActivityItem): PresentationIcon {
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
