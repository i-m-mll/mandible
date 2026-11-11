import type { Db } from "../db.js";
import { AttachmentValidationError, validatedAnnotationTarget, validatedAnnotationText } from "../conversation-control/attachment-store.js";
import type { AnnotationTarget } from "../conversation-control/attachments.js";
import { commentCarriesInterfaceNotes, NOTE_COLUMNS, NOTE_FROM, noteFromRow, type NoteRow } from "./read.js";
import { resolveOperationalIssueRef } from "../ledger/operational-links.js";
import { resolveProjectRef } from "../ledger/project-registry.js";
import { LedgerStore } from "../ledger/store.js";
import type { LedgerActorInput } from "../ledger/types.js";
import {
  INTERFACE_NOTES_PROJECT_SETTING,
  renderInterfaceNotesBody,
  type FileInterfaceNotesResult,
  type InterfaceNote,
  type InterfaceNoteChangedPayload,
  type InterfaceNoteErrorCode,
  type InterfaceNotePin,
} from "./contract.js";

export type InterfaceNoteFailure = { code: InterfaceNoteErrorCode; message?: string };
export type InterfaceNoteResult<T> = { ok: true; value: T } | { ok: false; error: InterfaceNoteFailure };
export type InterfaceNoteWriteActor = LedgerActorInput;
export type InterfaceNoteChangeListener = (payload: InterfaceNoteChangedPayload) => void;

const MAX_NOTE_ID = 128;
const MAX_PIN_JSON = 100_000;
const ok = <T>(value: T): InterfaceNoteResult<T> => ({ ok: true, value });
const fail = <T>(code: InterfaceNoteErrorCode, message?: string): InterfaceNoteResult<T> =>
  ({ ok: false, error: message === undefined ? { code } : { code, message } });

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validated<T>(read: () => T): InterfaceNoteResult<T> {
  try {
    return ok(read());
  } catch (error) {
    if (error instanceof AttachmentValidationError) return fail("invalid_note", error.message);
    throw error;
  }
}

function validatedInput(input: unknown): InterfaceNoteResult<{ id: string; text: string; target: AnnotationTarget; pin: InterfaceNotePin }> {
  if (!isRecord(input)) return fail("invalid_note", "A note must be an object");
  const { id, pin } = input;
  if (typeof id !== "string" || !id || id.length > MAX_NOTE_ID) return fail("invalid_note", "A note id is 1 to 128 characters");
  const fields = validated(() => ({ text: validatedAnnotationText(input.text), target: validatedAnnotationTarget(input.target) }));
  if (!fields.ok) return fields;
  if (!URL.canParse(fields.value.target.url)) return fail("invalid_note", "A note's page URL must be absolute");
  if (!isRecord(pin) || pin.id !== id) return fail("invalid_note", "A note's pin must be an object whose id is the note id");
  const stored = { ...pin, id, comment: fields.value.text } as InterfaceNotePin;
  if (JSON.stringify(stored).length > MAX_PIN_JSON) return fail("invalid_note", "A note's pin is too large");
  return ok({ id, text: fields.value.text, target: fields.value.target, pin: stored });
}

/**
 * The daemon's record of interface notes. A filed note's comment body is the
 * text form of the comment's notes, regenerated in the same transaction as
 * every change to them.
 */
export class InterfaceNoteStore {
  private readonly ledger: LedgerStore;

  constructor(private readonly db: Db, private readonly onChange: InterfaceNoteChangeListener) {
    this.ledger = new LedgerStore(db);
  }

  listUnfiled(): InterfaceNote[] {
    return (this.db.prepare(`SELECT ${NOTE_COLUMNS} FROM ${NOTE_FROM} WHERE n.comment_id IS NULL ORDER BY n.created_at, n.id`)
      .all() as NoteRow[]).map(noteFromRow);
  }

  get(id: string): InterfaceNote | null {
    const row = this.db.prepare(`SELECT ${NOTE_COLUMNS} FROM ${NOTE_FROM} WHERE n.id = ?`).get(id) as NoteRow | undefined;
    return row ? noteFromRow(row) : null;
  }

  create(input: unknown, now: number = Date.now()): InterfaceNoteResult<InterfaceNote> {
    const parsed = validatedInput(input);
    if (!parsed.ok) return parsed;
    const note = parsed.value;
    return this.db.transaction(() => {
      if (this.get(note.id)) return fail<InterfaceNote>("note_exists");
      this.db.prepare(
        `INSERT INTO interface_notes (id, comment_id, text, target_json, pin_json, created_at, updated_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?)`,
      ).run(note.id, note.text, JSON.stringify(note.target), JSON.stringify(note.pin), now, now);
      this.changed([note.id], null);
      return ok(this.get(note.id)!);
    })();
  }

  updateText(id: string, text: unknown, actor: InterfaceNoteWriteActor): InterfaceNoteResult<InterfaceNote> {
    const parsed = validated(() => validatedAnnotationText(text));
    if (!parsed.ok) return parsed;
    return this.db.transaction(() => {
      const note = this.get(id);
      if (!note) return fail<InterfaceNote>("note_not_found");
      if (note.text === parsed.value) return ok(note);
      this.db.prepare("UPDATE interface_notes SET text = ?, pin_json = ?, updated_at = ? WHERE id = ?")
        .run(parsed.value, JSON.stringify({ ...note.pin, comment: parsed.value }), Date.now(), id);
      if (note.owner.kind === "comment") this.regenerate(note.owner.comment_id, actor);
      this.changed([id], note.owner.kind === "comment" ? note.owner.issue_id : null);
      return ok(this.get(id)!);
    })();
  }

