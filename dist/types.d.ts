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
    last_active: string | null;
    children?: Session[];
}
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
export type AuthRequestStatus = "pending" | "executing" | "approved" | "rejected" | "expired" | "completed" | "dismissed";
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
    depends_on_id?: string | null;
    execution_mode?: AuthExecutionMode;
}
export interface AuthOutputChunk {
    request_id: string;
    stream: "stdout" | "stderr";
    text: string;
    timestamp: number;
}
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
    parent_id?: string;
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
export interface SessionIssueLink {
    session_id: string;
    issue_id: string;
    repo_id: string;
    created_at: number;
}
export interface SseEvent {
    event: string;
    type?: string;
    data: unknown;
}
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
    /** Derived from command and is_operator. Not stored in DB. */
    agent_type: 'claude' | 'codex' | 'operator' | 'shell';
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
}
export interface ClaudeStreamSystemInit {
    type: 'system';
    subtype: 'init';
    session_id: string;
    tools: string[];
    model?: string;
}
export interface ClaudeStreamAssistant {
    type: 'assistant';
    message: {
        id: string;
        role: 'assistant';
        model: string;
        content: ClaudeContentBlock[];
        stop_reason: string | null;
        usage: ClaudeUsage;
    };
    session_id: string;
    parent_tool_use_id: string | null;
}
export interface ClaudeStreamUser {
    type: 'user';
    message: {
        role: 'user';
        content: ClaudeContentBlock[];
    };
    session_id: string;
    parent_tool_use_id: string | null;
}
export interface ClaudeStreamResult {
    type: 'result';
    subtype: 'success' | 'error';
    session_id: string;
    result: string;
    is_error: boolean;
    duration_ms: number;
    num_turns: number;
    cost_usd: number;
}
export interface ClaudeStreamEvent {
    type: 'stream_event';
    event: {
        type: string;
        index?: number;
        delta?: {
            type: string;
            text?: string;
            partial_json?: string;
        };
        content_block?: {
            type: string;
            id?: string;
            name?: string;
        };
    };
    session_id: string;
}
export type ClaudeStreamLine = ClaudeStreamSystemInit | ClaudeStreamAssistant | ClaudeStreamUser | ClaudeStreamResult | ClaudeStreamEvent;
export interface ClaudeContentBlock {
    type: 'text' | 'tool_use' | 'tool_result';
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
    tool_use_id?: string;
    content?: string | ClaudeContentBlock[];
}
export interface ClaudeUsage {
    input_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    output_tokens: number;
}
export type GraphNodeType = "issue" | "session" | "auth_request";
export type GraphEdgeType = "session_issue" | "session_parent" | "auth_issue" | "umbrella_child";
export interface GraphNode {
    id: string;
    type: GraphNodeType;
    label: string;
    status?: string;
    labels?: string[];
    repo?: string;
    branch?: string;
    active?: boolean;
    created_at?: string;
}
export interface GraphEdge {
    id: string;
    source: string;
    target: string;
    type: GraphEdgeType;
}
export interface GraphPayload {
    nodes: GraphNode[];
    edges: GraphEdge[];
}
export interface GraphQueryParams {
    repo?: string;
    branch?: string;
    since?: string;
    limit?: number;
    status?: "open" | "all";
}
