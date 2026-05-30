// --- Core daemon types (P1) ---

export interface SSEEvent {
  type: string;
  data: unknown;
  timestamp: string;
}

export interface StartupCommitInfo {
  hash: string;
  summary: string;
  date: string;
}

export interface HealthResponse {
  status: "ok";
  uptime: number;
  version: string;
  startup_commit: StartupCommitInfo;
  // Bug: 4db692a — true when daemon is about to restart after a self-merge.
  // The UI health poll uses this to avoid reloading prematurely while the
  // daemon is still alive but in the process of shutting down.
  rebuilding?: boolean;
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
  children?: Session[];
}

// --- Starred chat types (P2) ---

export interface StarredChat {
  id: string;
  session_id: string | null;
  label: string;
  notes: string | null;
  transcript_path: string | null;
  cwd: string | null;
  branch: string | null;
  created_at: string;
}

// --- Auth types (P3) ---

export type AuthRequestStatus =
  | "pending"
  | "executing"
  | "approved"   // legacy — kept for DB backward compat, recovery converts to executing
  | "rejected"
  | "expired"
  | "completed"
  | "dismissed";
// Bug: 93c57c4 — outcome is the terminal result of an auth request, distinct from lifecycle status.
// null means the request has not yet reached a terminal state.
export type AuthRequestOutcome =
  | "succeeded"   // completed with exit_code === 0
  | "failed"      // completed with exit_code !== 0
  | "rejected"    // user rejected
  | "dismissed"   // dismissed without executing
  | "expired"     // TTL elapsed before execution
  | null;         // still in lifecycle (pending / executing / approved)
export type AuthExecutionMode = "daemon" | "remote";
// Bug: dd21c1e — generalize auth queue to support action types beyond merges
export type AuthRequestType = "merge" | "commit" | "force-push" | "branch-delete" | "config-change" | "preset-promote" | "data-delete";

export interface AuthRequest {
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
  files_changed?: number;
  additions?: number;
  deletions?: number;
  post_merge_handoff?: string | null;
  issue_references?: string[] | null;
  issue_closures?: string[] | null;
  issue_ids?: string[] | null;
  /** @deprecated Legacy close-on-merge issue list. Use issue_closures. */
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
}

export interface AuthRequestInput {
  session_id?: string | null;
  type?: AuthRequestType;
  command: string;
  title: string;
  cwd?: string | null;
  diff_summary?: string | null;
  commit_message?: string | null;
  spec_content?: string | null;
  repo?: string;
  base_branch?: string;
  head_branch?: string;
  files_changed?: number;
  additions?: number;
  deletions?: number;
  post_merge_handoff?: string | null;
  issue_references?: string[] | null;
  issue_closures?: string[] | null;
  /** @deprecated Legacy close-on-merge issue list. Use issue_closures. */
  issues?: string[] | null;
  depends_on_id?: string | null;
  execution_mode?: AuthExecutionMode;
  // Bug: 4e32923 — scoping fields supplied by the submitting CLI; if null,
  // delivery falls back to legacy broadcast behaviour (pre-migration rows).
  target_session_id?: string | null;
  target_repo_root?: string | null;
  // Bug: 6d7411b — conversation_id persists across Claude Code resumes
  conversation_id?: string | null;
}

export interface AuthOutputChunk {
  request_id: string;
  stream: "stdout" | "stderr";
  text: string;
  timestamp: number;
}

// --- Issue tracking types ---

export interface GitBugIssue {
  id: string;
  repo_id: string;
  repo_name: string;
  title: string;
  status: "open" | "closed";
  labels: string[];
  author: string;
  created_at: string;
  description: string;
  parent_id?: string;  // derived from parent:<human_id> label
}

export interface GitBugIssueDetail extends GitBugIssue {
  comments: GitBugComment[];
}

export interface GitBugComment {
  id: string;
  author: string;
  date: string;
  body: string;
}

export interface IssueRepoSummary {
  repo_id: string;
  repo_name: string;
  repo_root: string;
  open_count: number;
  merged_count: number;
  closed_count: number;
  issues: GitBugIssue[];
}

// --- Session-Issue linking types ---

export interface SessionIssueLink {
  session_id: string;
  issue_id: string;
  repo_id: string;
  created_at: number;
}

// --- SSE event type used by partitions (P2/P3/P4) ---

