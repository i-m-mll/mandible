import { coalesceTransportWaitMembers } from './wait-chain.js';
import { operationObservationForTool } from './tool-observation.js';
import { coalesceAdjacentReasoningMembers, reasoningEquivalence } from './reasoning-equivalence.js';
import { activitySemanticFacts } from './activity-presentation.js';
import { assistantResponseMembership } from "../parsers/assistant-response.js";
import { readingNodeDisclosures } from './reading-disclosures.js';
import type { ReadingPlan, ReadingPlanMember, ReadingRowDescriptor } from './reading-plan.js';
import { planReadingLayout, readingSourceKey } from './reading-plan.js';
import { readingSpeaker } from '../conversations/reading-context.js';
import type { CanonicalChatItemEvent, PersistedBlockSource, RenderNode, StreamEvent } from './types.js';
import { chatItemIdentityKey } from '../conversation-control/provider-live.js';
import { projectDisplayFragments } from './fragments.js';
import { buildStreamState } from './model.js';
import { presentActivityRunFacts } from './activity-presentation.js';
export type ConversationSourceCoordinate = { conversationId: string; positionSpaceId: string; position: number; subtarget?: string; offset?: number };

export type ReadingRow = {
  key: string;
  revision?: string;
  memberKeys?: readonly string[];
  materializedMemberKeys?: readonly string[];
  activityRun?: NonNullable<ReadingPlanMember['run']>;
  kind: 'content' | 'activity-summary' | 'permission';
  isFinalResponse: boolean;
  protectedPositions: readonly number[];
  items: readonly CanonicalChatItemEvent[];
  nodes: readonly RenderNode[];
  sources: readonly PersistedBlockSource[];
  actionGroup: ReadingActionGroup;
  disclosureOwner: string | null;
  activityGroup?: { presentation: ActivityRunPresentation; expanded: boolean; items: Extract<RenderNode, { kind: 'activity' }>[] };
  turnStart?: boolean;
  turnEnd?: boolean;
  activityMember?: boolean;
  activityEnd?: boolean;
  totalTokens?: number;
};

export type ReadingMembership = {
  rowKey: string;
  memberKey: string;
  position: number | null;
  disclosurePath: readonly string[];
  detailSources: readonly PersistedBlockSource[];
  summaryRowKey?: string;
  subtarget: string | null;
};
export type ReadingActionRun = { group: ReadingActionGroup; events: readonly CanonicalChatItemEvent[] };
export type ReadingProjection = {
  lastAssistantTurnId?: string;
  actionRuns: ReadonlyMap<string, ReadingActionRun>;
  rows: ReadingRow[];
  membership: ReadonlyMap<number, ReadingMembership>;
  viewMembership: ReadonlyMap<string, ReadingMembership>;
};
export type ReadingActionGroup = { key: string; start: number | null; end: number | null };

type ActivityRunPresentation = ReturnType<typeof presentActivityRunFacts>;

export function sourceSubtarget(position: number): string { return `source:${position}`; }

function toolExecutionKey(event: CanonicalChatItemEvent): string | null {
  const item = event.item;
  if (item.type !== 'tool-call') return null;
  const id = item.tool_id ?? item.identity.native_tool_id;
  return id ? JSON.stringify([item.identity.provider, item.identity.session_id, id]) : null;
}

/** Canonical fragments use exact source coordinates; native/intent identities provide verified handoffs. */
export type ReadingPreparationInput = {
  events: readonly StreamEvent[];
  conversationId: string;
  positionSpaceId: string;
  readingContext: ReadonlyMap<number, import('../conversations/reading-context.js').ReadingContextEntry>;
  expanded: Readonly<Record<string, boolean>>;
  streaming?: boolean;
  positionFacts?:ReadonlyMap<number,import('../conversations/conversation-index.js').PositionFacts>;
  displayContext?: import('../conversations/display-context.js').ConversationDisplayContext;
};

export type PreparedReadingMember = ReadingPlanMember & { node: RenderNode; event?: CanonicalChatItemEvent; sources: readonly PersistedBlockSource[] };
export type ReadingPreparation = { members: PreparedReadingMember[]; actionRuns: ReadonlyMap<string, ReadingActionRun>; lastAssistantTurnId?: string };

