import { requestNarrativeQuestions } from "./briefing-directives.js";
import { appendDirectiveAnswer, readDirectiveAnswer } from "./review-answers.js";
import { BriefingStoreError } from "./briefing-errors.js";
import { canEditRequestFile, canEditRequestFiles, requestDrafts } from "./request-drafts.js";
import type { ReviewChangeEdit } from "./request-draft-types.js";
import { storedTrackedReviewGroups, trackedReviewGroups } from "./tracked-briefing-reviews.js";
import { canonicalJson } from "../canonical-json.js";
import { authSnapshotDigest } from "../auth-request-snapshot.js";
import type { Db } from "../db.js";
import { shortRef } from "../entity-refs.js";
import { readGitFilePair } from "../git-change-review.js";
import type { AuthRequest, AuthRequestStatus } from "../types.js";
import { carryReviewLines, carryReviewRanges } from "./review-ranges.js";
import {
  createReviewRound, effectiveReviewAnnotations, reviewDocumentBindings,
  reviewSubmissionAnnotations, reviewSubmissionTargets, reviewThreadEvents, reviewThreadResolved,
  submittedChangeEdit, type ReviewRoundOwner,
} from "./review-store.js";
import type { CarriedReviewRange, RequestReviewFile, ReviewAnnotation, ReviewDocumentBinding, ReviewThreadEvent } from "./review-types.js";

type Owner = Extract<ReviewRoundOwner, { kind: "request_revision" }>;
type RequestBinding = ReviewDocumentBinding & {
  source: Extract<ReviewDocumentBinding["source"], { kind: "request_file" | "request_description" | "request_narrative" }>;
};

export type RequestReviewRound = {
  id: string;
  owner: Owner;
  bindings: RequestBinding[];
};

export function requestReviewRound(request: AuthRequest): RequestReviewRound {
  const report = request.change_report;
  const narrativeDigest = request.narrative == null ? null : authSnapshotDigest(request.narrative);
  const id = authSnapshotDigest(canonicalJson([request.id, request.title, request.command, request.spec_content,
    request.commit_message, request.merge_head_sha, report, ...(narrativeDigest ? [narrativeDigest] : [])]));
  const bindings: RequestBinding[] = [];
  const bind = (documentKey: string, source: RequestBinding["source"], target: RequestBinding["comparison_target"]) => {
    const position = bindings.length;
    bindings.push({ id: `${id}:${position}`, round_id: id, position, document_key: documentKey, source, comparison_target: target });
  };
  bind("description", { kind: "request_description", text: request.commit_message ?? "" }, null);
  report?.files.forEach((file, index) => {
    // Older captured inventories lack blob IDs. Those still render through the
    // pinned file viewer but don't identify two exact comment targets.
    if (file.old_object === undefined || file.new_object === undefined) return;
    // Older rounds retain the anchor coordinate system captured with their report.
    const format = file.additions === null || file.deletions === null ? "binary"
      : file.review_format ?? (/\.(?:md|markdown)$/i.test(file.new_path ?? file.old_path ?? "") ? "markdown" : "lines");
    const before: RequestReviewFile = { kind: "request_file", side: "before", file_index: index, path: file.old_path,
      commit: report.comparison.merge_base_sha, blob: file.old_object, format };
    const after: RequestReviewFile = { kind: "request_file", side: "after", file_index: index, path: file.new_path,
      commit: report.comparison.head_sha, blob: file.new_object, format };
    bind(`file:${index}:before`, before, after);
    bind(`file:${index}:after`, after, before);
  });
  if (narrativeDigest) bind("narrative", { kind: "request_narrative", request_id: request.id, sha256: narrativeDigest }, null);
  return { id, owner: { kind: "request_revision", auth_request_id: request.id }, bindings };
}

export function ensureRequestReviewRound(db: Db, round: RequestReviewRound): void {
  if (!db.prepare("SELECT 1 FROM review_rounds WHERE id = ?").get(round.id)) {
    createReviewRound(db, round.id, round.owner, round.bindings);
  }
}

