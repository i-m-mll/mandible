// --- Core daemon types (P1) ---
import type { RuntimeDeliveryReference } from "./runtime-handoff-proof.js";

// --- Contracts owned by contracts.ts -------------------------------------
// These were byte-equivalent second declarations. contracts.ts is the module
// the UI imports directly and is dependency-light, so it owns them; types.ts
// re-exports so every existing `./types.js` import keeps resolving to ONE
// definition instead of a copy that drifts without any compile error.
import type { ProtectedRootDirtyAction } from "./auth-protected-root-dirty-action.js";
import type {
  AuthRequestAction,
  AuthDependencyProjection,
  AuthDependencyReadiness,
  AuthExecutionMode,
  AuthRequestType,
  AuthRequestActionInput,
  AuthPublicationBlocker,
  AuthChangeReport,
  AuthOutputChunk,
  ArtifactRecord,
  ArtifactIdentitySourceKind,
  ArtifactBlobRecord,
  ArtifactIdentityRecord,
  CanonicalArtifactVersionRecord,
  Artifact,
  ArtifactVersion,
  ProjectArtifactAssociationRecord,
  ProjectArtifactAssociation,
  ArtifactSeriesSummary,
  ArtifactAliasResolutionStatus,
  ArtifactAliasRecord,
  ArtifactLinkRecord,
  ArtifactResolveResult,
  ArtifactVersionSourceKind,
  ArtifactSeriesSourceKind,
  ArtifactVersionRecordResult,
  ArtifactDraftRecord,
  ArtifactDraftPublishResult,
  WorkUnitKind,
  WorkUnitState,
  WorkUnit,
} from "./contracts.js";
export type {
  AuthRequestAction,
  AuthDependencyProjection,
  AuthDependencyReadiness,
  AuthExecutionMode,
  AuthRequestType,
  AuthRequestActionInput,
  AuthPublicationBlocker,
  AuthChangeReport,
  AuthOutputChunk,
  ArtifactRecord,
  ArtifactIdentitySourceKind,
  ArtifactBlobRecord,
  ArtifactIdentityRecord,
  CanonicalArtifactVersionRecord,
  Artifact,
  ArtifactVersion,
  ProjectArtifactAssociationRecord,
  ProjectArtifactAssociation,
  ArtifactSeriesSummary,
  ArtifactAliasResolutionStatus,
  ArtifactAliasRecord,
  ArtifactLinkRecord,
  ArtifactResolveResult,
  ArtifactVersionSourceKind,
  ArtifactSeriesSourceKind,
  ArtifactVersionRecordResult,
  ArtifactDraftRecord,
  ArtifactDraftPublishResult,
  WorkUnitKind,
  WorkUnitState,
  WorkUnit,
};


import type {
  LedgerIssueKind,
  LedgerIssueResolution,
  LedgerIssueStatus,
  LedgerPriority,
  LedgerRelationshipType,
} from "./ledger/types.js";
import type {
  AttributionReadProjection,
  ReadUserIdentity,
} from "./identity/read-projection.js";
import { AUTH_REQUEST_ACTION_KINDS } from "./contracts.js";
import type {
  AuthRequestActionKind,
  AuthRequestActionState,
  AuthRequestOutcome,
  AuthRequestStatus,
} from "./contracts.js";
import type { SessionIdentityMismatch } from "./identity/session-mismatch.js";
import type { AnthropicBillingPosture } from "./claude-lane-policy.js";

export type { SSEEvent } from "./contracts.js";

export interface StartupCommitInfo {
  hash: string;
  summary: string;
  date: string;
}

export interface HealthResponse {
  current?: import("./runtime-health-contract.js").CurrentRuntimeHealth;
  status: "ok";
  uptime: number;
  version: string;
  /** Unique per daemon process/start, independent of the checked-out commit. */
  startup_epoch?: string;
  startup_commit: StartupCommitInfo;
  instance: InstanceInfo;
  file_rpc_dir?: string;
  // Bug: 4db692a — true when daemon is about to restart after a self-merge.
  // The UI health poll uses this to avoid reloading prematurely while the
  // daemon is still alive but in the process of shutting down.
  rebuilding?: boolean;
  // Issue a09b4d2 — the last merged self-update whose rebuild or runtime
  // handoff failed. Present only while it is current.
  rebuild_failure?: RebuildFailure;
  // Bug: 645f8a8 — lifecycle-owned readiness. true only once the daemon has
  // finished the critical startup work that makes normal dashboard mutations
  // (auth approve/reject, etc.) safe — NOT merely "the HTTP listener is alive".
  // The UI keeps the rebuild/start splash up and gates mutations while this is
  // not strictly true, so a freshly-listening-but-still-starting process does
  // not let users fire actions into a half-initialized daemon.
  ready?: boolean;
  // Second readiness tier. false means the daemon is mutation-safe but its
  // first deferred startup reconciliation is still populating cached data.
  // Optional so older health clients and lightweight test servers remain valid.
  warm?: boolean;
  // Lightweight, constant-space process diagnostics. Optional for response
  // compatibility with older daemons and test servers that do not wire a
  // process-lifetime collector.
  memory?: import("./daemon-memory.js").DaemonMemorySnapshot;
  // Constant-space request-loop responsiveness diagnostics. Optional for
  // compatibility with older daemons and lightweight test servers.
  eventLoop?: import("./daemon-event-loop.js").EventLoopLagSnapshot;
  // Issue 708dc4c — client-authentication mode and the unattributed-write
  // telemetry ratchet. Present only when the daemon wires a client-auth gate.
  client_auth?: {
    mode: "compat" | "strict";
    credential_directory?: string;
    authority_id?: string;
    telemetry?: unknown;
  };
}

export type InstanceRole = "main" | "preview" | "dev" | "test";
export type OperationalMutationPolicy = "allow" | "reject";