export function prepareReadingMembers(input: ReadingPreparationInput): ReadingPreparation {
  const canonicalEvents = input.events.filter((event): event is CanonicalChatItemEvent => event.type === 'chat:item');
  const runs: Array<{ speaker: ReturnType<typeof readingSpeaker>; events: CanonicalChatItemEvent[]; scope: ReadingActionGroup | null }> = [];
  for (const event of canonicalEvents) {
    const speaker = readingSpeaker(event.item.role);
    const position = event.source?.position;
    const sourceScope = position === undefined ? null : input.readingContext.get(position)?.action_scope;
    const group = sourceScope ? { key: `group:${input.conversationId}:${input.positionSpaceId}:${sourceScope.start}`, ...sourceScope } : null;
    let run = runs[runs.length - 1];
    if (!run || run.speaker !== speaker || (group && run.scope && group.key !== run.scope.key)) {
      run = { speaker, events: [], scope: group }; runs.push(run);
    }
    run.events.push(event);
    if (group) run.scope = group;
  }
  const actionRuns = new Map<string, ReadingActionRun>();
  const eventGroups = new Map<CanonicalChatItemEvent, ReadingActionGroup>();
  for (const run of runs) {
    const first = run.events[0];
    const group = run.scope ?? { key: `local-run:${first.intentId ?? first.displayKey ?? chatItemIdentityKey(first.item)}`, start: null, end: null };
    actionRuns.set(group.key, { group, events: run.events });
    for (const event of run.events) eventGroups.set(event, group);
  }
  const completed = new Set(canonicalEvents.flatMap(event => event.item.type === 'tool-call' && event.item.phase === 'result'
    ? [toolExecutionKey(event)].filter((key): key is string => key !== null) : []));
  const normalized = canonicalEvents.map(event => event.executionActive && completed.has(toolExecutionKey(event) ?? '')
    ? { ...event, executionActive: false } : event);
  normalized.forEach((event, index) => eventGroups.set(event, eventGroups.get(canonicalEvents[index])!));
  const owners = new Map(input.displayContext?.owners.map(owner => [owner.fragment_id, owner]));
  const ownedResults = new Set(input.displayContext?.aliases.filter(alias => owners.has(alias.fragment_id)).map(alias => alias.position));
  const fragments = projectDisplayFragments(normalized, true).filter(fragment => fragment.node.kind !== 'unmatched_tool_result'
    || fragment.position === undefined || !ownedResults.has(fragment.position));
  for (const owner of owners.values()) {
    const existing = fragments.find(fragment => fragment.position === owner.coordinate.position && fragment.part === owner.coordinate.part);
    if (existing) {
      if (existing.node.kind === 'activity' && existing.node.item.type === 'tool-call-activity') {
        existing.node = { ...existing.node, item: { ...existing.node.item, observation:owner.item.observation,executionEvidence:owner.item.executionEvidence,...(existing.node.source?.detailsLoaded===false?{header:owner.header}:{}) } };
      }
      continue;
    }
    const positions = input.displayContext!.aliases.filter(alias => alias.fragment_id === owner.fragment_id).map(alias => alias.position);
    const results = normalized.filter(event => event.source?.position !== undefined && positions.includes(event.source.position)
      && event.item.type === 'tool-call' && event.item.phase === 'result');
    const result = [...buildStreamState(results, true).nodes].reverse().find(node => node.kind === 'unmatched_tool_result');
    if (!result || result.kind !== 'unmatched_tool_result') continue;
    const item = { ...(owner.details ?? owner.item), input: owner.details?.input, header: owner.details ? undefined : owner.header, result: result.result };
    const fragment = { part: owner.coordinate.part, position: owner.coordinate.position, memberKey: owner.memberKey,
      node: { kind: 'activity' as const, key: owner.memberKey, entity: 'assistant' as const, item,
        source: { ...owner.source, detailsLoaded: Boolean(owner.details) } }, pairedSourcePositions: positions };
    const next = fragments.findIndex(candidate => candidate.position !== undefined && candidate.position >= owner.coordinate.position);
    fragments.splice(next < 0 ? fragments.length : next, 0, fragment);
  }
  const eventOrdinals=new Map(normalized.map((event,index)=>[event,index]));
  const byPosition = new Map(normalized.flatMap(event => event.source?.position === undefined ? [] : [[event.source.position, event] as const]));
  const byIdentity = new Map(normalized.flatMap(event => {
    const key = event.intentId ? `intent:${event.intentId}` : event.displayKey ?? chatItemIdentityKey(event.item);
    return key ? [[key, event] as const] : [];
  }));
  const descriptorByCoordinate = new Map(input.displayContext?.fragments.map(fragment => [`${fragment.coordinate.position}:${fragment.coordinate.part}`, fragment]));
  const canonicalRuns = new Map(input.displayContext?.activity_runs.map(run => [run.id, run]));
  const lastAssistantTurnId = [...fragments].reverse().flatMap(({ node }) => node.kind === 'assistant_turn' ? [node.turn.id]
    : node.kind === 'activity' && node.item.type !== 'activity' ? [node.item.turnId] : []).find((id): id is string => id !== undefined);
  const prepared = fragments.map(fragment => {
    const node = fragment.node;
    const event = fragment.position === undefined ? byIdentity.get(fragment.memberKey) : byPosition.get(fragment.position);
    const source = node.kind === 'activity' ? node.source : node.kind === 'assistant_turn'
      ? node.turn.assistantEvent.message.content[0]?.source : node.kind === 'user_message' ? node.persisted
        : node.kind === 'semantic_event' ? node.event.source : node.kind === 'unmatched_tool_result' ? node.result.source : undefined;
    const native = event ? chatItemIdentityKey(event.item) : undefined;
    const identity = event?.intentId ? `intent:${event.intentId}` : event?.displayKey ?? native ?? fragment.memberKey;
    const key = fragment.position === undefined ? `${identity}:${fragment.part}`
      : readingSourceKey(input.conversationId, input.positionSpaceId, fragment.position, fragment.part);
    const descriptor = fragment.position === undefined ? undefined : descriptorByCoordinate.get(`${fragment.position}:${fragment.part}`);
    const canonicalRun = descriptor?.activity_run_id ? canonicalRuns.get(descriptor.activity_run_id) : undefined;
    const owner = descriptor ? owners.get(descriptor.id) : undefined;
    const actionGroup = event ? eventGroups.get(event)! : owner
      ? { key: `group:${input.conversationId}:${input.positionSpaceId}:${owner.action_scope.start}`, ...owner.action_scope }
      : { key: `local-run:${identity}`, start: null, end: null };
    const resultSource = node.kind === 'activity' && node.item.type === 'tool-call-activity' ? node.item.result?.source : undefined;
    const reasoning=node.kind==='activity'&&(node.item.type==='thinking-block-activity'||(node.item.type==='activity'&&['thinking','reasoning-summary'].includes(node.item.activity_kind)));
    const equivalence=reasoning?(descriptor?.reasoningEquivalence??(event?reasoningEquivalence(event.item,node.item.type==='thinking-block-activity'?[node.item.content]:node.item.type==='activity'?node.item.parts.map(part=>part.text):[]):undefined)):undefined;
    return { fragment, node, event, eventOrdinal:event?eventOrdinals.get(event):undefined, equivalence,native, identity, key, canonicalRun, actionGroup,
      sources: [source, resultSource].filter((value): value is PersistedBlockSource => Boolean(value)) };
  });
  function transportSegment(entry:typeof prepared[number]):Pick<ReadingPlanMember,'transportSegment'> {
    if(entry.node.kind!=='activity'||entry.node.item.type!=='tool-call-activity'||!entry.event)return {};
    const position=entry.fragment.position;
    const facts=position===undefined?undefined:input.positionFacts?.get(position);
    const positions=[position,...entry.fragment.pairedSourcePositions].filter((value):value is number=>value!==undefined);
    const frame=entry.node.item.result?.source?.toolFrame;
    const origin=entry.node.item.operationContext?.origin??entry.node.item.result?.source?.toolOperation?.origin;
    const key=facts?.executionChainKey??JSON.stringify([origin?JSON.stringify([origin.provider,origin.session_id,origin.native_tool_id]):toolExecutionKey(entry.event),origin?.position??position]);
    const seconds=positions.map(position=>input.positionFacts?.get(position)?.wrapperSegmentSeconds).find(value=>value!==undefined)??frame?.wallTimeSeconds;
    const start=facts?.eventOrdinal??entry.eventOrdinal;
    const end=Math.max(...positions.flatMap(position=>input.positionFacts?.get(position)?.eventOrdinal??(byPosition.get(position)?eventOrdinals.get(byPosition.get(position)!)??[]:[])));
    return seconds!==undefined&&start!==undefined&&end===start+1?{transportSegment:{chainKey:key,seconds,start,end}}:{};
  }
  return { actionRuns, lastAssistantTurnId, members: coalesceTransportWaitMembers(coalesceAdjacentReasoningMembers(prepared.map(entry => ({
    key: entry.key,eventOrdinal:entry.eventOrdinal, position: entry.fragment.position, part: entry.fragment.part,
    kind: entry.node.kind === 'activity' ? 'activity' : 'content', speaker: entry.node.entity,
    actionGroup: entry.actionGroup, activity: entry.node.kind === 'activity' ? entry.node.item : null,
    ...(entry.node.kind==='activity'&&entry.node.item.type==='tool-call-activity'?{activityFacts:activitySemanticFacts({...entry.node.item,observation:operationObservationForTool(entry.node.item)})}:{}),
    ...transportSegment(entry),
    ...(entry.equivalence&&entry.node.kind==='activity'?{activityFacts:{...activitySemanticFacts(entry.node.item),reasoningEquivalence:entry.equivalence}}:{}),
    ...(entry.node.kind === 'assistant_turn' && entry.node.turn.assistantEvent.message.content[0]?.type === 'text' && entry.event
      ? { assistantResponse: assistantResponseMembership(entry.event.item) } : {}),
    run: entry.canonicalRun, dependencyRevision: JSON.stringify([entry.node, entry.event?.executionActive]),
    sourcePositions: [entry.fragment.position, ...entry.fragment.pairedSourcePositions].filter((position): position is number => position !== undefined),
    handoffKeys: [entry.identity, entry.native].filter((key): key is string => Boolean(key)), usage: entry.event?.usage,
    disclosures: readingNodeDisclosures(entry.node), node: entry.node, event: entry.event, sources: entry.sources,
  })))) };
}