function pinRequestReviewGroups(db: Db, request: AuthRequest, round: RequestReviewRound, capture: boolean) {
  const stored = storedTrackedReviewGroups(db, round.id);
  if (stored !== null) return stored;
  if (!capture) return [];
  const groups = trackedReviewGroups(db, request);
  if (groups.length === 0) return groups;
  return db.transaction(() => {
    ensureRequestReviewRound(db, round);
    db.prepare(`INSERT INTO briefing_request_group_snapshots (round_id, snapshot_json) VALUES (?, ?)
      ON CONFLICT(round_id) DO NOTHING`).run(round.id, JSON.stringify(groups));
    return storedTrackedReviewGroups(db, round.id)!;
  }).immediate();
}

function requestQuestions(db: Db, request: AuthRequest, round: RequestReviewRound, reviewerId: string | null) {
  const binding = round.bindings.find(({ source }) => source.kind === "request_narrative");
  if (!binding || !request.narrative) return [];
  return requestNarrativeQuestions(request.narrative).map(directive => {
    const id = `${binding.id}:${directive.key}`;
    return {
      id, directive,
      effective_response: reviewerId ? readDirectiveAnswer(db, round.id, id, reviewerId) : null,
    };
  });
}

export type NarrativeAnswerMutation =
  | { operation: "set"; expected_response_event_id: string | null; value: unknown }
  | { operation: "retract"; expected_response_event_id: string };

export function appendRequestNarrativeAnswer(db: Db, request: AuthRequest, round: RequestReviewRound,
  actorUserId: string, key: string, mutation: NarrativeAnswerMutation, now: number,
) {
  const binding = round.bindings.find(({ source }) => source.kind === "request_narrative");
  const question = requestQuestions(db, request, round, null).find(({ directive }) => directive.key === key);
  if (!binding || !question) throw new BriefingStoreError("Narrative directive not found.", 404, "directive_not_found");
  const { id, directive } = question;
  return appendDirectiveAnswer(db, { roundId: round.id, actorUserId, bindingId: binding.id },
    { id, response_type: directive.type, options_json: JSON.stringify(directive.options), variants_json: JSON.stringify(directive.variants) },
    mutation, now);
}

export function requestNarrativeAnswerMembers(db: Db, request: AuthRequest, round: RequestReviewRound,
  reviewerId: string, expected: readonly string[],
) {
  const current = requestQuestions(db, request, round, reviewerId).flatMap(({ id, effective_response }) =>
    effective_response ? [{ directive_instance_id: id, response_event_id: effective_response.response_event_id }] : []);
  const expectedIds = new Set(expected);
  if (current.length !== expected.length || current.some(answer => !expectedIds.has(answer.response_event_id))) {
    throw new BriefingStoreError("Narrative answers changed. Review them again.", 409, "stale_answer");
  }
  return current;
}

function submittedNarrativeAnswers(db: Db, submissionId: string) {
  const rows = db.prepare(`SELECT substr(e.directive_instance_id, length(e.document_binding_id) + 2) AS directive_key,
      e.id AS response_event_id, e.value_json FROM briefing_submission_answers a
      JOIN briefing_response_events e ON e.id = a.response_event_id
      WHERE a.submission_id = ? AND e.document_binding_id IS NOT NULL ORDER BY a.position`).all(submissionId) as Array<{
    directive_key: string; response_event_id: string; value_json: string;
  }>;
  return rows.map(({ value_json, ...answer }) => ({ ...answer, value: JSON.parse(value_json) as import("../contracts.js").FeedbackResponseValue }));
}

type RequestReviewNote = ReviewAnnotation & { source: RequestBinding["source"] };

type FrozenRequestReviewReturn = {
  round_id: string;
  submission_id: string;
  revision: number;
  reason: string | null;
  delivered: boolean;
  change_edit: ReviewChangeEdit | null;
  targets: ReturnType<typeof reviewSubmissionTargets>;
  answers: ReturnType<typeof submittedNarrativeAnswers>;
  tracked_groups: NonNullable<ReturnType<typeof storedTrackedReviewGroups>>;
  comments: RequestReviewNote[];
};