export interface InstanceInfo {
  role: InstanceRole;
  /** Stable authority registration, never derived from a port or worktree. */
  instance_id: string;
  installation_id: string;
  public_origin: string;
  backend_generation: string;
  allowed_effects: readonly import("./security/effect-policy.js").Effect[];
  writable_roots: readonly string[];
  preview_root?: string | null;
  /** Canonical per-instance root for authenticated user-owned appearance preferences. */
  user_preferences_root: string;
  artifact_root?: string | null;
  source_artifact_root?: string | null;
  db_path: string | null;
  db_path_source: string | null;
  source_db_path?: string | null;
  source_db_path_source?: string | null;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export type Logger = (level: LogLevel, message: string, details?: Record<string, unknown>) => void;

// --- Session types (P2) ---

export type SessionStatus = "active" | "idle" | "ended" | "dead";
export type NavMetadataStatus = "not_applicable" | "pending" | "ready" | "degraded" | "failed";

export interface Session {
  id: string;
  app: string;
  pid: number | null;
  pid_start: string | null;
  cwd: string | null;
  branch: string | null;
  worktree: string | null;
  terminal: string | null;
  multiplexer: string | null;
  nav_session: string | null;
  nav_tab: string | null;
  nav_pane_id: string | null;
  nav_extra: Record<string, unknown> | null;
  nav_metadata_status: NavMetadataStatus;
  nav_metadata_attempts: number;
  nav_metadata_last_error: string | null;
  nav_metadata_last_attempt_at: string | null;
  nav_metadata_next_retry_at: string | null;
  task: string | null;
  status: SessionStatus;
  parent_id: string | null;
  agent_type: string | null;
  description: string | null;
  // Bug: 6d7411b — provider-native conversation ID persists across resumes.
  conversation_id: string | null;
  created_at: string;
  updated_at: string;
  pinned: number;
  continuation: string | null;
  continuation_acked_by: string | null;
  ended_at: string | null;
  // Bug: e01653d — real user activity time from JSONL transcript mtime
  last_active: string | null;
  // Bug: 0b454df — channel-connected session tracking
  channel_connected_at: number | null;
  channel_last_tool_call: number | null;
  owner_user_id: string | null;
  owner?: ReadUserIdentity | null;
  // Issue 499c148 — set when this session's client token and its session
  // bindings resolved to different users at registration.
  identity_mismatch: SessionIdentityMismatch | null;
  children?: Session[];
}

// --- Auth types (P3) ---

// Lifecycle status and terminal outcome are owned by contracts.ts, alongside
// `computeAuthRequestOutcome`, which is the one mapping between them. Note
// "approved" is legacy — kept for DB backward compat; recovery converts it to
// "executing". Outcome `null` means "still in lifecycle", so anything that
// widens the status union must be classified in that function.
export type { AuthRequestStatus, AuthRequestOutcome };
// Owned by contracts.ts, which the UI imports directly. Re-exported here so the
// daemon's existing `./types.js` imports keep working against one definition
// rather than a second hand-maintained copy that drifts silently.
export { AUTH_REQUEST_ACTION_KINDS };
export type { AuthRequestActionKind, AuthRequestActionState };

export interface AuthRequest {
  space_publication_id?: string | null;
  id: string;
  session_id: string | null;
  requested_by_user_id: string | null;
  requester_evidence_method?: string | null;
  requester_credential_id?: string | null;
  approved_by_user_id: string | null;
  execution_evidence_id: string | null;
  type: AuthRequestType;
  command: string;
  title: string;
  cwd: string | null;
  diff_summary: string | null;
  /** The authored Description. Historical storage/wire key retained for signed evidence. */
  commit_message: string | null;
  // Issue 7d64d8f — SHA-256 of the canonical change message bytes. Non-null
  // exactly when `commit_message` is an agent-authored canonical change
  // message that cli/auth-merge.sh must use verbatim as the merge commit
  // message. Null for legacy/free-form review text.
  commit_message_digest?: string | null;
  /**
   * Issue 8ae6b5f — review Markdown stored by requests submitted before specs
   * were removed. Always null for new requests; kept read-only as history.
   */
  spec_content: string | null;
  /** Issue 8ae6b5f — where a protected-root dirty policy moved uncommitted work. */
  protected_root_dirty_action?: ProtectedRootDirtyAction | null;
  repo?: string;
  publication_blocker?: AuthPublicationBlocker | null;
  base_branch?: string;
  head_branch?: string;
  merge_head_sha?: string | null;
  merge_candidate_tree_sha?: string | null;
  merge_candidate_pin_sha?: string | null;
  merge_atomic_enabled?: boolean;
  merge_preflight_base_sha?: string | null;
  merge_preflight_queue_fingerprint?: string | null;
  merge_finalized_at?: number | null;
  // Issue 75f52ac — per-step durable state for the background finalizer queue.
  // JSON object keyed by step name: { [step]: { state, attempts, error?, at } }.
  // Null until Stage 3 finalizers run; lets crash recovery resume mid-queue and
  // surfaces failed steps in the auth:finalized payload and detail views.
  merge_finalizer_state?: string | null;
  change_report?: AuthChangeReport | null;
  files_changed?: number;
  additions?: number;
  deletions?: number;
  post_merge_handoff?: string | null;
  issue_references?: string[] | null;
  issue_closures?: string[] | null;
  issue_ids?: string[] | null;
  /** @deprecated Legacy close-on-merge issue list. Use issue_closures. */
  issues?: string[] | null;
  depends_on_ids?: string[];
  dependencies?: AuthDependencyProjection[];
  execution_mode: AuthExecutionMode;
  status: AuthRequestStatus;
  /** Issue cc8fe29 — why a `failed` execution failed, derived from its recorded error. */
  failure_reason?: string | null;
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
  // Bug: 4e32923 — owner session + repo for scoped channel delivery and
  // tiered inbox escalation. delivered_at is set by the MCP channel server
  // when it forwards the auth:resolved event to the owner; once set, the
  // item is removed from the owner's tier-1 inbox.
  target_session_id: string | null;
  target_repo_root: string | null;
  delivered_at: number | null;
  // Bug: 6d7411b — conversation_id persists across Claude Code resumes
  conversation_id: string | null;
  approval_source: "manual" | "auto_lease" | string;
  approval_lease_id: string | null;
  clearance_use_id?: string | null;
  supersedes_request_id?: string | null;
  superseded_by_request_id?: string | null;
  custody_work_unit_id?: string | null;
}

export type AuthRequestLifecycleEventType =
  | "legacy_snapshot" | "submitted" | "revised" | "approved" | "executing"
  | "rejected" | "withdrawn" | "superseded" | "needs_rebase" | "expired" | "completed" | "failed";

export interface AuthLifecycleActor {
  user_id: string;
  evidence_method: string;
  evidence_id?: string | null;
  credential_id?: string | null;
  session_id?: string | null;
  authority_path?: "custodian" | "operator_recovery" | "system" | "legacy";
}

export interface AuthRequestLifecycleEvent {
  request_origin_json?: string | null;
  request_origin?: import("./request-origin.js").RequestOrigin | null;
  id: string;
  auth_request_id: string;
  revision: number;
  event_type: AuthRequestLifecycleEventType;
  prior_status: AuthRequestStatus | null;
  next_status: AuthRequestStatus;
  snapshot_json: string;
  snapshot_sha256: string;
  prior_snapshot_json: string | null;
  prior_snapshot_sha256: string | null;
  actor_user_id: string | null;
  evidence_method: string | null;
  evidence_id: string | null;
  credential_id: string | null;
  reason: string | null;
  related_request_id: string | null;
  custody_work_unit_id: string | null;
  custody_generation: number | null;
  authority_path: string | null;
  occurred_at: number;
}

/**
 * Projected auth-request shape for list surfaces (history sidebar).
 *
 * Omits the unbounded body blobs (`diff_summary`, `spec_content`, `output`)
 * so a 50–200 row list does not serialize megabytes of diff/spec/console text
 * on the main thread. The detail route (`GET /api/auth/request/:id`) still
 * returns the full body, which the UI fetches on selection. `action_count`
 * is resolved in a single batched query rather than per-row.
 */
export type AuthRequestSummary = Omit<
  AuthRequest,
  "diff_summary" | "spec_content" | "output" | "change_report"
> & { action_count: number };

export interface AuthRequestInput {
  space_publication_id?: string | null;
  session_id?: string | null;
  type?: AuthRequestType;
  command: string;
  title: string;
  cwd?: string | null;
  diff_summary?: string | null;
  /** Required authored Description for new submissions; validated at the queue boundary. */
  commit_message: string;
  // Issue 7d64d8f — declares that `commit_message` is an agent-authored
  // canonical change message. The daemon canonicalizes the bytes, stores them
  // back, and records their digest; only then does the merge consume them
  // verbatim. Absent/false keeps the legacy free-form review-text behaviour.
  canonical_message?: boolean;
  // Issue 7d64d8f — the machine-owned `Verification:` section text. Required
  // whenever `canonical_message` is true: the daemon validates the message's
  // Verification section against this structured field rather than trusting
  // whatever prose the message happens to contain.
  verification?: string | null;
  repo?: string;
  base_branch?: string;
  head_branch?: string;
  merge_head_sha?: string | null;
  /** Route-owned immutable report; never accepted from request callers. */
  change_report?: AuthChangeReport | null;
  /**
   * Issue 8ae6b5f — what an explicit protected-root dirty policy did before a
   * merge submission. Validated by the route; stored on the request.
   */
  protected_root_dirty_action?: ProtectedRootDirtyAction | null;
  files_changed?: number;
  additions?: number;
  deletions?: number;
  post_merge_handoff?: string | null;
  issue_references?: string[] | null;
  issue_closures?: string[] | null;
  /** @deprecated Legacy close-on-merge issue list. Use issue_closures. */
  issues?: string[] | null;
  depends_on_ids?: string[];
  execution_mode?: AuthExecutionMode;
  // Bug: 4e32923 — scoping fields supplied by the submitting CLI; if null,
  // delivery falls back to legacy broadcast behaviour (pre-migration rows).
  target_session_id?: string | null;
  target_repo_root?: string | null;
  // Bug: 6d7411b — conversation_id persists across Claude Code resumes
  conversation_id?: string | null;
  actions?: AuthRequestActionInput[];
  /** Verified request-boundary provenance; route-owned, never caller-authored. */
  requester_evidence_method?: string | null;
  requester_credential_id?: string | null;
  supersedes_request_id?: string | null;
  superseded_action_dispositions?: Array<{ ordinal: number; reason: string }>;
  expected_revision?: number;
  expected_custody_generation?: number;
  /** Public route boundary: require one exact delivery work unit. */
  require_delivery_custody?: boolean;
}

// --- Issue tracking types ---

export interface GitBugIssue {
  id: string;
  repo_id: string;
  repo_name: string;
  title: string;
  status: "open" | "closed";
  kind?: import("./ledger/types.js").LedgerIssueKind;
  resolution?: import("./ledger/types.js").LedgerIssueResolution | null;
  priority?: import("./ledger/types.js").LedgerPriority;
  labels: string[];
  author: string;
  author_legacy_display?: string;
  author_attribution?: AttributionReadProjection | null;
  created_at: string;
  // Perf (issue e5fc02b): the set-based /api/issues list projection omits
  // description to keep list payloads small and avoid rehydrating every issue
  // body. Detail projections (GitBugIssueDetail) still populate it, so the
  // field is optional on the shared summary type rather than always present.
  description?: string;
  /** Compatibility projection; present only when exactly one canonical parent exists. */
  parent_id?: string;
  /** Canonical source issue ids for every active parent-child edge. */
  parent_ids?: string[];
  parent_relationships?: GitBugIssueParentRelationship[];
}

export interface GitBugIssueParentRelationship {
  id: string;
  parent_id: string;
  parent_ref: string;
  provenance: import("./ledger/types.js").LedgerRelationshipProvenance;
  confidence: string;
}

export interface GitBugIssueDetail extends GitBugIssue {
  description: string;
  comments: GitBugComment[];
}

export interface GitBugComment {
  id: string;
  author: string;
  author_legacy_display?: string;
  author_attribution?: AttributionReadProjection | null;
  date: string;
  body: string;
}

export interface IssueRepoSummary {
  repo_id: string;
  repo_name: string;
  repo_root: string;
  // Issue 3d85f43: the canonical project key (when this summary is ledger-backed),
  // so the repo filter and auth-list alias lookup round-trip the key the issue
  // detail surface and /r/issue redirect emit. Optional: scanner-only summaries
  // omit it.
  project_key?: string;
  open_count: number;
  delivered_count: number;
  closed_count: number;
  issues: GitBugIssue[];
}

// --- Project Timeline projection types ---

export type TimelineRootPolicy = "coordination" | "explicit" | "coordination_and_explicit";
export type TimelineHeadlineSource = "title" | "markdown_heading" | "body_excerpt" | "state" | "backlink";
export type TimelineSourceEntityType = "issue_body" | "comment" | "issue_state";
export type TimelineEventKind =
  | "body"
  | "comment"
  | "state"
  | "backlink"
  | "issue_state"
  | "label"
  | "commit"
  | "auth_request"
  | "session"
  | "work_unit";
export type TimelineRowOccurrenceKind = "root" | "promoted_root" | "explicit_root" | "transient" | "member";
export type TimelineLabelMembershipMode = "now" | "ever_in_window";
export type TimelineIssuePredicate =
  | { type: "referenced_by"; issue_id: string }
  | { type: "label"; name: string; membership?: TimelineLabelMembershipMode }
  | { type: "kind"; kind: LedgerIssueKind }
  | { type: "parent_subtree"; issue_id: string }
  | { type: "residual" }
  | { type: "and"; predicates: TimelineIssuePredicate[] }
  | { type: "or"; predicates: TimelineIssuePredicate[] }
  | { type: "not"; predicate: TimelineIssuePredicate };
export interface TimelineRowSpecInput {
  id?: string;
  title?: string;
  anchor?: string | null;
  anchor_issue_id?: string | null;
  scope?: TimelineIssuePredicate | null;
}
export interface TimelineNormalizedRowSpec {
  id: string;
  title: string;
  anchor_issue_id: string | null;
  scope: TimelineIssuePredicate | null;
}
export type TimelineDiagnosticKind =
  | "cycle"
  | "depth_limit"
  | "missing_expansion_event"
  | "filtered_target"
  | "deleted_target"
  | "invalid_predicate"
  | "unmatched_predicate";

export interface ProjectTimelineInput {
  project_id?: string;
  project_ref?: string;
  root_policy?: TimelineRootPolicy;
  root_specs?: TimelineRowSpecInput[];
  root_row_specs?: TimelineRowSpecInput[];
  explicit_root_issue_ids?: string[];
  promoted_root_issue_ids?: string[];
  expanded_event_ids?: string[];
  expanded_paths?: string[];
  include_closed?: boolean;
  statuses?: LedgerIssueStatus[];
  event_kinds?: TimelineEventKind[];
  depth?: number;
  from?: number;
  to?: number;
  /** Index into the ordered rows of the first row whose events this page carries. */
  row_offset?: number;
}

export interface ProjectTimelineNormalizedInput {
  project_id: string;
  root_policy: TimelineRootPolicy;
  root_specs: TimelineNormalizedRowSpec[];
  explicit_root_issue_ids: string[];
  promoted_root_issue_ids: string[];
  expanded_event_ids: string[];
  expanded_paths: string[];
  include_closed: boolean;
  statuses: LedgerIssueStatus[];
  event_kinds: TimelineEventKind[];
  depth: number;
  from: number | null;
  to: number | null;
}

export interface TimelineIssueRef {
  id: string;
  display_id: string;
  project_id: string;
  title: string;
  status: LedgerIssueStatus;
  resolution: LedgerIssueResolution | null;
  kind: LedgerIssueKind;
  priority: LedgerPriority;
  labels: string[];
  deleted: boolean;
}

export interface TimelineSourceEntityRef {
  type: TimelineSourceEntityType;
  id: string;
  issue_id: string;
}

export interface TimelineRowSpecRef {
  id: string;
  title: string;
  anchor_issue_id: string | null;
  scope: TimelineIssuePredicate | null;
  label_intervals?: TimelineLabelMembershipInterval[];
}

export interface TimelineLabelMembershipInterval {
  issue_id: string;
  label: string;
  start: number;
  end: number | null;
  degraded: boolean;
}

export interface TimelineRowOccurrence {
  id: string;
  issue: TimelineIssueRef | null;
  row_spec?: TimelineRowSpecRef | null;
  kind: TimelineRowOccurrenceKind;
  parent_row_id: string | null;
  source_event_id: string | null;
  depth: number;
  path: string[];
  expanded: boolean;
  cycle: boolean;
  hidden_reason: string | null;
}

export interface TimelineEvent {
  id: string;
  row_id: string;
  issue: TimelineIssueRef;
  source_entity: TimelineSourceEntityRef;
  kind: TimelineEventKind;
  timestamp: number;
  ordinal: number;
  display_headline: string;
  headline_source: TimelineHeadlineSource;
  author?: {
    display: string;
    legacy_display: string;
    attribution: AttributionReadProjection | null;
    source: string | null;
  } | null;
  body: string | null;
  state: {
    event_type: string;
    status: LedgerIssueStatus | null;
    resolution: LedgerIssueResolution | null;
    payload: Record<string, unknown>;
  } | null;
  backlink: {
    relationship_source_id: string;
    relationship_id: string;
    relationship_type: LedgerRelationshipType;
    source_issue: TimelineIssueRef;
    target_issue: TimelineIssueRef;
    source_entity: TimelineSourceEntityRef;
    ref_kind: string;
    raw_ref: string;
    normalized_ref: string;
    derived: boolean;
  } | null;
  link_ids: string[];
}

export interface TimelineLink {
  id: string;
  event_id: string;
  source_row_id: string;
  source_entity: TimelineSourceEntityRef;
  source_issue: TimelineIssueRef;
  target_issue: TimelineIssueRef;
  relationship_id: string;
  relationship_type: LedgerRelationshipType;
  ref_kind: string;
  raw_ref: string;
  normalized_ref: string;
  derived: boolean;
  expanded_row_id: string | null;
  created_at: number;
}

export interface TimelineTimeAxis {
  start: number | null;
  end: number | null;
  event_count: number;
}

export interface TimelineDiagnostic {
  kind: TimelineDiagnosticKind;
  message: string;
  row_id?: string;
  event_id?: string;
  issue_id?: string;
  target_issue_id?: string;
  row_spec_id?: string;
  predicate?: TimelineIssuePredicate;
  depth?: number;
  path?: string[];
}

export interface TimelineDiagnostics {
  total_issues: number;
  deleted_issues: number;
  root_count: number;
  reachable_from_roots_count: number;
  unreferenced_open_issue_ids: string[];
  loner_open_issue_ids: string[];
  derived_reference_count: number;
  repeated_reference_target_issue_ids: string[];
  multi_root_issue_ids: string[];
  cycles: TimelineDiagnostic[];
  depth_limits: TimelineDiagnostic[];
  filtered_targets: TimelineDiagnostic[];
  missing_expansions: TimelineDiagnostic[];
  predicate_diagnostics: TimelineDiagnostic[];
  invalid_predicates: TimelineDiagnostic[];
  unmatched_predicates: TimelineDiagnostic[];
}

export interface ProjectTimelineProjection {
  project: {
    id: string;
    display_name: string;
    repo_id: string | null;
    repo_name: string | null;
    repo_root: string | null;
  };
  inputs: ProjectTimelineNormalizedInput;
  time_axis: TimelineTimeAxis;
  rows: TimelineRowOccurrence[];
  events: TimelineEvent[];
  links: TimelineLink[];
  diagnostics: TimelineDiagnostics;
  page: TimelineProjectionPage;
}

/**
 * Every page carries the whole row tree, inputs, and diagnostics; `events`,
 * `links`, and `time_axis` cover only the rows from `row_offset` up to
 * `next_row_offset`, which is null on the last page.
 */
export interface TimelineProjectionPage {
  row_offset: number;
  next_row_offset: number | null;
}

// --- Session-Issue linking types ---

export interface SessionIssueLink {
  session_id: string;
  issue_id: string;
  repo_id: string;
  created_at: number;
}

// --- SSE event type used by partitions (P2/P3/P4) ---

export type { SseEvent } from "./contracts.js";

// --- Console session types (Bug: e980dd8) ---

export type ConsoleSessionStatus = 'running' | 'stopped' | 'crashed';
export type ConsoleInteractionMode = 'inbox_only' | 'direct' | 'both';
export type ConsoleAttentionKind =
  | 'input_prompt'
  | 'running_output'
  | 'permission_menu'
  | 'hook_notification'
  | 'unknown';
export type ConsoleAttentionSource = 'pty_screen' | 'pty_screen_fallback' | 'claude_hook';
export type ConsolePromptQueueBlockedBy =
  | 'permission_menu'
  | 'hook_notification'
  | 'running_output'
  | 'unknown'
  | 'no_attention_state';

export interface ConsolePromptQueueItem {
  id: string;
  text: string;
  queued_at: number;
  blocked_by: ConsolePromptQueueBlockedBy;
}

export interface ConsolePromptQueueState {
  pending_count: number;
  items: ConsolePromptQueueItem[];
  fallback_enabled: boolean;
  fallback_quiet_ms: number;
  last_flushed_at: number | null;
}

export interface ConsoleAttentionState {
  session_id: string;
  kind: ConsoleAttentionKind;
  source: ConsoleAttentionSource;
  at: number;
  active: boolean;
  screen_excerpt: string;
  clear_conditions: string[];
  detail: {
    provider: ConsoleSession['agent_type'];
    confidence: 'high' | 'medium' | 'low';
    reason: string;
    matched?: string;
  };
  cleared_at?: number;
  cleared_by?:
    | 'screen_changed'
    | 'structured_stream_activity'
    | 'transcript_activity'
    | 'process_exit'
    | 'manual_clear';
}

export interface ConsoleSession {
  id: string;
  label: string;
  command: string;
  args: string[];
  provider_session_id: string | null;
  /** Canonical placement projected from the exact conversation-spawn reservation. */
  canonical_project_id?: string | null;
  canonical_checkout_id?: string | null;
  cwd: string | null;
  env: Record<string, string>;
  cols: number;
  rows: number;
  status: ConsoleSessionStatus;
  pid: number | null;
  exit_code: number | null;
  auto_restart: boolean;
  is_operator: boolean;
  interaction_mode: ConsoleInteractionMode;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  stopped_at: number | null;
  backend_type: 'pty' | 'sdk' | 'spawn' | 'acp';
  transport_lane: ConsoleTransportLane;
  transport_badge: ConsoleTransportBadge;
  allowed_tools: string[] | null;
  /** Explicit provider/backend options that were successfully enforced. */
  run_options: Record<string, import("./session-run-options.js").SessionRunOptionValue>;
  mandible_session_id: string | null;
  /** Bug: 40f0298 — DAG branching: message UUID to resume conversation from. */
  resume_at_message: string | null;
  /** Derived from command and is_operator. Not stored in DB. */
  agent_type: 'claude' | 'codex' | 'gemini' | 'operator' | 'shell';
  /**
   * Issue 8aadf70 — which Anthropic billing path a Claude session lands on
   * (API key present in the spawn environment vs. the local Claude Code
   * subscription credentials). Derived at read time, not stored in DB; null for
   * non-Claude sessions.
   */
  anthropic_billing?: AnthropicBillingPosture | null;
  /** Bug: b5aba0e — channel-enabled PTY: launch with MCP channel server connectivity. */
  channel_enabled: boolean;
  owner_user_id: string | null;
  owner?: ReadUserIdentity | null;
  /**
   * Issue 499c148 — projected from the linked `sessions` row at list time, so
   * a mismatch recorded after the console session was created still shows up.
   */
  identity_mismatch?: SessionIdentityMismatch | null;
  /** Bug: 81c9d85 — derived from backend.processing, not stored in DB. */
  is_processing?: boolean;
  /** Derived from PTY screen state. Not stored in DB. */
  attention?: ConsoleAttentionState | null;
  /** Derived PTY composer prompt queue state. Not stored in DB. */
  prompt_queue?: ConsolePromptQueueState | null;
}

export interface ConsoleSessionInput {
  /** Mandible reservation identity. Only the spawn authority supplies this. */
  id?: string;
  label: string;
  command: string;
  args?: string[];
  cwd?: string | null;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  auto_restart?: boolean;
  is_operator?: boolean;
  interaction_mode?: ConsoleInteractionMode;
  backend_type?: 'pty' | 'sdk' | 'spawn' | 'acp';
  transport_lane?: ConsoleTransportLane;
  allowed_tools?: string[] | null;
  runOptions?: Record<string, import("./session-run-options.js").SessionRunOptionValue>;
  mandible_session_id?: string | null;
  provider_session_id?: string | null;
  resume_at_message?: string | null;
  /** Bug: b5aba0e — channel-enabled PTY: launch with MCP channel server connectivity. */
  channel_enabled?: boolean;
}

export type ConsoleTransportLane = 'sdk' | 'pty' | 'channel' | 'acp' | 'spawn';

export interface ConsoleTransportBadge {
  label: 'SDK' | 'PTY' | 'Channel' | 'ACP' | 'Spawn';
  title: string;
}

// --- Structured console stream events ---

export interface ConsoleContentBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'plan';
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | ConsoleContentBlock[];
}

