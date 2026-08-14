export type FeedbackCollectionKind = "recurring_feed" | "bounded_ask";
export type FeedbackInteractionMode = "immediate_per_item" | "explicit_submit";
export type FeedbackItemKind = "item" | "group";
export type FeedbackIdentityMode = "publisher_dedup" | "opaque";
export type FeedbackResponseType =
  | "verdict"
  | "free_text"
  | "single_choice"
  | "multi_choice";
export type FeedbackCollectionOperation =
  | "opened"
  | "submitted"
  | "expired"
  | "cancelled"
  | "closed";
export type FeedbackItemOperation = "expired";
export type FeedbackResponseOperation = "set" | "retract";

export interface FeedbackCollectionRow {
  id: string;
  kind: FeedbackCollectionKind;
  interaction_mode: FeedbackInteractionMode;
  source: string | null;
  created_at: number;
  tombstoned_at: number | null;
}

export interface FeedbackRecurringProfileRow {
  collection_id: string;
  source_namespace: string;
  item_expiry_ms: number;
  created_at: number;
  updated_at: number;
}

export interface FeedbackAskSessionRow {
  collection_id: string;
  requester_user_id: string;
  requester_session_id: string;
  request_key: string;
  request_digest: string;
  responder_user_ids_json: string;
  expires_at: number;
  retention_expires_at: number | null;
  created_at: number;
}

export interface FeedbackPublicationRow {
  id: string;
  collection_id: string;
  publication_key: string;
  publisher_user_id: string | null;
  task_identity: string;
  run_id: string | null;
  digest_series_ref: string | null;
  digest_version: number | null;
  item_count: number;
  received_at: number;
}

export interface FeedbackItemRow {
  id: string;
  collection_id: string;
  parent_item_id: string | null;
  item_kind: FeedbackItemKind;
  identity_mode: FeedbackIdentityMode;
  external_key: string | null;
  client_item_key: string | null;
  current_revision_id: string | null;
  created_at: number;
  tombstoned_at: number | null;
}

export interface FeedbackItemRevisionRow {
  id: string;
  item_id: string;
  ordinal: number;
  title: string;
  prompt: string;
  description: string | null;
  response_type: FeedbackResponseType | null;
  required: 0 | 1;
  content_json: string;
  evidence_digest: string | null;
  publication_id: string | null;
  position: number;
  created_at: number;
}

export interface FeedbackItemOptionRow {
  revision_id: string;
  option_key: string;
  label: string;
  description: string | null;
  position: number;
}

export interface FeedbackPublicationItemRow {
  id: string;
  publication_id: string;
  item_revision_id: string;
  position: number | null;
  seen_at: number;
}

export interface FeedbackCollectionEventRow {
  id: string;
  collection_id: string;
  operation: FeedbackCollectionOperation;
  previous_event_id: string | null;
  actor_user_id: string | null;
  metadata_json: string;
  created_at: number;
}

export interface FeedbackItemEventRow {
  id: string;
  item_id: string;
  item_revision_id: string;
  operation: FeedbackItemOperation;
  actor_user_id: string | null;
  created_at: number;
}

export interface FeedbackResponseEventRow {
  id: string;
  collection_id: string;
  item_id: string;
  item_revision_id: string;
  operation: FeedbackResponseOperation;
  value_json: string | null;
  retracts_event_id: string | null;
  actor_user_id: string;
  created_at: number;
}

export interface FeedbackSubmissionRow {
  id: string;
  collection_id: string;
  ordinal: number;
  supersedes_submission_id: string | null;
  lifecycle_event_id: string;
  actor_user_id: string;
  created_at: number;
}

export interface FeedbackSubmissionAnswerRow {
  submission_id: string;
  item_id: string;
  item_revision_id: string;
  response_event_id: string;
  position: number;
}

export interface FeedbackCommentRow {
  id: string;
  collection_id: string;
  item_id: string;
  item_revision_id: string;
  body: string;
  actor_user_id: string;
  created_at: number;
}

export type FeedbackVerdictValue = { verdict: "keep" | "dismiss" };
export type FeedbackFreeTextValue = { text: string };
export type FeedbackSingleChoiceValue = { option_key: string };
export type FeedbackMultiChoiceValue = { option_keys: string[] };

export interface FeedbackResponseValueByType {
  verdict: FeedbackVerdictValue;
  free_text: FeedbackFreeTextValue;
  single_choice: FeedbackSingleChoiceValue;
  multi_choice: FeedbackMultiChoiceValue;
}

export type FeedbackTypedResponseValue = {
  [Type in FeedbackResponseType]: {
    response_type: Type;
    value: FeedbackResponseValueByType[Type];
  };
}[FeedbackResponseType];
