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
