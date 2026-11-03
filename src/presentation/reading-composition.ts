import { framedToolResult } from './tool-transport.js';
import { extractToolResultText } from './model.js';
import { operationObservationForTool, observeOperationReceipt } from './tool-observation.js';
import { chatItemIdentityKey } from '../conversation-control/provider-live.js';
import { readingSpeaker } from '../conversations/reading-context.js';
import { activitySemanticFacts, semanticActivityRunFacts, presentActivityRunFacts } from './activity-presentation.js';
import { planConversationReading, type ConversationReadingManifest } from './reading-manifest.js';
import { planReadingLayout, type ReadingPlan, type ReadingPlanMember, type ReadingRowDescriptor } from './reading-plan.js';
import { materializePreparedReadingRows, prepareReadingMembers, preparedReadingMembersFromRows, type PreparedReadingMember, type ReadingActionRun, type ReadingRow } from './reading.js';
import type { CanonicalChatItemEvent, StreamEvent, ToolResultContentBlock } from './types.js';

export type ReadingRowRef = Pick<ReadingRowDescriptor, 'key' | 'revision'>;
type Overlay = { result?: ToolResultContentBlock; executionActive?: boolean };
function overlayExecution(observation:import('./operation-observation.js').CompactOperationObservation,overlay:Overlay):import('../parsers/types.js').ToolExecutionEvidence {
  if(overlay.result)return overlay.result.is_error||overlay.result.presentation?.failed?{state:'failed',provenance:'paired-result'}:overlay.result.source?.toolExecution??{state:'completed',provenance:'paired-result'};
  if(overlay.executionActive)return {state:'ongoing',provenance:'managed-generation'};
  return observation.execution.state==='ongoing'?{state:'unknown',provenance:'managed-generation'}:observation.execution;
}
function overlayObservation(observation:import('./operation-observation.js').CompactOperationObservation,overlay:Overlay) {
  if(!overlay.result)return {...observation,execution:overlayExecution(observation,overlay)};
  const result=overlay.result;
  const native=result.presentation;
  const transport=native?.decoded?native:framedToolResult(result.fullText??extractToolResultText(result.content),result.source?.toolFrame);
  return observeOperationReceipt(observation,{result:{...transport,failed:Boolean(result.is_error||transport.failed)},execution:result.source?.toolExecution});
}
export type ReadingComposition = {
  manifest: ConversationReadingManifest;
  plan: ReadingPlan;
  sourcePlan: ReadingPlan;
  members: readonly ReadingPlanMember[];
  localMembers: readonly PreparedReadingMember[];
  overlays: ReadonlyMap<string, Overlay>;
  actionRuns: ReadonlyMap<string, ReadingActionRun>;
  expanded: Readonly<Record<string, boolean>>;
  streaming: boolean;
  lastAssistantTurnId?: string;
};

export type RetainedReadingProvenance = Readonly<{ conversationId: string; positionSpaceId: string; rowKey: string; dependencies: readonly (readonly [string,string])[] }>;
export function retainedReadingProvenance(composition: ReadingComposition, body: ReadingRow): RetainedReadingProvenance {
  const descriptor=composition.plan.rows.find(row=>row.key===body.key)!;
  const members=new Map(composition.members.map(member=>[member.key,member.dependencyRevision]));
  return Object.freeze({conversationId:composition.manifest.conversationId,positionSpaceId:composition.manifest.positionSpaceId,rowKey:body.key,
    dependencies:Object.freeze(descriptor.memberKeys.map(key=>Object.freeze([key,members.get(key)!] as const)))});
}

