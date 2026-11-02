import {displaySummaryMembers} from '../conversations/display-context.js';
import type { IndexedDisplayFragment, DisplayPositionFacts } from '../conversations/display-context.js';
import type { ReadingContextEntry } from '../conversations/reading-context.js';
import { activityRunFacts, presentActivityRunFacts } from './activity-presentation.js';
import { planReadingLayout, readingSourceKey, type ReadingPlan, type ReadingPlanMember } from './reading-plan.js';

export type ConversationReadingManifest = {
  conversationId: string;
  positionSpaceId: string;
  sourceVersionId: string;
  publicationRevision: number;
  blockCount: number;
  members: Array<Omit<ReadingPlanMember, 'run'> & { activityRunId: string | null; executionKey?: string }>;
  runs: Record<string, NonNullable<ReadingPlanMember['run']>>;
  summarySources: Record<string, number[]>;
  scopes: Array<{ start: number; end: number; speaker: 'user' | 'assistant' | 'system'; usage?: Array<[string, number]>; totalTokens?: number }>;
  lastAssistantTurnId?: string;
};

/** No body reads: text-derived summaries are explicit source dependencies, resolved only on demand. */
export function buildReadingManifest(input: {
  conversationId: string; positionSpaceId: string; sourceVersionId: string; publicationRevision: number; blockCount: number;
  revisions: { members: Readonly<Record<string, string>>; runs: Readonly<Record<string, string>> };
  fragments: readonly IndexedDisplayFragment[]; positions: readonly DisplayPositionFacts[]; readingContext: readonly ReadingContextEntry[];
}): ConversationReadingManifest {
  const positions = new Map(input.positions.map(position => [position.position, position]));
  const contexts = new Map(input.readingContext.map(context => [context.position, context]));
  const runs = new Map<string, IndexedDisplayFragment[]>();
  for (const fragment of input.fragments) if (fragment.activity_run_id) {
    let run = runs.get(fragment.activity_run_id);
    if (!run) runs.set(fragment.activity_run_id, run = []);
    run.push(fragment);
  }
  const summarySources: Record<string, number[]> = {};
  const runPlans = new Map([...runs].map(([id, members]) => {
    const contributors = displaySummaryMembers(members);
    const unified = contributors.some(member => member.activity && (member.activity.type !== 'activity'
      || ['thinking', 'reasoning-summary'].includes(member.activity.activity_kind)));
    summarySources[id] = contributors.filter((member, index) => member.summary_from_source && (contributors.length === 1 || (!unified && index === 0)
      || (unified && member.activity?.type === 'activity' && !['thinking', 'reasoning-summary'].includes(member.activity.activity_kind))))
      .map(member => member.coordinate.position);
    const facts = activityRunFacts(contributors.flatMap(member => member.activity ? [member.activity] : []));
    facts.hasDetails ||= members.some(member => member.has_details);
    return [id, { id, revision: input.revisions.runs[id], member_count: members.length, presentation: { ...presentActivityRunFacts(facts), facts } }] as const;
  }));
  const scopeUsages = new Map<number, Map<string, number>>();
  for (const position of input.positions) if (position.usage) {
    const start = contexts.get(position.position)?.action_scope.start;
    if (start === undefined) throw new Error('Presentation position omitted its canonical action scope.');
    let usage = scopeUsages.get(start);
    if (!usage) scopeUsages.set(start, usage = new Map());
    usage.set(position.usage.key, position.usage.input + position.usage.output);
  }
  const scopes = [...new Map(input.readingContext.map(context => [context.action_scope.start, context.action_scope])).values()]
    .map(scope => ({ ...scope, speaker: positions.get(scope.start)?.speaker ?? 'assistant', usage: [...(scopeUsages.get(scope.start) ?? new Map())], ...(scopeUsages.get(scope.start)?.size ? { totalTokens: [...scopeUsages.get(scope.start)!.values()].reduce((sum, value) => sum + value, 0) } : {}) }));
  const handoffOwners = new Map<string, number[]>();
  for (const position of input.positions) for (const key of position.handoffKeys) {
    let owners = handoffOwners.get(key);
    if (!owners) handoffOwners.set(key, owners = []);
    owners.push(position.position);
  }
  const members = input.fragments.map(fragment => {
    const position = fragment.coordinate.position;
    const facts = positions.get(position);
    const context = contexts.get(position);
    if (!facts || !context) throw new Error('Presentation fragment omitted its source dependencies.');
    const sourcePositions = [position, ...fragment.paired_source_positions];
    const dependencyRevision = input.revisions.members[fragment.id];
    if (!dependencyRevision) throw new Error('Presentation fragment omitted its dependency revision.');
    return { key: readingSourceKey(input.conversationId, input.positionSpaceId, position, fragment.coordinate.part),
      position, part: fragment.coordinate.part, kind: fragment.kind, speaker: fragment.speaker,
      actionGroup: { key: `group:${input.conversationId}:${input.positionSpaceId}:${context.action_scope.start}`, ...context.action_scope },
      activity: fragment.activity, disclosures: fragment.disclosures, executionKey: facts.executionKey, activityRunId: fragment.activity_run_id,
      dependencyRevision, sourcePositions,
      handoffKeys: sourcePositions.flatMap(position => positions.get(position)?.handoffKeys ?? []).filter(key => handoffOwners.get(key)?.length === 1),
      handoffCoordinates: sourcePositions.flatMap(position => (positions.get(position)?.handoffKeys ?? []).filter(key => handoffOwners.get(key)?.length === 1).map(key => ({key, position}))),
    };
  });
  return { conversationId: input.conversationId, positionSpaceId: input.positionSpaceId, sourceVersionId: input.sourceVersionId,
    publicationRevision: input.publicationRevision, blockCount: input.blockCount, members, runs: Object.fromEntries(runPlans), summarySources, scopes,
    lastAssistantTurnId: [...input.fragments].reverse().flatMap(fragment => fragment.kind === 'content' && fragment.speaker === 'assistant'
      ? [positions.get(fragment.coordinate.position)?.turnId ?? `cblk:${input.conversationId}:${fragment.coordinate.position}`]
      : fragment.activity && fragment.activity.type !== 'activity' ? [fragment.activity.turnId] : []).find((id): id is string => id !== undefined) };
}

export function planConversationReading(manifest: ConversationReadingManifest, expanded: Readonly<Record<string, boolean>>, streaming = false): ReadingPlan {
  const plan = planReadingLayout({ ...manifest, members: manifest.members.map(member => ({ ...member, run: member.activityRunId ? manifest.runs[member.activityRunId] : undefined })), expanded, streaming });
  const scopes = new Map(manifest.scopes.map(scope => [scope.start, scope]));
  const members = new Map(manifest.members.map(member => [member.key, member]));
  for (const row of plan.rows) {
    if (row.turnEnd && row.actionGroup.start !== null) row.totalTokens = scopes.get(row.actionGroup.start)?.totalTokens;
    if (row.kind === 'activity-summary') {
      const first = members.get(row.memberKeys[0])!;
      row.sourcePositions = [...new Set([first.position!, ...(manifest.summarySources[row.disclosureOwner!] ?? [])])];
    }
    row.revision = JSON.stringify([row.revision, row.totalTokens]);
  }
  return plan;
}
