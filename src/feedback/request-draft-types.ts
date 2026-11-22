export const REVIEW_EDIT_MAX_BYTES = 128 * 1024;

export type ReviewDraftConflict = "overlap" | "detached";

export type RequestReviewDraft = {
  path: string;
  generation: number;
  text: string | null;
  conflict: ReviewDraftConflict | null;
};

export type ReviewDraftStamp = Pick<RequestReviewDraft, "path" | "generation">;

export type ReviewDraftMutation =
  | { operation: "save" | "resolve"; text: string }
  | { operation: "revert" };

export type ReviewChangeEdit = {
  request_id: string;
  parent_sha: string;
  commit_sha: string;
  ref: string;
};