export function materializePreparedReadingRows(descriptors: readonly ReadingRowDescriptor[], members: readonly PreparedReadingMember[]): ReadingRow[] {
  const byKey = new Map(members.map(member => [member.key, member]));
  return descriptors.map(descriptor => {
    const entries = descriptor.memberKeys.flatMap(key => byKey.get(key) ? [byKey.get(key)!] : []);
    const nodes = entries.map(entry => entry.node);
    return { ...descriptor, materializedMemberKeys: entries.map(entry => entry.key), activityRun: entries.find(entry => entry.run)?.run,
      protectedPositions: descriptor.kind === 'content' ? [...descriptor.sourcePositions] : [],
      items: entries.flatMap(entry => entry.event ? [entry.event] : []),
      nodes: descriptor.kind === 'content' ? nodes : [], sources: entries.flatMap(entry => [...entry.sources]),
      activityGroup: descriptor.activityGroup ? { ...descriptor.activityGroup,
        items: nodes.filter((node): node is Extract<RenderNode, {kind: 'activity'}> => node.kind === 'activity') } : undefined,
    };
  });
}

export function preparedReadingMembersFromRows(rows: readonly ReadingRow[]): Map<string, Pick<PreparedReadingMember, 'node' | 'event' | 'sources'>> {
  const members = new Map<string, Pick<PreparedReadingMember, 'node' | 'event' | 'sources'>>();
  for (const row of rows) {
    const nodes = row.activityGroup?.items ?? row.nodes;
    for (const [index, key] of (row.materializedMemberKeys ?? [row.key]).entries()) {
      const node = nodes[index];
      if (!node) continue;
      const sources = row.sources.filter(source => source.position === (node.kind === 'activity' ? node.source?.position
        : node.kind === 'assistant_turn' ? node.turn.assistantEvent.message.content[0]?.source?.position
        : node.kind === 'user_message' ? node.persisted?.position : node.kind === 'semantic_event' ? node.event.source?.position
        : node.kind === 'unmatched_tool_result' ? node.result.source?.position : undefined)
        || (node.kind === 'activity' && node.item.type === 'tool-call-activity' && source.position === node.item.result?.source?.position));
      members.set(key, {node, sources, event: row.items.find(event => event.source?.position === sources[0]?.position)});
    }
  }
  return members;
}

