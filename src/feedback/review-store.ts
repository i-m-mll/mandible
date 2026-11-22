import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import { canonicalJson } from "../canonical-json.js";
import { quoteReviewLines } from "./review-ranges.js";
import { requestOriginJson } from "../request-origin.js";
import type { ReviewAnnotation, ReviewDocumentBinding, ReviewDocumentReference, ReviewRange } from "./review-types.js";

export type ReviewRoundOwner = { kind: "briefing"; briefing_id: string }
  | { kind: "request_revision"; auth_request_id: string };
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
  db.prepare(`INSERT INTO review_rounds (id, owner_kind, briefing_round_id, auth_request_id) VALUES (?, ?, ?, ?)`)
    .run(roundId, owner.kind, owner.kind === "briefing" ? roundId : null,
      owner.kind === "request_revision" ? owner.auth_request_id : null);
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

export function effectiveReviewAnnotations(db: Db, roundId: string, actorUserId: string): ReviewAnnotation[] {
  return db.prepare(
    `SELECT id AS annotation_event_id, document_binding_id, annotation_kind, start_offset, end_offset,
            quote, body, replacement_text, created_at
       FROM briefing_annotation_events e
      WHERE round_id = ? AND actor_user_id = ? AND operation = 'set'
        AND NOT EXISTS (SELECT 1 FROM briefing_annotation_events r WHERE r.retracts_event_id = e.id)
      ORDER BY created_at, rowid`,
  ).all(roundId, actorUserId) as ReviewAnnotation[];
}

export function reviewSubmissionAnnotations(db: Db, submissionId: string): ReviewAnnotation[] {
  return db.prepare(`SELECT e.id AS annotation_event_id, e.document_binding_id, e.annotation_kind,
    e.start_offset, e.end_offset, e.quote, e.body, e.replacement_text, e.created_at
    FROM briefing_submission_annotations a JOIN briefing_annotation_events e ON e.id = a.annotation_event_id
    WHERE a.submission_id = ? ORDER BY e.created_at, e.rowid`).all(submissionId) as ReviewAnnotation[];
}

export type ReviewAnnotationMutation =
  | { operation: "retract"; annotation_event_id: string }
  | (ReviewRange & ({ operation: "set"; kind: "comment"; body: string }
    | { operation: "set"; kind: "suggest_replacement"; body: string | null; replacement_text: string }));

/** Append one event in the caller's write transaction, after checking owner access. */
export function appendReviewAnnotation(db: Db, actor: ReviewActor, document: { id: string; source: string; rangeKind?: "lines" },
  mutation: ReviewAnnotationMutation, now: number,
): { ok: true; id: string } | { ok: false; reason: "stale_annotation" | "quote_mismatch" | "annotation_noop" } {
  const id = randomUUID();
  if (mutation.operation === "retract") {
    const target = db.prepare(`SELECT id FROM briefing_annotation_events e
      WHERE id = ? AND round_id = ? AND document_binding_id = ? AND actor_user_id = ? AND operation = 'set'
      AND NOT EXISTS (SELECT 1 FROM briefing_annotation_events r WHERE r.retracts_event_id = e.id)`)
      .get(mutation.annotation_event_id, actor.roundId, document.id, actor.actorUserId);
    if (!target) return { ok: false, reason: "stale_annotation" };
    db.prepare(`INSERT INTO briefing_annotation_events
      (request_origin_json, id, round_id, briefing_id, document_binding_id, operation, retracts_event_id, actor_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, 'retract', ?, ?, ?)`)
      .run(requestOriginJson(), id, actor.roundId, actor.owner.kind === "briefing" ? actor.owner.briefing_id : null, document.id,
        mutation.annotation_event_id, actor.actorUserId, now);
    return { ok: true, id };
  }
  const { kind, start_offset: start, end_offset: end, quote, body } = mutation;
  const replacement = kind === "suggest_replacement" ? mutation.replacement_text : null;
  const captured = document.rangeKind === "lines"
    ? quoteReviewLines(document.source, start, end)
    : end <= document.source.length ? document.source.slice(start, end) : undefined;
  if (start < 0 || end <= start || captured !== quote) {
    return { ok: false, reason: "quote_mismatch" };
  }
  const duplicate = db.prepare(`SELECT 1 FROM briefing_annotation_events e
    WHERE round_id = ? AND document_binding_id = ? AND actor_user_id = ? AND operation = 'set'
      AND annotation_kind = ? AND start_offset = ? AND end_offset = ? AND quote = ? AND body IS ? AND replacement_text IS ?
      AND NOT EXISTS (SELECT 1 FROM briefing_annotation_events r WHERE r.retracts_event_id = e.id) LIMIT 1`)
    .get(actor.roundId, document.id, actor.actorUserId, kind, start, end, quote, body, replacement);
  if (duplicate) return { ok: false, reason: "annotation_noop" };
  db.prepare(`INSERT INTO briefing_annotation_events
    (request_origin_json, id, round_id, briefing_id, document_binding_id, operation, annotation_kind, start_offset,
     end_offset, quote, body, replacement_text, actor_user_id, created_at)
    VALUES (?, ?, ?, ?, ?, 'set', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(requestOriginJson(), id, actor.roundId, actor.owner.kind === "briefing" ? actor.owner.briefing_id : null, document.id, kind, start, end,
      quote, body, replacement, actor.actorUserId, now);
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

/** Freeze the actor's exact effective membership and the comparison shown for every document.
 * The owner authenticates the actor, validates answers and targets, and calls this inside its write transaction. */
export function freezeReviewSubmission(
  db: Db,
  actor: ReviewActor,
  input: {
    annotationEventIds: readonly string[];
    answers: readonly { directive_instance_id: string; response_event_id: string }[];
    comparisonTargets: readonly ReviewSubmissionTarget[];
    supersedesSubmissionId: string | null;
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
        && sameMembers(targetKeys(reviewSubmissionTargets(db, latest.id)), targetKeys(input.comparisonTargets))) {
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
