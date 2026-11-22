export type ArtifactReviewDocument = { kind: "artifact_version"; artifact_version_id: string };

export type GitReviewDocument = {
  kind: "git_file";
  project_id: string;
  commit: string;
  path: string;
  blob: { oid: string; mode: "100644" | "100755" } | null;
};

export type ReviewDocumentReference = ArtifactReviewDocument | GitReviewDocument;

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
