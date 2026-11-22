import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import { requestOriginJson } from "../request-origin.js";
import { carryReviewLineRanges, carryReviewRanges, reviewRangeMatches } from "./review-ranges.js";
import { appendReviewAnnotation, createReviewRound, type ReviewActor, type ReviewAnnotationResult } from "./review-store.js";
import type { CarriedReviewRange, ReviewRange, ReviewRangeKind, StandingDraftOrigin, StandingNote, StandingSourceReference } from "./review-types.js";

export type StandingNoteSource = {
  documentKey: string;
  reference: StandingSourceReference;
  order: number;
  source: string;
  rangeKind: ReviewRangeKind;
};

export type StandingNoteMutation = { kind: "edit"; body: string } | { kind: "resolve" } | { kind: "retract" };

const sourceKey = (reference: StandingSourceReference) => reference.kind === "artifact_version"
  ? reference.artifact_version_id : reference.history_id;

function annotationDocument(roundId: string, source: string, rangeKind: ReviewRangeKind) {
  return { id: roundId, source, rangeKind: rangeKind === "lines" ? rangeKind : undefined } as const;
}

/** Write in the adapter's transaction after resolving the exact immutable source. */
export function appendStandingNote(db: Db, target: StandingNoteSource, actorUserId: string, range: ReviewRange, body: string,
  now = Date.now(), draftOrigin?: StandingDraftOrigin,
): ReviewAnnotationResult {
  if (!draftOrigin && !reviewRangeMatches(target.source, range, target.rangeKind)) {
    return { ok: false, reason: "quote_mismatch" };
  }
  const roundId = `standing:${target.reference.kind}:${sourceKey(target.reference)}`;
  const owner = { kind: "standing_document", document_key: target.documentKey } as const;
  if (!db.prepare("SELECT 1 FROM review_rounds WHERE id = ? AND standing_document_key = ?").get(roundId, target.documentKey)) {
    const source = target.reference.kind === "artifact_version"
      ? { ...target.reference, range_kind: target.rangeKind } : target.reference;
    createReviewRound(db, roundId, owner, [{
      id: roundId, round_id: roundId, position: 0, document_key: target.documentKey, source, comparison_target: null,
    }]);
  }
  return appendReviewAnnotation(db, { owner, roundId, actorUserId }, annotationDocument(roundId, target.source, target.rangeKind),
    { operation: "set", kind: "comment", ...range, body }, now, draftOrigin);
}

type StandingNoteRecord = Omit<StandingNote, "anchor">;

export function standingNoteRecords(db: Db, documentKey: string, beforeOrAt: number, actorUserId?: string): StandingNoteRecord[] {
  const rows = db.prepare(`SELECT COALESCE(e.standing_note_root_id, e.id) AS id, e.body, u.display_name AS author,
      e.start_offset, e.end_offset, e.quote, orig.created_at, e.standing_note_resolved, e.standing_note_draft_origin,
      e.actor_user_id, b.source_json, COALESCE(v.version_no, h.generation) AS source_order
    FROM review_rounds r
    JOIN review_document_bindings b ON b.round_id = r.id
    JOIN briefing_annotation_events e ON e.document_binding_id = b.id AND e.round_id = r.id
    JOIN briefing_annotation_events orig ON orig.id = COALESCE(e.standing_note_root_id, e.id)
    JOIN users u ON u.id = e.actor_user_id
    LEFT JOIN artifact_version v ON v.id = b.artifact_version_id
    LEFT JOIN space_document_history h ON h.id = json_extract(b.source_json, '$.history_id')
    WHERE r.standing_document_key = ? AND COALESCE(v.version_no, h.generation) <= ?
      AND e.operation = 'set' AND e.annotation_kind = 'comment'
      AND NOT EXISTS (SELECT 1 FROM briefing_annotation_events retract WHERE retract.retracts_event_id = e.id)
    ORDER BY orig.created_at, orig.rowid`).all(documentKey, beforeOrAt) as Array<
    Omit<StandingNoteRecord, "source_reference" | "range_kind" | "resolved" | "can_edit" | "draft_origin"> & {
      source_json: string; standing_note_resolved: number; actor_user_id: string; standing_note_draft_origin: string | null;
    }>;
  return rows.map(({ source_json, standing_note_resolved, actor_user_id, standing_note_draft_origin, ...row }) => {
    const source_reference = JSON.parse(source_json) as StandingSourceReference;
    const draft_origin = standing_note_draft_origin === null ? null : JSON.parse(standing_note_draft_origin) as StandingDraftOrigin;
    const range_kind = draft_origin?.range_kind ?? (source_reference.kind === "artifact_version" ? source_reference.range_kind ?? "text" : "text");
    return { ...row, source_reference, range_kind,
      resolved: standing_note_resolved === 1, can_edit: actor_user_id === actorUserId,
      draft_origin };
  });
}