  deleteUnfiled(id: string): InterfaceNoteResult<void> {
    return this.db.transaction(() => {
      const note = this.get(id);
      if (!note) return fail<void>("note_not_found");
      if (note.owner.kind !== "unfiled") return fail<void>("note_filed");
      this.db.prepare("DELETE FROM interface_notes WHERE id = ?").run(id);
      this.changed([id], null);
      return ok(undefined);
    })();
  }

  removeFromComment(id: string, commentId: string, actor: InterfaceNoteWriteActor): InterfaceNoteResult<void> {
    return this.db.transaction(() => {
      const note = this.get(id);
      if (!note) return fail<void>("note_not_found");
      if (note.owner.kind !== "comment" || note.owner.comment_id !== commentId) return fail<void>("note_owner_mismatch");
      this.db.prepare("DELETE FROM interface_notes WHERE id = ?").run(id);
      if (commentCarriesInterfaceNotes(this.db, commentId)) this.regenerate(commentId, actor);
      else this.ledger.softDeleteComment(commentId, { ...actor, source: "mandible" });
      this.changed([id], note.owner.issue_id);
      return ok(undefined);
    })();
  }

  /** File the listed notes that are still unfiled as one new comment; notes filed or deleted meanwhile are skipped. */
  file(request: unknown, actor: InterfaceNoteWriteActor): InterfaceNoteResult<FileInterfaceNotesResult> {
    if (!isRecord(request) || !Array.isArray(request.note_ids) || request.note_ids.length === 0
        || !request.note_ids.every((id): id is string => typeof id === "string")) {
      return fail("invalid_note", "note_ids must be a non-empty list of note ids");
    }
    const noteIds = [...new Set(request.note_ids)];
    const destination = this.resolveDestination(request.destination);
    if (!destination.ok) return destination;
    return this.db.transaction(() => {
      const placeholders = noteIds.map(() => "?").join(",");
      const notes = (this.db.prepare(
        `SELECT ${NOTE_COLUMNS} FROM ${NOTE_FROM}
         WHERE n.comment_id IS NULL AND n.id IN (${placeholders})
         ORDER BY n.created_at, n.id`,
      ).all(...noteIds) as NoteRow[]).map(noteFromRow);
      if (notes.length === 0) return fail<FileInterfaceNotesResult>("nothing_to_file");
      const issueId = destination.value.kind === "issue"
        ? destination.value.issue_id
        : this.ledger.createIssue({
          ...actor,
          project_id: destination.value.project_id,
          title: destination.value.title,
          body: "",
          kind: "unknown",
          source: "mandible",
        }).id;
      const comment = this.ledger.addComment(issueId, { ...actor, body: renderInterfaceNotesBody(notes), source: "mandible" });
      const now = Date.now();
      const move = this.db.prepare("UPDATE interface_notes SET comment_id = ?, updated_at = ? WHERE id = ? AND comment_id IS NULL");
      for (const note of notes) move.run(comment.id, now, note.id);
      const filed = notes.map((note) => note.id);
      this.changed(filed, issueId);
      const issue = this.ledger.getIssue(issueId);
      return ok({
        issue_id: issue.id,
        issue_short_id: issue.short_id || issue.id.slice(0, 7),
        comment_id: comment.id,
        comment_ordinal: comment.ordinal,
        filed,
      });
    })();
  }

  private resolveDestination(value: unknown): InterfaceNoteResult<
    { kind: "issue"; issue_id: string } | { kind: "new_issue"; project_id: string; title: string }
  > {
    if (isRecord(value) && typeof value.issue === "string") {
      const resolved = resolveOperationalIssueRef(this.db, value.issue);
      return resolved.ok
        ? ok({ kind: "issue", issue_id: resolved.issue_id })
        : fail("issue_not_found", resolved.error === "ambiguous" ? `${value.issue} names more than one issue` : undefined);
    }
    if (isRecord(value) && isRecord(value.new_issue) && typeof value.new_issue.title === "string") {
      const title = value.new_issue.title.trim();
      if (!title) return fail("invalid_note", "A new issue needs a title");
      const setting = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(INTERFACE_NOTES_PROJECT_SETTING) as { value: string } | undefined;
      const project = setting?.value.trim() ? resolveProjectRef(this.db, setting.value.trim()) : null;
      if (!project?.ok) return fail("receiving_project_unset");
      return ok({ kind: "new_issue", project_id: project.project.id, title });
    }
    return fail("invalid_note", "destination must be { issue } or { new_issue: { title } }");
  }

  private regenerate(commentId: string, actor: InterfaceNoteWriteActor): void {
    const notes = (this.db.prepare(
      `SELECT ${NOTE_COLUMNS} FROM ${NOTE_FROM} WHERE n.comment_id = ? ORDER BY n.created_at, n.id`,
    ).all(commentId) as NoteRow[]).map(noteFromRow);
    this.ledger.updateComment(commentId, { body: renderInterfaceNotesBody(notes) }, { ...actor, source: "mandible" });
  }

  private changed(ids: string[], issueId: string | null): void {
    this.db.afterCommit(() => this.onChange({ ids, issue_id: issueId }));
  }
}