export function projectReadingRows(input: ReadingPreparationInput): ReadingProjection {
  const prepared = prepareReadingMembers(input);
  const plan: ReadingPlan = planReadingLayout({ ...input, members: prepared.members, lastAssistantTurnId: prepared.lastAssistantTurnId });
  const byKey = new Map(prepared.members.map(member => [member.key, member]));
  const membership = new Map<number, ReadingMembership>();
  const viewMembership = new Map<string, ReadingMembership>();
  for (const [position, value] of plan.membership) membership.set(position, { ...value, detailSources: byKey.get(value.memberKey)!.sources });
  for (const [key, value] of plan.viewMembership) viewMembership.set(key, { ...value, detailSources: byKey.get(value.memberKey)!.sources });
  return { rows: materializePreparedReadingRows(plan.rows, prepared.members), membership, viewMembership,
    actionRuns: prepared.actionRuns, lastAssistantTurnId: prepared.lastAssistantTurnId };
}

export type ReadingRevealCommand = { token: string; target: ConversationSourceCoordinate; end?: false } | { token: string; target?: ConversationSourceCoordinate; end: true };
export type ReadingRevealResult = { token: string; status:
  'revealed' | 'cancelled' | 'source-unavailable' | 'position-space-changed' | 'not-renderable' | 'unsuccessful' };

/** Renderers prepare lazy/disclosed content and register their exact focus target inside the measured box. */
export type ReadingTargetRegistration = {
  coordinate: ConversationSourceCoordinate;
  rowKey: string;
  element: HTMLElement | null;
};
export type ReadingRendererPreparation = (target: ConversationSourceCoordinate, signal: AbortSignal) => Promise<
  { status: 'prepared'; membership: ReadingMembership } | { status: 'source-unavailable' | 'position-space-changed' | 'not-renderable' }
>;