/** Read in the adapter's snapshot when it also reads mutable source metadata. */
export function listStandingNotes(db: Db, target: Pick<StandingNoteSource, "documentKey" | "order" | "source" | "rangeKind">,
  resolveSource: (reference: StandingSourceReference) => StandingNoteSource | null, actorUserId?: string,
): StandingNote[] {
  const maps = new Map<string, (range: ReviewRange) => CarriedReviewRange>();
  return standingNoteRecords(db, target.documentKey, target.order, actorUserId).map(note => {
    const range = { start_offset: note.start_offset, end_offset: note.end_offset, quote: note.quote };
    if (note.draft_origin || note.range_kind !== target.rangeKind) return { ...note, anchor: { status: "detached" } };
    const key = sourceKey(note.source_reference);
    if (note.source_order === target.order) return { ...note, anchor: { status: "preserved", ...range } };
    let carry = maps.get(key);
    if (!carry) {
      const original = resolveSource(note.source_reference);
      carry = original ? (target.rangeKind === "lines" ? carryReviewLineRanges : carryReviewRanges)(original.source, target.source)
        : () => ({ status: "detached" });
      maps.set(key, carry);
    }
    return { ...note, anchor: carry(range) };
  });
}

export function parseStandingNoteRange(value: Record<string, unknown>): ReviewRange | null {
  const { start_offset, end_offset, quote } = value;
  if (typeof start_offset !== "number" || !Number.isSafeInteger(start_offset) || start_offset < 0
      || typeof end_offset !== "number" || !Number.isSafeInteger(end_offset) || end_offset <= start_offset
      || typeof quote !== "string" || !quote) return null;
  return { start_offset, end_offset, quote };
}

export function parseStandingNoteMutation(value: Record<string, unknown>): StandingNoteMutation | null {
  if (value.kind === "resolve" || value.kind === "retract") return { kind: value.kind };
  return value.kind === "edit" && typeof value.body === "string" && value.body.trim()
    ? { kind: "edit", body: value.body.trim() } : null;
}

export function mutateStandingNote(db: Db, documentKey: string, actorUserId: string, noteId: string,
  mutation: StandingNoteMutation, now = Date.now(),
): ReviewAnnotationResult {
  return db.transaction((): ReviewAnnotationResult => {
    const prior = db.prepare(`SELECT e.id, e.round_id, e.body, e.standing_note_resolved
      FROM briefing_annotation_events e JOIN review_rounds r ON r.id = e.round_id
      WHERE r.standing_document_key = ? AND (e.id = ? OR e.standing_note_root_id = ?)
        AND e.actor_user_id = ? AND e.operation = 'set' AND e.annotation_kind = 'comment'
        AND NOT EXISTS (SELECT 1 FROM briefing_annotation_events retract WHERE retract.retracts_event_id = e.id)`)
      .get(documentKey, noteId, noteId, actorUserId) as {
        id: string; round_id: string; body: string; standing_note_resolved: number;
      } | undefined;
    if (!prior) return { ok: false, reason: "stale_annotation" };
    if (mutation.kind === "resolve" && prior.standing_note_resolved === 1
      || mutation.kind === "edit" && mutation.body === prior.body) return { ok: true, id: noteId };
    const actor: ReviewActor = { roundId: prior.round_id, owner: { kind: "standing_document", document_key: documentKey }, actorUserId };
    const retracted = appendReviewAnnotation(db, actor, { id: prior.round_id, source: "" },
      { operation: "retract", annotation_event_id: prior.id }, now);
    if (!retracted.ok || mutation.kind === "retract") return retracted;
    db.prepare(`INSERT INTO briefing_annotation_events
      (id, round_id, document_binding_id, operation, annotation_kind, start_offset, end_offset, quote, body,
        actor_user_id, created_at, request_origin_json, standing_note_root_id, standing_note_resolved, standing_note_draft_origin)
      SELECT ?, round_id, document_binding_id, operation, annotation_kind, start_offset, end_offset, quote, ?,
        actor_user_id, ?, ?, COALESCE(standing_note_root_id, id), ?, standing_note_draft_origin
      FROM briefing_annotation_events WHERE id = ?`).run(randomUUID(), mutation.kind === "edit" ? mutation.body : prior.body,
      now, requestOriginJson(), mutation.kind === "resolve" ? 1 : prior.standing_note_resolved, prior.id);
    return { ok: true, id: noteId };
  })();
}
