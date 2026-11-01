import { readingSpeaker } from '../../../src/conversations/reading-context';
import type { CanonicalChatItemEvent, PersistedBlockSource, StreamEvent } from '../components/stream-renderer/types';
import { chatItemIdentityKey } from '../../../src/conversation-control/provider-live';
import { isRoutineActivityStatus } from './renderModel';
import type { ConversationSourceCoordinate } from '../query/conversationData';

export type ReadingRow = {
  key: string;
  kind: 'content' | 'activity-summary' | 'permission';
  protectedPositions: readonly number[];
  items: readonly CanonicalChatItemEvent[];
  sources: readonly PersistedBlockSource[];
  actionGroup: ReadingActionGroup;
  disclosureOwner: number | null;
  totalTokens?: number;
};

export type ReadingMembership = {
  rowKey: string;
  memberKey: string;
  position: number | null;
  disclosurePath: readonly number[];
  subtarget: string | null;
};
export type ReadingActionRun = { group: ReadingActionGroup; events: readonly CanonicalChatItemEvent[] };
export type ReadingProjection = {
  actionRuns: ReadonlyMap<string, ReadingActionRun>;
  rows: ReadingRow[];
  membership: ReadonlyMap<number, ReadingMembership>;
  viewMembership: ReadonlyMap<string, ReadingMembership>;
};
export type ReadingActionGroup = { key: string; start: number | null; end: number | null };

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
  expanded: ReadonlySet<number>;
}): ReadingProjection {
  const rows: ReadingRow[] = [];
  const membership = new Map<number, ReadingMembership>();
  const viewMembership = new Map<string, ReadingMembership>();
  const summaries = new Map<string, number>();
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
  const completed = new Set(canonicalEvents.flatMap(event => event.type === 'chat:item' && event.item.type === 'tool-call' && event.item.phase === 'result'
    ? [toolExecutionKey(event)].filter((key): key is string => key !== null) : []));
  for (const event of canonicalEvents) {
    if (event.type !== 'chat:item') continue;
    const execution = toolExecutionKey(event);
    const canonical = event.executionActive && execution && completed.has(execution) ? { ...event, executionActive: false } : event as CanonicalChatItemEvent;
    const item = canonical.item;
    if (item.type === 'activity' && isRoutineActivityStatus(item)
        && canonical.source?.detailsLoaded !== false) continue;
    const source = canonical.source;
    const position = source?.position;
    const native = chatItemIdentityKey(item);
    const identity = native ?? (position === undefined ? null
      : `position:${input.conversationId}:${input.positionSpaceId}:${position}`);
    if (!identity) continue;
    const key = canonical.intentId ? `intent:${canonical.intentId}` : canonical.displayKey ?? identity;
    const owner = position === undefined ? null : input.readingContext.get(position)?.activity_owner ?? null;
    const actionGroup = eventGroups.get(event)!;
    const collapsed = owner !== null && !input.expanded.has(owner);
    const rowKey = collapsed ? `activity:${input.conversationId}:${input.positionSpaceId}:${owner}` : key;
    const summaryIndex = summaries.get(rowKey);
    if (collapsed && summaryIndex !== undefined) {
      const previous = rows[summaryIndex];
      rows[summaryIndex] = { ...previous, sources: [...previous.sources, ...(source ? [source] : [])] };
    } else {
      if (collapsed) summaries.set(rowKey, rows.length);
      rows.push({ key: rowKey, kind: collapsed ? 'activity-summary' : 'content',
        protectedPositions: collapsed || position === undefined ? [] : [position], items: collapsed ? [] : [canonical], sources: source ? [source] : [], actionGroup, disclosureOwner: owner });
    }
    const member: ReadingMembership = { rowKey, memberKey: key, position: position ?? null,
      disclosurePath: collapsed ? [owner!] : [], subtarget: position === undefined ? null : sourceSubtarget(position) };
    viewMembership.set(key, member);
    if (native) viewMembership.set(native, member);
    if (position !== undefined) membership.set(position, member);
  }
  for (const [key, run] of actionRuns) {
    const usages = new Map(run.events.flatMap(event => event.usage ? [[event.usage.key, event.usage.input + event.usage.output] as const] : []));
    const last = [...rows].reverse().find(row => row.actionGroup.key === key);
    if (last && usages.size) last.totalTokens = [...usages.values()].reduce((sum, value) => sum + value, 0);
  }
  return { rows, membership, viewMembership, actionRuns };
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