function requestReviewSubmissions(db: Db, requestId: string, eventType: "returned" | "revised" | "approved"): FrozenRequestReviewReturn[] {
  const returned = db.prepare(`SELECT e.review_submission_id AS submission_id, e.revision, e.reason, s.round_id,
    EXISTS(SELECT 1 FROM notifications n WHERE n.subject_kind = 'auth_request' AND n.subject_id = e.auth_request_id
      AND n.review_submission_id = e.review_submission_id AND n.delivered_at IS NOT NULL) AS delivered
    FROM auth_request_lifecycle_events e JOIN briefing_submissions s ON s.id = e.review_submission_id
    WHERE e.auth_request_id = ? AND e.event_type = ? ORDER BY e.revision DESC`).all(requestId, eventType) as
    Array<Pick<FrozenRequestReviewReturn, "submission_id" | "revision" | "reason"> & { round_id: string; delivered: number }>;
  return returned.map(({ round_id, delivered, ...receipt }) => {
    const bindings = new Map((reviewDocumentBindings(db, round_id) as RequestBinding[]).map(binding => [binding.id, binding]));
    return { ...receipt, round_id, delivered: Boolean(delivered), tracked_groups: storedTrackedReviewGroups(db, round_id) ?? [], change_edit: submittedChangeEdit(db, receipt.submission_id),
      targets: reviewSubmissionTargets(db, receipt.submission_id),
      answers: submittedNarrativeAnswers(db, receipt.submission_id),
      comments: reviewSubmissionAnnotations(db, receipt.submission_id).map(comment => ({
        ...comment, source: bindings.get(comment.document_binding_id)!.source,
      })) };
  });
}

function frozenRequestReviewReturn(db: Db, requestId: string): FrozenRequestReviewReturn | null {
  return requestReviewSubmissions(db, requestId, "returned")[0] ?? null;
}

export function returnedRequestReview(db: Db, requestId: string) {
  const receipt = frozenRequestReviewReturn(db, requestId);
  if (!receipt) return null;
  const threads = projectRequestThreads(db, receipt.comments);
  const { tracked_groups: _trackedGroups, ...publicReceipt } = receipt;
  return { ...publicReceipt, comments: receipt.comments.map(comment => ({ ...comment, thread: threads(comment) })) };
}

export type RequestReviewVersion = {
  id: string;
  short_id: string;
  status: AuthRequestStatus;
  head: string | null;
  description: string | null;
};

export function requestReviewVersions(db: Db, requestId: string): RequestReviewVersion[] {
  const rows = db.prepare(`WITH RECURSIVE
    earlier(id) AS (SELECT ? UNION SELECT r.supersedes_request_id FROM auth_requests r JOIN earlier e ON r.id = e.id
      WHERE r.supersedes_request_id IS NOT NULL),
    later(id) AS (SELECT ? UNION SELECT r.superseded_by_request_id FROM auth_requests r JOIN later l ON r.id = l.id
      WHERE r.superseded_by_request_id IS NOT NULL)
    SELECT id, status, json_extract(COALESCE(frozen_change_report_json, change_report_json), '$.comparison.head_sha') AS head,
      commit_message AS description, merge_effective_head_sha
    FROM auth_requests WHERE id IN (SELECT id FROM earlier UNION SELECT id FROM later)
    ORDER BY created_at, rowid`).all(requestId, requestId) as Array<Omit<RequestReviewVersion, "short_id"> & { merge_effective_head_sha: string | null }>;
  return rows.flatMap(({ merge_effective_head_sha, ...version }) => {
    const short_id = shortRef(db, "auth_request", version.id);
    const shown = { ...version, short_id };
    if (!merge_effective_head_sha) return [shown];
    const revisions = db.prepare(`SELECT revision, json_extract(snapshot_json,
        '$.request.frozen_change_report_json.comparison.head_sha') AS candidate,
        json_extract(snapshot_json, '$.request.change_report_json.comparison.head_sha') AS requester,
        json_extract(snapshot_json, '$.request.commit_message') AS description
      FROM auth_request_lifecycle_events WHERE auth_request_id = ? AND event_type IN ('submitted', 'revised')
      ORDER BY revision`).all(version.id) as Array<{ revision: number; candidate: string | null; requester: string | null; description: string | null }>;
    const heads = new Set([version.head]);
    const earlier = revisions.flatMap(revision => {
      const head = revision.candidate ?? revision.requester;
      if (!head || heads.has(head)) return [];
      heads.add(head);
      return [{ id: `${version.id}@${revision.revision}`, short_id, status: "superseded" as const, head,
        description: revision.description }];
    });
    return [...earlier, shown];
  });
}