export interface ConsoleUsage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}

export type ConsoleStreamEvent = {
  type: string;
  session_id?: string;
  subtype?: string;
  parent_tool_use_id?: string | null;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    content?: ConsoleContentBlock[];
    stop_reason?: string | null;
    usage?: ConsoleUsage;
  };
  tools?: string[];
  model?: string;
  result?: string;
  is_error?: boolean;
  duration_ms?: number;
  num_turns?: number;
  cost_usd?: number;
  total_cost_usd?: number;
  errors?: string[];
  usage?: Record<string, unknown>;
  event?: Record<string, unknown>;
  [key: string]: unknown;
};

// --- Graph view types (Bug: 7a141c3, 50c4afb) ---

export type GraphMode =
  | "activity"
  | "issue"
  | "work"
  | "provenance"
  | "provider-lineage"
  | "artifact-lineage";

export type GraphPreset =
  | "activity"
  | "issues"
  | "work"
  | "provenance"
  | "provider-lineage"
  | "artifact-lineage";

export type GraphNodeType =
  | "repo"
  | "issue"
  | "work_unit"
  | "session"
  | "conversation"
  | "auth_request"
  | "branch"
  | "commit"
  | "preset"
  | "provider"
  | "provider_spec"
  | "provider_manifest"
  | "run"
  | "model"
  | "dataset"
  | "analysis"
  | "artifact_bundle"
  | "artifact"
  | "report"
  | "curated_topic"
  | (string & {});

