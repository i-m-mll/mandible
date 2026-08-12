// Shared API/UI contracts. Keep this module dependency-light so daemon and
// browser UI code can import its types without dragging in runtime services.

export type ApiListEnvelope<T> = {
  items: T[];
  total?: number;
  offset?: number;
  limit?: number;
};

export type LegacyListEnvelope<T> = Partial<ApiListEnvelope<T>> & {
  sessions?: T[];
  queue?: T[];
  requests?: T[];
  repos?: T[];
  branches?: T[];
  work_units?: T[];
  hooks?: T[];
  artifacts?: T[];
  conversations?: T[];
  templates?: T[];
  presets?: T[];
  nodes?: T[];
  diffs?: T[];
};

export type ApiList<T> = T[] | ApiListEnvelope<T> | LegacyListEnvelope<T>;

export type MandibleEventType =
  | "auth:new"
  | "auth:updated"
  | "auth:output"
  | "auth:merged"
  | "auth:resolved"
  | "auth:finalized"
  | "auth:completed"
  | "auth:deleted"
  | "auth:needs_rebase"
  | "channel:session:connected"
  | "channel:session:disconnected"
  | "console:inbox:badge"
  | "console:permission:cleared"
  | "console:permission:request"
  | "console:session:created"
  | "console:session:updated"
  | "console:session:started"
  | "console:session:stopped"
  | "console:session:ended"
  | "console:session:exit"
  | "console:session:deleted"
  | "console:stream_event"
  | "console:subagent:start"
  | "console:subagent:stop"
  | "conversation:new"
  | "conversation:updated"
  | "daemon:reloaded"
  | "heartbeat"
  | "mandible:rebuilding"
  | "preset:created"
  | "preset:updated"
  | "preset:deleted"
  | "preset:diff:created"
  | "preset:diff:resolved"
  | "preset:violation"
  | "push:auth:pending"
  | "push:auth:complete"
  | "push:started"
  | "push:error"
  | "push:repo:progress"
  | "push:repo:complete"
  | "push:complete"
  | "reaper:tick"
  | "session:registered"
  | "session:updated"
  | "session:ended"
  | "session:child:added"
  | "session:child:ended"
  | "session:discovery:completed"
  | "session:metadata-warning"
  | "webhook:received"
  | "webhook:delivered"
  | "webhook:dismissed"
  | "work:branch:updated"
  | "work:scan:started"
  | "work:scan:completed"
  | (string & {});

export type MandibleEvent<TData = unknown> = {
  type: MandibleEventType;
  event?: MandibleEventType;
  data?: TData;
  timestamp?: string;
} & Record<string, unknown>;

export type SseEvent<TData = unknown> = {
  event: MandibleEventType;
  type?: MandibleEventType;
  data: TData;
};

export type AuthRequestStatus =
  | "pending"
  | "executing"
  | "approved"
  | "needs_rebase"
  | "rejected"
  | "expired"
  | "completed"
  | "dismissed";

export type AuthRequestOutcome =
  | "succeeded"
  | "failed"
  | "needs_rebase"
  | "rejected"
  | "dismissed"
  | "expired"
  | null;

export type AuthExecutionMode = "daemon" | "remote";
export type AuthRequestType =
  | "merge"
  | "commit"
  | "force-push"
  | "branch-delete"
  | "config-change"
  | "preset-promote"
  | "data-delete";
export type AuthRequestActionKind =
  | "comment_add"
  | "issue_close"
  | "worker_status_set"
  | "label_add"
  | "label_rm"
  | "checkpoint_add"
  | "link_add";
export type AuthRequestActionState = "staged" | "applied" | "failed" | "skipped_stale" | "vetoed";

export type AuthRequestActionInput = {
  kind: AuthRequestActionKind;
  target_issue_ref: string;
  payload: Record<string, unknown>;
};

export type AuthRequestAction = AuthRequestActionInput & {
  id: string;
  auth_request_id: string;
  ordinal: number;
  state: AuthRequestActionState;
  target_digest: string | null;
  staged_at: number;
  updated_at: number;
  applied_at: number | null;
  outcome_detail: string | null;
};

