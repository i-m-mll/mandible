import { readingSpeaker } from '../../../src/conversations/reading-context';
import type { CanonicalChatItemEvent, PersistedBlockSource, RenderNode, StreamEvent } from '../components/stream-renderer/types';
import { chatItemIdentityKey } from '../../../src/conversation-control/provider-live';
import { projectDisplayFragments } from '../../../src/presentation/fragments';
import { buildStreamState } from '../../../src/presentation/model';
import { activityRunFacts, mergeActivityRunFacts, presentActivityRunFacts } from '../../../src/presentation/activity-presentation';
import type { ConversationSourceCoordinate } from '../query/conversationData';

export type ReadingRow = {
  key: string;
  kind: 'content' | 'activity-summary' | 'permission';
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

/** View identity is provider/intent identity; canonical links remain position-space coordinates. */
export function projectReadingRows(input: {
  events: readonly StreamEvent[];
  conversationId: string;
  positionSpaceId: string;
  readingContext: ReadonlyMap<number, import('../../../src/conversations/reading-context').ReadingContextEntry>;
  expanded: Readonly<Record<string, boolean>>;
  streaming?: boolean;
  displayContext?: import('../../../src/conversations/display-context').ConversationDisplayContext;
}): ReadingProjection {
  const rows: ReadingRow[] = [];
  const membership = new Map<number, ReadingMembership>();
  const viewMembership = new Map<string, ReadingMembership>();
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
    if (fragments.some(fragment => fragment.position === owner.coordinate.position && fragment.part === owner.coordinate.part)) continue;
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
    const key = `${identity}:${fragment.part}`;
    const descriptor = fragment.position === undefined ? undefined : descriptorByCoordinate.get(`${fragment.position}:${fragment.part}`);
    const canonicalRun = descriptor?.activity_run_id ? canonicalRuns.get(descriptor.activity_run_id) : undefined;
    const owner = descriptor ? owners.get(descriptor.id) : undefined;
    const actionGroup = event ? eventGroups.get(event)! : owner
      ? { key: `group:${input.conversationId}:${input.positionSpaceId}:${owner.action_scope.start}`, ...owner.action_scope }
      : { key: `local-run:${identity}`, start: null, end: null };
    const resultSource = node.kind === 'activity' && node.item.type === 'tool-call-activity' ? node.item.result?.source : undefined;
    return { fragment, node, event, native, identity, key, canonicalRun, actionGroup,
      sources: [source, resultSource].filter((value): value is PersistedBlockSource => Boolean(value)) };
  });
  const register = (entry: typeof prepared[number], row: ReadingRow, disclosurePath: string[], summaryRowKey?: string) => {
    const positions = [entry.fragment.position, ...entry.fragment.pairedSourcePositions].filter((value): value is number => value !== undefined);
    const member: ReadingMembership = { rowKey: row.key, memberKey: entry.key, position: entry.fragment.position ?? null,
      disclosurePath, detailSources: entry.sources, summaryRowKey, subtarget: entry.fragment.position === undefined ? null : sourceSubtarget(entry.fragment.position) };
    viewMembership.set(entry.key, member);
    // The first fragment owns the default source/native reveal; later fragments have their own view identity.
    if (!viewMembership.has(entry.identity)) viewMembership.set(entry.identity, member);
    if (entry.native && !viewMembership.has(entry.native)) viewMembership.set(entry.native, member);
    for (const position of positions) if (!membership.has(position)) membership.set(position,
      { ...member, position, subtarget: sourceSubtarget(position) });
  };
  const content = (entry: typeof prepared[number], owner: string | null = null): ReadingRow => ({ key: entry.key, kind: 'content',
    protectedPositions: entry.sources.flatMap(source => source.position === undefined ? [] : [source.position]),
    items: entry.event ? [entry.event] : [], nodes: [entry.node], sources: entry.sources, actionGroup: entry.actionGroup,
    disclosureOwner: owner, activityMember: owner !== null });
  for (let index = 0; index < prepared.length;) {
    const first = prepared[index];
    if (first.node.kind !== 'activity') {
      const row = content(first); rows.push(row); register(first, row, []); index += 1; continue;
    }
    const entries = [first];
    let canonicalRun = first.canonicalRun;
    let next = index + 1;
    while (next < prepared.length && prepared[next].node.kind === 'activity'
      && prepared[next].node.entity === first.node.entity
      && (!canonicalRun || !prepared[next].canonicalRun || prepared[next].canonicalRun?.id === canonicalRun.id)) {
      canonicalRun ??= prepared[next].canonicalRun;
      entries.push(prepared[next++]);
    }
    const count = Math.max(canonicalRun?.member_count ?? 0, entries.length);
    if (count === 1) {
      const row = content(first); rows.push(row); register(first, row, []); index = next; continue;
    }
    const nodes = entries.map(entry => entry.node as Extract<RenderNode, { kind: 'activity' }>);
    const items = nodes.map(node => node.item);
    const provisionalItems = entries.filter(entry => entry.fragment.position === undefined).map(entry => (entry.node as Extract<RenderNode, { kind: 'activity' }>).item);
    const presentation = canonicalRun ? provisionalItems.length
      ? presentActivityRunFacts(mergeActivityRunFacts(canonicalRun.presentation.facts, activityRunFacts(provisionalItems)))
      : canonicalRun.presentation : presentActivityRunFacts(activityRunFacts(items));
    const owner = canonicalRun?.id ?? `live:${first.key}`;
    const expanded = input.expanded[`group:${owner}`] ?? (presentation.defaultExpanded || (Boolean(input.streaming) && nodes.some(node =>
      node.item.type === 'thinking-block-activity' && node.item.turnId === lastAssistantTurnId)));
    const key = `activity:${input.conversationId}:${input.positionSpaceId}:${owner}`;
    const header: ReadingRow = { key, kind: 'activity-summary', items: entries.flatMap(entry => entry.event ? [entry.event] : []),
      nodes: [], sources: entries.flatMap(entry => entry.sources), actionGroup: first.actionGroup, disclosureOwner: owner,
      protectedPositions: [], activityGroup: { presentation, expanded, items: nodes } };
    rows.push(header);
    for (const entry of entries) {
      const row = expanded ? content(entry, owner) : header;
      if (expanded) rows.push(row);
      register(entry, row, expanded ? [] : [owner], key);
    }
    index = next;
  }
  for (let index = 0; index < rows.length; index += 1) {
    rows[index].turnStart = rows[index - 1]?.actionGroup.key !== rows[index].actionGroup.key;
    rows[index].turnEnd = rows[index + 1]?.actionGroup.key !== rows[index].actionGroup.key;
    rows[index].activityEnd = rows[index].activityMember && rows[index + 1]?.disclosureOwner !== rows[index].disclosureOwner;
  }
  for (const [key, run] of actionRuns) {
    const usages = new Map(run.events.flatMap(event => event.usage ? [[event.usage.key, event.usage.input + event.usage.output] as const] : []));
    const last = [...rows].reverse().find(row => row.actionGroup.key === key);
    if (last && usages.size) last.totalTokens = [...usages.values()].reduce((sum, value) => sum + value, 0);
  }
  return { rows, membership, viewMembership, actionRuns, lastAssistantTurnId };
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
