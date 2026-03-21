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
export type AuthExecutionMode = "daemon" | "remote";

export interface AuthRequest {
  id: string;
  session_id: string | null;
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
}

export interface AuthRequestInput {
  session_id?: string | null;
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
  issues?: string[] | null;
  depends_on_id?: string | null;
  execution_mode?: AuthExecutionMode;
}

export interface AuthOutputChunk {
  request_id: string;
  stream: "stdout" | "stderr";
  text: string;
  timestamp: number;
}

// --- Issue tracking types (git-bug) ---

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

// --- Graph view types (Bug: 7a141c3) ---

export type GraphNodeType = "issue" | "session" | "auth_request";
export type GraphEdgeType =
  | "session_issue"    // session_issues table row
  | "session_parent"   // sessions.parent_id FK
  | "auth_issue"       // Bug: trailer in auth_requests.commit_message
  | "umbrella_child";  // umbrella issue description references child issue IDs

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  label: string;
  // type-specific metadata for UI rendering:
  status?: string;     // issue status, auth status, session status
  labels?: string[];   // issue labels
  repo?: string;       // repo name
  branch?: string;     // branch name (sessions, auth requests, branches)
  active?: boolean;    // session: currently running (status === 'active')
  created_at?: string; // ISO string or epoch ms depending on source
}

export interface GraphEdge {
  id: string;         // deterministic: `${type}:${source}:${target}`
  source: string;     // node id
  target: string;     // node id
  type: GraphEdgeType;
}

export interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphQueryParams {
  repo?: string;       // filter by repo name/id
  branch?: string;     // filter by branch name (sessions and auth_requests)
  since?: string;      // ISO timestamp or relative like "3d", "1w", "2h"
  limit?: number;      // max nodes to return (default 50)
  status?: "open" | "all"; // issue filter only (default 'open')
}

// --- Work-unit types (Bug: a247bc3) ---

export type WorkUnitKind = "solo" | "partition" | "integration";
export type WorkUnitState = "open" | "committed" | "resolved" | "abandoned";

export interface WorkUnit {
  id: string;
  issue_id: string;
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