/** Disclosure presentation can change while complete canonical member payloads remain sufficient. */
export function reprojectHydratedReadingRow(previous: RetainedReadingProvenance, current: ReadingComposition, ref: ReadingRowRef, body: ReadingRow): ReadingRow | null {
  if (previous.conversationId !== current.manifest.conversationId || previous.positionSpaceId !== current.manifest.positionSpaceId || previous.rowKey!==body.key) return null;
  const after = current.plan.rows.find(row => row.key === ref.key && row.revision === ref.revision);
  if (!after || after.kind !== 'content' || previous.dependencies.length !== after.memberKeys.length || previous.dependencies.some(([key],index)=>key!==after.memberKeys[index])) return null;
  const oldMembers = new Map(previous.dependencies);
  const members = new Map(current.members.map(member=>[member.key,member]));
  const payloads = preparedReadingMembersFromRows([body]);
  const prepared: PreparedReadingMember[] = [];
  for (const key of after.memberKeys) {
    const member = members.get(key);
    const payload = payloads.get(key);
    if (!member || oldMembers.get(key) !== member.dependencyRevision || !payload) return null;
    const fullText = payload.node.kind === 'user_message' || payload.node.kind === 'assistant_turn' && payload.node.turn.assistantEvent.message.content.every(block=>block.type==='text');
    if (!fullText && (!payload.sources.length || payload.sources.some(source=>source.detailsLoaded!==true && source.hasBody!==false))) return null;
    prepared.push(prepareCanonicalMember(current,member,payload));
  }
  return materializePreparedReadingRows([after],prepared)[0];
}
function prepareCanonicalMember(composition: ReadingComposition, member: ReadingPlanMember, payload: Pick<PreparedReadingMember,'node'|'event'|'sources'>): PreparedReadingMember {
  let node=payload.node;
  const overlay=composition.overlays.get(member.key);
  if(overlay&&node.kind==='activity'&&node.item.type==='tool-call-activity'){
    const observation=member.activityFacts?.observation??overlayObservation(operationObservationForTool(node.item),overlay);
    node={...node,item:{...node.item,executionActive:overlay.executionActive,observation,executionEvidence:observation.execution,...(overlay.result?{result:overlay.result}:{})}};
  }
  return {...member,...payload,node};
}

const executionKey = (event: CanonicalChatItemEvent): string | null => {
  const item = event.item;
  if (item.type !== 'tool-call') return null;
  const id = item.tool_id ?? item.identity.native_tool_id;
  return id ? JSON.stringify([item.identity.provider, item.identity.session_id, id]) : null;
};
function overlayRun(run: NonNullable<ReadingPlanMember['run']>, overlays: readonly ReadingPlanMember[]): NonNullable<ReadingPlanMember['run']> {
  if (!overlays.length) return run;
  const changed = semanticActivityRunFacts(overlays.flatMap(member => member.activityFacts ? [member.activityFacts] : member.activity ? [activitySemanticFacts(member.activity)] : []));
  const facts = { ...run.presentation.facts,
    states: changed.states,
    toolStates: changed.toolStates,
    hasDetails: run.presentation.facts.hasDetails || changed.hasDetails };
  return { ...run, revision: JSON.stringify([run.revision, overlays.map(member => member.dependencyRevision)]),
    presentation: { ...presentActivityRunFacts(facts), facts } };
}

