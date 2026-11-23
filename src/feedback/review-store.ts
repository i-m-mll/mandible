import type { ReviewChangeEdit } from "./request-draft-types.js";
import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import { canonicalJson } from "../canonical-json.js";
import { reviewRangeMatches } from "./review-ranges.js";
import { requestOriginJson } from "../request-origin.js";
import type {
  ReviewAnnotation, ReviewDocumentBinding, ReviewDocumentReference, ReviewRange,
  ReviewThreadActor, ReviewThreadEvent, ReviewThreadMutation, StandingDraftOrigin,
} from "./review-types.js";

export type ReviewRoundOwner = { kind: "briefing"; briefing_id: string }
  | { kind: "request_revision"; auth_request_id: string }
  | { kind: "standing_document"; document_key: string };
export type ReviewActor = { roundId: string; owner: ReviewRoundOwner; actorUserId: string };

export function createBriefingReviewRound(
  db: Db,
  roundId: string,
  binding: Omit<ReviewDocumentBinding, "round_id" | "id" | "position">,
): void {
  createReviewRound(db, roundId, { kind: "briefing", briefing_id: binding.document_key }, [
    { ...binding, id: roundId, round_id: roundId, position: 0 },
  ]);
}

export function createReviewRound(db: Db, roundId: string, owner: ReviewRoundOwner,
  bindings: readonly ReviewDocumentBinding[],
): void {
  db.prepare(`INSERT INTO review_rounds (id, owner_kind, briefing_round_id, auth_request_id, standing_document_key) VALUES (?, ?, ?, ?, ?)`)
    .run(roundId, owner.kind, owner.kind === "briefing" ? roundId : null,
      owner.kind === "request_revision" ? owner.auth_request_id : null,
      owner.kind === "standing_document" ? owner.document_key : null);
  const insert = db.prepare(`INSERT INTO review_document_bindings
    (id, round_id, position, document_key, source_json, comparison_target_json)
    VALUES (?, ?, ?, ?, ?, ?)`);
  for (const binding of bindings) insert.run(binding.id, roundId, binding.position, binding.document_key, canonicalJson(binding.source),
    binding.comparison_target === null ? null : canonicalJson(binding.comparison_target));
}

export function reviewDocumentBindings(db: Db, roundId: string): ReviewDocumentBinding[] {
  const rows = db.prepare(`SELECT id, round_id, position, document_key, source_json, comparison_target_json
    FROM review_document_bindings WHERE round_id = ? ORDER BY position`).all(roundId) as Array<
      Omit<ReviewDocumentBinding, "source" | "comparison_target"> & {
        source_json: string; comparison_target_json: string | null;
      }>;
  return rows.map(({ source_json, comparison_target_json, ...row }) => ({
    ...row,
    source: JSON.parse(source_json),
    comparison_target: comparison_target_json === null ? null : JSON.parse(comparison_target_json),
  }));
}

const EFFECTIVE_REVIEW_ANNOTATION = `e.operation = 'set'
  AND NOT EXISTS (SELECT 1 FROM briefing_annotation_events r WHERE r.retracts_event_id = e.id)`;

export function effectiveReviewAnnotations(db: Db, roundId: string, actorUserId: string): ReviewAnnotation[] {
  return db.prepare(
    `SELECT id AS annotation_event_id, document_binding_id, annotation_kind, start_offset, end_offset,
            quote, body, replacement_text, created_at
       FROM briefing_annotation_events e
      WHERE round_id = ? AND actor_user_id = ? AND ${EFFECTIVE_REVIEW_ANNOTATION}
      ORDER BY created_at, rowid`,
  ).all(roundId, actorUserId) as ReviewAnnotation[];
}

export function reviewRoundsWithUnsentComments(db: Db, roundIds: readonly string[], actorUserId: string): Set<string> {
  if (roundIds.length === 0) return new Set();
  const rows = db.prepare(`SELECT DISTINCT e.round_id FROM briefing_annotation_events e
    WHERE e.round_id IN (SELECT value FROM json_each(?)) AND e.actor_user_id = ?
      AND e.annotation_kind = 'comment' AND ${EFFECTIVE_REVIEW_ANNOTATION}
      AND NOT EXISTS (
        SELECT 1 FROM briefing_submission_annotations a WHERE a.annotation_event_id = e.id
          AND a.submission_id = (SELECT id FROM briefing_submissions
            WHERE round_id = e.round_id AND actor_user_id = e.actor_user_id ORDER BY ordinal DESC LIMIT 1)
      )`).all(JSON.stringify(roundIds), actorUserId) as Array<{ round_id: string }>;
  return new Set(rows.map(({ round_id }) => round_id));
}

