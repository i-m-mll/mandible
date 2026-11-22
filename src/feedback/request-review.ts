import { canonicalJson } from "../canonical-json.js";
import { authSnapshotDigest } from "../auth-request-snapshot.js";
import type { Db } from "../db.js";
import { shortRef } from "../entity-refs.js";
import { readGitFilePair } from "../git-change-review.js";
import type { AuthRequest, AuthRequestStatus } from "../types.js";
import { carryReviewLines, carryReviewRanges } from "./review-ranges.js";
import {
  createReviewRound, effectiveReviewAnnotations, reviewDocumentBindings,
  reviewSubmissionAnnotations, reviewSubmissionTargets, reviewThreadEvents, reviewThreadResolved, type ReviewRoundOwner,
} from "./review-store.js";
import type { CarriedReviewRange, RequestReviewFile, ReviewAnnotation, ReviewDocumentBinding, ReviewThreadEvent } from "./review-types.js";

type Owner = Extract<ReviewRoundOwner, { kind: "request_revision" }>;
type RequestBinding = ReviewDocumentBinding & {
  source: Extract<ReviewDocumentBinding["source"], { kind: "request_file" | "request_description" }>;
};

export type RequestReviewRound = {
  id: string;
  owner: Owner;
  bindings: RequestBinding[];
};

export function requestReviewRound(request: AuthRequest): RequestReviewRound {
  const report = request.change_report;
  const id = authSnapshotDigest(canonicalJson([request.id, request.title, request.command, request.spec_content,
    request.commit_message, request.merge_head_sha, report]));
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
    const format = file.additions === null || file.deletions === null ? "binary"
      : /\.(?:md|markdown)$/i.test(file.new_path ?? file.old_path ?? "") ? "markdown" : "lines";
    const before: RequestReviewFile = { kind: "request_file", side: "before", file_index: index, path: file.old_path,
      commit: report.comparison.merge_base_sha, blob: file.old_object, format };
    const after: RequestReviewFile = { kind: "request_file", side: "after", file_index: index, path: file.new_path,
      commit: report.comparison.head_sha, blob: file.new_object, format };
    bind(`file:${index}:before`, before, after);
    bind(`file:${index}:after`, after, before);
  });
  return { id, owner: { kind: "request_revision", auth_request_id: request.id }, bindings };
}

export function ensureRequestReviewRound(db: Db, round: RequestReviewRound): void {
  if (!db.prepare("SELECT 1 FROM review_rounds WHERE id = ?").get(round.id)) {
    createReviewRound(db, round.id, round.owner, round.bindings);
  }
}

type RequestReviewNote = ReviewAnnotation & { source: RequestBinding["source"] };

type FrozenRequestReviewReturn = {
  submission_id: string;
  revision: number;
  reason: string | null;
  delivered: boolean;
  targets: ReturnType<typeof reviewSubmissionTargets>;
  comments: RequestReviewNote[];
};

function frozenRequestReviewReturn(db: Db, requestId: string): FrozenRequestReviewReturn | null {
  const returned = db.prepare(`SELECT e.review_submission_id AS submission_id, e.revision, e.reason, s.round_id,
    EXISTS(SELECT 1 FROM notifications n WHERE n.subject_kind = 'auth_request' AND n.subject_id = e.auth_request_id
      AND n.review_submission_id = e.review_submission_id AND n.delivered_at IS NOT NULL) AS delivered
    FROM auth_request_lifecycle_events e JOIN briefing_submissions s ON s.id = e.review_submission_id
    WHERE e.auth_request_id = ? AND e.event_type = 'returned' ORDER BY e.revision DESC LIMIT 1`).get(requestId) as
    (Pick<FrozenRequestReviewReturn, "submission_id" | "revision" | "reason"> & { round_id: string; delivered: number }) | undefined;
  if (!returned) return null;
  const { round_id, delivered, ...receipt } = returned;
  const bindings = new Map((reviewDocumentBindings(db, round_id) as RequestBinding[]).map(binding => [binding.id, binding]));
  return { ...receipt, delivered: Boolean(delivered), targets: reviewSubmissionTargets(db, receipt.submission_id),
    comments: reviewSubmissionAnnotations(db, receipt.submission_id).map(comment => ({
      ...comment, source: bindings.get(comment.document_binding_id)!.source,
    })) };
}

export function returnedRequestReview(db: Db, requestId: string) {
  const receipt = frozenRequestReviewReturn(db, requestId);
  if (!receipt) return null;
  const threads = projectRequestThreads(db, receipt.comments);
  return { ...receipt, comments: receipt.comments.map(comment => ({ ...comment, thread: threads(comment) })) };
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
    SELECT id, status, json_extract(change_report_json, '$.comparison.head_sha') AS head, commit_message AS description
    FROM auth_requests WHERE id IN (SELECT id FROM earlier UNION SELECT id FROM later)
    ORDER BY created_at, rowid`).all(requestId, requestId) as Array<Omit<RequestReviewVersion, "short_id">>;
  return rows.map(version => ({ ...version, short_id: shortRef(db, "auth_request", version.id) }));
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

export async function readRequestReviewSource(root: string | null, source: RequestBinding["source"]): Promise<string | null> {
  if (source.kind === "request_description") return source.text;
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
  const notes = returned?.comments ?? (reviewerId ? effectiveReviewAnnotations(db, round.id, reviewerId)
    .map(comment => ({ ...comment, source: bindings.get(comment.document_binding_id)!.source })) : []);
  const currentIndex = versions.findIndex(version => version.id === request.id);
  const prior = versions.slice(0, currentIndex).flatMap(version =>
    (frozenRequestReviewReturn(db, version.id)?.comments ?? []).map(comment => ({ comment, origin: version.id })));
  return { round, versions, returned, notes, prior };
}

export function resolveRequestReviewComment(db: Db, request: AuthRequest, reviewerId: string | null, ref: string) {
  const { notes, prior } = requestReviewRoots(db, request, reviewerId);
  const matches = [...notes.map(comment => ({ comment, origin: request.id })), ...prior]
    .filter(({ comment }) => comment.annotation_kind === "comment" && comment.annotation_event_id.startsWith(ref));
  return matches.length === 1 ? matches[0] : null;
}

export async function readRequestReview(db: Db, request: AuthRequest, reviewerId: string | null) {
  const { round, versions, returned, notes, prior } = requestReviewRoots(db, request, reviewerId);
  const thread = projectRequestThreads(db, [...notes, ...prior.map(({ comment }) => comment)]);
  const annotations: RequestReviewComment[] = notes.map(comment => ({
    ...comment, origin_request_id: request.id, anchor: { ...comment, status: "preserved" }, thread: thread(comment),
  }));
  const readSources = new Map<string, Promise<string | null>>();
  const read = (source: RequestBinding["source"]) => {
    const key = canonicalJson(source);
    let value = readSources.get(key);
    if (!value) {
      value = readRequestReviewSource(request.target_repo_root, source);
      readSources.set(key, value);
    }
    return value;
  };
  for (const { comment, origin } of prior) {
    const source = comment.source;
    const candidates = round.bindings.filter(binding => source.kind === "request_description"
      ? binding.source.kind === "request_description"
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
  return { round, versions, annotations, returned: returned && { ...returned,
    comments: returned.comments.map(comment => ({ ...comment, thread: thread(comment) })) } };
}

export type RequestReview = Awaited<ReturnType<typeof readRequestReview>>;
