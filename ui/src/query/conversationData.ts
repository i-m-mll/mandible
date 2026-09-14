import type {
  Conversation,
  ConversationBlock,
  ConversationChild,
  ConversationPositionWindow,
  ConversationSidebarGroup,
  ConversationSidebarResponse,
} from '../api';

export type ConversationWithDetails = Conversation & {
  blocks: ConversationBlock[];
  children: ConversationChild[];
  parent: ConversationPositionWindow['parent'];
  position_window: Pick<ConversationPositionWindow, 'revision' | 'total' | 'target' | 'window'>;
};

export function flattenConversationWindow(payload: ConversationPositionWindow): ConversationWithDetails {
  return {
    ...payload.conversation,
    blocks: payload.blocks,
    children: payload.children,
    parent: payload.parent,
    position_window: {
      revision: payload.revision,
      total: payload.total,
      target: payload.target,
      window: payload.window,
    },
  };
}

function mergeBlocks(...windows: ConversationPositionWindow[]): ConversationBlock[] {
  const byId = new Map<string, ConversationBlock>();
  for (const window of windows) {
    for (const block of window.blocks) byId.set(block.id, block);
  }
  return [...byId.values()].sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
}

export function mergeConversationWindows(
  current: ConversationPositionWindow | undefined,
  incoming: ConversationPositionWindow,
): ConversationPositionWindow {
  if (!current || current.conversation.id !== incoming.conversation.id) return incoming;
  const blocks = mergeBlocks(current, incoming);
  const startPosition = blocks[0]?.position ?? null;
  const endPosition = blocks.at(-1)?.position ?? null;
  const total = Math.max(current.total, incoming.total);
  return {
    ...incoming,
    conversation: { ...current.conversation, ...incoming.conversation },
    children: incoming.revision >= current.revision ? incoming.children : current.children,
    parent: incoming.revision >= current.revision ? incoming.parent : current.parent,
    revision: Math.max(current.revision, incoming.revision),
    total,
    blocks,
    window: {
      ...incoming.window,
      start_position: startPosition,
      end_position: endPosition,
      has_before: startPosition !== null && startPosition > 0,
      has_after: endPosition !== null && endPosition < total - 1,
      after_count: endPosition === null ? total : Math.max(0, total - endPosition - 1),
    },
  };
}

function mergeGroup(current: ConversationSidebarGroup, incoming: ConversationSidebarGroup): ConversationSidebarGroup {
  const seen = new Set(current.conversations.map((conversation) => conversation.id));
  return {
    ...incoming,
    conversations: [
      ...current.conversations,
      ...incoming.conversations.filter((conversation) => !seen.has(conversation.id)),
    ],
  };
}

export function mergeSidebarPages(
  initial: ConversationSidebarResponse | undefined,
  pages: ConversationSidebarResponse[],
): ConversationSidebarGroup[] {
  if (!initial) return [];
  const groups = new Map(initial.groups.map((group) => [group.key, group]));
  for (const page of pages) {
    for (const group of page.groups) {
      const current = groups.get(group.key);
      groups.set(group.key, current ? mergeGroup(current, group) : group);
    }
  }
  return [...groups.values()];
}

export type ConversationAppendPayload = Partial<Conversation> & {
  id?: string;
  append?: {
    from_position?: number;
    blocks?: ConversationBlock[];
  };
};

type ConversationWithBlocks = Conversation & {
  blocks: ConversationBlock[];
  children: ConversationChild[];
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
  if (fromPosition !== expectedPosition || appendBlocks[0]?.position !== expectedPosition) return null;

  return {
    ...conversation,
    ...conversationData,
    blocks: [...conversation.blocks, ...appendBlocks],
    children: conversation.children,
    block_count: conversationData.block_count ?? conversation.block_count + appendBlocks.length,
  };
}

export type ConversationSummaryMergeResult = {
  conversations: Conversation[];
  applied: boolean;
  refetch: boolean;
};

export function mergeConversationSummaryIntoList(
  conversations: Conversation[],
  data: Partial<Conversation> & { id?: string },
): ConversationSummaryMergeResult {
  if (!data.id) return { conversations, applied: false, refetch: false };
  const index = conversations.findIndex((conversation) => conversation.id === data.id);
  if (index === -1) return { conversations, applied: false, refetch: true };
  if (typeof data.block_count !== 'number') return { conversations, applied: false, refetch: true };
  const existing = conversations[index];
  if (data.block_count < existing.block_count) return { conversations, applied: false, refetch: false };
  const next = conversations.slice();
  next[index] = {
    ...existing,
    block_count: data.block_count,
    ...(typeof data.title === 'string' ? { title: data.title } : {}),
  };
  return { conversations: next, applied: true, refetch: false };
}
