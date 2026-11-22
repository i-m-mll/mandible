import { collectAuthMergeReview } from "../auth-change-report.js";
import type { AuthChangeFile, DiffFilePair } from "../contracts.js";
import type { Db } from "../db.js";
import { readGitFilePair } from "../git-change-review.js";
import type { AuthRequest } from "../types.js";
import { buildChangeEdit, carryFileText, readChangeEditFile, retainChangeEdit } from "./change-edit-git.js";
import {
  REVIEW_EDIT_MAX_BYTES, type RequestReviewDraft, type ReviewChangeEdit, type ReviewDraftMutation, type ReviewDraftStamp,
} from "./request-draft-types.js";

type TextPair = Extract<DiffFilePair, { kind: "text" }>;
type EditFile = AuthChangeFile & { new_path: string; new_object: { mode: string; oid: string } };

export function canEditRequestFiles(request: AuthRequest): boolean {
  const comparisonHead = request.merge_effective_head_sha ? request.merge_candidate_pin_sha : request.merge_head_sha;
  return request.type === "merge" && !request.space_publication_id && Boolean(request.target_repo_root &&
    comparisonHead && request.change_report?.comparison.head_sha === comparisonHead);
}

export function canEditRequestFile(file: AuthChangeFile): file is EditFile {
  return file.new_path !== null && file.new_object != null && file.file_type_after === "blob" &&
    (file.new_object.mode === "100644" || file.new_object.mode === "100755") &&
    file.old_object !== undefined && file.additions !== null && file.deletions !== null;
}

function validEditText(text: string): boolean {
  return Buffer.byteLength(text) <= REVIEW_EDIT_MAX_BYTES && !text.includes("\0") &&
    Buffer.from(text, "utf8").toString("utf8") === text;
}

export async function readEditFile(request: AuthRequest, path: string): Promise<{ file: EditFile; pair: TextPair } | null> {
  if (!canEditRequestFiles(request)) return null;
  const file = request.change_report!.files.find(file => file.new_path === path);
  if (!file || !canEditRequestFile(file)) return null;
  const pair = await readGitFilePair(request.target_repo_root!, request.change_report!.comparison, file);
  if (!pair.ok || pair.file.kind !== "text" || !validEditText(pair.file.before.contents) || !validEditText(pair.file.after.contents)) return null;
  return { file, pair: pair.file };
}

// A frozen file is displayed from the merged tree. Transfer only the operator's new change back to the effective tree.
async function projectFrozenDraft(request: AuthRequest, path: string, text: string, shown: TextPair) {
  const root = request.target_repo_root!;
  const head = request.merge_effective_head_sha!;
  let source = await readChangeEditFile(root, head, path);
  if (!source) {
    const moves = await collectAuthMergeReview(root, {
      base_sha: head, merge_base_sha: head, head_sha: request.merge_candidate_pin_sha!,
    });
    if (!moves.ok) throw new Error(moves.error.message);
    const rename = moves.value.report.files.find(file => file.change_kind === "renamed" && file.new_path === path);
    if (!rename?.old_path) return null;
    path = rename.old_path;
    source = await readChangeEditFile(root, head, path);
  }
  if (!source || !validEditText(source.text)) return null;
  return { path, object: source.object, ...await carryFileText(shown.after.contents, text, source.text) };
}

export function requestDrafts(db: Db, requestId: string, actorUserId: string): RequestReviewDraft[] {
  return db.prepare(`SELECT path, generation, text, conflict FROM request_review_drafts
    WHERE request_id = ? AND actor_user_id = ? ORDER BY path`).all(requestId, actorUserId) as RequestReviewDraft[];
}

type OwnedDraft = RequestReviewDraft & { actor_user_id: string };
export function requestOwnedDrafts(db: Db, requestId: string): OwnedDraft[] {
  return db.prepare(`SELECT actor_user_id, path, generation, text, conflict FROM request_review_drafts
    WHERE request_id = ? ORDER BY actor_user_id, path`).all(requestId) as OwnedDraft[];
}

export function requestOwnedDraftStamps(db: Db, requestId: string): Array<Pick<OwnedDraft, "actor_user_id" | "path" | "generation">> {
  return db.prepare(`SELECT actor_user_id, path, generation FROM request_review_drafts
    WHERE request_id = ? ORDER BY actor_user_id, path`).all(requestId) as Array<Pick<OwnedDraft, "actor_user_id" | "path" | "generation">>;
}

export function matchesDraftSnapshot(drafts: readonly RequestReviewDraft[], expected: readonly ReviewDraftStamp[]): boolean {
  const generations = new Map(expected.map(stamp => [stamp.path, stamp.generation]));
  return expected.length === drafts.length && generations.size === drafts.length &&
    drafts.every(draft => generations.get(draft.path) === draft.generation);
}