export function reviewSubmissionAnnotations(db: Db, submissionId: string): ReviewAnnotation[] {
  return db.prepare(`SELECT e.id AS annotation_event_id, e.document_binding_id, e.annotation_kind,
    e.start_offset, e.end_offset, e.quote, e.body, e.replacement_text, e.created_at
    FROM briefing_submission_annotations a JOIN briefing_annotation_events e ON e.id = a.annotation_event_id
    WHERE a.submission_id = ? ORDER BY e.created_at, e.rowid`).all(submissionId) as ReviewAnnotation[];
}

export function reviewThreadEvents(db: Db, commentIds: readonly string[]) {
  const threads = new Map<string, ReviewThreadEvent[]>();
  if (!commentIds.length) return threads;
  const rows = db.prepare(`SELECT id, comment_id, round_id, operation, body, actor_role, actor_user_id, created_at
    FROM review_thread_events WHERE comment_id IN (SELECT value FROM json_each(?)) ORDER BY sequence`)
    .all(JSON.stringify(commentIds)) as Array<ReviewThreadEvent & { comment_id: string }>;
  for (const { comment_id, ...event } of rows) {
    const thread = threads.get(comment_id) ?? [];
    thread.push(event);
    threads.set(comment_id, thread);
  }
  return threads;
}

export function reviewThreadResolved(events: readonly ReviewThreadEvent[]): boolean {
  return events.filter(event => event.operation === "resolve" || event.operation === "reopen").at(-1)?.operation === "resolve";
}

