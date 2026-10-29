import type { Db } from "../db.js";
import { ConversationSourceStore } from "./source-store.js";

/** Canonical publication facts; physical bytes still require a verified lease. */
export function readConversationSourceGeneration(db: Db, conversationId: string): string {
  return db.transaction(() => {
    const store = new ConversationSourceStore(db);
    const source = store.resolveConversation(conversationId);
    return JSON.stringify({
      source,
      version: source?.currentVersionId ? store.resolveVersion(source.currentVersionId) : null,
      aliases: source ? store.listAliases(source.sourceId).sort((left, right) => left.id.localeCompare(right.id)) : [],
    });
  })();
}