export type AuthRequest = {
  id: string;
  session_id: string | null;
  type: AuthRequestType;
  command: string;
  title: string;
  cwd: string | null;
  diff_summary: string | null;
  commit_message: string | null;
  spec_content: string | null;
  repo?: string;
  base_branch?: string;
  head_branch?: string;
  merge_head_sha?: string | null;
  merge_preflight_base_sha?: string | null;
  merge_preflight_queue_fingerprint?: string | null;
  merge_finalized_at?: number | null;
  files_changed?: number;
  additions?: number;
  deletions?: number;
  post_merge_handoff?: string | null;
  issue_references?: string[] | null;
  issue_closures?: string[] | null;
  issue_ids?: string[] | null;
  issues?: string[] | null;
  depends_on_id?: string | null;
  execution_mode: AuthExecutionMode;
  status: AuthRequestStatus;
  created_at: number;
  updated_at: number;
  last_executed_at: number | null;
  approved_at: number | null;
  resolved_at: number | null;
  skipped_at: number | null;
  expires_at: number;
  exit_code: number | null;
  output: string;
  error: string | null;
  acknowledged_by: string | null;
  target_session_id: string | null;
  target_repo_root: string | null;
  delivered_at: number | null;
  conversation_id: string | null;
  approval_source: "manual" | "auto_lease" | string;
  approval_lease_id: string | null;
};

export type AuthOutputChunk = {
  request_id: string;
  stream: "stdout" | "stderr";
  text: string;
  timestamp: number;
};

export type WorkUnitKind = "solo" | "partition" | "integration";
export type WorkUnitState = "open" | "committed" | "resolved" | "abandoned";

export type WorkUnit = {
  id: string;
  issue_id: string;
  ledger_issue_id: string | null;
  repo_id: string;
  branch: string | null;
  parent_branch: string | null;
  kind: WorkUnitKind;
  state: WorkUnitState;
  assigned_session_id: string | null;
  provider: string | null;
  provider_session_id: string | null;
  continuation: string | null;
  continuation_by: string | null;
  continuation_at: number | null;
  created_at: number;
  activated_at: number | null;
  last_commit_at: number | null;
  resolved_at: number | null;
  auth_request_id: string | null;
};

export type WorkUnitLiveness = {
  has_live_agent: boolean;
  agent_session_id: string | null;
  agent_status: string | null;
  is_processing: boolean;
  last_activity: number | null;
};

export type WorkUnitWithLiveness = WorkUnit & {
  liveness: WorkUnitLiveness;
};

export type ConversationSource = "claude_code" | "codex" | "gemini";
export type ConversationAttachKind = "live-owned" | "live-external" | "resumable" | "historical";
export type ConversationAttachReason =
  | "mandible-owned"
  | "transcript-recent"
  | "channel-fresh"
  | "session-active"
  | "provider-resumable"
  | "subagent"
  | "no-session"
  | "unsupported-provider";

export type ConversationAttachState = {
  kind: ConversationAttachKind;
  reason: ConversationAttachReason;
  resumable: boolean;
  can_fork: boolean;
  provider_session_id: string | null;
  console_session_id?: string | null;
  external_session_id?: string | null;
  source_mtime?: number | null;
  checked_at: number;
};
export type BlockType =
  | "user_message"
  | "assistant_message"
  | "thinking"
  | "tool_use"
  | "tool_result"
  | "system"
  | "event";
export type Role = "user" | "assistant" | "system" | "tool";

export type StoredConversationBlock = {
  id: string;
  conversation_id: string;
  type: BlockType;
  role: Role;
  content: string;
  position: number;
  timestamp: string;
  parent_id: string | null;
  metadata_json: string;
  dag_uuid?: string | null;
  dag_parent_uuid?: string | null;
};

export type Conversation = {
  id: string;
  source: ConversationSource;
  source_path: string;
  title: string;
  summary: string | null;
  started_at: string;
  ended_at: string | null;
  block_count: number;
  session_id: string;
  project_path: string | null;
  cwd: string | null;
  branch: string | null;
  model: string | null;
  cli_version: string | null;
  is_sidechain: boolean;
  agent_id: string | null;
  starred: boolean;
  label: string | null;
  notes: string | null;
  parent_conversation_id: string | null;
  children_count: number;
  attach_state: ConversationAttachState;
};

export type ConversationChild = {
  id: string;
  title: string;
  block_count: number;
  started_at: string;
  ended_at: string | null;
  source: string;
  model: string | null;
  agent_id: string | null;
  is_sidechain: boolean;
  status: "active" | "finished";
  duration_seconds: number | null;
};

export type ConversationParent = {
  id: string;
  title: string;
};

export type WorkflowRunStatus = "pending" | "running" | "completed" | "failed" | "warning";
export type WorkflowWorkerStatus = "pending" | "running" | "completed" | "failed" | "warning";

export type WorkflowWarning = {
  code: string;
  message: string;
  path?: string;
};

export type WorkflowPhase = {
  id: string;
  workflow_id: string;
  phase_index: number;
  title: string;
  status: WorkflowRunStatus;
  worker_count: number;
  completed_count: number;
};