/** Canonical metadata and provisional content enter one semantic plan; saved window bodies never replace manifest authority. */
export function composeConversationReading(input: {
  manifest: ConversationReadingManifest; events: readonly StreamEvent[];
  expanded: Readonly<Record<string, boolean>>; streaming?: boolean;
}): ReadingComposition {
  const { manifest, expanded } = input;
  const sourcePlan = planConversationReading(manifest, expanded, input.streaming);
  const canonical = manifest.members.map(member => ({ ...member, run: member.activityRunId ? manifest.runs[member.activityRunId] : undefined }));
  const aliases = new Map<string, typeof canonical>();
  for (const member of canonical) for (const key of member.handoffKeys) {
    let owners = aliases.get(key); if (!owners) aliases.set(key, owners = []); owners.push(member);
  }
  const overlays = new Map<string, Overlay>();
  const handoffGroups = new Map<CanonicalChatItemEvent, ReadingPlanMember['actionGroup']>();
  const provisional = input.events.filter((event): event is CanonicalChatItemEvent => event.type === 'chat:item' && !event.source);
  const unmatched: CanonicalChatItemEvent[] = [];
  for (const event of provisional) {
    const handoff = [event.intentId ? `intent:${event.intentId}` : event.displayKey, chatItemIdentityKey(event.item)]
      .flatMap(key => key ? aliases.get(key) ?? [] : []);
    const positions = new Set(handoff.map(member => member.position));
    const owner = handoff.find(member => member.activityFacts?.kind === 'tool');
    const newExecution = event.item.type === 'tool-call' && event.item.phase === 'call' && event.executionActive
      && owner && (owner.sourcePositions.length > 1 || owner.activityFacts?.hasResult);
    if (positions.size === 1 && !newExecution) {
      handoffGroups.set(event, handoff[0].actionGroup);
      if (owner && event.item.type === 'tool-call' && event.item.phase === 'call' && owner.sourcePositions.length === 1) {
        overlays.set(owner.key, { executionActive: Boolean(event.executionActive) });
      }
      continue;
    }
    unmatched.push(event);
  }
  const localCallKeys = new Set(unmatched.filter(event => event.item.type === 'tool-call' && event.item.phase === 'call').map(executionKey));
  const remaining: CanonicalChatItemEvent[] = [];
  for (const event of unmatched) {
    const key = executionKey(event);
    const owners = key && !localCallKeys.has(key) && event.item.type === 'tool-call' && event.item.phase === 'result'
      ? canonical.filter(member => member.executionKey === key && member.activityFacts?.kind === 'tool'
        && member.sourcePositions.length === 1 && !member.activityFacts?.hasResult) : [];
    if (owners.length === 1) {
      const prepared = prepareReadingMembers({ ...input, events: [event], conversationId: manifest.conversationId,
        positionSpaceId: manifest.positionSpaceId, readingContext: new Map() });
      const result = prepared.members.find(member => member.node.kind === 'unmatched_tool_result')?.node;
      if (result?.kind === 'unmatched_tool_result') {
        overlays.set(owners[0].key, { result: result.result, executionActive: false });
        handoffGroups.set(event, owners[0].actionGroup);
      }
      else remaining.push(event);
    } else remaining.push(event);
  }
  for (const member of canonical) {
    const overlay = overlays.get(member.key);
    if (!overlay || member.activityFacts?.kind !== 'tool') continue;
    member.activityFacts = { ...member.activityFacts, executionActive: overlay.executionActive,
      ...(member.activityFacts.observation?{observation:overlayObservation(member.activityFacts.observation,overlay)}:{}),
      ...(overlay.result ? {hasResult:true,failed:overlay.result.is_error,running:overlay.result.running} : {}) };
    member.dependencyRevision = JSON.stringify([member.dependencyRevision, overlay]);
  }
  const changedRuns = new Map<string, NonNullable<ReadingPlanMember['run']>>();
  for (const member of canonical) if (member.run && overlays.has(member.key) && !changedRuns.has(member.run.id)) {
    changedRuns.set(member.run.id, overlayRun(member.run, canonical.filter(candidate => candidate.run?.id === member.run!.id)));
  }
  for (const member of canonical) if (member.run && changedRuns.has(member.run.id)) member.run = changedRuns.get(member.run.id);
  const local = prepareReadingMembers({ ...input, events: remaining, conversationId: manifest.conversationId,
    positionSpaceId: manifest.positionSpaceId, readingContext: new Map() });
  const trailingScope = manifest.scopes.at(-1);
  const first = local.members[0];
  const localGroupRemap = new Map<string, ReadingPlanMember['actionGroup']>();
  if (first && trailingScope && readingSpeaker(first.event?.item.role ?? first.speaker) === trailingScope.speaker) {
    const original = first.actionGroup.key;
    const group = { key: `group:${manifest.conversationId}:${manifest.positionSpaceId}:${trailingScope.start}`, start: trailingScope.start, end: trailingScope.end };
    for (const member of local.members) if (member.actionGroup.key === original) member.actionGroup = group;
    localGroupRemap.set(original, group);
  }
  const members: ReadingPlanMember[] = [...canonical, ...local.members];
  const lastAssistantTurnId = local.lastAssistantTurnId ?? manifest.lastAssistantTurnId;
  const plan = planReadingLayout({ ...manifest, members, expanded, streaming: input.streaming, lastAssistantTurnId });
  const scopes = new Map(manifest.scopes.map(scope => [scope.start, scope]));
  for (const row of plan.rows) if (row.turnEnd && row.actionGroup.start !== null) {
    const usage = new Map(scopes.get(row.actionGroup.start)?.usage ?? []);
    for (const member of local.members) if (member.actionGroup.key === row.actionGroup.key && member.usage) usage.set(member.usage.key, member.usage.input + member.usage.output);
    row.totalTokens = usage.size ? [...usage.values()].reduce((sum, value) => sum + value, 0) : scopes.get(row.actionGroup.start)?.totalTokens;
    row.revision = JSON.stringify([row.revision, row.totalTokens]);
  }
  const byKey = new Map(members.map(member => [member.key, member]));
  for (const row of plan.rows) if (row.kind === 'activity-summary') {
    const first = row.memberKeys.map(key => byKey.get(key)!).find(member => member.position !== undefined);
    row.sourcePositions = first ? [...new Set([first.position!, ...(manifest.summarySources[row.disclosureOwner!] ?? [])])] : [];
  }
  const actionRuns = new Map<string, ReadingActionRun>();
  const append = (group: ReadingPlanMember['actionGroup'], events: readonly CanonicalChatItemEvent[]) => {
    const prior = actionRuns.get(group.key)?.events ?? [];
    actionRuns.set(group.key, {group, events: [...prior, ...events].sort((left, right) => provisional.indexOf(left) - provisional.indexOf(right))});
  };
  for (const [event, group] of handoffGroups) append(group, [event]);
  for (const run of local.actionRuns.values()) append(localGroupRemap.get(run.group.key) ?? run.group, run.events);
  return { manifest, sourcePlan, plan, members, localMembers: local.members, overlays, actionRuns, expanded,
    streaming: Boolean(input.streaming), lastAssistantTurnId };
}

