import type { Conversation, ConversationBlock, ConversationChild } from '../api';

export type ConversationWithBlocks = Conversation & {
  blocks: ConversationBlock[];
  children: ConversationChild[];
};

export type ConversationAppendPayload = Partial<Conversation> & {
  id?: string;
  append?: {
    from_position?: number;
    blocks?: ConversationBlock[];
  };
};

export function applyConversationAppendPayload<T extends ConversationWithBlocks>(
  conversation: T,
  data: ConversationAppendPayload,
): T | null {
  const { append, ...conversationData } = data;
  const appendBlocks = append?.blocks ?? [];
  if (appendBlocks.length === 0) {
    return { ...conversation, ...conversationData, blocks: conversation.blocks, children: conversation.children };
  }

  const existingIds = new Set(conversation.blocks.map((block) => block.id));
  if (appendBlocks.every((block) => existingIds.has(block.id))) {
    return { ...conversation, ...conversationData, blocks: conversation.blocks, children: conversation.children };
  }

  const expectedPosition = conversation.blocks.length > 0
    ? Math.max(...conversation.blocks.map((block) => block.position)) + 1
    : 0;
  const fromPosition = append?.from_position ?? appendBlocks[0]?.position;
  if (fromPosition !== expectedPosition || appendBlocks[0]?.position !== expectedPosition) {
    return null;
  }

  return {
    ...conversation,
    ...conversationData,
    blocks: [...conversation.blocks, ...appendBlocks],
    children: conversation.children,
    block_count: conversationData.block_count ?? conversation.block_count + appendBlocks.length,
  };
}

/** A `conversation:updated` summary payload as applied to a sidebar list row. */
export type ConversationSummaryPatch = Partial<Conversation> & { id?: string };

/**
 * Outcome of merging a `conversation:updated` summary into the sidebar list.
 *
 * - `applied`: `conversations` is a new array with the matched row updated in
 *   place (monotonic `block_count` accepted, plus any newer title).
 * - `refetch`: the event cannot be applied locally — an unknown conversation id
 *   (membership/grouping under the active filters is server-determined) or a
 *   summary with no `block_count` revision anchor — so the caller should
 *   schedule a debounced list refetch.
 * - neither flag set: a stale/out-of-order summary (`block_count` regressed);
 *   the existing list is kept unchanged and no refetch is needed.
 */
export type ConversationSummaryMergeResult = {
  conversations: Conversation[];
  applied: boolean;
  refetch: boolean;
};

export function mergeConversationSummaryIntoList(
  conversations: Conversation[],
  data: ConversationSummaryPatch,
): ConversationSummaryMergeResult {
  const id = data.id;
  if (!id) {
    return { conversations, applied: false, refetch: false };
  }
  const index = conversations.findIndex((conv) => conv.id === id);
  if (index === -1) {
    // Unknown id: it may or may not belong in the filtered/grouped list, which
    // only the server can decide — signal a refetch.
    return { conversations, applied: false, refetch: true };
  }
  const incomingCount =
    typeof data.block_count === 'number' ? data.block_count : undefined;
  if (incomingCount === undefined) {
    // No revision anchor to compare against — fall back to a refetch.
    return { conversations, applied: false, refetch: true };
  }
  const existing = conversations[index];
  if (incomingCount < existing.block_count) {
    // Out-of-order / stale summary — reject the merge.
    return { conversations, applied: false, refetch: false };
  }
  const merged: Conversation = {
    ...existing,
    block_count: incomingCount,
    ...(typeof data.title === 'string' ? { title: data.title } : {}),
  };
  const next = conversations.slice();
  next[index] = merged;
  return { conversations: next, applied: true, refetch: false };
}