export type WorkflowWorker = {
  id: string;
  workflow_id: string;
  phase_id: string | null;
  worker_index: number;
  agent_id: string | null;
  label: string;
  status: WorkflowWorkerStatus;
  model: string | null;
  queued_at: number | null;
  started_at: number | null;
  last_progress_at: number | null;
  completed_at: number | null;
  duration_ms: number | null;
  tokens: number | null;
  tool_calls: number | null;
  last_tool_name: string | null;
  last_tool_summary: string | null;
  prompt_preview: string | null;
  result_preview: string | null;
  transcript_path: string | null;
  conversation_id: string | null;
  warnings: WorkflowWarning[];
};

export type WorkflowRun = {
  id: string;
  provider: "claude_code";
  provider_run_id: string;
  session_id: string;
  project_path: string | null;
  summary_path: string;
  script_path: string | null;
  workflow_name: string;
  status: WorkflowRunStatus;
  started_at: number | null;
  updated_at: number | null;
  completed_at: number | null;
  duration_ms: number | null;
  total_tokens: number | null;
  total_tool_calls: number | null;
  agent_count: number;
  completed_workers: number;
  total_workers: number;
  format_version: string;
  warnings: WorkflowWarning[];
  phases: WorkflowPhase[];
  workers: WorkflowWorker[];
};

export type WorkflowListResponse = { workflows: WorkflowRun[] };
export type WorkflowResponse = { workflow: WorkflowRun };

export type ArtifactAliasResolutionStatus = "resolved" | "unresolved" | "ambiguous" | "unsupported";

export type ArtifactAliasRecord = {
  id: string;
  artifact_id: string | null;
  scheme: string;
  alias: string;
  normalized_ref: string;
  locator: Record<string, unknown>;
  resolution_status: ArtifactAliasResolutionStatus;
  source: string;
  created_at: number;
  updated_at: number;
};

export type ArtifactLinkRecord = {
  id: string;
  artifact_id: string;
  entity_type: string;
  entity_id: string;
  link_type: string;
  role: string | null;
  repo_id: string | null;
  provider_id: string | null;
  source: string;
  metadata: Record<string, unknown>;
  // Typed-link columns (migration v89, issue 10960ea). Canonical name is
  // `link_kind` (not `link_mode`). `pinned` (default) names one immutable
  // artifact version; `living` tracks a series head via `series_id`/`series_ref`
  // (both null for pinned links).
  link_kind: "pinned" | "living";
  series_id: string | null;
  series_ref: string | null;
  created_at: number;
  updated_at: number;
};

export type ArtifactRecord = {
  id: string;
  algorithm: string;
  content_hash: string;
  uri: string;
  media_type: string | null;
  role: string | null;
  size_bytes: number;
  provider_id: string | null;
  manifest_id: string | null;
  metadata: Record<string, unknown>;
  pinned: boolean;
  custody_mode: "link" | "copy" | "managed" | "external";
  home_repo_id: string | null;
  repo_locator: Record<string, unknown>;
  availability: "present" | "missing" | "stale" | "unchecked" | "remote_only" | "pinned";
  retention: Record<string, unknown>;
  reference: Record<string, unknown>;
  created_at: number;
  alias_schemes?: string[];
  aliases?: ArtifactAliasRecord[];
  links?: ArtifactLinkRecord[];
};

export type ArtifactIdentitySourceKind =
  | "tracked_repo"
  | "local_only"
  | "managed"
  | "external"
  | "mixed";

export type ArtifactBlobRecord = {
  id: string;
  algorithm: string;
  content_hash: string;
  storage_uri: string | null;
  media_type: string | null;
  role: string | null;
  size_bytes: number;
  provider_id: string | null;
  manifest_id: string | null;
  metadata: Record<string, unknown>;
  custody_mode: "link" | "copy" | "managed" | "external";
  availability: "present" | "missing" | "stale" | "unchecked" | "remote_only" | "pinned";
  retention: Record<string, unknown>;
  reference: Record<string, unknown>;
  created_at: number;
};

export type ArtifactIdentityRecord = {
  id: string;
  identity_key: string;
  source_kind: ArtifactIdentitySourceKind;
  title: string | null;
  source_project_id: string | null;
  source_repo_id: string | null;
  logical_name: string | null;
  source_path: string | null;
  latest_version_id: string | null;
  version_count: number;
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
};

export type CanonicalArtifactVersionRecord = {
  id: string;
  artifact_id: string;
  version_no: number;
  blob_id: string;
  source_kind: Exclude<ArtifactIdentitySourceKind, "mixed">;
  content_hash: string;
  source_project_id: string | null;
  source_repo_id: string | null;
  repo_path: string | null;
  commit_sha: string | null;
  observed_path: string | null;
  source_locator: Record<string, unknown>;
  custody_mode: "link" | "copy" | "managed" | "external" | null;
  label: string | null;
  note: string | null;
  metadata: Record<string, unknown>;
  created_at: number;
};

export type Artifact = ArtifactIdentityRecord;
export type ArtifactVersion = CanonicalArtifactVersionRecord;

