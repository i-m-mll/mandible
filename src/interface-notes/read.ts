import type { Db } from "../db.js";
import type { AnnotationTarget } from "../conversation-control/attachments.js";
import type { InterfaceNote, InterfaceNotePin } from "./contract.js";

export type NoteRow = {
  id: string;
  comment_id: string | null;
  issue_id: string | null;
  text: string;
  target_json: string;
  pin_json: string;
  created_at: number;
  updated_at: number;
};

export const NOTE_COLUMNS = "n.id, n.comment_id, c.issue_id, n.text, n.target_json, n.pin_json, n.created_at, n.updated_at";
export const NOTE_FROM = "interface_notes n LEFT JOIN ledger_comments c ON c.id = n.comment_id";

export function noteFromRow(row: NoteRow): InterfaceNote {
  return {
    id: row.id,
    text: row.text,
    target: JSON.parse(row.target_json) as AnnotationTarget,
    pin: JSON.parse(row.pin_json) as InterfaceNotePin,
    owner: row.comment_id === null || row.issue_id === null
      ? { kind: "unfiled" }
      : { kind: "comment", issue_id: row.issue_id, comment_id: row.comment_id },
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** All notes of an issue's live comments, in comment order and then creation order. */
export function listIssueInterfaceNotes(db: Db, issueId: string): InterfaceNote[] {
  return (db.prepare(
    `SELECT ${NOTE_COLUMNS} FROM interface_notes n JOIN ledger_comments c ON c.id = n.comment_id
     WHERE c.issue_id = ? AND c.deleted_at IS NULL
     ORDER BY c.ordinal, n.created_at, n.id`,
  ).all(issueId) as NoteRow[]).map(noteFromRow);
}

/** Count and most recent change of the notes each issue carries; issues without notes are absent. */
export function interfaceNoteStatsByIssue(db: Db): Map<string, { count: number; last_at: number }> {
  const rows = db.prepare(
    `SELECT c.issue_id, count(*) AS count, max(n.updated_at) AS last_at
     FROM interface_notes n JOIN ledger_comments c ON c.id = n.comment_id
     WHERE c.deleted_at IS NULL
     GROUP BY c.issue_id`,
  ).all() as Array<{ issue_id: string; count: number; last_at: number }>;
  return new Map(rows.map((row) => [row.issue_id, { count: row.count, last_at: row.last_at }]));
}

export function commentCarriesInterfaceNotes(db: Db, commentId: string): boolean {
  return db.prepare("SELECT 1 FROM interface_notes WHERE comment_id = ? LIMIT 1").get(commentId) !== undefined;
}
