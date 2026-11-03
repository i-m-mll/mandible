import type { ConversationSource } from '../parsers/types.js';

export type ActivityTarget =
  | { kind: 'thread'; provider: ConversationSource; sessionId: string; labelHint?: string }
  | { kind: 'pending-thread'; provider: 'codex'; clientThreadId: string; labelHint?: string }
  | { kind: 'subagent'; provider: ConversationSource; parentSessionId: string; agentId: string; labelHint?: string };

export function activityTargetKey(target: ActivityTarget): string {
  return JSON.stringify(target.kind==='thread' ? [target.kind,target.provider,target.sessionId]
    : target.kind==='pending-thread' ? [target.kind,target.provider,target.clientThreadId]
    : [target.kind,target.provider,target.parentSessionId,target.agentId]);
}

type TargetObservation = {targets:readonly ActivityTarget[];children?:readonly TargetObservation[]};
export function activityObservationTargets(observation: TargetObservation):ActivityTarget[] {
  const targets:ActivityTarget[]=[];
  const visit=(value:TargetObservation)=>{targets.push(...value.targets);for(const child of value.children??[])visit(child);};
  visit(observation);
  return [...new Map(targets.map(target=>[activityTargetKey(target),target])).values()];
}

export function activityDirectiveTargets(directive:import('./provider-directives.js').ProviderDirective):ActivityTarget[] {
  return directive.kind==='created-thread' ? [directive.identity==='threadId'
    ? {kind:'thread',provider:'codex',sessionId:directive.providerSessionId}
    : {kind:'pending-thread',provider:'codex',clientThreadId:directive.providerSessionId}]
    : directive.rolloutIds.map(sessionId=>({kind:'thread',provider:'codex',sessionId}));
}

export type ActivityTargetResolution = { key: string } & (
  | { status: 'resolved'; conversationId: string; title: string }
  | { status: 'not_found' | 'ambiguous' }
);
