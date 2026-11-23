export type ArtifactReviewDocument = { kind: "artifact_version"; artifact_version_id: string; range_kind?: ReviewRangeKind };

export type GitReviewDocument = {
  kind: "git_file";
  project_id: string;
  commit: string;
  path: string;
  blob: { oid: string; mode: "100644" | "100755" } | null;
};

export type RequestReviewNarrative = { kind: "request_narrative"; request_id: string; sha256: string };

export type RequestReviewDescription = { kind: "request_description"; text: string };

export type RequestReviewFile = {
  kind: "request_file";
  side: "before" | "after";
  file_index: number;
  path: string | null;
  commit: string;
  blob: { oid: string; mode: string } | null;
  format: "markdown" | "lines" | "binary";
};

export type SpaceReviewDocument = { kind: "space_saved_source"; history_id: string; generation: number };

export type ReviewDocumentReference = ArtifactReviewDocument | GitReviewDocument | RequestReviewDescription
  | RequestReviewNarrative | RequestReviewFile | SpaceReviewDocument;

export type ReviewDocumentBinding = {
  id: string;
  round_id: string;
  position: number;
  document_key: string;
  source: ReviewDocumentReference;
  comparison_target: ReviewDocumentReference | null;
};

export type ReviewRange = {
  start_offset: number;
  end_offset: number;
  quote: string;
};

export type CarriedReviewRange =
  | ({ status: "preserved" | "moved" } & ReviewRange)
  | { status: "detached" };

export type ReviewAnnotation = ReviewRange & {
  annotation_event_id: string;
  document_binding_id: string;
  annotation_kind: "comment" | "suggest_replacement";
  body: string | null;
  replacement_text: string | null;
  created_at: number;
};

export type ReviewThreadMutation = { operation: "reply"; body: string }
  | { operation: "address" | "resolve" | "reopen" };

export type ReviewThreadActor =
  | { role: "operator"; user_id: string }
  | { role: "requester"; user_id: string; session_id: string };

export type ReviewThreadEvent = ReviewThreadMutation & {
  id: string;
  round_id: string;
  actor_role: ReviewThreadActor["role"];
  actor_user_id: string;
  created_at: number;
};

export type ReviewRangeKind = "text" | "lines";

export type StandingDraftOrigin = {
  base_version_id: string;
  source_hash: string;
  range_kind?: ReviewRangeKind;

};

export type StandingSourceReference = (
  | ArtifactReviewDocument
  | SpaceReviewDocument
);

export type StandingNote = ReviewRange & {
  id: string;
  source_reference: StandingSourceReference;
  source_order: number;
  range_kind: ReviewRangeKind;
  body: string;
  author: string;
  created_at: number;
  resolved: boolean;
  can_edit: boolean;
  draft_origin: StandingDraftOrigin | null;
  anchor: CarriedReviewRange;
};

export type ArtifactDraftStandingNote = ReviewRange & {
  id: string;
  actor_user_id: string;
  author: string;
  body: string;
  created_at: number;
  resolved: boolean;
  range_kind: ReviewRangeKind;
  origin: StandingDraftOrigin;
  anchor: CarriedReviewRange;
};

export type StandingNotePresentation = Pick<StandingNote, "id" | "quote" | "anchor" | "author" | "body" | "resolved" | "can_edit">
  & Partial<Pick<StandingNote, "created_at">>;
