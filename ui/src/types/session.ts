export type IssueLink = {
  issue_id: string;
  repo_id: string;
  created_at: number;
  status?: string;
};

export type ProjectLink = {
  repo_id: string;
  repo_name: string;
};

/**
 * Issue 499c148 — recorded when a session's authenticated client token and its
 * session bindings resolve to different users. Surfacing only: the daemon does
 * not refuse anything on the strength of this flag.
 */
export type SessionIdentityPrincipal = {
  user_id: string;
  slug: string | null;
  kind: 'human' | 'agent' | 'system' | 'external' | null;
  display_name: string | null;
};

export type SessionIdentityMismatch = {
  detected_at: number;
  client_method: 'api_token' | 'ephemeral';
  client: SessionIdentityPrincipal;
  binding: SessionIdentityPrincipal;
  message: string;
};

export type SessionRecord = {
  id?: string;
  session_id?: string;
  status?: string;
  state?: string;
  app?: string;
  agent?: string;
  task?: string;
  intent?: string;
  branch?: string;
  worktree?: string;
  worktree_path?: string;
  cwd?: string;
  created_at?: string;
  started_at?: string;
  start_time?: string;
  ended_at?: string;
  end_time?: string;
  updated_at?: string;
  last_active?: string | null;
  owner_user_id?: string | null;
  owner?: {
    id: string;
    display_name: string;
    kind: 'human' | 'agent' | 'system' | 'external';
  } | null;
  parent_id?: string;
  parentId?: string;
  children?: SessionRecord[];
  pinned?: number;
  nav_metadata_status?: string;
  nav_metadata_attempts?: number;
  nav_metadata_last_error?: string;
  issues?: IssueLink[];
  projects?: ProjectLink[];
  channel_connected_at?: number | null;
  channel_last_tool_call?: number | null;
  identity_mismatch?: SessionIdentityMismatch | null;
  [key: string]: unknown;
};
