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
  | "auth:resolved"
  | "auth:completed"
  | "auth:deleted"
  | "auth:needs_rebase"
  | "channel:session:connected"
  | "channel:session:disconnected"
  | "console:inbox:badge"
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

export type ReviewSpecResponse = {
  markdown: string;
  commits: string[];
  meta: Record<string, unknown>;
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
  starred: boolean;
  label: string | null;
  notes: string | null;
  parent_conversation_id: string | null;
  children_count: number;
};

export type ConversationChild = {
  id: string;
  title: string;
  block_count: number;
  started_at: string;
  ended_at: string | null;
  source: string;
  model: string | null;
  duration_seconds: number | null;
};

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

export type ArtifactResolveResult = {
  status: ArtifactAliasResolutionStatus;
  ref: string;
  scheme: string;
  normalized_ref: string;
  artifact: ArtifactRecord | null;
  alias: ArtifactAliasRecord | null;
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
export type SpaceItemRefType = 'issue' | 'comment' | 'artifact' | 'external_ref';

export const SPACE_RENDERERS: readonly SpaceRenderer[] = ['canvas', 'document', 'board', 'collection'];
export const SPACE_OCCURRENCE_RENDERERS: readonly SpaceOccurrenceRenderer[] = ['canvas', 'board', 'collection'];
export const SPACE_ITEM_REF_TYPES: readonly SpaceItemRefType[] = ['issue', 'comment', 'artifact', 'external_ref'];

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
 * One group in the grouped Spaces list (issue 812df41): a project (with id and
 * name) or the top-level / global bucket (`project_id: null`, `project_name: null`).
 */
export type SpaceGroup = {
  project_id: string | null;
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