export type ProjectArtifactAssociationRecord = {
  id: string;
  project_id: string;
  target_type: "artifact" | "artifact_version";
  target_id: string;
  association_kind: "associated" | "canonical";
  role: string;
  title: string | null;
  description: string | null;
  rank: number | null;
  status: "active" | "superseded" | "archived";
  source: "user" | "agent_explicit" | "space_rule" | "migration" | "system";
  source_ref_type: string | null;
  source_ref_id: string | null;
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
};

export type ProjectArtifactAssociation = ProjectArtifactAssociationRecord;

export type ArtifactVersionSourceKind = "tracked_repo" | "local_only" | "managed";
export type ArtifactSeriesSourceKind = ArtifactVersionSourceKind | "mixed";

export type ArtifactSeriesRecord = {
  id: string;
  series_key: string;
  source_kind: ArtifactSeriesSourceKind;
  title: string | null;
  repo_id: string | null;
  logical_name: string | null;
  latest_version_id: string | null;
  version_count: number;
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
};

export type ArtifactVersionRecord = {
  id: string;
  series_id: string;
  artifact_id: string;
  version_no: number;
  parent_version_id: string | null;
  source_kind: ArtifactVersionSourceKind;
  content_hash: string;
  commit_sha: string | null;
  repo_path: string | null;
  observed_path: string | null;
  custody_mode: string | null;
  label: string | null;
  note: string | null;
  metadata: Record<string, unknown>;
  created_at: number;
};

export type ArtifactResolveResult = {
  status: ArtifactAliasResolutionStatus;
  ref: string;
  scheme: string;
  normalized_ref: string;
  target_type?: "artifact" | "artifact_version" | "artifact_blob" | "legacy_artifact";
  target_id?: string | null;
  artifact: ArtifactRecord | null;
  alias: ArtifactAliasRecord | null;
  logical_artifact?: ArtifactIdentityRecord | null;
  artifact_version?: CanonicalArtifactVersionRecord | null;
  artifact_blob?: ArtifactBlobRecord | null;
  series?: ArtifactSeriesRecord | null;
  version?: ArtifactVersionRecord | null;
  warnings?: string[];
};

export type ArtifactSeriesSummary = {
  id: string;
  ref: string;
  series_key: string;
  source_kind: ArtifactSeriesSourceKind;
  title: string | null;
  repo_id: string | null;
  logical_name: string | null;
  latest_version_id: string | null;
  version_count: number;
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
  latest_version: ArtifactVersionRecord | null;
  latest_artifact: ArtifactRecord | null;
  links: ArtifactLinkRecord[];
};

export type ArtifactDraftRecord = {
  id: string;
  series_id: string;
  base_version_id: string;
  base_version_no: number;
  latest_version_id: string | null;
  latest_version_no: number | null;
  stale: boolean;
  content: string;
  media_type: string | null;
  label: string | null;
  note: string | null;
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
};

export type ArtifactVersionRecordResult = {
  series: ArtifactSeriesRecord;
  version: ArtifactVersionRecord;
  artifact: ArtifactRecord;
  created: boolean;
  warnings: string[];
};

export type ArtifactDraftPublishResult = {
  draft: ArtifactDraftRecord;
  result: ArtifactVersionRecordResult;
};

// ---------------------------------------------------------------------------
// Spaces (umbrella de56ffa) — shared records, request/response envelopes, and
// the seed/block/export contract surface.
//
// These types mirror the FROZEN C2 route shapes (`src/routes/spaces.ts` over
// `src/ledger/spaces.ts`). They are declared structurally here, in the
// dependency-light shared module, so daemon route code and browser UI code can
// import one contract without pulling the ledger storage layer into the bundle.
//
// The backend record types in `src/ledger/spaces.ts` are the source of truth;
// the record shapes below are kept structurally identical to them and are
// compile-checked against that module by the contract tests. The `SpaceBlock`
// (C11) and `SpaceExport` (C13a) records mirror the planned `space_blocks` /
// `space_exports` schemas (docs/spaces UMBRELLA-PLAN §3.5 and
// DOCUMENT-CUSTODY-DESIGN §2.1); those routes are added by later children and
// MUST consume these types rather than re-declaring them.
// ---------------------------------------------------------------------------

/** Space-level renderer. `document` is only valid at the Space level (occurrences use the narrower {@link SpaceOccurrenceRenderer}). */
export type SpaceRenderer = 'canvas' | 'document' | 'board' | 'collection';
/** Occurrence-level renderer. `document` is intentionally excluded — document structure lives in {@link SpaceBlock}, not occurrences. */
export type SpaceOccurrenceRenderer = 'canvas' | 'board' | 'collection';
export type SpaceItemRefType = 'issue' | 'comment' | 'artifact' | 'external_ref' | 'space' | 'finding';