export type GraphEdgeType =
  | "session_issue"
  | "session_parent"
  | "auth_issue"
  | "umbrella_child"
  | "repo_contains_issue"
  | "issue_has_work_unit"
  | "work_unit_uses_branch"
  | "auth_request_references_issue"
  | "provider_emitted_manifest"
  | "manifest_declares"
  | "manifest_references_artifact"
  | "bundle_contains"
  | "produced"
  | "derived_from"
  | "validated_by"
  | "requested_by"
  | "approved_by"
  | "blocks"
  | "implements"
  | "parent"
  | "curated_related"
  | (string & {});

export type GraphEdgeClass = "provenance" | "lifecycle" | "semantic" | "provider" | (string & {});
export type GraphActionKind = "navigate" | "preview" | "validate" | "ingest" | "compute" | "auth_request" | (string & {});
export type GraphEndpointPolicy = "strict" | "include-context";
export type GraphLayoutStrategy = "structured" | "explore";

export interface GraphAction {
  id: string;
  label: string;
  kind: GraphActionKind;
  target?: string;
  requires_auth?: boolean;
  disabled?: boolean;
  description?: string;
}

export interface GraphVisualHint {
  color?: string;
  icon?: string;
  shape?: string;
  size?: number;
}

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  label: string;
  status?: string;
  labels?: string[];
  repo?: string;
  repo_id?: string;
  branch?: string;
  provider_id?: string;
  active?: boolean;
  created_at?: string;
  updated_at?: string;
  summary?: Record<string, unknown>;
  detail?: Record<string, unknown>;
  metrics?: Record<string, number | string | boolean>;
  visual?: GraphVisualHint;
  actions?: GraphAction[];
  source?: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: GraphEdgeType;
  edge_class?: GraphEdgeClass;
  provenance?: string;
  confidence?: string;
  metadata?: Record<string, unknown>;
}

