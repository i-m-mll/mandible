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

export function applyConversationAppendPayload(
  conversation: ConversationWithBlocks,
  data: ConversationAppendPayload,
): ConversationWithBlocks | null {
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