type RequestThreadEvent = ReviewThreadEvent & { request_ref: string };
type RequestReviewThread = { short_id: string; resolved: boolean; events: RequestThreadEvent[] };

function projectRequestThreads(db: Db, notes: readonly ReviewAnnotation[]) {
  const threads = reviewThreadEvents(db, notes.map(note => note.annotation_event_id));
  const requestIds = new Map<string, string>();
  const requestRef = (roundId: string) => {
    const known = requestIds.get(roundId);
    if (known) return known;
    const row = db.prepare("SELECT auth_request_id FROM review_rounds WHERE id = ?").get(roundId) as { auth_request_id: string };
    const ref = shortRef(db, "auth_request", row.auth_request_id);
    requestIds.set(roundId, ref);
    return ref;
  };
  return (note: ReviewAnnotation): RequestReviewThread => {
    const events = threads.get(note.annotation_event_id) ?? [];
    return { short_id: note.annotation_event_id.slice(0, 8), resolved: reviewThreadResolved(events),
      events: events.map(event => ({ ...event, request_ref: requestRef(event.round_id) })) };
  };
}

export async function readRequestReviewSource(db: Db, root: string | null, source: RequestBinding["source"]): Promise<string | null> {
  if (source.kind === "request_description") return source.text;
  if (source.kind === "request_narrative") {
    const row = db.prepare("SELECT narrative FROM auth_requests WHERE id = ?").get(source.request_id) as { narrative: string | null } | null;
    return row?.narrative != null && authSnapshotDigest(row.narrative) === source.sha256 ? row.narrative : null;
  }
  if (!root || source.format === "binary" || !source.path || !source.blob) return null;
  const result = await readGitFilePair(root, { merge_base_sha: source.commit, head_sha: source.commit },
    { old_path: null, new_path: source.path, old_object: null, new_object: source.blob });
  return result.ok && result.file.kind === "text" ? result.file.after.contents : null;
}

export type RequestReviewComment = RequestReviewNote & {
  anchor: CarriedReviewRange;
  origin_request_id: string;
  thread: RequestReviewThread;
};

function requestReviewRoots(db: Db, request: AuthRequest, reviewerId: string | null) {
  const round = requestReviewRound(request);
  const versions = requestReviewVersions(db, request.id);
  const returned = frozenRequestReviewReturn(db, request.id);
  const bindings = new Map(round.bindings.map(binding => [binding.id, binding]));
  const active = reviewerId ? effectiveReviewAnnotations(db, round.id, reviewerId) : [];
  const approved = request.status !== "pending" ? requestReviewSubmissions(db, request.id, "approved")[0] : undefined;
  const notes = returned?.comments ?? approved?.comments ?? active.map(comment => ({
    ...comment, source: bindings.get(comment.document_binding_id)!.source,
  }));
  const currentIndex = versions.findIndex(version => version.id === request.id);
  const revised = requestReviewSubmissions(db, request.id, "revised");
  const prior = [
    ...versions.slice(0, currentIndex).filter(version => !version.id.includes("@")).flatMap(version =>
      (frozenRequestReviewReturn(db, version.id)?.comments ?? []).map(comment => ({ comment, origin: version.id }))),
    ...revised.flatMap(submission =>
      submission.comments.map(comment => ({ comment, origin: `${request.id}@${submission.revision - 1}` }))),
  ];
  return { round, versions, returned, approved, revised, notes, prior, active };
}

export function resolveRequestReviewComment(db: Db, request: AuthRequest, reviewerId: string | null, ref: string) {
  const { notes, prior } = requestReviewRoots(db, request, reviewerId);
  const matches = [...notes.map(comment => ({ comment, origin: request.id })), ...prior]
    .filter(({ comment }) => comment.annotation_kind === "comment" && comment.annotation_event_id.startsWith(ref));
  return matches.length === 1 ? matches[0] : null;
}