export interface SseEvent {
  event: string;
  type?: string;
  data: unknown;
}

// --- Console session types (Bug: e980dd8) ---

export type ConsoleSessionStatus = 'running' | 'stopped' | 'crashed';
export type ConsoleInteractionMode = 'inbox_only' | 'direct' | 'both';

export interface ConsoleSession {
  id: string;
  label: string;
  command: string;
  args: string[];
  provider_session_id: string | null;
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
  backend_type: 'pty' | 'sdk' | 'spawn';
  allowed_tools: string[] | null;
  mandible_session_id: string | null;
  /** Bug: 40f0298 — DAG branching: message UUID to resume conversation from. */
  resume_at_message: string | null;
  /** Derived from command and is_operator. Not stored in DB. */
  agent_type: 'claude' | 'codex' | 'gemini' | 'operator' | 'shell';
  /** Bug: b5aba0e — channel-enabled PTY: launch with MCP channel server connectivity. */
  channel_enabled: boolean;
  /** Bug: 81c9d85 — derived from backend.processing, not stored in DB. */
  is_processing?: boolean;
}

export interface ConsoleSessionInput {
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
  backend_type?: 'pty' | 'sdk' | 'spawn';
  allowed_tools?: string[] | null;
  mandible_session_id?: string | null;
  provider_session_id?: string | null;
  resume_at_message?: string | null;
  /** Bug: b5aba0e — channel-enabled PTY: launch with MCP channel server connectivity. */
  channel_enabled?: boolean;
  /** Bug: 61bee4e — Preset IDs to associate with this console session */
  presetIds?: string[];
}

// --- Structured console stream events ---

export interface ConsoleContentBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result';
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

export interface GraphPayload {
  version?: 1;
  mode?: GraphMode;
  nodes: GraphNode[];
  edges: GraphEdge[];
  modes?: GraphModeDescriptor[];
  layers?: GraphLayerDescriptor[];
  filters?: {
    repos: string[];
    branches: string[];
  };
  truncated?: boolean;
}

export interface GraphQueryParams {
  mode?: GraphMode;
  repo?: string;       // filter by repo name/id
  repos?: string[];    // multi-select repo filter values
  branch?: string;     // filter by branch name (sessions and auth_requests)
  branches?: string[]; // multi-select branch filter values
  since?: string;      // ISO timestamp or relative like "3d", "1w", "2h"
  limit?: number;      // max nodes to return (default 50)
  status?: "open" | "all"; // issue filter only (default 'open')
}

export interface GraphModeDescriptor {
  id: GraphMode;
  label: string;
  description: string;
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

export interface ArtifactRecord {
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
  aliases?: ArtifactAliasRecord[];
  links?: ArtifactLinkRecord[];
}

export type ArtifactAliasResolutionStatus = "resolved" | "unresolved" | "ambiguous" | "unsupported";

export interface ArtifactAliasRecord {
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
}

export interface ArtifactLinkRecord {
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
}

export interface ArtifactResolveResult {
  status: ArtifactAliasResolutionStatus;
  ref: string;
  scheme: string;
  normalized_ref: string;
  artifact: ArtifactRecord | null;
  alias: ArtifactAliasRecord;
}

export interface ProviderManifestRecord {
  id: string;
  provider_id: string;
  manifest_type: string;
  version: string | null;
  content_hash: string;
  artifact_id: string | null;
  source: string;
  content: Record<string, unknown>;
  created_at: number;
}

// --- Work-unit types (Bug: a247bc3) ---

export type WorkUnitKind = "solo" | "partition" | "integration";
export type WorkUnitState = "open" | "committed" | "resolved" | "abandoned";

export interface WorkUnit {
  id: string;
  issue_id: string;
  ledger_issue_id: string | null;
  repo_id: string;
  branch: string | null;
  parent_branch: string | null;
  kind: WorkUnitKind;
  state: WorkUnitState;
  assigned_session_id: string | null;
  continuation: string | null;
  continuation_by: string | null;
  continuation_at: number | null;
  created_at: number;
  activated_at: number | null;
  last_commit_at: number | null;
  resolved_at: number | null;
  auth_request_id: string | null;
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
}

export interface AuthHookExecutionResult {
  hook_id: string;
  label: string;
  exit_code: number | null;
  output: string;
  duration_ms: number;
}
