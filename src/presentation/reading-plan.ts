import { readingDisclosureState, readingToolExecutionActive, type ReadingDisclosures } from './reading-disclosures.js';
import type { ActivityRunFacts } from './activity-presentation.js';
import { activitySemanticFacts, semanticActivityRunFacts, mergeActivityRunFacts, presentActivityRunFacts } from './activity-presentation.js';
import type { ActivityFacts } from '../conversations/conversation-index.js';
import type { DisplayActivityItem } from './types.js';

export type ReadingActionGroup = { key: string; start: number | null; end: number | null };
export type ReadingPlanMember = {
  key: string;
  position?: number;
  eventOrdinal?:number;
  part: string;
  kind: 'content' | 'activity';
  speaker: 'user' | 'assistant' | 'system';
  actionGroup: ReadingActionGroup;
  activity: DisplayActivityItem | null;
  activityFacts?: ActivityFacts;
  run?: { id: string; revision?: string; member_count: number; presentation: ReturnType<typeof presentActivityRunFacts> & { facts: ActivityRunFacts } };
  assistantResponse?: import("../parsers/assistant-response.js").AssistantResponseMembership;
  dependencyRevision: string;
  sourcePositions: readonly number[];
  handoffKeys: readonly string[];
  handoffCoordinates?: readonly {key: string; position: number}[];
  disclosures?: ReadingDisclosures;
  usage?: { key: string; input: number; output: number };
};
export type ReadingRowDescriptor = {
  key: string;
  kind: 'content' | 'activity-summary';
  memberKeys: readonly string[];
  sourcePositions: readonly number[];
  actionGroup: ReadingActionGroup;
  disclosureOwner: string | null;
  activityMember?: boolean;
  activityEnd?: boolean;
  isFinalResponse: boolean;
  turnStart: boolean;
  turnEnd: boolean;
  totalTokens?: number;
  activityGroup?: { presentation: ReturnType<typeof presentActivityRunFacts>; expanded: boolean };
  revision: string;
};
export type ReadingPlanMembership = {
  rowKey: string; memberKey: string; position: number | null;
  disclosurePath: readonly string[]; summaryRowKey?: string; detailKeys?: readonly string[]; subtarget: string | null;
};
export type ReadingPlan = {
  rows: ReadingRowDescriptor[];
  membership: ReadonlyMap<number, ReadingPlanMembership>;
  viewMembership: ReadonlyMap<string, ReadingPlanMembership>;
};
export const readingSourceKey = (conversationId: string, positionSpaceId: string, position: number, part: string): string =>
  `source:${conversationId}:${positionSpaceId}:${position}:${part}`;

