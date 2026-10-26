export const LEDGER_ISSUE_STATUSES = ["open", "closed"] as const;
export type LedgerIssueStatus = (typeof LEDGER_ISSUE_STATUSES)[number];

export const LEDGER_WORKER_STATUSES = [
  "none",
  "in_progress",
  "done",
  "blocked",
  "pivot-needed",
] as const;
export type LedgerWorkerStatus = (typeof LEDGER_WORKER_STATUSES)[number];

/**
 * Worker statuses a caller may store. `in_progress` is never stored: readers
 * derive it from an open or committed work unit (see issue-work-state.ts).
 */
export const LEDGER_STORED_WORKER_STATUSES = [
  "none",
  "done",
  "blocked",
  "pivot-needed",
] as const;
export type LedgerStoredWorkerStatus = (typeof LEDGER_STORED_WORKER_STATUSES)[number];

export const LEDGER_ISSUE_BRANCH_ROLES = ["primary", "superseded"] as const;
export type LedgerIssueBranchRole = (typeof LEDGER_ISSUE_BRANCH_ROLES)[number];

export const LEDGER_ISSUE_RESOLUTIONS = [
  "delivered",
  "duplicate",
  "wontfix",
] as const;
export type LedgerIssueResolution = (typeof LEDGER_ISSUE_RESOLUTIONS)[number];

export const LEDGER_ISSUE_KINDS = [
  "bug",
  "feature",
  "maintenance",
  "experiment",
  "tracker",
  "umbrella",
  "unknown",
] as const;
export type LedgerIssueKind = (typeof LEDGER_ISSUE_KINDS)[number];

/** Kinds permitted for newly created agent-owned issues. */
export const LEDGER_CONCRETE_ISSUE_KINDS = [
  "bug",
  "feature",
  "maintenance",
  "experiment",
  "tracker",
  "umbrella",
] as const;
export type LedgerConcreteIssueKind = (typeof LEDGER_CONCRETE_ISSUE_KINDS)[number];

export const LEDGER_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type LedgerPriority = (typeof LEDGER_PRIORITIES)[number];

export const LEDGER_ACTOR_TYPES = [
  "mandible_user",
  "agent",
  "system",
  "external_adapter",
] as const;
export type LedgerActorType = (typeof LEDGER_ACTOR_TYPES)[number];

export const LEDGER_EVENT_SOURCES = [
  "mandible",
  "git_bug",
  "auth_queue",
  "session",
  "work_unit",
  "import",
  "system",
] as const;
export type LedgerEventSource = (typeof LEDGER_EVENT_SOURCES)[number];

export const LEDGER_RELATIONSHIP_TYPES = [
  "parent_child",
  "blocks",
  "duplicate_of",
  "related",
  "references",
  "fixed_by",
  "caused_by",
  "implements",
  "tests",
] as const;
export type LedgerRelationshipType = (typeof LEDGER_RELATIONSHIP_TYPES)[number];

export const LEDGER_RELATIONSHIP_PROVENANCES = [
  "manual",
  "imported",
  "derived",
  "system",
] as const;
export type LedgerRelationshipProvenance = (typeof LEDGER_RELATIONSHIP_PROVENANCES)[number];

export const LEDGER_RELATIONSHIP_ENTITY_TYPES = ["issue", "comment"] as const;
export type LedgerRelationshipEntityType = (typeof LEDGER_RELATIONSHIP_ENTITY_TYPES)[number];

export const LEDGER_BODY_REVISION_ENTITY_TYPES = ["issue_body", "issue_work_notes", "comment_body"] as const;
export type LedgerBodyRevisionEntityType = (typeof LEDGER_BODY_REVISION_ENTITY_TYPES)[number];

export const LEDGER_BODY_REVISION_REASONS = [
  "create",
  "edit",
  "import_snapshot",
  "external_update",
  "normalize",
  "migration_snapshot",
  "restore",
] as const;
export type LedgerBodyRevisionReason = (typeof LEDGER_BODY_REVISION_REASONS)[number];

export type LedgerNamespacePolicy = "remote" | "upstream" | "local";

/**
 * Resolved user principal for a ledger write (umbrella 8e2e8b2 / issue 92813cc).
 * Mirrors `AttributionContext` in `src/identity/resolver.ts` structurally so the
 * ledger layer can accept it without importing the resolver at the type level.
 * When present, the store records these values in the parallel `*_user_id`
 * columns and projects `actor_type` from the user's kind.
 */
export interface LedgerAttributionInput {
  user_id: string;
  evidence_method: string;
  evidence_id?: string | null;
  authorizer_user_id?: string | null;
}

export interface LedgerActorInput {
  actor_id?: string | null;
  actor_type?: LedgerActorType;
  author_display?: string;
  /**
   * Resolved user attribution for a durable ledger write, or `null` when the
   * write could not be attributed to any principal (issue a64d2de). Historical
   * rows may retain NULL user ids; a `null` here reproduces that pre-identity
   * legacy behavior for a genuinely unattributable write (tokenless compat-mode
   * request with no resolvable session binding). Callers must pass `null`
   * explicitly — the key is required so no write path can omit the attribution
   * decision by accident and silently fall through to NULL.
   */
  attribution: LedgerAttributionInput | null;
}