export function readingCompositionRequests(composition: ReadingComposition, refs: readonly ReadingRowRef[]): ReadingRowRef[] {
  const requested = new Set(refs.map(ref => ref.key));
  const sourceByKey = new Map(composition.sourcePlan.rows.map(row => [row.key, row]));
  const result = new Map<string, ReadingRowRef>();
  const canonicalKeys = new Set(composition.manifest.members.map(member => member.key));
  const memberByKey = new Map(composition.members.map(member => [member.key, member]));
  const summaries = new Map(composition.sourcePlan.rows.filter(row => row.kind === 'activity-summary').map(row => [row.disclosureOwner, row]));
  for (const row of composition.plan.rows) if (requested.has(row.key)) {
    for (const key of row.memberKeys) {
      if (!canonicalKeys.has(key)) continue;
      const member = memberByKey.get(key)!;
      const summary = row.kind === 'activity-summary' && member.run
        ? summaries.get(member.run.id) : undefined;
      const target = summary ?? sourceByKey.get(key) ?? sourceByKey.get(composition.sourcePlan.membership.get(member.position!)?.rowKey ?? '');
      if (target) result.set(target.key, { key: target.key, revision: target.revision });
    }
  }
  return [...result.values()];
}

export function materializeConversationReading(composition: ReadingComposition, refs: readonly ReadingRowRef[], canonicalRows: readonly ReadingRow[]):
  { status: 'source'; rows: ReadingRow[] } | { status: 'unavailable'; reason: string } {
  const byKey = new Map(composition.plan.rows.map(row => [row.key, row]));
  const descriptors: ReadingRowDescriptor[] = [];
  for (const ref of refs) {
    const row = byKey.get(ref.key);
    if (!row || row.revision !== ref.revision) return {status: 'unavailable', reason: 'The composed row plan changed.'};
    descriptors.push(row);
  }
  const canonicalByKey = new Map(canonicalRows.map(row => [row.key, row]));
  if (readingCompositionRequests(composition, refs).some(ref => canonicalByKey.get(ref.key)?.revision !== ref.revision)) {
    return {status: 'unavailable', reason: 'A requested canonical dependency was not materialized at its matching revision.'};
  }
  const payloads = preparedReadingMembersFromRows(canonicalRows);
  const hydratedRuns = new Map(canonicalRows.flatMap(row => row.activityRun ? [[row.activityRun.id, row.activityRun] as const] : []));
  const effectiveRuns = new Map([...hydratedRuns].map(([id, run]) => [id, overlayRun(run,
    composition.members.filter(member => member.run?.id === id))]));
  const members = composition.members.map(member => ({...member, run: member.run ? effectiveRuns.get(member.run.id) ?? member.run : undefined}));
  const hydratedPlan = planReadingLayout({ ...composition.manifest, members, expanded: composition.expanded,
    streaming: composition.streaming, lastAssistantTurnId: composition.lastAssistantTurnId });
  const hydratedByKey = new Map(hydratedPlan.rows.map(row => [row.key, row]));
  const prepared: PreparedReadingMember[] = [...composition.localMembers];
  for (const member of members) {
    const payload = payloads.get(member.key);
    if (!payload) continue;
    prepared.push(prepareCanonicalMember(composition,member,payload));
  }
  const available = new Set(prepared.map(member => member.key));
  if (descriptors.some(row => row.kind === 'content' && row.memberKeys.some(key => !available.has(key)))) {
    return {status: 'unavailable', reason: 'A requested canonical source member was not materialized.'};
  }
  return { status: 'source', rows: materializePreparedReadingRows(descriptors.map(row => ({ ...row,
    activityGroup: hydratedByKey.get(row.key)?.activityGroup ?? row.activityGroup })), prepared) };
}
