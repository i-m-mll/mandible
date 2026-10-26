import type { Db } from "../db.js";
import { setConversationArchiveState } from "./metadata.js";
import { getRetainedChild } from "./retention-policy.js";
import { projectChildRetentionActivity } from "./retention-state.js";
import type { ConversationBlock } from "../parsers/types.js";
import { systemAction } from "../identity/resolver.js";

export function reconcileIngestedChildRetention(db: Db, conversationId: string, sourcePath: string,
  blocks: readonly Pick<ConversationBlock, "type" | "role" | "timestamp" | "position" | "metadata">[]): void {
  projectChildRetentionActivity(db, conversationId, blocks);
  const child = getRetainedChild(db, conversationId);
  if (!child) return;
  const state = db.prepare(`SELECT last_activity_at,provider_archived FROM conversation_retention_state WHERE conversation_id=?`)
    .get(conversationId) as { last_activity_at: number | null; provider_archived: number | null } | undefined;
  if (!state) return;
  const archive = db.prepare("SELECT archived_at FROM conversation_archive_states WHERE conversation_id=?")
    .get(conversationId) as { archived_at: number } | undefined;
  const newActivity = archive && state.last_activity_at != null && state.last_activity_at > archive.archived_at;
  if (newActivity) {
    setConversationArchiveState(db, { conversation_id: conversationId, archived: false, cause: "observed-provider" },
      { actor_type: "system", actor_id: "conversation-ingestion", attribution: systemAction() });
  }
  if (child.provider !== "codex") return;
  const archived = sourcePath.split(/[\\/]/).includes("archived_sessions");
  const wasArchived = state.provider_archived;
  db.prepare("UPDATE conversation_retention_state SET provider_archived=? WHERE conversation_id=?")
    .run(archived ? 1 : 0, conversationId);
  if (archived && wasArchived !== 1 && !newActivity) {
    setConversationArchiveState(db, { conversation_id: conversationId, archived: true, cause: "observed-provider" },
      { actor_type: "system", actor_id: "conversation-ingestion", attribution: systemAction() });
  }
}
