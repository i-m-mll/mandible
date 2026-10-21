// Bug: 1d652d5 — MCP channel server shared types

/** Inbox response from Mandible's GET /api/inbox or /api/inbox/global */
export interface InboxResponse {
  continuations: InboxContinuation[];
  auth_results: InboxAuthResult[];
  open_issues: InboxIssue[];
  work_units: InboxWorkUnit[];
  work_unit_continuations: InboxWorkUnit[];
  pending_webhooks?: InboxWebhookEvent[];
  total: number;
}

export interface InboxWebhookEvent {
  id: string;
  source: string;
  event_type: string;
  title: string | null;
  data: unknown;
  target_issue: string | null;
  target_branch: string | null;
  priority: string;
  status: string;
  created_at: number;
}

export interface InboxContinuation {
  session_id: string;
  continuation: string;
  branch: string;
  ended_at: string;
  repo?: string | null;
}

export interface InboxAuthResult {
  id: string;
  title: string;
  status: string;
  exit_code: number | null;
  error: string | null;
  head_branch: string | null;
  resolved_at: number | null;
  post_merge_handoff?: string | null;
  issue_references?: string[] | null;
  issue_closures?: string[] | null;
  issue_ids?: string[] | null;
  repo?: string | null;
  base_branch?: string | null;
}

export interface InboxIssue {
  id: string;
  title: string;
  labels: string[];
  repo_id?: string;
  repo_name?: string;
}

export interface InboxWorkUnit {
  id: string;
  issue_id: string;
  repo_id: string;
  branch: string | null;
  parent_branch: string | null;
  kind: string;
  state: string;
  assigned_session_id: string | null;
  provider: string | null;
  provider_session_id: string | null;
  worker_provider_session_id: string | null;
  continuation: string | null;
  continuation_by: string | null;
  continuation_at: number | null;
  created_at: number;
  activated_at: number | null;
  last_commit_at: number | null;
  resolved_at: number | null;
  auth_request_id: string | null;
  liveness: {
    state: "live" | "stopped" | "unknown";
    agent_session_id: string | null;
    agent_status: string | null;
    is_processing: boolean;
    last_activity: number | null;
  };
}

/** Auth queue response from GET /api/auth/queue */
export interface AuthQueueResponse {
  requests: AuthQueueRequest[];
}

export interface AuthQueueRequest {
  id: string;
  title: string;
  status: string;
  head_branch?: string | null;
  base_branch?: string | null;
  repo?: string | null;
  created_at: number;
  depends_on_id?: string | null;
  depends_on_status?: string | null;
}

/** Issues list response from GET /api/issues */
export interface IssueRepoSummary {
  repo_id: string;
  repo_name: string;
  repo_root: string;
  open_count: number;
  merged_count: number;
  closed_count: number;
  issues: IssueSummary[];
}

export interface IssueSummary {
  id: string;
  title: string;
  status: string;
  labels: string[];
  author: string;
  created_at: string;
  description: string;
  parent_id?: string;
}

/** Work units response from GET /api/work-units */
export interface WorkUnitsResponse {
  work_units: InboxWorkUnit[];
}

/** Auth request submission response from POST /api/auth/request */
export interface AuthSubmitResponse {
  request_id: string;
}

/** Session update response from PATCH /api/sessions/:id */
export interface SessionUpdateResponse {
  [key: string]: unknown;
}

/** SSE event from Mandible's event stream */
export interface MandibleSSEEvent {
  type: string;
  data: unknown;
  timestamp?: string;
}

/**
 * Bug: 4e32923 — minimal auth_result record returned by
 * GET /api/inbox/undelivered. Used at channel-server startup to replay any
 * auth resolutions that landed while the SSE listener was offline.
 */
export interface UndeliveredAuthResult {
  id: string;
  head_branch: string | null;
  status: string;
  exit_code: number | null;
  resolved_at: number | null;
  title: string | null;
  target_session_id: string | null;
}

export interface UndeliveredResponse {
  undelivered: UndeliveredAuthResult[];
}
