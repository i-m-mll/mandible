export type ArtifactReviewDocument = { kind: "artifact_version"; artifact_version_id: string };

export type GitReviewDocument = {
  kind: "git_file";
  project_id: string;
  commit: string;
  path: string;
  blob: { oid: string; mode: "100644" | "100755" } | null;
};

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

export type ReviewDocumentReference = ArtifactReviewDocument | GitReviewDocument | RequestReviewDescription | RequestReviewFile;

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