export const SPACE_RENDERERS: readonly SpaceRenderer[] = ['canvas', 'document', 'board', 'collection'];
export const SPACE_OCCURRENCE_RENDERERS: readonly SpaceOccurrenceRenderer[] = ['canvas', 'board', 'collection'];
export const SPACE_ITEM_REF_TYPES: readonly SpaceItemRefType[] = ['issue', 'comment', 'artifact', 'external_ref', 'space', 'finding'];

export type Space = {
  id: string;
  /** Owning project, or `null` for a top-level / global Space (issue 812df41). */
  project_id: string | null;
  title: string;
  default_renderer: SpaceRenderer;
  description: string | null;
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
};

export type SpaceItem = {
  id: string;
  space_id: string;
  ref_type: SpaceItemRefType;
  ref_id: string;
  ref_uri: string | null;
  title: string | null;
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
};

export type SpaceOccurrence = {
  id: string;
  space_id: string;
  item_id: string | null;
  renderer: SpaceOccurrenceRenderer;
  parent_id: string | null;
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
  z_index: number | null;
  sort_key: string | null;
  section_id: string | null;
  note: string | null;
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
};

export type SpaceEdge = {
  id: string;
  space_id: string;
  source: string;
  target: string;
  label: string | null;
  style: string | null;
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
};

/**
 * Document block (C11 `space_blocks`). Mirrors the planned schema at
 * docs/spaces/UMBRELLA-PLAN.md §3.5. An `item_id` embed ALWAYS carries an
 * `item_snapshot_json` placeholder (DB-level invariant) so it degrades to a
 * resolvable node when the embedded item is deleted.
 */
export type SpaceBlockType =
  | 'heading'
  | 'paragraph'
  | 'reference'
  | 'artifact_embed'
  | 'issue_embed'
  | 'comment_embed'
  | 'todo';

export type SpaceBlock = {
  id: string;
  space_id: string;
  parent_id: string | null;
  block_type: SpaceBlockType;
  item_id: string | null;
  /** Resolvable placeholder snapshot; non-null whenever `item_id` is set. */
  item_snapshot: Record<string, unknown> | null;
  sort_key: string;
  markdown: string | null;
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
};

/**
 * Mutable export-tracking record (C13a `space_exports`). Mirrors the planned
 * schema at docs/spaces/DOCUMENT-CUSTODY-DESIGN.md §2.1. `authority` records who
 * owns the bytes; `status` is the drift state computed against live repo state.
 */
export type SpaceExportAuthority = 'mandible' | 'repo';
export type SpaceExportStatus = 'clean' | 'stale' | 'repo_changed' | 'worktree_dirty' | 'conflict';

export type SpaceExport = {
  id: string;
  space_id: string;
  /** References `ledger_project_checkouts.id` (the backed-up project-checkout identity), NOT `work_repos.id`. */
  repo_id: string;
  branch: string;
  path: string;
  authority: SpaceExportAuthority;
  status: SpaceExportStatus;
  last_export_artifact_id: string | null;
  pre_export_snapshot_artifact_id: string | null;
  last_export_commit: string | null;
  last_export_blob_sha: string | null;
  last_export_content_sha256: string | null;
  last_seen_commit: string | null;
  last_seen_content_sha256: string | null;
  created_at: number;
  updated_at: number;
};

// --- request bodies ---------------------------------------------------------

export type CreateSpaceRequest = {
  /** Owning project. Omit or pass `null` to create a top-level / global Space (issue 812df41). */
  project_id?: string | null;
  title: string;
  default_renderer?: SpaceRenderer;
  description?: string | null;
  metadata?: Record<string, unknown>;
};

export type UpdateSpaceRequest = {
  title?: string;
  default_renderer?: SpaceRenderer;
  description?: string | null;
  metadata?: Record<string, unknown>;
};

export type AddSpaceItemRequest = {
  ref_type: SpaceItemRefType;
  ref_id: string;
  ref_uri?: string | null;
  title?: string | null;
  metadata?: Record<string, unknown>;
};

export type UpdateSpaceItemRequest = {
  ref_uri?: string | null;
  title?: string | null;
  metadata?: Record<string, unknown>;
};

export type SpaceOccurrenceInput = {
  item_id?: string | null;
  renderer?: SpaceOccurrenceRenderer;
  parent_id?: string | null;
  x?: number | null;
  y?: number | null;
  width?: number | null;
  height?: number | null;
  z_index?: number | null;
  sort_key?: string | null;
  section_id?: string | null;
  note?: string | null;
  metadata?: Record<string, unknown>;
};

export type CreateSpaceOccurrenceRequest = SpaceOccurrenceInput;
export type UpdateSpaceOccurrenceRequest = SpaceOccurrenceInput;

