import { annotationAttachmentText, type AnnotationTarget, type ChatAttachment } from "../conversation-control/attachments.js";

/**
 * Interface notes: annotations made with the Agentation toolbar on Mandible's own
 * interface, kept by the daemon from the moment they are saved and filed onto
 * issue comments. This file is the contract between the server, the toolbar host,
 * the Send menu and the issue view; see docs/specs/interface-annotations-and-attachments.md.
 */

/**
 * Agentation's own annotation record, stored verbatim so the toolbar can draw the
 * pin again. The daemon reads only `id` and `comment`; everything else is opaque.
 * `timestamp` is never written back to the toolbar's cache, because the package
 * drops cached notes older than seven days.
 */
export type InterfaceNotePin = { id: string; comment: string } & Record<string, unknown>;

export type InterfaceNoteOwner =
  | { kind: "unfiled" }
  | { kind: "comment"; issue_id: string; comment_id: string };

export interface InterfaceNote {
  /** Agentation's annotation id; the toolbar's cache and the daemon share it. */
  id: string;
  text: string;
  target: AnnotationTarget;
  pin: InterfaceNotePin;
  owner: InterfaceNoteOwner;
  created_at: number;
  updated_at: number;
}

/** What the toolbar host sends when a note is made. */
export type InterfaceNoteInput = Pick<InterfaceNote, "id" | "text" | "target" | "pin">;

export type InterfaceNoteDestination =
  | { issue: string }
  | { new_issue: { title: string } };

export interface FileInterfaceNotesRequest {
  /** The unfiled notes the user saw when choosing; notes filed meanwhile are skipped. */
  note_ids: string[];
  destination: InterfaceNoteDestination;
}

export interface FileInterfaceNotesResult {
  issue_id: string;
  issue_short_id: string;
  comment_id: string;
  comment_ordinal: number;
  filed: string[];
}

/** Project (any project ref) whose issues receive filed notes. Unset: Send offers Chat only. */
export const INTERFACE_NOTES_PROJECT_SETTING = "interface_notes_project";

/** SSE event after any note write; the payload names the notes and the issue, if any, they touched. */
export const INTERFACE_NOTE_CHANGED_EVENT = "interface_note:changed";
export interface InterfaceNoteChangedPayload {
  ids: string[];
  issue_id: string | null;
}

export const INTERFACE_NOTE_ROUTES = {
  /** GET: unfiled notes, or `?issue=<ref>` for one issue's filed notes. POST InterfaceNoteInput: 201, or 409 `note_exists`. */
  collection: "/api/interface-notes",
  /**
   * PATCH `{ text }`: edit, whoever owns the note; a filed note's edit revises its comment body. 404 `note_not_found`.
   * DELETE: delete an unfiled note. 404 `note_not_found`; 409 `note_filed` when the note has an owner, which is left untouched.
   */
  note: (id: string): string => `/api/interface-notes/${encodeURIComponent(id)}`,
  /**
   * DELETE: remove a filed note from the comment that owns it; the last note of a comment soft-deletes the comment.
   * 404 `note_not_found`; 409 `note_owner_mismatch` when that comment does not own the note.
   */
  noteOnComment: (id: string, commentId: string): string =>
    `/api/interface-notes/${encodeURIComponent(id)}?comment=${encodeURIComponent(commentId)}`,
  /** POST FileInterfaceNotesRequest: one new comment carrying the notes. */
  file: "/api/interface-notes/file",
  /** GET /api/issues with this query lists only issues that carry notes, most recently annotated first. */
  issuesWithNotesQuery: "has_notes=true",
} as const;

/**
 * Every refusal of an interface-notes route is `{ error: <code>, message?: string }` with the status below.
 * A caller replaying a write treats `note_exists` on create, and `note_not_found` or `note_filed` on
 * edit or delete, as done: the daemon already holds the state the write asked for, or has moved past it.
 * Any other failure leaves the write pending.
 */
export const INTERFACE_NOTE_ERRORS = {
  /** POST collection: a note with this id is already held. */
  note_exists: 409,
  /** PATCH, DELETE: no note with this id. */
  note_not_found: 404,
  /** DELETE of an unfiled note: the note has been filed and stays on its comment. */
  note_filed: 409,
  /** DELETE from a comment: that comment does not own the note. */
  note_owner_mismatch: 409,
  /** POST, PATCH: the text, target or pin fails validation. */
  invalid_note: 400,
  /** POST file: the issue ref does not resolve. */
  issue_not_found: 404,
  /** POST file with `new_issue`: `interface_notes_project` is unset or does not resolve. */
  receiving_project_unset: 409,
} as const;
export type InterfaceNoteErrorCode = keyof typeof INTERFACE_NOTE_ERRORS;

export const MAX_INTERFACE_NOTE_TEXT = 10_000;

/** The attachment shape every pill, preview, Chat draft and text renderer consumes. */
export function interfaceNoteAttachment(note: InterfaceNote, ordinal: number): Extract<ChatAttachment, { kind: "annotation" }> {
  return { kind: "annotation", id: note.id, ordinal, text: note.text, target: note.target };
}

/**
 * The body of a comment that carries notes. The daemon regenerates it on every
 * change to the comment's notes; it is the same text Chat delivery gives an agent.
 */
export function renderInterfaceNotesBody(notes: readonly InterfaceNote[]): string {
  return notes.map((note, index) => annotationAttachmentText(interfaceNoteAttachment(note, index + 1))).join("\n\n");
}

/** Where a note's pin is shown: the pathname of the page it was made on. */
export function interfaceNotePagePath(note: Pick<InterfaceNote, "target">): string {
  return new URL(note.target.url).pathname;
}
