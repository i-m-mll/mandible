import type { ConversationStructure } from '../api';
import type { CanonicalChatItemEvent, PersistedBlockSource, StreamEvent } from '../components/stream-renderer/types';
import { chatItemIdentityKey } from '../../../src/conversation-control/provider-live';
import { isRoutineActivityStatus } from './renderModel';
import type { ConversationSourceCoordinate } from '../query/conversationData';

export type ReadingRow = {
  key: string;
  kind: 'content' | 'activity-summary';
  items: readonly CanonicalChatItemEvent[];
  sources: readonly PersistedBlockSource[];
  actionGroup: ReadingActionGroup;
  disclosureOwner: number | null;
};

export type ReadingMembership = {
  rowKey: string;
  memberKey: string;
  position: number | null;
  disclosurePath: readonly number[];
  subtarget: string | null;
};
export type ReadingProjection = {
  rows: ReadingRow[];
  membership: ReadonlyMap<number, ReadingMembership>;
  viewMembership: ReadonlyMap<string, ReadingMembership>;
};
export type ReadingActionGroup = { key: string; start: number | null; end: number | null };

/** Complete action scope comes from source structure, even when the active window clips the speaker run. */
export function sourceActionGroups(structure: ConversationStructure): ReadonlyMap<number, ReadingActionGroup> {
  const groups = new Map<number, ReadingActionGroup>();
  let group: ReadingActionGroup | null = null;
  let speaker: string | null = null;
  for (const row of structure.rows) {
    const nextSpeaker = row.role === 'tool' ? 'assistant' : row.role;
    if (!group || speaker !== nextSpeaker) {
      group = { key: `group:${structure.conversation_id}:${structure.position_space_id}:${row.position}`, start: row.position, end: row.position };
      speaker = nextSpeaker;
    }
    group.end = row.position;
    groups.set(row.position, group);
  }
  return groups;
}

/** Global source relationships, rather than the currently loaded members, choose summary owners. */
export function activityOwners(structure: ConversationStructure): ReadonlyMap<number, number> {
  const owners = new Map<number, number>();
  let runOwner: number | null = null;
  for (const row of structure.rows) {
    const activity = ['thinking', 'tool_use', 'tool_result', 'event'].includes(row.type);
    if (!activity) { runOwner = null; continue; }
    const related = row.parent_position === null ? null : owners.get(row.parent_position) ?? row.parent_position;
    if (related !== null) runOwner = related;
    else if (runOwner === null || row.type === 'tool_use') runOwner = row.position;
    owners.set(row.position, runOwner);
  }
  return owners;
}

export function sourceSubtarget(position: number): string { return `source:${position}`; }

/** View identity is provider/intent identity; canonical links remain position-space coordinates. */
export function projectReadingRows(input: {
  events: readonly StreamEvent[];
  conversationId: string;
  positionSpaceId: string;
  activityOwners: ReadonlyMap<number, number>;
  actionGroups: ReadonlyMap<number, ReadingActionGroup>;
  expanded: ReadonlySet<number>;
}): ReadingProjection {
  const rows: ReadingRow[] = [];
  const membership = new Map<number, ReadingMembership>();
  const viewMembership = new Map<string, ReadingMembership>();
  const summaries = new Map<string, number>();
  for (const event of input.events) {
    if (event.type !== 'chat:item') continue;
    const canonical = event as CanonicalChatItemEvent;
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
    const owner = position === undefined ? null : input.activityOwners.get(position) ?? null;
    const actionGroup = position === undefined ? { key, start: null, end: null }
      : input.actionGroups.get(position) ?? { key, start: position, end: position };
    const collapsed = owner !== null && !input.expanded.has(owner);
    const rowKey = collapsed ? `activity:${input.conversationId}:${input.positionSpaceId}:${owner}` : key;
    const summaryIndex = summaries.get(rowKey);
    if (collapsed && summaryIndex !== undefined) {
      const previous = rows[summaryIndex];
      rows[summaryIndex] = { ...previous, sources: [...previous.sources, ...(source ? [source] : [])] };
    } else {
      if (collapsed) summaries.set(rowKey, rows.length);
      rows.push({ key: rowKey, kind: collapsed ? 'activity-summary' : 'content',
        items: collapsed ? [] : [canonical], sources: source ? [source] : [], actionGroup, disclosureOwner: owner });
    }
    const member: ReadingMembership = { rowKey, memberKey: key, position: position ?? null,
      disclosurePath: collapsed ? [owner!] : [], subtarget: position === undefined ? null : sourceSubtarget(position) };
    viewMembership.set(key, member);
    if (native) viewMembership.set(native, member);
    if (position !== undefined) membership.set(position, member);
  }
  return { rows, membership, viewMembership };
}

export type ReadingRevealCommand = { token: string; target: ConversationSourceCoordinate };
export type ReadingRevealResult = { token: string; status:
  'revealed' | 'cancelled' | 'source-unavailable' | 'position-space-changed' | 'not-renderable' | 'unsuccessful' };

/** Renderers prepare lazy/disclosed content and register their exact focus target inside the measured box. */
export type ReadingTargetRegistration = {
  coordinate: ConversationSourceCoordinate;
  rowKey: string;
  element: HTMLElement;
};
export type ReadingRendererPreparation = (target: ConversationSourceCoordinate, signal: AbortSignal) => Promise<
  { status: 'prepared'; membership: ReadingMembership } | { status: 'source-unavailable' | 'position-space-changed' | 'not-renderable' }
>;
