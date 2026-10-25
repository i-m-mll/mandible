import type { QueryClient, QueryKey } from '@tanstack/preact-query';
import type { ConversationSidebarResponse, ConversationPositionWindow } from '../api';
import {
  applyConversationAppendPayload,
  mergeConversationSummaryIntoList,
  type ConversationAppendPayload,
  type ConversationTranscriptData,
} from './conversationData';
import { conversationKeys, type ConversationSidebarFilters } from './conversationKeys';
import { markSidebarListsStale } from './conversationSidebarRefresh';

const MEMBERSHIP_FIELDS = new Set([
  'starred',
  'archived_at',
  'cwd',
  'project_path',
  'canonical_project_id',
  'canonical_project_key',
]);

function queryConversationId(key: QueryKey): string | null {
  return key[0] === 'chat' && key[1] === 'conversation' && typeof key[2] === 'string' ? key[2] : null;
}

/**
 * Whether an update to a conversation absent from a sidebar list could add it to that list.
 * Appending to a conversation that already met the block threshold changes neither its
 * started_at rank nor its eligibility, so an unsearched started_at list cannot gain it.
 */
function mayEnterList(filters: ConversationSidebarFilters | undefined, data: ConversationAppendPayload): boolean {
  if (filters?.sort === 'block_count' || filters?.search) return true;
  const appendedFrom = data.append?.from_position;
  return typeof appendedFrom !== 'number' || appendedFrom < (filters?.min_blocks ?? 0);
}

export function applyConversationSse(
  client: QueryClient,
  type: 'conversation:new' | 'conversation:updated',
  data: ConversationAppendPayload,
): void {
  if (type === 'conversation:new' || !data.id) {
    void client.invalidateQueries({ queryKey: conversationKeys.routeTargets() });
    markSidebarListsStale(client);
    return;
  }

  const raw = data as ConversationAppendPayload & { updates?: unknown };
  const membershipChanged = [...MEMBERSHIP_FIELDS].some((field) => Object.hasOwn(raw, field))
    || (Array.isArray(raw.updates) && raw.updates.some((field) => typeof field === 'string' && MEMBERSHIP_FIELDS.has(field)));

  for (const [key, cached] of client.getQueriesData<ConversationSidebarResponse>({ queryKey: conversationKeys.sidebars() })) {
    if (!cached) continue;
    const filters = key[3] as ConversationSidebarFilters | undefined;
    let affected = false;
    let uncertain = membershipChanged;
    const groups = cached.groups.map((group) => {
      const existing = group.conversations.find((conversation) => conversation.id === data.id);
      if (!existing) return group;
      affected = true;
      uncertain ||= filters?.sort === 'block_count'
        ? typeof data.block_count === 'number' && data.block_count !== existing.block_count
        : typeof data.started_at === 'string' && data.started_at !== existing.started_at;
      const result = mergeConversationSummaryIntoList(group.conversations, data);
      uncertain ||= result.refetch;
      return result.applied ? { ...group, conversations: result.conversations } : group;
    });
    if (affected && !uncertain) client.setQueryData(key, { ...cached, groups });
    else if (affected || (key[2] === 'initial' && (membershipChanged || mayEnterList(filters, data)))) {
      markSidebarListsStale(client, key, true);
    }
  }

  const appendBlocks = data.append?.blocks ?? [];
  if (typeof data.block_count === 'number' && appendBlocks.length === 0) {
    void client.invalidateQueries({ queryKey: conversationKeys.windows(data.id) });
    return;
  }

  const aggregateKey = conversationKeys.aggregate(data.id);
  const aggregate = client.getQueryData<ConversationTranscriptData>(aggregateKey);
  if (aggregate) {
    const total = Math.max(aggregate.total, data.block_count ?? aggregate.total);
    const flattened = {
      ...aggregate.conversation,
      blocks: aggregate.blocks,
      children: aggregate.children,
    };
    const lastInterval = aggregate.loaded_intervals.at(-1);
    const includesTail = aggregate.end_reached;
    const next = includesTail ? applyConversationAppendPayload(flattened, data) : null;
    const blocks = next?.blocks ?? aggregate.blocks;
    const endPosition = blocks.at(-1)?.position ?? lastInterval?.end ?? null;
    const nextIntervals = next && endPosition !== null
      ? aggregate.loaded_intervals.map((interval, index) => index === aggregate.loaded_intervals.length - 1
        ? { ...interval, end: Math.max(interval.end, endPosition) }
        : interval)
      : aggregate.loaded_intervals;
    client.setQueryData(aggregateKey, {
      ...aggregate,
      conversation: {
        ...aggregate.conversation,
        ...data,
        block_count: Math.max(aggregate.conversation.block_count, data.block_count ?? next?.block_count ?? 0),
      },
      blocks,
      revision: Math.max(aggregate.revision, data.block_count ?? next?.block_count ?? 0),
      total,
      loaded_intervals: nextIntervals,
      end_reached: next ? true : aggregate.end_reached,
      after_count: next ? 0 : Math.max(aggregate.after_count, total - aggregate.total),
    });
  }

  for (const [key, cached] of client.getQueriesData<ConversationPositionWindow>({ queryKey: conversationKeys.windows(data.id) })) {
    if (!cached || queryConversationId(key) !== data.id) continue;
    const flattened = {
      ...cached.conversation,
      blocks: cached.blocks,
      children: cached.children,
    };
    if (cached.window.has_after) {
      const total = Math.max(cached.total, data.block_count ?? cached.total);
      client.setQueryData(key, {
        ...cached,
        conversation: { ...cached.conversation, ...data, block_count: Math.max(cached.conversation.block_count, data.block_count ?? 0) },
        revision: Math.max(cached.revision, data.block_count ?? 0),
        total,
        window: { ...cached.window, after_count: Math.max(0, total - (cached.window.end_position ?? -1) - 1) },
      });
      continue;
    }
    const next = applyConversationAppendPayload(flattened, data);
    if (!next) {
      void client.invalidateQueries({ queryKey: key, exact: true });
      continue;
    }
    const endPosition = next.blocks.at(-1)?.position ?? cached.window.end_position;
    const total = Math.max(cached.total, data.block_count ?? next.block_count);
    client.setQueryData(key, {
      ...cached,
      conversation: { ...cached.conversation, ...data, block_count: next.block_count },
      blocks: next.blocks,
      revision: Math.max(cached.revision, data.block_count ?? next.block_count),
      total,
      window: {
        ...cached.window,
        end_position: endPosition,
        has_after: endPosition !== null && endPosition < total - 1,
        after_count: endPosition === null ? total : Math.max(0, total - endPosition - 1),
      },
    });
  }
}
