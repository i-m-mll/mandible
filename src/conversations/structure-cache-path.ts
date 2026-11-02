import path from "node:path";

export const CONVERSATION_STRUCTURE_CACHE_VERSION = 16;

/** Physical cache names include the schema, so opening never migrates another writer's cache. */
export function conversationStructureCachePath(ledgerPath: string, override?: string): string {
  if (override === ":memory:" || (!override && ledgerPath === ":memory:")) return ":memory:";
  if (!ledgerPath && !override) throw new Error("conversation structure cache requires an owning ledger");
  const base = override?.trim() || `${path.resolve(ledgerPath)}.conversation-structure.db`;
  return `${path.resolve(base)}.v${CONVERSATION_STRUCTURE_CACHE_VERSION}`;
}