/** One entry in a batch occurrence write; an `id` matching an existing occurrence updates it, otherwise it is created. */
export type BatchSpaceOccurrenceEntry = SpaceOccurrenceInput & { id?: string };

export type BatchSpaceOccurrenceRequest = {
  occurrences: BatchSpaceOccurrenceEntry[];
};

export type CreateSpaceEdgeRequest = {
  source: string;
  target: string;
  label?: string | null;
  style?: string | null;
  metadata?: Record<string, unknown>;
};

export type UpdateSpaceEdgeRequest = {
  source?: string;
  target?: string;
  label?: string | null;
  style?: string | null;
  metadata?: Record<string, unknown>;
};

/**
 * Seed request. The C2 route accepts the predicate under either `predicate` or
 * the legacy `scope` alias; the client helper sends `predicate`. The predicate
 * is the shared Timeline issue-predicate AST (`TimelineIssuePredicate`), kept as
 * an opaque object here so this contract module stays dependency-light.
 */
export type SeedSpaceRequest = {
  predicate: Record<string, unknown>;
  with_shelf_occurrences?: boolean;
  include_artifacts?: boolean;
};

// --- response envelopes -----------------------------------------------------

export type SpaceListResponse = { spaces: Space[] };

/**
 * One group in the grouped Spaces list (issue 812df41): a project (with id,
 * stable key, and name) or the top-level / global bucket (`project_id: null`,
 * `project_name: null`). `project_key` is the stable registry slug from
 * `ledger_projects.project_key` (null for the top-level group and for unresolvable
 * project rows). `project_name` is already disambiguated by the backend when
 * two project rows share the same `display_name` (issue 6fdd924).
 */
export type SpaceGroup = {
  project_id: string | null;
  /** Stable registry slug from `ledger_projects.project_key`, or null. */
  project_key: string | null;
  project_name: string | null;
  spaces: Space[];
};

/**
 * Grouped Spaces list response (`GET /api/spaces` with no `project_id`/`scope`,
 * issue 812df41). `groups` is the top-level group first (when non-empty) then one
 * group per owning project. `spaces` is every Space flattened across the groups so
 * existing flat-list callers keep working.
 */
export type SpaceGroupedListResponse = { groups: SpaceGroup[]; spaces: Space[] };
export type SpaceResponse = { space: Space };
export type DeleteSpaceResponse = { ok: true; id: string };

export type AddSpaceItemResponse = {
  item: SpaceItem;
  created: boolean;
  already_present: boolean;
};
export type SpaceItemResponse = { item: SpaceItem };
export type DeleteSpaceItemResponse = { ok: true; id: string };

export type SpaceOccurrenceResponse = { occurrence: SpaceOccurrence };
export type DeleteSpaceOccurrenceResponse = { ok: true; id: string };
export type BatchSpaceOccurrenceResponse = {
  occurrences: SpaceOccurrence[];
  created: number;
  updated: number;
};

export type SpaceEdgeResponse = { edge: SpaceEdge };
export type DeleteSpaceEdgeResponse = { ok: true; id: string };

/** One diagnostic emitted by predicate evaluation during seeding (opaque shape mirroring `TimelineDiagnostic`). */
export type SpaceSeedDiagnostic = Record<string, unknown>;

export type SeedSpaceResult = {
  matched_issue_ids: string[];
  items: SpaceItem[];
  items_created: number;
  items_existing: number;
  occurrences: SpaceOccurrence[];
  diagnostics: SpaceSeedDiagnostic[];
};

/** Read-only fact packet for a Space (items/occurrences/edges) as returned by `loadSpaceFactPacket`. */
export type SpaceFactPacket = {
  space: Space;
  items: SpaceItem[];
  occurrences: SpaceOccurrence[];
  edges: SpaceEdge[];
};

// --- unified ref resolver ---------------------------------------------------

export type ResolverRefKind = 'issue' | 'comment' | 'artifact' | 'mandible' | 'repo' | 'unknown';

export type ResolverResult = {
  ref: string;
  kind: ResolverRefKind;
  resolved: boolean;
  entity: Record<string, unknown> | null;
  detail?: Record<string, unknown> | null;
  error?: string;
};

export type ResolveRefResponse = { resolution: ResolverResult };

// --- briefing review queue (umbrella 99b74d6 / issue ce22a3a) ----------------
//
// The briefing store holds reviewable findings produced by scheduled collector
// tasks. Identity is publisher-derived and deterministic:
//   candidate_key = sha256(source + "\0" + ref)
//   evidence_hash = sha256(canonical JSON of the evidence the ref points at)
// A (candidate_key, evidence_hash) pair is a REVISION. Seeing the same pair
// again is only a new occurrence; a new evidence_hash for a known candidate is
// a new revision that re-pends the candidate exactly once.
//
// Review state is DERIVED from the append-only decision-event stream, never
// stored as a mutable column. See `BriefingCandidateState`.