export interface GraphSpec {
  preset?: GraphPreset;
  node_types: GraphNodeType[];
  edge_types: string[];
  edge_classes?: GraphEdgeClass[];
  filters: {
    repos: string[];
    branches: string[];
    since?: string;
    until?: string;
    status: {
      issue?: string[];
      session?: string[];
      auth_request?: string[];
      work_unit?: string[];
      artifact?: string[];
      provider?: string[];
      [nodeType: string]: string[] | undefined;
    };
    search?: string;
  };
  limit: number;
  include_isolates: boolean;
  endpoint_policy: GraphEndpointPolicy;
  layout: {
    strategy: GraphLayoutStrategy;
    primary_edge_types: string[];
  };
}

export interface GraphLegendItem {
  id: string;
  label: string;
  description?: string;
  count: number;
  enabled: boolean;
  visible: boolean;
  visual?: {
    color?: string;
    stroke_width?: number;
    dash?: string;
    opacity?: number;
    route?: "orthogonal" | "smooth" | "bezier";
  };
}

export interface GraphPresetDescriptor {
  id: GraphPreset;
  label: string;
  description: string;
  spec_patch: Partial<GraphSpec>;
}

export interface GraphDisplayCounts {
  total_nodes: number;
  total_edges: number;
  available_nodes: number;
  available_edges: number;
  visible_nodes: number;
  visible_edges: number;
  hidden_edges: number;
  dropped_by_filter: number;
  dropped_by_limit: number;
  isolated_visible: number;
  context_nodes?: number;
}

