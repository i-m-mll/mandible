import type { Db } from "../db.js";
import type { ConversationRow } from "../ledger-reads/conversations.js";
import type { LedgerActorInput } from "../ledger/types.js";
import { mutateLedgerRecord } from "../ledger/mutation-history.js";
import { DOMAIN_EVENTS } from "../contracts.js";
import { broadcast } from "../sse.js";

export type ConversationArchiveCause = "manual" | "retention" | "resolved-worker" | "observed-provider";
export interface ConversationMetadataResult {
  updated: ConversationRow | null;
  archivedAt: number | null;
  changedFields: string[];
  changed: boolean;
}

function canonicalizeTags(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of value as string[]) {
    const tag = raw.trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

/** Canonical authored metadata boundary for exact conversation or reservation IDs. */
export function updateConversationMetadata(db: Db, id: string, body: Record<string, unknown>, options: { archiveCause?: ConversationArchiveCause; actor?: LedgerActorInput } = {}): ConversationMetadataResult | null {
  const allowed = new Set(["starred", "archived", "tags", "tags_add", "tags_remove", "notes", "notes_append"]);
  const supplied = Object.keys(body);
  if (!supplied.length || supplied.some(key => !allowed.has(key))) throw new Error("No updates provided");
  if ("starred" in body && body.starred !== true && body.starred !== false && body.starred !== 0 && body.starred !== 1) {
    throw new Error("starred must be a boolean");
  }
  if ("archived" in body && typeof body.archived !== "boolean") {
    throw new Error("archived must be a boolean");
  }
  if ("notes" in body && body.notes !== null && typeof body.notes !== "string") {
    throw new Error("notes must be a string or null");
  }
  if ("notes_append" in body && (typeof body.notes_append !== "string" || !body.notes_append.trim())) {
    throw new Error("notes_append must be a non-empty string");
  }
  const project = db.prepare("SELECT project_id FROM conversation_spawn_requests WHERE id=?").get(id) as { project_id: string | null } | undefined;
  const result = mutateLedgerRecord(db, {
    entity_type: "conversation_metadata", entity_id: id, project_id: project?.project_id,
    ...options.actor,
    payload: { conversation_id: id, ...("archived" in body ? { cause: options.archiveCause ?? "manual", archived: body.archived } : {}) },
    snapshot: () => {
      const metadata = db.prepare("SELECT starred,tags,notes FROM conversations WHERE id=?").get(id) as Record<string, unknown> | undefined;
      const archive = db.prepare("SELECT archived_at FROM conversation_archive_states WHERE conversation_id=?").get(id) as { archived_at: number } | undefined;
      return metadata || archive ? { ...metadata, archived_at: archive?.archived_at ?? null } : null;
    },
  }, () => {
    const current = db.prepare("SELECT * FROM conversations WHERE id = ?")
      .get(id) as ConversationRow | undefined;
    const spawn = db.prepare(`SELECT id FROM conversation_spawn_requests
      WHERE id = ? AND schema_version = 'mandible-conversation-spawn-request@3'`).get(id);
    if (!current && !spawn) return null;
    const conversationOnlyFields = supplied.filter((field) => field !== "archived");
    if (!current && conversationOnlyFields.length > 0) {
      throw new Error("Only archive state can be updated before a conversation materializes");
    }
    const previousArchive = db.prepare("SELECT archived_at FROM conversation_archive_states WHERE conversation_id = ?")
      .get(id) as { archived_at: number } | undefined;
    const changedFields: string[] = [];
    if ("archived" in body) {
      if (body.archived && !previousArchive) {
        db.prepare("INSERT INTO conversation_archive_states (conversation_id, archived_at) VALUES (?, ?)")
          .run(id, Date.now());
        changedFields.push("archived_at");
      } else if (!body.archived && previousArchive) {
        db.prepare("DELETE FROM conversation_archive_states WHERE conversation_id = ?").run(id);
        changedFields.push("archived_at");
      }
    }
    if (!current) {
      const archive = db.prepare("SELECT archived_at FROM conversation_archive_states WHERE conversation_id = ?")
        .get(id) as { archived_at: number } | undefined;
      return { updated: null, archivedAt: archive?.archived_at ?? null, changedFields };
    }
    let tags = canonicalizeTags(JSON.parse(current.tags), "stored tags");
    if ("tags" in body) tags = canonicalizeTags(body.tags, "tags");
    if ("tags_add" in body) tags = canonicalizeTags([...tags, ...canonicalizeTags(body.tags_add, "tags_add")], "tags");
    if ("tags_remove" in body) {
      const remove = new Set(canonicalizeTags(body.tags_remove, "tags_remove"));
      tags = tags.filter((tag) => !remove.has(tag));
    }

    const nextStarred = "starred" in body ? (body.starred === true || body.starred === 1 ? 1 : 0) : current.starred;
    if (nextStarred !== current.starred) changedFields.push("starred");
    const nextTags = JSON.stringify(tags);
    if (nextTags !== current.tags) changedFields.push("tags");
    let nextNotes = current.notes;
    if ("notes" in body) nextNotes = body.notes === null ? null : (body.notes as string).trim() || null;
    if ("notes_append" in body) {
      const append = (body.notes_append as string).trim();
      nextNotes = nextNotes?.trim() ? `${nextNotes.trim()}\n\n${append}` : append;
    }
    if (nextNotes !== current.notes) changedFields.push("notes");

    if (changedFields.length) db.prepare(`UPDATE conversations
      SET starred = ?, tags = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(nextStarred, nextTags, nextNotes, id);
    const updated = db.prepare(`SELECT c.*, a.archived_at FROM conversations c
      LEFT JOIN conversation_archive_states a ON a.conversation_id = c.id WHERE c.id = ?`)
      .get(id) as ConversationRow;
    return { updated, archivedAt: updated.archived_at ?? null, changedFields };
  });
  if (!result) return null;
  if (result.changedFields.length) db.afterCommit(() => broadcast(DOMAIN_EVENTS.CONVERSATION_UPDATED, { id, updates: result.changedFields }));
  return { ...result, changed: result.changedFields.length > 0 };
}

/** Archive state is shared by manual actions, retention and provider observations. */
export function setConversationArchiveState(db: Db, input: { conversation_id: string; archived: boolean; cause: ConversationArchiveCause }, actor?: LedgerActorInput): ConversationMetadataResult | null {
  return updateConversationMetadata(db, input.conversation_id, { archived: input.archived }, { archiveCause: input.cause, actor });
}