export const BRIEFING_INGEST_SCHEMA = 'briefing-ingest@1';

export type BriefingEvidenceKind = 'snapshot-item' | 'finding-only';

export type BriefingDecisionAction = 'keep' | 'dismiss' | 'undo' | 'expire';

/** Actions a human reviewer may submit. `expire` is system-generated only. */
export type BriefingReviewAction = 'keep' | 'dismiss' | 'undo';

/**
 * Presentation state of a candidate, derived from the last decision event on
 * its current revision: no events or a trailing `undo` means pending.
 * `expired_unreviewed` is an `expire` event, which the sweep records with a
 * NULL actor because no human reviewed it.
 */
export type BriefingCandidateState =
  | 'pending'
  | 'kept'
  | 'dismissed'
  | 'expired_unreviewed';

/** One finding in an ingest batch. All identity fields are publisher-derived. */
export type BriefingIngestItem = {
  candidate_key: string;
  source: string;
  ref: string;
  title: string;
  why_notable?: string | null;
  refs?: string[];
  evidence_hash: string;
  evidence_kind: BriefingEvidenceKind;
  captured_at?: string | null;
  rank?: number | null;
};

export type BriefingIngestRequest = {
  schema: typeof BRIEFING_INGEST_SCHEMA;
  task_identity: string;
  run_id: string;
  digest: { series_ref: string; version: number };
  batch_key: string;
  items: BriefingIngestItem[];
};

/**
 * Ingest outcome. Replaying a `batch_key` writes nothing and returns exactly
 * this same result, so the shape carries no batch-local or replay-local fields.
 */
export type BriefingIngestResult = {
  accepted: number;
  created: number;
  revised: number;
  unchanged: number;
};

export type BriefingRevision = {
  id: string;
  candidate_id: string;
  title: string;
  why_notable: string | null;
  refs: string[];
  source_ref: string | null;
  evidence_hash: string;
  evidence_kind: BriefingEvidenceKind;
  captured_at: string | null;
  run_id: string | null;
  digest_series_ref: string | null;
  digest_version: number | null;
  rank: number | null;
  batch_key: string;
  ingested_at: number;
};

export type BriefingOccurrenceStats = {
  count: number;
  first_seen_at: number | null;
  last_seen_at: number | null;
};

export type BriefingDecisionEvent = {
  id: string;
  candidate_id: string;
  revision_id: string;
  action: BriefingDecisionAction;
  actor_user_id: string | null;
  comment_id: string | null;
  created_at: number;
};

export type BriefingComment = {
  id: string;
  candidate_id: string;
  revision_id: string;
  body: string;
  actor_user_id: string | null;
  created_at: number;
};

export type BriefingQueueEntry = {
  id: string;
  source: string;
  candidate_key: string;
  created_at: number;
  state: BriefingCandidateState;
  revision: BriefingRevision;
  revision_count: number;
  occurrences: BriefingOccurrenceStats;
};

/** Per-source ingest health, pulled from the batch ledger. */
export type BriefingSourceHealth = {
  source: string;
  pending_count: number;
  candidate_count: number;
  last_task_identity: string | null;
  last_run_id: string | null;
  last_digest_version: number | null;
  last_ingested_at: number | null;
  last_ingest_age_ms: number | null;
  last_batch_item_count: number | null;
};

export type BriefingQueueResponse = {
  candidates: BriefingQueueEntry[];
  sources: BriefingSourceHealth[];
};

export type BriefingCandidateHistoryResponse = {
  candidate: {
    id: string;
    source: string;
    candidate_key: string;
    current_revision_id: string | null;
    created_at: number;
    state: BriefingCandidateState;
  };
  revisions: BriefingRevision[];
  decisions: BriefingDecisionEvent[];
  comments: BriefingComment[];
};

export type BriefingDecisionResponse = {
  candidate_id: string;
  revision_id: string;
  action: BriefingReviewAction;
  event_id: string;
  state: BriefingCandidateState;
};

export type BriefingCommentResponse = { comment: BriefingComment };

/** SSE event names emitted by the briefing routes. */
export const BRIEFING_EVENTS = Object.freeze({
  ingested: 'briefing:ingested',
  decided: 'briefing:decided',
  commented: 'briefing:commented',
  expired: 'briefing:expired',
} as const);

export type BriefingEvent = (typeof BRIEFING_EVENTS)[keyof typeof BRIEFING_EVENTS];

export const BRIEFING_EVENT_VALUES: readonly BriefingEvent[] = Object.freeze(
  Object.values(BRIEFING_EVENTS),
) as readonly BriefingEvent[];