export interface GraphPayload {
  version?: 1;
  mode?: GraphMode;
  nodes: GraphNode[];
  edges: GraphEdge[];
  modes?: GraphModeDescriptor[];
  spec?: GraphSpec;
  presets?: GraphPresetDescriptor[];
  node_legend?: GraphLegendItem[];
  edge_legend?: GraphLegendItem[];
  counts?: GraphDisplayCounts;
  metadata?: Record<string, unknown>;
  layers?: GraphLayerDescriptor[];
  filters?: {
    repos: string[];
    branches: string[];
  };
  truncated?: boolean;
  limit?: number;
  displayed_count?: number;
  available_count?: number;
}

export interface GraphQueryParams {
  mode?: GraphMode;
  spec?: GraphSpec;
  repo?: string;       // filter by repo name/id
  repos?: string[];    // multi-select repo filter values
  branch?: string;     // filter by branch name (sessions and auth_requests)
  branches?: string[]; // multi-select branch filter values
  since?: string;      // ISO timestamp or relative like "3d", "1w", "2h"
  limit?: number;      // max nodes to return (default 120)
  status?: "open" | "all"; // issue filter only (default 'open')
}

export interface GraphModeDescriptor {
  id: GraphMode;
  label: string;
  kind?: "perspective";
  description: string;
  summary?: string;
  count: number;
  available: boolean;
}

