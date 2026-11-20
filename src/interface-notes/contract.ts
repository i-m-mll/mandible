import { annotationAttachmentText, MAX_ANNOTATION_TEXT, type AnnotationTarget, type ChatAttachment } from "../conversation-control/attachments.js";

/**
 * Interface notes: annotations made with the Agentation toolbar on Mandible's own
 * interface or on another app's dev server, kept by the daemon from the moment they
 * are saved and filed onto issue comments. This file is the contract between the
 * server, the toolbar host, the interface-notes embed, the Send menu and the issue
 * view; see docs/specs/interface-annotations-and-attachments.md.
 */

/** The app key of notes made on Mandible's own interface, and of a note whose input names no app. */
export const MANDIBLE_INTERFACE_NOTES_APP = "mandible";

/**
 * An app key: `mandible`, or a project key, `:` and a path within its checkout (`.` for its root). An
 * embedding page's key always has the separator, so no page can be given Mandible's own notes.
 */
export const INTERFACE_NOTES_APP_PATTERN = /^(?:mandible|[A-Za-z0-9][A-Za-z0-9._-]*:[A-Za-z0-9._/-]+)$/;
export const MAX_INTERFACE_NOTES_APP = 256;

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
  /** The app whose interface the note was made on; unfiled notes, counts and the toolbar are scoped by it. */
  app: string;
  /** The embedding page's origin for a note made through the embed; null for a note made in Mandible. */
  origin: string | null;
  text: string;
  target: AnnotationTarget;
  pin: InterfaceNotePin;
  owner: InterfaceNoteOwner;
  created_at: number;
  updated_at: number;
}

/**
 * What the toolbar host sends when a note is made. The daemon reads an absent `app` as `mandible`. Another
 * app's note names the embedding page's `origin`, which is also its page URL's origin; Mandible's names none.
 */
export type InterfaceNoteInput = Pick<InterfaceNote, "id" | "app" | "text" | "target" | "pin"> & { origin?: string };

export type InterfaceNoteDestination =
  | { issue: string }
  /** `project` is the project ref the embedding app declares; without it, the `interface_notes_project` setting. */
  | { new_issue: { title: string; project?: string } };

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

/** Project (any project ref) whose issues receive Mandible's own filed notes. Unset: Send offers Chat only. */
export const INTERFACE_NOTES_PROJECT_SETTING = "interface_notes_project";

/**
 * SSE event after any note write; the payload names the notes, their app and the issue, if any, they touched.
 * `app` is null only on the event a preview emits when its relay (re)connects, which may stand for any app.
 */
export const INTERFACE_NOTE_CHANGED_EVENT = "interface_note:changed";
export interface InterfaceNoteChangedPayload {
  ids: string[];
  app: string | null;
  issue_id: string | null;
}

export const INTERFACE_NOTE_ROUTES = {
  /**
   * GET: one app's unfiled notes (`?app=<app>`, default `mandible`), or `?issue=<ref>` for one issue's filed notes of every app.
   * POST InterfaceNoteInput: 201, or 409 `note_exists`.
   */
  collection: "/api/interface-notes",
  unfiled: (app: string): string => `/api/interface-notes?app=${encodeURIComponent(app)}`,
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
  /** GET /api/issues with this query lists only issues that carry notes, most recently annotated first; `&project=<id>` limits it to one project. */
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
  /** POST, PATCH: the text, target or pin fails validation; POST file: the request is malformed. */
  invalid_note: 400,
  /** POST file: the issue ref does not resolve. */
  issue_not_found: 404,
  /** POST file with `new_issue`: neither the given project nor `interface_notes_project` resolves. */
  receiving_project_unset: 409,
  /** POST file: every listed note was filed or deleted meanwhile; no comment or issue is created. */
  nothing_to_file: 409,
  /** GET embed identity: the origin is not an http(s) origin on a loopback host. */
  origin_not_loopback: 400,
  /** Embed identity: no process listens on the port, a listener's directory is unreadable, or the directory is not a checkout of a registered project. */
  origin_not_registered: 404,
  /** Embed identity: the operator has not allowed this origin for this directory; the request is recorded as pending. */
  origin_not_granted: 403,
  /** Embed grants: no request from this origin and directory. */
  grant_not_found: 404,
  /** Any route, in a preview that keeps notes in its source instance: that instance did not answer. */
  source_unavailable: 503,
} as const;
export type InterfaceNoteErrorCode = keyof typeof INTERFACE_NOTE_ERRORS;

export const MAX_INTERFACE_NOTE_TEXT = MAX_ANNOTATION_TEXT;

/**
 * The interface-notes embed, for apps other than Mandible. A dev page loads `script`
 * from the daemon's origin; it opens `bridge`, a hidden iframe on that origin, and
 * sends note operations to it with postMessage. The bridge asks `identity` which app
 * and project the embedding page's origin is, and makes ordinary same-origin requests
 * with that app and project. See docs/specs/interface-annotations-and-attachments.md.
 */
export const INTERFACE_NOTES_EMBED = {
  script: "/embed/notes.js",
  bridge: "/embed/bridge",
  /**
   * POST `{ origin }`: EmbedIdentity for a granted origin; 403 `origin_not_granted` with `{ grant: EmbedGrant }`
   * after recording the request as pending; 404 `origin_not_registered`; 400 `origin_not_loopback`.
   */
  identity: "/api/interface-notes/embed-identity",
  /**
   * GET: every EmbedGrant, pending first. PUT `{ origin, directory }`: allow a recorded request.
   * DELETE `?origin=&directory=`: revoke or dismiss it. Only Mandible's own interface calls these.
   */
  grants: "/api/interface-notes/embed-grants",
  /** The Settings view, opened top-level with `embed_origin=<origin>` to show that origin's request. */
  grantView: "/settings",
} as const;

/** The app a loopback dev origin serves: the registered project whose checkout the listening process runs in. */
export interface EmbedIdentity {
  /** `<project key>:<path>` for a directory within the checkout, `<project key>:.` for its root. */
  app: string;
  project: { id: string; key: string; name: string };
}

/** The operator's decision on one embedding origin, as written, and the directory its listener ran in. */
export interface EmbedGrant extends EmbedIdentity {
  origin: string;
  directory: string;
  state: "pending" | "granted";
  requested_at: number;
  decided_at: number | null;
}

/** The attachment shape every pill, preview, Chat draft and text renderer consumes. */
export function interfaceNoteAttachment(note: InterfaceNote, ordinal: number): Extract<ChatAttachment, { kind: "annotation" }> {
  return { kind: "annotation", id: note.id, ordinal, text: note.text, target: note.target };
}

/**
 * The body of a comment that carries notes. The daemon regenerates it on every
 * change to the comment's notes; it is the same text Chat delivery gives an agent.
 */
export function renderInterfaceNotesBody(notes: readonly InterfaceNote[]): string {
  return notes.map((note, index) => {
    const text = annotationAttachmentText(interfaceNoteAttachment(note, index + 1));
    return note.origin === null ? text : `${text}\n${interfaceNoteProvenance(note)}`;
  }).join("\n\n");
}

/** Where a note made through the embed came from, as its comment body states it. */
export function interfaceNoteProvenance(note: Pick<InterfaceNote, "origin" | "app">): string {
  return `Made on: ${note.origin} (${note.app}), not in Mandible`;
}

/** Where a note's pin is shown: the pathname of the page it was made on. */
export function interfaceNotePagePath(note: Pick<InterfaceNote, "target">): string {
  return new URL(note.target.url).pathname;
}