/** Append in the caller's transaction after authorizing the actor and comment. */
export function appendReviewThreadEvent(db: Db, commentId: string, roundId: string, actor: ReviewThreadActor,
  mutation: ReviewThreadMutation, now: number,
): { ok: true; id: string } | { ok: false; reason: "thread_state_conflict" } {
  const events = reviewThreadEvents(db, [commentId]).get(commentId) ?? [];
  const resolved = reviewThreadResolved(events);
  if ((mutation.operation === "resolve" && resolved) || (mutation.operation === "reopen" && !resolved)
      || (mutation.operation === "address" && (resolved
        || events.some(event => event.operation === "address" && event.round_id === roundId)))) {
    return { ok: false, reason: "thread_state_conflict" };
  }
  const id = randomUUID();
  db.prepare(`INSERT INTO review_thread_events
    (id, comment_id, round_id, operation, body, actor_user_id, actor_role, actor_session_id, created_at, request_origin_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, commentId, roundId, mutation.operation, mutation.operation === "reply" ? mutation.body : null,
      actor.user_id, actor.role, actor.role === "requester" ? actor.session_id : null, now, requestOriginJson());
  return { ok: true, id };
}

export type ReviewAnnotationMutation =
  | { operation: "retract"; annotation_event_id: string }
  | (ReviewRange & ({ operation: "set"; kind: "comment"; body: string }
    | { operation: "set"; kind: "suggest_replacement"; body: string | null; replacement_text: string }));

export type ReviewAnnotationResult = { ok: true; id: string }
  | { ok: false; reason: "stale_annotation" | "quote_mismatch" | "annotation_noop" };

/** Append one event in the caller's write transaction, after checking owner access. */
export function appendReviewAnnotation(db: Db, actor: ReviewActor, document: { id: string; source: string; rangeKind?: "lines" },
  mutation: ReviewAnnotationMutation, now: number, draftOrigin?: StandingDraftOrigin,
): ReviewAnnotationResult {
  const id = randomUUID();
  if (mutation.operation === "retract") {
    const target = db.prepare(`SELECT id FROM briefing_annotation_events e
      WHERE id = ? AND round_id = ? AND document_binding_id = ? AND actor_user_id = ? AND operation = 'set'
      AND NOT EXISTS (SELECT 1 FROM briefing_annotation_events r WHERE r.retracts_event_id = e.id)`)
      .get(mutation.annotation_event_id, actor.roundId, document.id, actor.actorUserId);
    if (!target) return { ok: false, reason: "stale_annotation" };
    if (db.prepare("SELECT 1 FROM review_thread_events WHERE comment_id = ? LIMIT 1").get(mutation.annotation_event_id)) {
      return { ok: false, reason: "stale_annotation" };
    }
    db.prepare(`INSERT INTO briefing_annotation_events
      (request_origin_json, id, round_id, briefing_id, document_binding_id, operation, retracts_event_id, actor_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, 'retract', ?, ?, ?)`)
      .run(requestOriginJson(), id, actor.roundId, actor.owner.kind === "briefing" ? actor.owner.briefing_id : null, document.id,
        mutation.annotation_event_id, actor.actorUserId, now);
    return { ok: true, id };
  }
  const { kind, start_offset: start, end_offset: end, quote, body } = mutation;
  const replacement = kind === "suggest_replacement" ? mutation.replacement_text : null;
  if (!draftOrigin && !reviewRangeMatches(document.source, mutation, document.rangeKind ?? "text")) {
    return { ok: false, reason: "quote_mismatch" };
  }
  const origin = draftOrigin ? canonicalJson(draftOrigin) : null;
  const duplicate = db.prepare(`SELECT 1 FROM briefing_annotation_events e
    WHERE round_id = ? AND document_binding_id = ? AND actor_user_id = ? AND operation = 'set'
      AND annotation_kind = ? AND start_offset = ? AND end_offset = ? AND quote = ? AND body IS ? AND replacement_text IS ? AND standing_note_draft_origin IS ?
      AND NOT EXISTS (SELECT 1 FROM briefing_annotation_events r WHERE r.retracts_event_id = e.id) LIMIT 1`)
    .get(actor.roundId, document.id, actor.actorUserId, kind, start, end, quote, body, replacement, origin);
  if (duplicate) return { ok: false, reason: "annotation_noop" };
  db.prepare(`INSERT INTO briefing_annotation_events
    (request_origin_json, id, round_id, briefing_id, document_binding_id, operation, annotation_kind, start_offset,
     end_offset, quote, body, replacement_text, actor_user_id, created_at, standing_note_draft_origin)
    VALUES (?, ?, ?, ?, ?, 'set', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(requestOriginJson(), id, actor.roundId, actor.owner.kind === "briefing" ? actor.owner.briefing_id : null, document.id, kind, start, end,
      quote, body, replacement, actor.actorUserId, now, origin);
  return { ok: true, id };
}

export type ReviewSubmissionTarget = {
  document_binding_id: string;
  target: ReviewDocumentReference | null;
};

export function reviewSubmissionTargets(db: Db, submissionId: string): ReviewSubmissionTarget[] {
  return (db.prepare(`SELECT t.document_binding_id, t.comparison_target_json FROM review_submission_targets t
    JOIN review_document_bindings b ON t.document_binding_id = b.id AND t.round_id = b.round_id
    WHERE t.submission_id = ? ORDER BY b.position`).all(submissionId) as Array<{
      document_binding_id: string; comparison_target_json: string | null;
    }>).map(({ document_binding_id, comparison_target_json }) => ({
      document_binding_id,
      target: comparison_target_json === null ? null : JSON.parse(comparison_target_json),
    }));
}

function sameMembers(expected: readonly string[], supplied: readonly string[]): boolean {
  return expected.length === supplied.length && canonicalJson([...expected].sort()) === canonicalJson([...supplied].sort());
}

export type FrozenReviewSubmission = {
  submission_id: string;
  ordinal: number;
  supersedes_submission_id: string | null;
  actor_user_id: string;
  created_at: number;
};

export function submittedChangeEdit(db: Db, submissionId: string): ReviewChangeEdit | null {
  const edit = db.prepare(`SELECT e.* FROM review_submission_change_edits s JOIN request_review_change_edits e
      ON e.request_id = s.request_id AND e.commit_sha = s.commit_sha WHERE s.submission_id = ?`)
    .get(submissionId) as ReviewChangeEdit | undefined;
  return edit ?? null;
}

/** Freeze the actor's exact effective membership and the comparison shown for every document.
 * The owner authenticates the actor, validates answers and targets, and calls this inside its write transaction. */
export function freezeReviewSubmission(
  db: Db,
  actor: ReviewActor & { owner: Exclude<ReviewRoundOwner, { kind: "standing_document" }> },
  input: {
    annotationEventIds: readonly string[];
    answers: readonly { directive_instance_id: string; response_event_id: string }[];
    comparisonTargets: readonly ReviewSubmissionTarget[];
    supersedesSubmissionId: string | null;
    changeEdit?: ReviewChangeEdit | null;
  },
  now: number,
): { ok: true; submission: FrozenReviewSubmission } | {
  ok: false;
  reason: "stale_submission_annotations" | "submission_empty" | "stale_submission" | "submission_noop" | "invalid_submission_targets";
} {
  const { roundId, actorUserId, owner } = actor;
  const current = effectiveReviewAnnotations(db, roundId, actorUserId);
  const currentIds = current.map((event) => event.annotation_event_id);
  if (!sameMembers(currentIds, input.annotationEventIds)) return { ok: false, reason: "stale_submission_annotations" };
  if (owner.kind === "briefing" && input.answers.length === 0 && current.length === 0) {
    return { ok: false, reason: "submission_empty" };
  }
  const bindingIds = reviewDocumentBindings(db, roundId).map((binding) => binding.id);
  if (!sameMembers(bindingIds, input.comparisonTargets.map((target) => target.document_binding_id))) {
    return { ok: false, reason: "invalid_submission_targets" };
  }
  if (input.changeEdit && (owner.kind !== "request_revision" || owner.auth_request_id !== input.changeEdit.request_id)) {
    throw new Error("Change edit belongs to a different review.");
  }
  const latest = db.prepare(
    "SELECT id FROM briefing_submissions WHERE round_id = ? AND actor_user_id = ? ORDER BY ordinal DESC LIMIT 1",
  ).get(roundId, actorUserId) as { id: string } | undefined;
  if ((latest?.id ?? null) !== input.supersedesSubmissionId) return { ok: false, reason: "stale_submission" };
  if (latest) {
    const priorAnswers = db.prepare(
      "SELECT response_event_id FROM briefing_submission_answers WHERE submission_id = ?",
    ).all(latest.id) as Array<{ response_event_id: string }>;
    const priorAnnotations = db.prepare(
      "SELECT annotation_event_id FROM briefing_submission_annotations WHERE submission_id = ?",
    ).all(latest.id) as Array<{ annotation_event_id: string }>;
    const targetKeys = (targets: readonly ReviewSubmissionTarget[]) => targets.map((target) => canonicalJson(target));
    if (sameMembers(priorAnswers.map((row) => row.response_event_id), input.answers.map((answer) => answer.response_event_id))
        && sameMembers(priorAnnotations.map((row) => row.annotation_event_id), currentIds)
        && sameMembers(targetKeys(reviewSubmissionTargets(db, latest.id)), targetKeys(input.comparisonTargets))
        && (submittedChangeEdit(db, latest.id)?.commit_sha ?? null) === (input.changeEdit?.commit_sha ?? null)) {
      return { ok: false, reason: "submission_noop" };
    }
  }
  const ordinal = (db.prepare("SELECT COALESCE(MAX(ordinal), 0) + 1 AS n FROM briefing_submissions WHERE round_id = ?")
    .get(roundId) as { n: number }).n;
  const submissionId = randomUUID();
  db.prepare(`INSERT INTO briefing_submissions
    (request_origin_json, id, round_id, briefing_id, ordinal, supersedes_submission_id, actor_user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(requestOriginJson(), submissionId, roundId, owner.kind === "briefing" ? owner.briefing_id : null,
    ordinal, input.supersedesSubmissionId, actorUserId, now);
  if (input.changeEdit) db.prepare(`INSERT INTO review_submission_change_edits (submission_id, request_id, commit_sha)
    VALUES (?, ?, ?)`).run(submissionId, input.changeEdit.request_id, input.changeEdit.commit_sha);
  const addAnswer = db.prepare(`INSERT INTO briefing_submission_answers
    (submission_id, round_id, actor_user_id, directive_instance_id, response_event_id, position)
    VALUES (?, ?, ?, ?, ?, ?)`);
  input.answers.forEach((answer, position) => addAnswer.run(submissionId, roundId, actorUserId,
    answer.directive_instance_id, answer.response_event_id, position));
  const addAnnotation = db.prepare(`INSERT INTO briefing_submission_annotations
    (submission_id, round_id, document_binding_id, actor_user_id, annotation_event_id, position)
    VALUES (?, ?, ?, ?, ?, ?)`);
  current.sort((a, b) => a.annotation_event_id.localeCompare(b.annotation_event_id)).forEach((annotation, position) =>
    addAnnotation.run(submissionId, roundId, annotation.document_binding_id, actorUserId, annotation.annotation_event_id, position));
  const addTarget = db.prepare(`INSERT INTO review_submission_targets
    (submission_id, round_id, actor_user_id, document_binding_id, comparison_target_json) VALUES (?, ?, ?, ?, ?)`);
  for (const { document_binding_id, target } of input.comparisonTargets) {
    addTarget.run(submissionId, roundId, actorUserId, document_binding_id, target === null ? null : canonicalJson(target));
  }
  return { ok: true, submission: { submission_id: submissionId, ordinal, supersedes_submission_id: input.supersedesSubmissionId,
    actor_user_id: actorUserId, created_at: now } };
}
