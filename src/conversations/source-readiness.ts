import type { Db } from "../db.js";
import { getAllParsers } from "../parsers/index.js";
import { canonicalSourcePath } from "./logical-source.js";
import { ConversationSourceStore } from "./source-store.js";
import { getConversationStructureCache } from "./structure-cache.js";
import { conversationSourceEpochsMatch, CURRENT_CONVERSATION_SOURCE_EPOCHS } from "./source-types.js";

export type ConversationSourceReadinessReason =
  | "current"
  | "source_not_indexed"
  | "source_unavailable"
  | "version_not_indexed"
  | "epochs_outdated"
  | "version_unsealed"
  | "projection_incomplete"
  | "unsupported_representation"
  | "conversation_not_found"
  | "repair_failed"
  | "repair_unavailable";

export interface ConversationSourceReadiness {
  status: "ready" | "repair_needed" | "unavailable";
  reason: ConversationSourceReadinessReason;
  conversationId: string;
  sourceId: string | null;
  sourceVersionId: string | null;
  sourcePath: string | null;
}

/** Metadata readiness only; the source reader still proves the physical bytes. */
export function readConversationSourceReadiness(db: Db, conversationId: string): ConversationSourceReadiness {
  const conversation = db.prepare("SELECT source, source_path, block_count FROM conversations WHERE id = ?")
    .get(conversationId) as { source: string; source_path: string | null; block_count: number } | undefined;
  const store = new ConversationSourceStore(db);
  const source = store.resolveConversation(conversationId);
  const version = source?.currentVersionId ? store.resolveVersion(source.currentVersionId) : null;
  const aliases = source ? store.listAliases(source.sourceId) : [];
  const selectedAlias = aliases.find((alias) => alias.availability === "available") ?? aliases[0];
  const sourcePath = selectedAlias?.path ?? conversation?.source_path;
  const result = (
    status: ConversationSourceReadiness["status"], reason: ConversationSourceReadinessReason,
  ): ConversationSourceReadiness => ({
    status, reason, conversationId, sourceId: source?.sourceId ?? null,
    sourceVersionId: source?.currentVersionId ?? null,
    sourcePath: sourcePath ? canonicalSourcePath(sourcePath) : null,
  });
  if (!conversation) return result("unavailable", "conversation_not_found");
  const repairable = getAllParsers().some(parser => parser.source === conversation.source && parser.parseIncremental);
  const needsRepair = (reason: ConversationSourceReadinessReason) =>
    result(repairable ? "repair_needed" : "unavailable", reason);
  if (!source) return needsRepair("source_not_indexed");
  if (!source.positionSpaceId) return needsRepair("projection_incomplete");
  if (source.availability === "missing" || version?.availability === "missing") {
    return result("unavailable", "source_unavailable");
  }
  if (!version || version.sourceId !== source.sourceId) return needsRepair("version_not_indexed");
  const epochs = CURRENT_CONVERSATION_SOURCE_EPOCHS;
  if (!conversationSourceEpochsMatch(source, epochs) || !conversationSourceEpochsMatch(version, epochs)) {
    return needsRepair("epochs_outdated");
  }
  if (!repairable) return result("unavailable", "unsupported_representation");
  if (source.availability !== "available" || version.availability !== "available") {
    return needsRepair("source_unavailable");
  }
  if (version.generation !== "sealed_sha256") return needsRepair("version_unsealed");
  const complete = getConversationStructureCache(db).hasCompleteConversation(conversationId, version.id, conversation.block_count, epochs);
  return complete ? result("ready", "current") : needsRepair("projection_incomplete");
}