export async function readRequestReview(db: Db, request: AuthRequest, reviewerId: string | null) {
  const { round, versions, returned, approved, revised, notes, prior, active } = requestReviewRoots(db, request, reviewerId);
  const tracked_groups = reviewerId ? pinRequestReviewGroups(db, request, round, request.status === "pending") : [];
  const drafts = reviewerId ? requestDrafts(db, request.id, reviewerId) : [];
  const editable_files = canEditRequestFiles(request) ? request.change_report!.files.flatMap((file, index) =>
    canEditRequestFile(file) ? [{ index, path: file.new_path }] : []) : [];
  const thread = projectRequestThreads(db, [...notes, ...prior.map(({ comment }) => comment)]);
  const annotations: RequestReviewComment[] = notes.map(comment => ({
    ...comment, origin_request_id: request.id, anchor: { ...comment, status: "preserved" }, thread: thread(comment),
  }));
  const readSources = new Map<string, Promise<string | null>>();
  const read = (source: RequestBinding["source"]) => {
    const key = canonicalJson(source);
    let value = readSources.get(key);
    if (!value) {
      value = readRequestReviewSource(db, request.target_repo_root, source);
      readSources.set(key, value);
    }
    return value;
  };
  for (const { comment, origin } of prior) {
    const source = comment.source;
    const candidates = round.bindings.filter(binding => source.kind !== "request_file"
      ? binding.source.kind === source.kind
      : source.path !== null && binding.source.kind === "request_file" && binding.source.side === source.side
        && binding.source.format === source.format && (binding.source.path === source.path
          || (source.side === "after" && binding.comparison_target?.kind === "request_file"
            && binding.comparison_target.path === source.path)));
    const exact = candidates.filter(binding => binding.source.kind === "request_file" && source.kind === "request_file"
      && binding.source.path === source.path);
    const candidate = exact.length === 1 ? exact[0] : candidates.length === 1 ? candidates[0] : undefined;
    let anchor: CarriedReviewRange = { status: "detached" };
    if (candidate) {
      const [before, after] = await Promise.all([read(source), read(candidate.source)]);
      if (before !== null && after !== null) {
        anchor = source.kind === "request_file" && source.format === "lines"
          ? carryReviewLines(before, after, comment) : carryReviewRanges(before, after)(comment);
      }
    }
    annotations.push({ ...comment, origin_request_id: origin, anchor, thread: thread(comment),
      ...(candidate && anchor.status !== "detached"
        ? { document_binding_id: candidate.id, source: candidate.source } : {}) });
  }
  const questions = requestQuestions(db, request, round, request.status === "pending" ? reviewerId : null);
  const submitted = returned ?? approved;
  const tracked_group_history = reviewerId ? revised.flatMap(receipt =>
    receipt.tracked_groups.length ? [{ round_id: receipt.round_id, revision: receipt.revision, groups: receipt.tracked_groups }] : []) : [];
  const returnedReview = returned && (({ tracked_groups: _trackedGroups, ...receipt }) => receipt)(returned);
  return {
    round, versions, annotations, drafts, editable_files, tracked_groups, tracked_group_history,
    narrative: request.narrative ?? null, narrative_report: request.narrative ? request.change_report ?? null : null,
    narrative_questions: questions.map(question => ({ ...question,
      effective_response: submitted?.answers.find(answer => answer.directive_key === question.directive.key) ?? question.effective_response,
    })),
    active_answer_event_ids: questions.flatMap(question => question.effective_response ? [question.effective_response.response_event_id] : []),
    active_annotation_event_ids: active.map(note => note.annotation_event_id),
    frozen_head: request.merge_effective_head_sha ?? null, comparison_head: request.change_report?.comparison.head_sha ?? null,
    returned: returnedReview && { ...returnedReview, comments: returnedReview.comments.map(comment => ({ ...comment, thread: thread(comment) })) },
  };
}

export type RequestReview = Awaited<ReturnType<typeof readRequestReview>>;