export function mutateRequestDraft(db: Db, requestId: string, actor: string, path: string, expected: number,
  headText: string | null, mutation: ReviewDraftMutation,
): { ok: true; draft: RequestReviewDraft } | { ok: false; reason: string } {
  const current = db.prepare(`SELECT generation, text, conflict FROM request_review_drafts
    WHERE request_id = ? AND actor_user_id = ? AND path = ?`).get(requestId, actor, path) as Omit<RequestReviewDraft, "path"> | undefined;
  if (expected !== (current?.generation ?? 0)) return { ok: false, reason: "The review draft changed." };
  if (mutation.operation === "revert") {
    if (headText === null && current?.conflict !== "detached") return { ok: false, reason: "This review file is unavailable." };
  } else {
    if (headText === null) return { ok: false, reason: "This review file cannot be edited." };
    if (!validEditText(mutation.text)) return { ok: false, reason: "Review edits must be UTF-8 text within the size limit." };
  }
  if (mutation.operation === "resolve" && current?.conflict !== "overlap") {
    return { ok: false, reason: "This review draft has no conflict to resolve." };
  }
  if (mutation.operation === "resolve" &&
      /^(?:<<<<<<< Requester|\|\|\|\|\|\|\| Previous request|>>>>>>> Review draft)\r?$/m.test(mutation.text)) {
    return { ok: false, reason: "Remove the merge conflict markers before resolving the draft." };
  }
  const conflict = mutation.operation === "save" ? current?.conflict ?? null : null;
  const text = mutation.operation === "revert" || (conflict === null && mutation.text === headText) ? null : mutation.text;
  const draft = { path, generation: expected + 1, text, conflict };
  db.prepare(`INSERT INTO request_review_drafts (request_id, actor_user_id, path, generation, text, conflict)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (request_id, actor_user_id, path) DO UPDATE SET
    generation = excluded.generation, text = excluded.text, conflict = excluded.conflict`)
    .run(requestId, actor, path, draft.generation, text, conflict);
  return { ok: true, draft };
}

/** Reuse in any action that publishes an immutable change edit. The authorizing action owns the final SQL transaction. */
export async function prepareRequestReviewChangeEdit(db: Db, request: AuthRequest, drafts: readonly RequestReviewDraft[]):
  Promise<{ ok: true; changeEdit: ReviewChangeEdit | null } | { ok: false; reason: string }> {
  try {
    const files = [];
    for (const draft of drafts) {
      if (draft.conflict) return { ok: false, reason: `Resolve the review draft conflict for ${draft.path}.` };
      if (draft.text === null) continue;
      const source = await readEditFile(request, draft.path);
      if (!source) return { ok: false, reason: `Review file is unavailable: ${draft.path}` };
      const file = request.merge_effective_head_sha
        ? await projectFrozenDraft(request, draft.path, draft.text, source.pair)
        : { path: draft.path, object: source.file.new_object, text: draft.text, conflict: null };
      if (!file || file.conflict || !validEditText(file.text)) {
        return { ok: false, reason: `Review draft for ${draft.path} overlaps the protected base or exceeds the size limit.` };
      }
      files.push({ path: file.path, object: file.object, text: file.text });
    }
    if (!files.length) return { ok: true, changeEdit: null };
    const root = request.target_repo_root!;
    const edit = await buildChangeEdit(root, request.id, request.merge_head_sha!, request.created_at, files,
      request.merge_effective_head_sha ?? undefined);
    // The preparation owns its content-addressed ref even if a race or a restart interrupts publication.
    // The same edit can resume without replacing an existing pin.
    db.prepare(`INSERT INTO request_review_change_edits (request_id, parent_sha, commit_sha, ref)
      VALUES (?, ?, ?, ?) ON CONFLICT (request_id, commit_sha) DO NOTHING`)
      .run(edit.request_id, edit.parent_sha, edit.commit_sha, edit.ref);
    await retainChangeEdit(root, edit);
    return { ok: true, changeEdit: edit };
  } catch (error) {
    return { ok: false, reason: `Unable to prepare review edits: ${error instanceof Error ? error.message : String(error)}` };
  }
}

type DraftToCarry = OwnedDraft & { base?: string | null };

