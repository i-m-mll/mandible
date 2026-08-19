export type ConversationSidebarSort = "started_at" | "block_count";

export interface ConversationSidebarOrderRow {
  id: string;
  started_at: string;
  block_count: number;
}

export function compareConversationSidebarRows(
  left: ConversationSidebarOrderRow,
  right: ConversationSidebarOrderRow,
  sort: ConversationSidebarSort,
): number {
  if (sort === "block_count" && left.block_count !== right.block_count) {
    return right.block_count - left.block_count;
  }
  if (sort === "started_at" && left.started_at !== right.started_at) {
    return right.started_at.localeCompare(left.started_at);
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