/** Shared semantic layout; complete source metadata and bounded hydrated content use the same rule. */
export function planReadingLayout(input: {
  members: readonly ReadingPlanMember[]; conversationId: string; positionSpaceId: string;
  expanded: Readonly<Record<string, boolean>>; streaming?: boolean; lastAssistantTurnId?: string;
}): ReadingPlan {
  const rows: ReadingRowDescriptor[] = [];
  const membership = new Map<number, ReadingPlanMembership>();
  const viewMembership = new Map<string, ReadingPlanMembership>();
  const keyOwners = new Map<string, Set<string>>();
  for (const member of input.members) for (const key of member.handoffKeys) {
    let owners = keyOwners.get(key);
    if (!owners) keyOwners.set(key, owners = new Set());
    owners.add(member.position === undefined ? member.key : `source:${member.position}`);
  }
  const row = (members: readonly ReadingPlanMember[], key: string, kind: ReadingRowDescriptor['kind'], owner: string | null): ReadingRowDescriptor => ({
    key, kind, memberKeys: members.map(member => member.key), sourcePositions: [...new Set(members.flatMap(member => [...member.sourcePositions]))],
    actionGroup: members[0].actionGroup, disclosureOwner: owner, turnStart: false, turnEnd: false,
    activityMember: kind === 'content' && owner !== null, isFinalResponse: false, revision: '',
  });
  const register = (member: ReadingPlanMember, target: ReadingRowDescriptor, disclosurePath: string[], summaryRowKey?: string) => {
    const value: ReadingPlanMembership = { rowKey: target.key, memberKey: member.key, position: member.position ?? null,
      disclosurePath, summaryRowKey, detailKeys: member.disclosures?.keys, subtarget: member.position === undefined ? null : `source:${member.position}` };
    viewMembership.set(member.key, value);
    for (const key of member.handoffKeys) if (keyOwners.get(key)?.size === 1) {
      if (!viewMembership.has(key)) viewMembership.set(key, value);
      viewMembership.set(`${key}:${member.part}`, value);
    }
    for (const alias of member.handoffCoordinates ?? []) if (keyOwners.get(alias.key)?.size === 1) {
      viewMembership.set(alias.key, {...value, position: alias.position, subtarget: `source:${alias.position}`});
    }
    for (const position of member.sourcePositions) if (!membership.has(position)) membership.set(position, { ...value, position, subtarget: `source:${position}` });
  };
  for (let index = 0; index < input.members.length;) {
    const first = input.members[index];
    if (first.kind !== 'activity') {
      const content = row([first], first.key, 'content', null); rows.push(content); register(first, content, []); index++; continue;
    }
    const members = [first];
    let run = first.run;
    let next = index + 1;
    while (next < input.members.length && input.members[next].kind === 'activity'
      && input.members[next].speaker === first.speaker
      && (!run || !input.members[next].run || input.members[next].run?.id === run.id)) {
      run ??= input.members[next].run;
      members.push(input.members[next++]);
    }
    if (Math.max(run?.member_count ?? 0, members.length) === 1) {
      const content = row([first], first.key, 'content', null); rows.push(content); register(first, content, []); index = next; continue;
    }
    const provisional = members.filter(member => member.position === undefined).flatMap(member => member.activity ? [member.activity] : []);
    const presentation = run ? provisional.length ? presentActivityRunFacts(mergeActivityRunFacts(run.presentation.facts, semanticActivityRunFacts(provisional.map(activitySemanticFacts))))
      : run.presentation : presentActivityRunFacts(semanticActivityRunFacts(members.flatMap(member => member.activityFacts ? [member.activityFacts] : member.activity ? [activitySemanticFacts(member.activity)] : [])));
    const owner = run?.id ?? `live:${first.key}`;
    const expanded = input.expanded[`group:${owner}`] ?? (presentation.defaultExpanded || (Boolean(input.streaming) && members.some(member =>
      (member.activityFacts?.kind === 'thinking' && member.activityFacts.turnId === input.lastAssistantTurnId) || (member.activity?.type === 'thinking-block-activity' && member.activity.turnId === input.lastAssistantTurnId))));
    const summary = row(members, `activity:${input.conversationId}:${input.positionSpaceId}:${owner}`, 'activity-summary', owner);
    summary.activityGroup = { presentation, expanded };
    rows.push(summary);
    for (const member of members) {
      const content = expanded ? row([member], member.key, 'content', owner) : summary;
      if (expanded) rows.push(content);
      register(member, content, expanded ? [] : [owner], summary.key);
    }
    index = next;
  }
  const usages = new Map<string, Map<string, number>>();
  for (const member of input.members) if (member.usage) {
    let run = usages.get(member.actionGroup.key);
    if (!run) usages.set(member.actionGroup.key, run = new Map());
    run.set(member.usage.key, member.usage.input + member.usage.output);
  }
  const finalOwners = new Map<string, string>();
  for (const member of input.members) if (member.assistantResponse?.classification === 'final') finalOwners.set(member.assistantResponse.key, member.key);
  const membersByKey = new Map(input.members.map(member => [member.key, member]));
  for (let index = 0; index < rows.length; index++) {
    const current = rows[index];
    current.turnStart = rows[index - 1]?.actionGroup.key !== current.actionGroup.key;
    current.turnEnd = rows[index + 1]?.actionGroup.key !== current.actionGroup.key;
    current.activityEnd = current.activityMember && rows[index + 1]?.disclosureOwner !== current.disclosureOwner;
    const usage = usages.get(current.actionGroup.key);
    if (current.turnEnd && usage?.size) current.totalTokens = [...usage.values()].reduce((sum, value) => sum + value, 0);
    const contributors = current.memberKeys.map(key => membersByKey.get(key)!);
    current.isFinalResponse = current.kind === 'content' && contributors.some(member => member.assistantResponse?.classification === 'final'
      && finalOwners.get(member.assistantResponse.key) === member.key);
    const canonicalRunRevision = current.kind === 'activity-summary' ? contributors[0].run?.revision : undefined;
    const dependencyRevision = canonicalRunRevision
      ? [canonicalRunRevision, contributors.filter(member => member.position === undefined).map(member => member.dependencyRevision)]
      : contributors.map(member => member.dependencyRevision);
    current.revision = JSON.stringify([dependencyRevision, current.kind, contributors[0].speaker, current.actionGroup.key,
      current.disclosureOwner, current.activityMember, current.turnStart, current.turnEnd, current.activityEnd,
      current.totalTokens, current.isFinalResponse, current.activityGroup, current.kind === 'content' ? contributors.map(member => [readingDisclosureState(member.disclosures, input.expanded, input), member.activityFacts?.kind === 'tool' ? readingToolExecutionActive(member.activityFacts.executionActive,input) : member.activity?.type === 'tool-call-activity' ? readingToolExecutionActive(member.activity.executionActive, input) : null]) : []]);
  }
  return { rows, membership, viewMembership };
}