async function draftsToCarry(db: Db, request: AuthRequest, drafts: readonly OwnedDraft[]): Promise<DraftToCarry[]> {
  if (!request.merge_effective_head_sha) {
    return drafts.filter(draft => draft.text !== null);
  }
  const edit = db.prepare(`SELECT change.parent_sha, change.commit_sha, s.actor_user_id, event.event_type
    FROM auth_request_lifecycle_events event
    JOIN briefing_submissions s ON s.id = event.review_submission_id
    JOIN review_submission_change_edits binding ON binding.submission_id = s.id
    JOIN request_review_change_edits change ON change.request_id = binding.request_id AND change.commit_sha = binding.commit_sha
    WHERE event.auth_request_id = ? AND (event.event_type = 'returned'
      OR (event.event_type = 'revised' AND change.commit_sha = ?))
    ORDER BY event.revision DESC LIMIT 1`).get(request.id, request.merge_effective_head_sha) as
    { parent_sha: string; commit_sha: string; actor_user_id: string; event_type: "revised" | "returned" } | undefined;
  if (!edit || edit.parent_sha !== request.merge_head_sha || !request.target_repo_root) {
    throw new Error("The predecessor's frozen change edit is unavailable.");
  }
  const root = request.target_repo_root;
  const comparison = { base_sha: edit.parent_sha, merge_base_sha: edit.parent_sha, head_sha: edit.commit_sha };
  const result = await collectAuthMergeReview(root, comparison);
  if (!result.ok) throw new Error(result.error.message);
  const carried = new Map<string, DraftToCarry>();
  const store = (draft: DraftToCarry) => carried.set(JSON.stringify([draft.actor_user_id, draft.path]), draft);
  for (const file of result.value.report.files) {
    const pair = await readGitFilePair(root, comparison, file);
    if (!file.new_path || !pair.ok || pair.file.kind !== "text" || !validEditText(pair.file.after.contents)) {
      throw new Error("Cannot read the predecessor's frozen edit.");
    }
    store({ actor_user_id: edit.actor_user_id, path: file.new_path, generation: 0, text: pair.file.after.contents,
      base: pair.file.before.contents, conflict: null });
  }
  for (const draft of drafts) {
    if (draft.text === null || (edit.event_type === "returned" && draft.actor_user_id === edit.actor_user_id)) continue;
    const source = await readEditFile(request, draft.path);
    const projected = source && await projectFrozenDraft(request, draft.path, draft.text, source.pair);
    if (!projected) {
      store({ ...draft, base: null, conflict: draft.conflict ?? "overlap" });
      continue;
    }
    const base = await readChangeEditFile(root, edit.parent_sha, projected.path);
    const fits = validEditText(projected.text);
    store({ ...draft, path: projected.path, base: base?.text ?? null,
      text: fits ? projected.text : draft.text, conflict: draft.conflict ?? projected.conflict ?? (fits ? null : "overlap") });
  }
  return [...carried.values()];
}

export async function carryRequestDrafts(db: Db, predecessor: AuthRequest, successor: AuthRequest, input: readonly OwnedDraft[]): Promise<OwnedDraft[]> {
  const drafts = await draftsToCarry(db, predecessor, input);
  const carried: OwnedDraft[] = [];
  for (const draft of drafts) {
    if (draft.text === null) continue;
    const candidates = successor.change_report?.files ?? [];
    const exact = candidates.find(file => file.new_path === draft.path);
    const renames = candidates.filter(file => file.change_kind === "renamed" && file.old_path === draft.path);
    const renamed = renames.length === 1 ? renames[0]?.new_path : null;
    const existingAtRename = renamed && drafts.some(item => item.actor_user_id === draft.actor_user_id && item.path === renamed && item.text !== null);
    const path = exact?.new_path ?? (!existingAtRename ? renamed : null);
    const next = path ? await readEditFile(successor, path) : null;
    if (!next) {
      carried.push({ ...draft, conflict: "detached" });
      continue;
    }
    if (draft.conflict) {
      carried.push({ ...draft, path: next.file.new_path, conflict: "overlap" });
      continue;
    }
    const base = draft.base === undefined ? (await readEditFile(predecessor, draft.path))?.pair.after.contents : draft.base;
    if (base == null) {
      carried.push({ ...draft, path: next.file.new_path, conflict: "overlap" });
      continue;
    }
    const result = await carryFileText(base, draft.text, next.pair.after.contents);
    if (result.conflict || result.text !== next.pair.after.contents) {
      carried.push({ ...draft, path: next.file.new_path, text: validEditText(result.text) ? result.text : draft.text,
        conflict: result.conflict ?? (validEditText(result.text) ? null : "overlap") });
    }
  }
  return carried;
}

export function insertCarriedDrafts(db: Db, requestId: string, drafts: readonly OwnedDraft[]): void {
  const insert = db.prepare(`INSERT INTO request_review_drafts (request_id, actor_user_id, path, generation, text, conflict)
    VALUES (?, ?, ?, ?, ?, ?)`);
  for (const draft of drafts) {
    insert.run(requestId, draft.actor_user_id, draft.path, draft.generation + 1, draft.text, draft.conflict);
  }
}
