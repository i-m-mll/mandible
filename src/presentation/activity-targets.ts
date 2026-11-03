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

export function activityObservationTargets(observation: {targets:readonly ActivityTarget[];children?:readonly {targets:readonly ActivityTarget[]}[]}):ActivityTarget[] {
  const targets=[...observation.targets,...(observation.children??[]).flatMap(child=>child.targets)];
  return [...new Map(targets.map(target=>[activityTargetKey(target),target])).values()];
}

export type ActivityTargetResolution = { key: string } & (
  | { status: 'resolved'; conversationId: string; title: string }
  | { status: 'not_found' | 'ambiguous' }
);
