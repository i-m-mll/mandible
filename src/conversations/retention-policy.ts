import type { Db } from "../db.js";
import { readOpeningLine } from "../lineage-marker.js";
import type { ConversationSource } from "../parsers/types.js";
import type { RetainedChildRole } from "./retention-contract.js";

export interface RetainedChild {
  conversationId: string;
  provider: ConversationSource;
  sessionId: string;
  role: RetainedChildRole;
}

export function getRetainedChild(db: Db, conversationId: string): RetainedChild | null {
  const row = db.prepare(`SELECT id, source, session_id, parent_source, parent_session_id,
    parent_conversation_id, opening_lineage, opening_line FROM conversations WHERE id = ?`).get(conversationId) as {
    id: string; source: ConversationSource; session_id: string; parent_source: string | null;
    parent_session_id: string | null; parent_conversation_id: string | null;
    opening_lineage: string | null; opening_line: string | null;
  } | undefined;
  if (!row || row.opening_lineage !== "child" || !row.parent_conversation_id || !row.opening_line) return null;
  const opening = readOpeningLine(row.opening_line);
  if (opening.kind !== "marker" || opening.marker.relation !== "child") return null;
  const marker = opening.marker;
  if (marker.parent.source !== row.parent_source || marker.parent.sessionId !== row.parent_session_id) return null;
  if (marker.role !== "planner" && marker.role !== "archaeologist" && marker.role !== "worker") return null;
  return { conversationId: row.id, provider: row.source, sessionId: row.session_id, role: marker.role };
}

export function getRetainedChildByProvider(db: Db, provider: ConversationSource, sessionId: string): RetainedChild | null {
  const row = db.prepare(`SELECT id FROM conversations WHERE source = ? AND session_id = ?
    AND is_sidechain = 0 ORDER BY created_at, id LIMIT 1`).get(provider, sessionId) as { id: string } | undefined;
  return row ? getRetainedChild(db, row.id) : null;
}