export interface GraphLayerDescriptor {
  id: string;
  label: string;
  count: number;
  enabled: boolean;
}

// --- Provider/artifact substrate types (Bug: 50c4afb) ---

export interface ProviderRecord {
  id: string;
  display_name: string;
  version: string | null;
  status: string;
  transport: string;
  endpoint: string | null;
  capabilities: Record<string, unknown>;
  actions: GraphAction[];
  source: string;
  created_at: number;
  updated_at: number;
  last_seen_at: number | null;
}

export type ArtifactRecoverability =
  | "repo_commit"
  | "repo_worktree"
  | "local_only"
  | "mandible_cas"
  | "provider_store"
  | "external_remote"
  | "regenerable";

export interface ArtifactGitState {
  inside_worktree: boolean;
  repo_root: string | null;
  repo_id: string | null;
  relative_path: string | null;
  commit: string | null;
  branch: string | null;
  tracked: boolean;
  ignored: boolean;
  staged: boolean;
  dirty: boolean;
  status: string | null;
}

export interface ArtifactMaterializationCheck {
  artifact_id: string;
  ref?: string;
  materializable: boolean;
  hash_matches: boolean | null;
  expected_sha256: string | null;
  actual_sha256: string | null;
  source: string | null;
  recoverability: ArtifactRecoverability | null;
  reasons: string[];
  warnings: string[];
}

export interface ArtifactBundleMemberRecord {
  artifact: ArtifactRecord;
  link: ArtifactLinkRecord;
  order: number;
  role: string | null;
}

export interface ArtifactBundleRecord {
  bundle: ArtifactRecord;
  members: ArtifactBundleMemberRecord[];
}

// Stable LOGICAL artifact identity. Separate from the immutable content rows in
// `artifacts`; a series groups multiple `artifact_versions` rows that each pin
// one immutable `artifacts.id`.
export interface ArtifactSeriesRecord {
  id: string;
  /** Canonical author-facing ref, shortened only when it remains unambiguous. */
  ref?: string;
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
}

// A version row under a series. `artifact_id` references an immutable
// `artifacts` row (the source of truth); the version adds provenance/custody
// history without mutating that content row.
export interface ArtifactVersionRecord {
  id: string;
  /** Canonical author-facing ref, shortened only when it remains unambiguous. */
  ref?: string;
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
}

export interface ArtifactVersionHistory {
  series: ArtifactSeriesRecord;
  versions: ArtifactVersionRecord[];
  links: ArtifactLinkRecord[];
}

export type KnowledgeBackrefSourceType = "artifact" | "document";
export type KnowledgeBackrefRefType = "document" | "entity" | "claim";

