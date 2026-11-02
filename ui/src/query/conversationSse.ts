import type { QueryClient, QueryKey } from '@tanstack/preact-query';
import type { ConversationSidebarResponse, ConversationPositionWindow } from '../api';
import {
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
    if (filters?.full_text && filters.search) {
      markSidebarListsStale(client, key, true);
      continue;
    }
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

  void client.invalidateQueries({ queryKey: ['chat', 'conversation', data.id, 'reading-manifest'] });

  const aggregateKey = conversationKeys.aggregate(data.id);
  const aggregate = client.getQueryData<ConversationTranscriptData>(aggregateKey);
  if (aggregate) {
    client.setQueryData(aggregateKey, {
      ...aggregate,
      conversation: { ...aggregate.conversation, ...data,
        block_count: Math.max(aggregate.conversation.block_count, data.block_count ?? 0) },
    });
  }

  const appendBlocks = data.append?.blocks ?? [];
  if (typeof data.block_count === 'number' && appendBlocks.length === 0) {
    void client.invalidateQueries({ queryKey: conversationKeys.windows(data.id) });
    return;
  }

  for (const [key, cached] of client.getQueriesData<ConversationPositionWindow>({ queryKey: conversationKeys.windows(data.id) })) {
    if (!cached || queryConversationId(key) !== data.id) continue;
    client.setQueryData(key, { ...cached, conversation: { ...cached.conversation, ...data,
      block_count: Math.max(cached.conversation.block_count, data.block_count ?? 0) } });
    void client.invalidateQueries({ queryKey: key, exact: true });
  }
}