export function isBriefingEvent(value: unknown): value is BriefingEvent {
  return typeof value === 'string'
    && (BRIEFING_EVENT_VALUES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Space finding references (briefing umbrella 99b74d6, lane d7e51a1).
//
// A `finding` SpaceItem points at ONE briefing review candidate:
// `ref_id` is the candidate id, and the item `metadata` carries the reference's
// explicit revision semantics — `revision_mode: 'latest' | 'pinned'`, where
// `pinned` REQUIRES `pinned_revision_id`. A pinned reference keeps showing the
// revision it was pinned to when a newer revision arrives; a latest-tracking
// reference follows the candidate's current revision and says so (the
// `finding_latest_not_pinned` warning mirrors the artifact-series
// `series_latest_not_pinned` idiom).
//
// Spaces are a READ-ONLY surface for findings: review state is displayed but
// never mutated from a Space, and adding a finding to a Space is a placement
// fact only — it implies no decision event.
// ---------------------------------------------------------------------------

export type SpaceFindingRevisionMode = 'latest' | 'pinned';

export const SPACE_FINDING_REVISION_MODES: readonly SpaceFindingRevisionMode[] = ['latest', 'pinned'];

/** The `metadata` shape stored on a `finding` SpaceItem. */
export type SpaceFindingRefMetadata = {
  revision_mode: SpaceFindingRevisionMode;
  /** Required when (and only when) `revision_mode` is `'pinned'`. */
  pinned_revision_id?: string;
};

/**
 * Derived review state of a candidate's CURRENT revision (contract §2: pending
 * iff the current revision has no effective decision event). `unknown` is
 * reported when the decision store is unavailable, never guessed as pending.
 */
export type FindingReviewState = 'pending' | 'kept' | 'dismissed' | 'expired_unreviewed' | 'unknown';

export type FindingEvidenceKind = 'snapshot-item' | 'finding-only';

/** One `candidate_revisions` row, projected for display. */
export type SpaceFindingRevisionSummary = {
  id: string;
  candidate_id: string;
  title: string | null;
  why_notable: string | null;
  source_ref: string | null;
  evidence_hash: string | null;
  evidence_kind: FindingEvidenceKind | null;
  captured_at: string | null;
  run_id: string | null;
  digest_series_ref: string | null;
  digest_version: number | null;
  rank: number | null;
  batch_key: string | null;
  ingested_at: number | null;
  refs: string[];
};

/** A pickable review candidate (Space item picker rows). */
export type SpaceFindingCandidateSummary = {
  candidate_id: string;
  source: string;
  candidate_key: string;
  title: string | null;
  current_revision_id: string | null;
  review_state: FindingReviewState;
  created_at: number | null;
};

/**
 * Revision state of one placed reference:
 * - `latest` — tracking mode, showing the candidate's current revision.
 * - `pinned_current` — pinned, and the pin is still the current revision.
 * - `pinned_superseded` — pinned, and a newer revision exists (the reference
 *   deliberately does NOT move).
 * - `pinned_missing` — pinned to a revision that is not in the store.
 * - `unresolved` — the candidate itself could not be resolved.
 */
export type SpaceFindingRevisionState =
  | 'latest'
  | 'pinned_current'
  | 'pinned_superseded'
  | 'pinned_missing'
  | 'unresolved';

export type SpaceFindingResolution = {
  /** Canonical `finding:<candidate id>` ref. */
  ref: string;
  candidate_id: string;
  resolved: boolean;
  source: string | null;
  candidate_key: string | null;
  revision_mode: SpaceFindingRevisionMode;
  pinned_revision_id: string | null;
  /** The revision this reference displays under its own revision mode. */
  effective_revision: SpaceFindingRevisionSummary | null;
  /** The candidate's current (newest) revision, whatever this reference shows. */
  current_revision: SpaceFindingRevisionSummary | null;
  revision_state: SpaceFindingRevisionState;
  review_state: FindingReviewState;
  warnings: string[];
  error?: string;
};

/** Latest-tracking reference: mirrors artifact `series_latest_not_pinned`. */
export const SPACE_FINDING_WARNING_LATEST_NOT_PINNED = 'finding_latest_not_pinned';
/** Pinned reference whose candidate has moved on to a newer revision. */
export const SPACE_FINDING_WARNING_PINNED_SUPERSEDED = 'finding_pinned_revision_superseded';
/** Pinned reference whose pinned revision is absent from the store. */
export const SPACE_FINDING_WARNING_PINNED_MISSING = 'finding_pinned_revision_missing';
/** The briefing candidate store is not present in this database. */
export const SPACE_FINDING_WARNING_STORE_UNAVAILABLE = 'finding_store_unavailable';

export type SpaceFindingResolveResponse = { resolution: SpaceFindingResolution };
export type SpaceFindingListResponse = { findings: SpaceFindingCandidateSummary[] };
