// Conversation lineage: which session created a conversation to do part of its
// work. `conversations.parent_conversation_id` is the one lineage store, and
// this module is its one writer.
//
// A child row records the parent declared for it (`parent_source`,
// `parent_session_id`) and is linked to an indexed row of that session as soon
// as one exists, whichever of the two is ingested first. A subagent's parent is
// the provider's own record; any other child declares its parent with the
// lineage marker on line 1 of its first user message (`lineage-marker.ts`),
// and a conversation that should declare one but does not is a lineage gap. Readers find a
// session's children through every row that indexes it, so duplicate rows of a
// parent session never split its family.

import type { Db } from "./db.js";
import type { ConversationSource, ParseResult, TranscriptOpening } from "./parsers/types.js";

/** The session a conversation's provider names as its creator. */
export interface ConversationParent {
  source: ConversationSource;
  sessionId: string;
}

export interface LineageEvidence extends ConversationParent {
  conversationId: string;
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
 * parent and is still unlinked. Returns their indexed identities.
 */
export function linkWaitingChildren(
  db: Db,
  conversation: { source: ConversationSource; session_id: string },
): LineageEvidence[] {
  return db.prepare(`
    UPDATE conversations
       SET parent_conversation_id = ${DECLARED_PARENT_ROW_SQL}
     WHERE parent_session_id = ?
       AND parent_source = ?
       AND parent_conversation_id IS NULL
       AND ${DECLARED_PARENT_ROW_SQL} IS NOT NULL
     RETURNING id AS conversationId, source, session_id AS sessionId
  `).all(conversation.session_id, conversation.source) as LineageEvidence[];
}

/**
 * What a conversation's opening (line 1 of its first user message) declares.
 * `unread` marks rows indexed before openings were read, whose first message
 * an appended batch cannot supply; a full parse replaces it.
 */
export type OpeningLineage =
  | "unread"
  | "none"
  | "child"
  | "successor"
  | "malformed"
  | "mismatched"
  | "legacy-prose";

/**
 * Why a conversation that should have a parent has none or a doubtful one
 * (a gap), or has one whose relation was assumed (a warning).
 */
export type LineageGapKind =
  | "malformed-marker"
  | "parent-mismatch"
  | "unresolved-parent"
  | "legacy-prose"
  | "missing-marker"
  | "assumed-child";

export type LineageGapSeverity = "gap" | "warning";

/** A child linked from the provider's creator record alone has no declared roles. */
export function lineageGapSeverity(kind: LineageGapKind): LineageGapSeverity {
  return kind === "assumed-child" ? "warning" : "gap";
}

interface OpeningDeclaration {
  lineage: Exclude<OpeningLineage, "unread">;
  line: string | null;
  parent: ConversationParent | null;
}

/**
 * Combine the marker with the provider's record of who delivered the message.
 * The marker says whether the thread is a child and names the roles; when the
 * provider records the creator, that record is the parent, and a marker naming
 * a different parent is flagged as a mismatch.
 */
export function openingDeclaration(opening: TranscriptOpening): OpeningDeclaration {
  const { line, creator } = opening;
  if (line.kind === "none") return { lineage: "none", line: null, parent: null };
  if (line.kind !== "marker") return { lineage: line.kind, line: line.line, parent: null };
  const marker = line.marker;
  if (marker.relation === "successor") return { lineage: "successor", line: line.line, parent: null };
  const agrees = !creator || (creator.source === marker.parent.source && creator.sessionId === marker.parent.sessionId);
  return { lineage: agrees ? "child" : "mismatched", line: line.line, parent: creator ?? marker.parent };
}

/**
 * SQL expression for the lineage gap of the conversation row `alias`, or NULL.
 * Subagents are never judged, nor are rows whose opening has not been read.
 */
export function lineageGapSql(alias: string): string {
  return `CASE
    WHEN ${alias}.is_sidechain != 0 OR ${alias}.opening_lineage IS NULL OR ${alias}.opening_lineage = 'unread' THEN NULL
    WHEN ${alias}.opening_lineage = 'malformed' THEN 'malformed-marker'
    WHEN ${alias}.opening_lineage = 'mismatched' THEN 'parent-mismatch'
    WHEN ${alias}.parent_session_id IS NOT NULL AND ${alias}.parent_conversation_id IS NULL THEN 'unresolved-parent'
    WHEN ${alias}.opening_lineage = 'legacy-prose' THEN 'legacy-prose'
    WHEN ${alias}.opening_lineage = 'none' AND ${alias}.agent_created != 0 AND ${alias}.parent_session_id IS NULL THEN 'missing-marker'
    WHEN ${alias}.opening_lineage = 'none' AND ${alias}.parent_session_id IS NOT NULL THEN 'assumed-child'
  END`;
}

/** A subagent's parent is the provider's own record; its opening never replaces it. */
function isSubagent(db: Db, conversationId: string): boolean {
  const row = db.prepare("SELECT is_sidechain FROM conversations WHERE id = ?").get(conversationId) as
    { is_sidechain: number } | undefined;
  return (row?.is_sidechain ?? 0) !== 0;
}

function lineageGapOf(db: Db, conversationId: string): LineageGapKind | null {
  const row = db.prepare(`SELECT ${lineageGapSql("c")} AS gap FROM conversations c WHERE c.id = ?`)
    .get(conversationId) as { gap: LineageGapKind | null } | undefined;
  return row?.gap ?? null;
}

/**
 * Record what an ingested batch's opening declares. A batch that starts the
 * transcript replaces the record; an appended batch fills it only when no
 * opening has been read. Returns the declaration when it was recorded.
 */
function recordOpening(db: Db, conversationId: string, opening: TranscriptOpening): OpeningDeclaration | null {
  const declaration = openingDeclaration(opening);
  const recorded = db.prepare(`
    UPDATE conversations
       SET opening_lineage = ?, opening_line = ?
     WHERE id = ? AND (? OR opening_lineage IS NULL)
  `).run(declaration.lineage, declaration.line, conversationId, opening.atStart ? 1 : 0).changes > 0;
  return recorded ? declaration : null;
}

/**
 * Apply one ingested batch's lineage: the provider's subagent parent, or else
 * the parent the opening declares, then link children that were waiting for
 * this session. Returns a newly created gap and the identities whose indexed
 * lineage can now be reconciled by the caller.
 */
export function linkIngestedConversation(
  db: Db,
  conversation: { id: string; source: ConversationSource; session_id: string },
  batch: Pick<ParseResult, "parent" | "opening" | "createdByAgent">,
): { gap: LineageGapKind | null; affected: LineageEvidence[] } {
  const gapBefore = lineageGapOf(db, conversation.id);
  if (batch.createdByAgent) {
    db.prepare("UPDATE conversations SET agent_created = 1 WHERE id = ?").run(conversation.id);
  }
  const declared = batch.opening ? recordOpening(db, conversation.id, batch.opening) : null;
  const parent = batch.parent ?? (declared?.parent && !isSubagent(db, conversation.id) ? declared.parent : null);
  if (parent) recordConversationParent(db, conversation.id, parent);
  const linked = linkWaitingChildren(db, conversation);
  const gapAfter = lineageGapOf(db, conversation.id);
  return { gap: gapAfter !== gapBefore ? gapAfter : null,
    affected: [{ conversationId: conversation.id, source: conversation.source, sessionId: conversation.session_id }, ...linked] };
}

export interface LineageGap {
  kind: LineageGapKind;
  severity: LineageGapSeverity;
  conversation_id: string;
  source: ConversationSource;
  session_id: string;
  title: string;
  started_at: string;
  opening_line: string | null;
  parent_source: ConversationSource | null;
  parent_session_id: string | null;
}

export interface LineageGapReport {
  /** Gaps in conversations started at or after this time; null for every one. */
  since: string | null;
  counts: Array<{ source: ConversationSource; kind: LineageGapKind; severity: LineageGapSeverity; count: number }>;
  gaps: LineageGap[];
}

/**
 * List conversations that are children without a trustworthy parent, one row
 * per provider session. Only conversations whose opening Mandible has read are
 * judged, so history indexed before openings were read never appears.
 */
export function listLineageGaps(
  db: Db,
  options: { since: string | null; source: ConversationSource | null },
): LineageGapReport {
  const rows = db.prepare(`
    SELECT kind, conversation_id, source, session_id, title, started_at, opening_line, parent_source, parent_session_id
      FROM (
        SELECT ${lineageGapSql("c")} AS kind, c.id AS conversation_id, c.source, c.session_id, c.title,
               c.started_at, c.opening_line, c.parent_source, c.parent_session_id, c.created_at
          FROM conversations c
         WHERE c.opening_lineage IS NOT NULL
           AND (? IS NULL OR c.started_at >= ?)
           AND (? IS NULL OR c.source = ?)
      )
     WHERE kind IS NOT NULL
     ORDER BY started_at DESC, created_at, conversation_id
  `).all(options.since, options.since, options.source, options.source) as Array<Omit<LineageGap, "severity">>;
  const sessions = new Set<string>();
  const gaps: LineageGap[] = [];
  for (const row of rows) {
    const session = `${row.source}:${row.session_id}`;
    if (sessions.has(session)) continue;
    sessions.add(session);
    gaps.push({ ...row, severity: lineageGapSeverity(row.kind) });
  }
  const counts = new Map<string, LineageGapReport["counts"][number]>();
  for (const gap of gaps) {
    const key = `${gap.source}:${gap.kind}`;
    const entry = counts.get(key) ?? { source: gap.source, kind: gap.kind, severity: gap.severity, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  return { since: options.since, counts: [...counts.values()], gaps };
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