export interface KnowledgeBackrefRecord {
  id: string;
  source_type: KnowledgeBackrefSourceType;
  source_id: string;
  provider_id: string;
  ref_type: KnowledgeBackrefRefType;
  external_id: string;
  external_ref: string;
  status: "offered" | "indexed" | "returned";
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
}

export interface KnowledgeBackrefInput {
  source_type?: KnowledgeBackrefSourceType | string;
  source_id?: string;
  provider_id?: string;
  ref_type?: KnowledgeBackrefRefType | string;
  external_id?: string;
  external_ref?: string;
  status?: "offered" | "indexed" | "returned" | string;
  metadata?: Record<string, unknown>;
}

export interface ProviderManifestRecord {
  id: string;
  provider_id: string;
  manifest_type: string;
  version: string | null;
  content_hash: string;
  blob_id: string | null;
  source: string;
  content: Record<string, unknown>;
  created_at: number;
}

// --- Webhook event types (Bug: 9f66ad9) ---

export type WebhookPriority = "low" | "normal" | "high";
export type WebhookEventStatus = "pending" | "delivered" | "dismissed";

export interface WebhookEvent {
  source: string;           // "github", "ci", "monitoring", "custom"
  event_type: string;       // "pr_review", "build_failed", "alert", etc.
  data: unknown;            // arbitrary payload
  target_session?: string;  // specific console session ID
  target_issue?: string;    // issue ID (routes via work unit)
  target_branch?: string;   // branch name (routes to sessions on that branch)
  priority?: WebhookPriority;
  title?: string;           // human-readable summary
}

export interface WebhookEventRow {
  id: string;
  source: string;
  event_type: string;
  title: string | null;
  data_json: string;
  target_session: string | null;
  target_issue: string | null;
  target_branch: string | null;
  priority: string;
  status: WebhookEventStatus;
  created_at: number;
  delivered_at: number | null;
  delivered_to: string | null;
}

// --- Auth hook types (Bug: 4afab83) ---

export interface AuthHook {
  id: string;
  repo_pattern: string;        // glob pattern matching repo name, or "*" for all repos
  auth_type: AuthRequestType;  // which auth action type triggers this hook
  command: string;             // shell command to run in the repo directory
  label: string;               // human-readable description
  enabled: boolean;
  builtin: boolean;            // true for system-seeded hooks (non-deletable)
  position: number;            // execution order (lower = first)
  /**
   * Issue 27241e6 — a required hook is part of convergence: while it has not
   * succeeded the request reads `merged / convergence pending|failed` and its
   * deferred issue closures are withheld. An advisory hook (required = false)
   * is reported but never withholds anything.
   */
  required: boolean;
  created_at: number;
  updated_at: number;
}

export interface AuthHookInput {
  repo_pattern: string;
  auth_type: AuthRequestType;
  command: string;
  label: string;
  enabled?: boolean;
  position?: number;
  required?: boolean;
}

export interface AuthHookExecutionResult {
  hook_id: string;
  label: string;
  exit_code: number | null;
  output: string;
  duration_ms: number;
  runtime_delivery?: RuntimeDeliveryReference | null;
}

/**
 * Issue 27241e6 — durable per-request hook execution state.
 *
 * `pending` is runnable, `running` means an attempt was persisted and the
 * process was spawned (a daemon crash leaves the row here), `complete` and
 * `failed` are terminal for this row. `failed` is only reached once the
 * attempt budget is exhausted; before that a failed attempt returns the row to
 * `pending` so a later sweep reruns the hook command — never the merge.
 */
export type AuthHookRunState = "pending" | "running" | "complete" | "failed" | "retired";

export interface AuthHookRunAttempt {
  attempt: number;
  started_at: number;
  finished_at: number;
  exit_code: number | null;
  duration_ms: number;
  outcome: "ok" | "failed" | "timeout" | "spawn_error" | "interrupted";
}

export interface AuthHookRun {
  id: string;
  auth_request_id: string;
  hook_id: string;
  hook_label: string;
  /** Command bytes snapshotted when execution began; retries rerun exactly these. */
  command: string;
  /** SHA-256 of the snapshotted command, so hook edits after the fact are visible. */
  command_digest: string;
  runtime_delivery: RuntimeDeliveryReference | null;
  position: number;
  required: boolean;
  state: AuthHookRunState;
  attempts: number;
  max_attempts: number;
  exit_code: number | null;
  output: string;
  attempt_history: AuthHookRunAttempt[];
  started_at: number | null;
  finished_at: number | null;
  created_at: number;
  updated_at: number;
}

/** Issue 27241e6 — convergence state of one merged auth request. */
export type AuthConvergenceState = "none" | "complete" | "pending" | "failed";

export interface AuthConvergenceHookSummary {
  hook_id: string;
  label: string;
  state: AuthHookRunState;
  required: boolean;
  attempts: number;
  max_attempts: number;
  exit_code: number | null;
  /** The original failure of a failed or retired run; retirement never rewrites it. */
  failure: string | null;
  command_digest: string;
  started_at: number | null;
  finished_at: number | null;
}

export interface AuthConvergence {
  state: AuthConvergenceState;
  hooks: AuthConvergenceHookSummary[];
  runtime_verification?: AuthRuntimeVerification;
}

export interface AuthRuntimeVerification {
  phase: 'verification-pending';
  code: string;
  reason: string;
}

export interface AuthHookAlert {
  id: string;
  auth_request_id: string;
  hook_id: string;
  hook_label: string;
  session_id: string | null;
  repo: string | null;
  detail: string;
  created_at: number;
  updated_at: number;
  acknowledged_at: number | null;
  acknowledged_by: string | null;
}

/** Issue a09b4d2 — a merged self-update whose rebuild or runtime handoff failed. */
export interface RebuildFailure {
  request_id: string;
  message: string;
  failed_at: number;
}