export interface LedgerProject {
  id: string;
  display_name: string;
  remote_identity: string;
  upstream_identity: string;
  namespace_policy: LedgerNamespacePolicy;
  created_at: number;
  updated_at: number;
}

export interface LedgerProjectCheckout {
  id: string;
  project_id: string;
  work_repo_id: string | null;
  root: string;
  name: string;
  default_branch: string;
  remote_url: string;
  created_at: number;
  updated_at: number;
}

export interface LedgerIssue {
  id: string;
  short_id: string;
  project_id: string;
  title: string;
  body: string;
  work_notes: string;
  status: LedgerIssueStatus;
  worker_status: LedgerWorkerStatus;
  resolution: LedgerIssueResolution | null;
  kind: LedgerIssueKind;
  priority: LedgerPriority;
  author_actor_id: string | null;
  author_actor_type: LedgerActorType;
  author_display: string;
  author_user_id: string | null;
  evidence_method: string | null;
  evidence_id: string | null;
  source: LedgerEventSource;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  deleted_at: number | null;
}

export interface LedgerIssueAlias {
  issue_id: string;
  alias_kind: string;
  project_id: string;
  alias: string;
  external_id: string;
  source: string;
  is_primary: number;
  created_at: number;
}

export interface LedgerComment {
  id: string;
  issue_id: string;
  ordinal: number;
  body: string;
  author_actor_id: string | null;
  author_actor_type: LedgerActorType;
  author_display: string;
  author_user_id: string | null;
  evidence_method: string | null;
  evidence_id: string | null;
  source: LedgerEventSource;
  created_at: number;
  updated_at: number | null;
  deleted_at: number | null;
}

export interface LedgerIssueCheckpoint {
  id: string;
  issue_id: string;
  kind: string;
  payload_json: string;
  author_actor_id: string | null;
  author_actor_type: LedgerActorType;
  author_display: string;
  author_user_id: string | null;
  evidence_method: string | null;
  evidence_id: string | null;
  source: LedgerEventSource;
  created_at: number;
}

export interface LedgerBodyRevision {
  request_origin?: import("../request-origin.js").RequestOrigin | null;
  id: string;
  entity_type: LedgerBodyRevisionEntityType;
  entity_id: string;
  issue_id: string;
  project_id: string;
  revision_no: number;
  event_id: string | null;
  actor_id: string | null;
  actor_type: LedgerActorType;
  actor_user_id: string | null;
  evidence_method: string | null;
  evidence_id: string | null;
  source: LedgerEventSource;
  reason: LedgerBodyRevisionReason;
  occurred_at: number;
  observed_at: number;
  base_revision_id: string | null;
  base_hash: string | null;
  new_hash: string;
  snapshot_body: string;
  patch_format: string | null;
  patch_text: string | null;
  metadata_json: string;
  redacted_at: number | null;
  redacted_by_actor_id: string | null;
  redacted_by_user_id: string | null;
  redaction_reason: string | null;
}

export interface LedgerLabel {
  issue_id: string;
  label: string;
  source: string;
  created_at: number;
  deleted_at: number | null;
}

export interface LedgerIssueBranch {
  issue_id: string;
  branch: string;
  role: LedgerIssueBranchRole;
  created_at: number;
  updated_at: number;
}

export interface LedgerIssueRelationship {
  id: string;
  source_issue_id: string;
  target_issue_id: string;
  relationship_type: LedgerRelationshipType;
  provenance: LedgerRelationshipProvenance;
  confidence: string;
  metadata_json: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface LedgerIssueRelationshipSource {
  id: string;
  relationship_id: string;
  source_entity_type: "issue_body" | "comment";
  source_entity_id: string;
  source_issue_id: string;
  target_issue_id: string;
  relationship_type: LedgerRelationshipType;
  ref_kind: "issue" | "comment";
  raw_ref: string;
  normalized_ref: string;
  metadata_json: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface LedgerRelationshipEdge {
  id: string;
  source_entity_type: LedgerRelationshipEntityType;
  source_entity_id: string;
  source_project_id: string;
  source_issue_id: string;
  target_entity_type: LedgerRelationshipEntityType;
  target_entity_id: string;
  target_project_id: string;
  target_issue_id: string;
  link_type: LedgerRelationshipType;
  provenance: LedgerRelationshipProvenance;
  note: string | null;
  action_id: string;
  actor_id: string | null;
  actor_type: LedgerActorType;
  actor_user_id: string | null;
  evidence_method: string | null;
  evidence_id: string | null;
  source: LedgerEventSource;
  metadata_json: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface LedgerEvent {
  id: string;
  entity_type: string;
  entity_id: string;
  event_type: string;
  actor_id: string | null;
  actor_type: LedgerActorType;
  actor_user_id: string | null;
  evidence_method: string | null;
  evidence_id: string | null;
  source: LedgerEventSource;
  payload_json: string;
  occurred_at: number;
  observed_at: number;
}

export interface LedgerIssueDetail extends LedgerIssue {
  aliases: LedgerIssueAlias[];
  comments: LedgerComment[];
  checkpoints: LedgerIssueCheckpoint[];
  labels: LedgerLabel[];
  branches: LedgerIssueBranch[];
  outgoing_relationships: LedgerIssueRelationship[];
  incoming_relationships: LedgerIssueRelationship[];
}
