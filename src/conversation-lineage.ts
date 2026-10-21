// Conversation lineage: which session created a conversation to do part of its
// work. `conversations.parent_conversation_id` is the one lineage store, and
// this module is its one writer.
//
// A child row records the parent its provider declares (`parent_source`,
// `parent_session_id`) and is linked to an indexed row of that session as soon
// as one exists, whichever of the two is ingested first. Readers find a
// session's children through every row that indexes it, so duplicate rows of a
// parent session never split its family.

import type { Db } from "./db.js";
import type { ConversationSource } from "./parsers/types.js";

/** The session a conversation's provider names as its creator. */
export interface ConversationParent {
  source: ConversationSource;
  sessionId: string;
}

/**
 * The row that stands for `child`'s declared parent session. A row that is
 * itself a declared child of the same session (a Claude subagent transcript
 * carries its parent's session id) is never a parent.
 */
const DECLARED_PARENT_ROW_SQL = `(
  SELECT parent.id
    FROM conversations parent
   WHERE parent.source = conversations.parent_source
     AND parent.session_id = conversations.parent_session_id
     AND parent.id != conversations.id
     AND parent.parent_session_id IS NOT parent.session_id
   ORDER BY parent.is_sidechain ASC, parent.started_at ASC, parent.created_at ASC, parent.id ASC
   LIMIT 1
)`;

/**
 * Record the parent that `conversationId`'s provider declares, and link it if
 * that parent is indexed. A changed declaration drops the previous link.
 */
export function recordConversationParent(db: Db, conversationId: string, parent: ConversationParent): void {
  db.prepare(`
    UPDATE conversations
       SET parent_conversation_id = CASE
             WHEN parent_source IS ? AND parent_session_id IS ? THEN parent_conversation_id
           END,
           parent_source = ?,
           parent_session_id = ?
     WHERE id = ?
  `).run(parent.source, parent.sessionId, parent.source, parent.sessionId, conversationId);
  db.prepare(`
    UPDATE conversations
       SET parent_conversation_id = ${DECLARED_PARENT_ROW_SQL}
     WHERE id = ?
       AND parent_session_id IS NOT NULL
       AND parent_conversation_id IS NULL
  `).run(conversationId);
}

/**
 * Link every indexed child that declared `conversation`'s session as its
 * parent and is still unlinked. Returns the number of children linked.
 */
export function linkWaitingChildren(
  db: Db,
  conversation: { source: ConversationSource; session_id: string },
): number {
  return db.prepare(`
    UPDATE conversations
       SET parent_conversation_id = ${DECLARED_PARENT_ROW_SQL}
     WHERE parent_session_id = ?
       AND parent_source = ?
       AND parent_conversation_id IS NULL
       AND ${DECLARED_PARENT_ROW_SQL} IS NOT NULL
  `).run(conversation.session_id, conversation.source).changes;
}

/**
 * Apply one ingested conversation's lineage: record the parent its transcript
 * declares, if this parse saw one, then link children that were waiting for
 * this session.
 */
export function linkIngestedConversation(
  db: Db,
  conversation: { id: string; source: ConversationSource; session_id: string },
  parent: ConversationParent | null,
): void {
  if (parent) recordConversationParent(db, conversation.id, parent);
  linkWaitingChildren(db, conversation);
}

/**
 * SQL predicate selecting, as `childAlias`, the children of the session that
 * the conversation row `conversationIdSql` indexes, across every row of that
 * session and every provider. A row that is itself an in-session child has no
 * children.
 */
export function childrenOfConversationSql(childAlias: string, conversationIdSql = "?"): string {
  return `${childAlias}.parent_conversation_id IN (
    SELECT family.id
      FROM conversations self
      JOIN conversations family ON family.session_id = self.session_id
     WHERE self.id = ${conversationIdSql}
       AND self.parent_session_id IS NOT self.session_id
  )`;
}

/**
 * SQL predicate selecting, as `childAlias`, the children of the provider
 * session id bound at `sessionIdSql`, across every row of that session and
 * every provider.
 */
export function childrenOfSessionSql(childAlias: string, sessionIdSql = "?"): string {
  return `${childAlias}.parent_conversation_id IN (
    SELECT family.id FROM conversations family WHERE family.session_id = ${sessionIdSql}
  )`;
}
