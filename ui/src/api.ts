import type { InboxData } from './views/inbox';
import type { GraphNode, GraphEdge } from './types/graph';
import type { PresetWithNodes, PresetDiff, ConventionSettingLink, SessionValidationResult } from './types/presets';
import type { ProjectTimelineInput, ProjectTimelineProjection } from './types/timeline';
import type {
  ApiList,
  ArtifactAliasRecord as ContractArtifactAliasRecord,
  ArtifactAliasResolutionStatus as ContractArtifactAliasResolutionStatus,
  ArtifactLinkRecord as ContractArtifactLinkRecord,
  ArtifactRecord as ContractArtifactRecord,
  ArtifactResolveResult as ContractArtifactResolveResult,
  AuthRequestAction as ContractAuthRequestAction,
  BlockType as ContractBlockType,
  Conversation as ContractConversation,
  ConversationChild as ContractConversationChild,
  ConversationSource as ContractConversationSource,
  ReviewSpecResponse,
  Role as ContractRole,
  StoredConversationBlock as ContractConversationBlock,
  WorkUnit as ContractWorkUnit,
  WorkUnitKind as ContractWorkUnitKind,
  WorkUnitLiveness as ContractWorkUnitLiveness,
  WorkUnitState as ContractWorkUnitState,
  WorkUnitWithLiveness as ContractWorkUnitWithLiveness,
  Space as ContractSpace,
  SpaceItem as ContractSpaceItem,
  SpaceOccurrence as ContractSpaceOccurrence,
  SpaceEdge as ContractSpaceEdge,
  CreateSpaceRequest,
  UpdateSpaceRequest,
  AddSpaceItemRequest,
  UpdateSpaceItemRequest,
  CreateSpaceOccurrenceRequest,
  UpdateSpaceOccurrenceRequest,
  BatchSpaceOccurrenceEntry,
  BatchSpaceOccurrenceResponse,
  CreateSpaceEdgeRequest,
  UpdateSpaceEdgeRequest,
  AddSpaceItemResponse,
  SeedSpaceRequest,
  SeedSpaceResult,
  ResolverResult,
} from '../../src/contracts';
export type {
  Space,
  SpaceItem,
  SpaceOccurrence,
  SpaceEdge,
  SpaceBlock,
  SpaceExport,
  SpaceRenderer,
  SpaceOccurrenceRenderer,
  SpaceItemRefType,
  CreateSpaceRequest,
  UpdateSpaceRequest,
  AddSpaceItemRequest,
  UpdateSpaceItemRequest,
  CreateSpaceOccurrenceRequest,
  UpdateSpaceOccurrenceRequest,
  BatchSpaceOccurrenceEntry,
  CreateSpaceEdgeRequest,
  UpdateSpaceEdgeRequest,
  SeedSpaceRequest,
  SeedSpaceResult,
  ResolverResult,
  ResolverRefKind,
} from '../../src/contracts';
export type { Preset, PresetNode, LibraryConvention, ConventionSettingLink, SessionValidationWarning, SessionValidationResult } from './types/presets';
export type AuthRequestAction = ContractAuthRequestAction;

export type InstructionTargetMode = 'managed-block' | 'standalone';

export type InstructionTarget = {
  path: string;
  mode: InstructionTargetMode;
};

export type InstructionDeliverySettings = {
  targets: InstructionTarget[];
  postExport: string;
  configuredTargets: boolean;
  export?: {
    ok: boolean;
    stdout: string;
    stderr: string;
  };
  cleanup?: Array<{
    target: InstructionTarget;
    ok: boolean;
    stdout: string;
    stderr: string;
  }>;
};

export type UpdateInstructionDeliveryRequest = {
  targets?: InstructionTarget[];
  postExport?: string;
  cleanupRemovedTargets?: boolean;
  resetToDefaults?: boolean;
};

const DEFAULT_HEADERS = {
  Accept: 'application/json',
};

async function apiGet(path: string): Promise<Response> {
  const response = await fetch(path, { headers: DEFAULT_HEADERS });
  if (!response.ok) {
    await throwOnError(response, 'GET', path);
  }
  return response;
}

async function throwOnError(response: Response, method: string, path: string): Promise<never> {
  let message = `${method} ${path} failed: ${response.status}`;
  try {
    const body = await response.json() as { error?: string; message?: string };
    if (body.error) message = body.error;
    else if (body.message) message = body.message;
  } catch {
    // keep the generic message when the server did not return JSON
  }
  throw new Error(message);
}

async function apiPost(path: string, body?: unknown): Promise<Response> {
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      ...DEFAULT_HEADERS,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    await throwOnError(response, 'POST', path);
  }
  return response;
}

async function apiPatch(path: string, body?: unknown): Promise<Response> {
  const response = await fetch(path, {
    method: 'PATCH',
    headers: {
      ...DEFAULT_HEADERS,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    await throwOnError(response, 'PATCH', path);
  }
  return response;
}

async function apiPut(path: string, body?: unknown): Promise<Response> {
  const response = await fetch(path, {
    method: 'PUT',
    headers: {
      ...DEFAULT_HEADERS,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    await throwOnError(response, 'PUT', path);
  }
  return response;
}

async function apiDelete(path: string): Promise<Response> {
  const response = await fetch(path, {
    method: 'DELETE',
    headers: DEFAULT_HEADERS,
  });
  if (!response.ok) {
    await throwOnError(response, 'DELETE', path);
  }
  return response;
}

function normalizeList<T>(payload: ApiList<T>): T[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  return (
    payload.items ||
    payload.sessions ||
    payload.queue ||
    payload.requests ||
    payload.repos ||
    payload.branches ||
    payload.work_units ||
    payload.hooks ||
    payload.artifacts ||
    payload.conversations ||
    payload.templates ||
    payload.presets ||
    payload.nodes ||
    payload.diffs ||
    []
  );
}

function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined) {
      return;
    }
    searchParams.set(key, String(value));
  });
  const query = searchParams.toString();
  return query ? `?${query}` : '';
}

async function parseMaybeJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return response.text();
}

export async function getSessions<T>(query?: string): Promise<T[]> {
  const response = await apiGet(`/api/sessions${query || ''}`);
  const payload = (await parseMaybeJson(response)) as ApiList<T>;
  return normalizeList(payload);
}

export async function navigateSession(sessionId: string): Promise<void> {
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/navigate`;
  const response = await fetch(path, {
    method: 'POST',
    headers: { ...DEFAULT_HEADERS, 'Content-Type': 'application/json' },
  });
  if (!response.ok) {
    let message = `POST ${path} failed: ${response.status}`;
    try {
      const body = await response.json() as { error?: string; message?: string };
      if (body.message) message = body.message;
      else if (body.error) message = body.error;
    } catch {
      // ignore parse errors — keep the generic message
    }
    throw new Error(message);
  }
}

export async function killSession(sessionId: string): Promise<void> {
  await apiPost(`/api/sessions/${encodeURIComponent(sessionId)}/kill`);
}

export async function patchSession(sessionId: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await apiPatch(`/api/sessions/${encodeURIComponent(sessionId)}`, body);
  return parseMaybeJson(response);
}

export async function getAuthQueue<T>(): Promise<T[]> {
  const response = await apiGet('/api/auth/queue');
  const payload = (await parseMaybeJson(response)) as ApiList<T>;
  return normalizeList(payload);
}

export async function getAuthHistory<T>(limit?: number): Promise<T[]> {
  const query = limit != null ? `?limit=${limit}` : '';
  const response = await apiGet(`/api/auth/history${query}`);
  const payload = (await parseMaybeJson(response)) as ApiList<T>;
  return normalizeList(payload);
}

export async function getAuthRequestActions(requestId: string): Promise<AuthRequestAction[]> {
  const response = await apiGet(`/api/auth/request/${encodeURIComponent(requestId)}/actions`);
  const payload = await parseMaybeJson(response);
  if (payload && typeof payload === 'object' && Array.isArray((payload as { actions?: unknown }).actions)) {
    return (payload as { actions: AuthRequestAction[] }).actions;
  }
  return [];
}

export async function setAuthRequestActionVeto(
  requestId: string,
  actionId: string,
  vetoed: boolean,
): Promise<AuthRequestAction> {
  const response = await apiPost(
    `/api/auth/request/${encodeURIComponent(requestId)}/actions/${encodeURIComponent(actionId)}/veto`,
    { vetoed },
  );
  const payload = await parseMaybeJson(response);
  if (payload && typeof payload === 'object' && (payload as { action?: unknown }).action) {
    return (payload as { action: AuthRequestAction }).action;
  }
  throw new Error('Invalid action veto response.');
}

export async function approveAuthRequest(requestId: string): Promise<void> {
  // Bug: 58d93ee — extract server error message so the dashboard can surface it
  // (e.g. invalid_command: "Auth request has no command set")
  // Bug: 737df04 — wrap in AbortController so the fetch does not hang indefinitely
  // if Mandible is mid-startup-scan and the event loop is saturated.
  const APPROVE_TIMEOUT_MS = 10_000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), APPROVE_TIMEOUT_MS);

  const path = `/api/auth/request/${encodeURIComponent(requestId)}/approve`;
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { ...DEFAULT_HEADERS, 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timeoutId);
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error('Approve timed out — Mandible may be starting up. Try again in a moment.');
    }
    throw e;
  }
  clearTimeout(timeoutId);

  if (!response.ok) {
    let message = `POST ${path} failed: ${response.status}`;
    try {
      const body = await response.json() as { error?: string; message?: string };
      if (body.error) message = body.error;
      else if (body.message) message = body.message;
    } catch {
      // ignore parse errors — keep the generic message
    }
    throw new Error(message);
  }
}

export async function rejectAuthRequest(requestId: string): Promise<void> {
  await apiPost(`/api/auth/request/${encodeURIComponent(requestId)}/reject`);
}

export async function retryAuthRequest(requestId: string): Promise<void> {
  await apiPost(`/api/auth/request/${encodeURIComponent(requestId)}/retry`);
}

export async function dismissAuthRequest(requestId: string): Promise<void> {
  await apiPost(`/api/auth/request/${encodeURIComponent(requestId)}/dismiss`);
}

export type AuthAutoApproveStatus = {
  enabled: boolean;
  lease_id: string | null;
  enabled_until: number | null;
  remaining_ms: number;
  duration_minutes: number;
  signing: {
    provider: string;
    configured: boolean;
    public_key: string | null;
    public_key_path: string;
    encrypted_passphrase_path: string;
    recipient_path: string;
    missing_tools: string[];
  };
};

export async function getAuthAutoApproveStatus(): Promise<AuthAutoApproveStatus> {
  const response = await apiGet('/api/auth/auto-approve');
  return (await parseMaybeJson(response)) as AuthAutoApproveStatus;
}

export async function enableAuthAutoApprove(): Promise<AuthAutoApproveStatus> {
  const response = await apiPost('/api/auth/auto-approve/enable');
  return (await parseMaybeJson(response)) as AuthAutoApproveStatus;
}

export async function disableAuthAutoApprove(): Promise<AuthAutoApproveStatus> {
  const response = await apiPost('/api/auth/auto-approve/disable');
  return (await parseMaybeJson(response)) as AuthAutoApproveStatus;
}

export async function setupDelegatedSigning(input: {
  name?: string;
  email?: string;
  age_recipient?: string;
  overwrite?: boolean;
}): Promise<AuthAutoApproveStatus['signing']> {
  const response = await apiPost('/api/auth/auto-approve/setup', input);
  return (await parseMaybeJson(response)) as AuthAutoApproveStatus['signing'];
}

// Bug: 2c826ca — allow editing auth request fields (commit_message, title, etc.)
// from the dashboard so stale content can be corrected before approval.
export async function updateAuthRequestField(
  requestId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  await apiPut(`/api/auth/request/${encodeURIComponent(requestId)}`, fields);
}

export async function getWorkRepos<T>(): Promise<T[]> {
  const response = await apiGet('/api/work/repos');
  const payload = (await parseMaybeJson(response)) as ApiList<T>;
  return normalizeList(payload);
}

export async function getRepoBranches<T>(repoId: string): Promise<T[]> {
  const response = await apiGet(`/api/work/repos/${encodeURIComponent(repoId)}/branches`);
  const payload = (await parseMaybeJson(response)) as ApiList<T>;
  return normalizeList(payload);
}

export async function getReviewDiff(
  params: Record<string, string | number | boolean | undefined>,
): Promise<string> {
  const response = await apiGet(`/api/review/diff${buildQuery(params)}`);
  const payload = await parseMaybeJson(response);
  if (typeof payload === 'string') {
    return payload;
  }
  if (payload && typeof payload === 'object' && 'html' in payload) {
    return String((payload as { html?: unknown }).html || '');
  }
  return '';
}

export type ReviewSpecPayload = ReviewSpecResponse;

export async function getReviewSpec(
  params: Record<string, string | number | boolean | undefined>,
): Promise<ReviewSpecPayload> {
  const response = await apiGet(`/api/review/spec${buildQuery(params)}`);
  const payload = await parseMaybeJson(response);
  if (typeof payload === 'string') {
    return { markdown: payload, commits: [], meta: {} };
  }
  if (!payload || typeof payload !== 'object') {
    return { markdown: '', commits: [], meta: {} };
  }
  const data = payload as {
    markdown?: string;
    raw?: string;
    spec?: string;
    commits?: string[];
    meta?: Record<string, unknown>;
    content?: string;
  };
  return {
    markdown: data.markdown || data.raw || data.spec || data.content || '',
    commits: Array.isArray(data.commits) ? data.commits : [],
    meta: data.meta ?? {},
  };
}

export async function getIssueRepos<T>(): Promise<T[]> {
  const response = await apiGet('/api/issues');
  const payload = (await parseMaybeJson(response)) as ApiList<T>;
  return normalizeList(payload);
}

export async function getProjectTimeline(
  input: ProjectTimelineInput,
  signal?: AbortSignal,
): Promise<ProjectTimelineProjection> {
  const response = await fetch('/api/timeline/project', {
    method: 'POST',
    headers: {
      ...DEFAULT_HEADERS,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
    signal,
  });
  if (!response.ok) {
    let message = `POST /api/timeline/project failed: ${response.status}`;
    try {
      const body = await response.json() as { error?: string; message?: string };
      message = body.error || body.message || message;
    } catch {
      // keep generic message
    }
    throw new Error(message);
  }
  return (await parseMaybeJson(response)) as ProjectTimelineProjection;
}

export async function getIssueDetail(
  repoId: string,
  issueId: string,
): Promise<unknown> {
  const response = await apiGet(
    `/api/issues/${encodeURIComponent(repoId)}/${encodeURIComponent(issueId)}`,
  );
  return parseMaybeJson(response);
}

export async function findIssue(issueId: string): Promise<unknown> {
  const response = await apiGet(`/api/issues/find/${encodeURIComponent(issueId)}`);
  return parseMaybeJson(response);
}

export async function issueAction(
  repoId: string,
  issueId: string,
  action: string,
  body: unknown,
): Promise<void> {
  await apiPost(
    `/api/issues/${encodeURIComponent(repoId)}/${encodeURIComponent(issueId)}/${action}`,
    body,
  );
}

export async function scanIssues<T>(): Promise<T[]> {
  const response = await apiPost('/api/issues/scan');
  const payload = (await parseMaybeJson(response)) as ApiList<T>;
  return normalizeList(payload);
}

/** Force-scan a single repo by ID. Used to unblock deep-link 404s on daemon reload. */
export async function scanIssueRepo(repoId: string): Promise<void> {
  await apiPost(`/api/issues/${encodeURIComponent(repoId)}/scan`);
}

export async function triggerWorkScan(): Promise<void> {
  await apiPost('/api/work/scan');
}

export async function openPath(targetPath: string): Promise<void> {
  await apiPost('/api/system/open-path', { path: targetPath });
}

export { buildQuery };

// ── Push/Sync API ── Bug: b5abaea

export async function pushRepos(scope: "current" | "all_ahead", repoIds?: string[]): Promise<unknown> {
  const response = await apiPost("/api/work/push", { scope, repo_ids: repoIds });
  return parseMaybeJson(response);
}

export async function pushRepo(repoId: string, scope: "current" | "all_ahead"): Promise<unknown> {
  const response = await apiPost(`/api/work/repos/${encodeURIComponent(repoId)}/push`, { scope });
  return parseMaybeJson(response);
}

export async function getPushStatus(): Promise<unknown> {
  const response = await apiGet("/api/work/push/status");
  return parseMaybeJson(response);
}

// ── Inbox API ──

export async function getInboxGlobal(): Promise<InboxData> {
  const res = await apiGet('/api/inbox/global');
  return (await parseMaybeJson(res)) as InboxData;
}

export async function acknowledgeInboxItem(
  type: 'continuation' | 'auth_result',
  id: string,
): Promise<void> {
  await apiPost(`/api/inbox/${type}/${encodeURIComponent(id)}/ack`, {});
}

export async function ackAllInbox(): Promise<void> {
  await apiPost('/api/inbox/ack-all');
}

export async function getSessionIssues(sessionId: string): Promise<unknown[]> {
  const response = await apiGet(`/api/sessions/${encodeURIComponent(sessionId)}/issues`);
  const payload = await parseMaybeJson(response);
  return Array.isArray(payload) ? payload : [];
}

// Bug: 84cd5ae — issue context hub aggregation
export type IssueContextLiveness = {
  has_live_agent: boolean;
  agent_status: string | null;
  is_processing: boolean;
  last_activity: string | null;
};

export type IssueContextWorkUnit = {
  branch: string | null;
  state: string;
  continuation: string | null;
  assigned_session_id: string | null;
  liveness: IssueContextLiveness;
};

export type IssueContextSession = {
  session_id: string;
  status: string;
  created_at: string | null;
  app: string;
  has_conversation: boolean;
};

export type IssueContextAuthRequest = {
  id: string;
  title: string;
  status: string;
  head_branch: string | null;
  created_at: number | null;
};

export type IssueContextBranchInfo = {
  ahead: number;
  behind: number;
  last_commit_date: string | null;
};

export type IssueContext = {
  issue: unknown;
  work_unit: IssueContextWorkUnit | null;
  sessions: IssueContextSession[];
  auth_requests: IssueContextAuthRequest[];
  branch_info: IssueContextBranchInfo | null;
};

export async function getIssueContext(repoId: string, issueId: string): Promise<IssueContext> {
  const response = await apiGet(
    `/api/issues/${encodeURIComponent(repoId)}/${encodeURIComponent(issueId)}/context`
  );
  return (await parseMaybeJson(response)) as IssueContext;
}

export type LedgerActorType = 'mandible_user' | 'agent' | 'system' | 'external_adapter';

export type LedgerIssueDetailActor = {
  id: string | null;
  type: LedgerActorType;
  display: string;
};

export type LedgerIssueDetailComment = {
  id: string;
  ordinal: number;
  body: string;
  author: LedgerIssueDetailActor;
  source: string;
  created_at: number;
  updated_at: number | null;
};

export type LedgerIssueDetailCheckpoint = {
  id: string;
  issue_id: string;
  kind: string;
  payload: unknown;
  author: LedgerIssueDetailActor;
  source: string;
  created_at: number;
};

export type LedgerIssueTimelineEntry =
  | {
      id: string;
      kind: 'body';
      ordinal: 0;
      body: string;
      author: LedgerIssueDetailActor;
      source: string;
      created_at: number;
      updated_at: number | null;
    }
  | {
      id: string;
      kind: 'comment';
      comment_id: string;
      ordinal: number;
      body: string;
      author: LedgerIssueDetailActor;
      source: string;
      created_at: number;
      updated_at: number | null;
    }
  | {
      id: string;
      kind: 'state';
      event_type: string;
      status: string | null;
      resolution: string | null;
      author: LedgerIssueDetailActor;
      source: string;
      created_at: number;
      payload: Record<string, unknown>;
    }
  | {
      id: string;
      kind: 'checkpoint';
      checkpoint_id: string;
      checkpoint_kind: string;
      payload: unknown;
      author: LedgerIssueDetailActor;
      source: string;
      created_at: number;
    };

export type LedgerIssueSummaryRef = {
  id: string;
  display_id: string;
  project_id: string;
  title: string;
  status: string;
  resolution: string | null;
  kind: string;
  priority: string;
  labels: string[];
};

export type LedgerIssueDetailRelationship = {
  id: string;
  direction: 'incoming' | 'outgoing';
  relationship_type: string;
  provenance: string;
  confidence: string;
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
  related_issue: LedgerIssueSummaryRef | null;
};

export type LedgerIssueDetailLiveness = {
  has_live_agent: boolean;
  agent_session_id: string | null;
  agent_status: string | null;
  is_processing: boolean;
  last_activity: number | null;
};

export type LedgerIssueDetailWorkUnit = {
  id: string;
  issue_id: string;
  ledger_issue_id: string | null;
  repo_id: string;
  branch: string | null;
  parent_branch: string | null;
  kind: string;
  state: string;
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
  link_type: string;
  link_source: string;
  link_created_at: number | null;
  last_seen_at: number | null;
  metadata: Record<string, unknown>;
  liveness: LedgerIssueDetailLiveness;
};

export type LedgerIssueDetailSession = {
  id: string;
  app: string;
  parent_id: string | null;
  status: string;
  branch: string | null;
  worktree: string | null;
  task: string | null;
  description: string | null;
  agent_type: string | null;
  created_at: string | null;
  updated_at: string | null;
  ended_at: string | null;
  last_active: string | null;
  has_conversation: boolean;
  link_type: string;
  link_source: string;
  link_created_at: number | null;
  last_seen_at: number | null;
  metadata: Record<string, unknown>;
};

export type LedgerIssueDetailAuthRequest = {
  id: string;
  type: string;
  title: string;
  status: string;
  repo: string | null;
  base_branch: string | null;
  head_branch: string | null;
  created_at: number | null;
  approved_at: number | null;
  resolved_at: number | null;
  skipped_at: number | null;
  exit_code: number | null;
  error: string | null;
  link_type: string;
  link_source: string;
  link_created_at: number | null;
  metadata: Record<string, unknown>;
};

export type LedgerIssueDetailConflict = {
  id: string;
  adapter: string;
  entity_type: string;
  entity_id: string;
  field: string;
  local_value: unknown;
  remote_value: unknown;
  base_value: unknown;
  status: string;
  resolution: string | null;
  created_at: number;
  resolved_at: number | null;
};

export type LedgerIssueDetailArtifactLink = {
  id: string;
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

export type LedgerIssueDetailAssociatedArtifact = {
  id: string;
  algorithm: string;
  content_hash: string;
  uri: string;
  media_type: string | null;
  role: string | null;
  provider_id: string | null;
  manifest_id: string | null;
  custody_mode: 'link' | 'copy' | 'managed' | 'external';
  availability: 'present' | 'missing' | 'stale' | 'unchecked' | 'remote_only' | 'pinned';
  created_at: number;
  refs: string[];
  links: LedgerIssueDetailArtifactLink[];
};

export type LedgerIssueDetailProjection = {
  id: string;
  display_id: string;
  project: {
    id: string;
    display_name: string;
    remote_identity: string;
    upstream_identity: string;
    repo_id: string | null;
    repo_name: string | null;
    repo_root: string | null;
    default_branch: string | null;
  };
  title: string;
  body: string;
  status: 'open' | 'closed';
  resolution: string | null;
  kind: string;
  priority: string;
  source: string;
  author: LedgerIssueDetailActor;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  aliases: Array<{ kind: string; alias: string; external_id: string; source: string; primary: boolean }>;
  labels: string[];
  comments: LedgerIssueDetailComment[];
  checkpoints: LedgerIssueDetailCheckpoint[];
  timeline: LedgerIssueTimelineEntry[];
  relationships: LedgerIssueDetailRelationship[];
  work_units: LedgerIssueDetailWorkUnit[];
  sessions: LedgerIssueDetailSession[];
  auth_requests: LedgerIssueDetailAuthRequest[];
  associated_artifacts?: LedgerIssueDetailAssociatedArtifact[];
  conflicts: LedgerIssueDetailConflict[];
  sync: {
    state: 'clean' | 'pending' | 'failed' | 'conflicted';
    outbox: Record<string, number>;
    open_conflicts: number;
    latest_jobs: Array<{
      id: string;
      adapter: string;
      direction: string;
      status: string;
      attempt_count: number;
      started_at: number | null;
      finished_at: number | null;
      last_error: string | null;
      updated_at: number;
    }>;
  };
};

export type LedgerBodyRevision = {
  id: string;
  entity_type: 'issue_body' | 'comment_body';
  entity_id: string;
  issue_id: string;
  project_id: string;
  revision_no: number;
  event_id: string | null;
  actor_id: string | null;
  actor_type: string;
  source: string;
  reason: string;
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
  redaction_reason: string | null;
};

export async function getLedgerIssueDetail(issueId: string): Promise<LedgerIssueDetailProjection> {
  const response = await apiGet(`/api/ledger/issues/${encodeURIComponent(issueId)}`);
  return (await parseMaybeJson(response)) as LedgerIssueDetailProjection;
}

export async function getLedgerIssueBodyRevisions(issueId: string): Promise<LedgerBodyRevision[]> {
  const response = await apiGet(`/api/ledger/issues/${encodeURIComponent(issueId)}/body/revisions`);
  const payload = (await parseMaybeJson(response)) as { revisions?: LedgerBodyRevision[] };
  return payload.revisions ?? [];
}

export async function getLedgerCommentBodyRevisions(commentId: string): Promise<LedgerBodyRevision[]> {
  const response = await apiGet(`/api/ledger/comments/${encodeURIComponent(commentId)}/revisions`);
  const payload = (await parseMaybeJson(response)) as { revisions?: LedgerBodyRevision[] };
  return payload.revisions ?? [];
}

export async function getLedgerBodyRevision(revisionId: string): Promise<LedgerBodyRevision> {
  const response = await apiGet(`/api/ledger/body-revisions/${encodeURIComponent(revisionId)}`);
  const payload = (await parseMaybeJson(response)) as { revision?: LedgerBodyRevision };
  return payload.revision as LedgerBodyRevision;
}

export async function getLedgerIssueDetailByRef(
  repoId: string,
  issueId: string,
): Promise<LedgerIssueDetailProjection> {
  const response = await apiGet(
    `/api/issues/${encodeURIComponent(repoId)}/${encodeURIComponent(issueId)}/ledger-detail`
  );
  return (await parseMaybeJson(response)) as LedgerIssueDetailProjection;
}

export async function addLedgerIssueComment(
  issueId: string,
  body: string,
): Promise<LedgerIssueDetailProjection> {
  const response = await apiPost(`/api/ledger/issues/${encodeURIComponent(issueId)}/comments`, { body });
  return (await parseMaybeJson(response)) as LedgerIssueDetailProjection;
}

export async function patchLedgerComment(
  commentId: string,
  body: Record<string, unknown>,
): Promise<LedgerIssueDetailProjection> {
  const response = await apiPatch(`/api/ledger/comments/${encodeURIComponent(commentId)}`, body);
  return (await parseMaybeJson(response)) as LedgerIssueDetailProjection;
}

export async function patchLedgerIssue(
  issueId: string,
  body: Record<string, unknown>,
): Promise<LedgerIssueDetailProjection> {
  const response = await apiPatch(`/api/ledger/issues/${encodeURIComponent(issueId)}`, body);
  return (await parseMaybeJson(response)) as LedgerIssueDetailProjection;
}

export async function setLedgerIssueLabel(
  issueId: string,
  label: string,
  present: boolean,
): Promise<LedgerIssueDetailProjection> {
  const response = await apiPost(`/api/ledger/issues/${encodeURIComponent(issueId)}/labels`, { label, present });
  return (await parseMaybeJson(response)) as LedgerIssueDetailProjection;
}

export async function resolveLedgerConflict(
  conflictId: string,
  resolution: string,
  status: 'resolved' | 'dismissed' = 'resolved',
): Promise<unknown> {
  const response = await apiPost(
    `/api/ledger/conflicts/${encodeURIComponent(conflictId)}/resolve`,
    { resolution, status },
  );
  return parseMaybeJson(response);
}

export async function getIssueSessions(repoId: string, issueId: string): Promise<unknown[]> {
  const response = await apiGet(
    `/api/issues/${encodeURIComponent(repoId)}/${encodeURIComponent(issueId)}/sessions`
  );
  const payload = await parseMaybeJson(response);
  return Array.isArray(payload) ? payload : [];
}

// Bug: cbbb3d9 — spawn SDK console session from issue hub
export type SpawnIssueAgentResult = {
  console_session_id: string;
  continuation: string | null;
  branch: string | null;
  cwd: string | null;
};

export async function spawnIssueAgent(
  repoId: string,
  issueId: string,
  label?: string,
): Promise<SpawnIssueAgentResult> {
  const response = await apiPost(
    `/api/issues/${encodeURIComponent(repoId)}/${encodeURIComponent(issueId)}/spawn`,
    label ? { label } : {},
  );
  return (await parseMaybeJson(response)) as SpawnIssueAgentResult;
}

export async function getStarredChats<T>(): Promise<T[]> {
  const response = await apiGet('/api/chats/starred');
  const payload = (await parseMaybeJson(response)) as ApiList<T>;
  return normalizeList(payload);
}

export async function starChat(
  data: {
    session_id?: string;
    label: string;
    notes?: string;
    transcript_path?: string;
    cwd?: string;
    branch?: string;
  },
): Promise<{ id: string }> {
  const response = await apiPost('/api/chats/star', data);
  const payload = await parseMaybeJson(response);
  if (payload && typeof payload === 'object' && 'id' in payload) {
    return payload as { id: string };
  }
  return { id: '' };
}

export async function unstarChat(id: string): Promise<void> {
  await apiDelete(`/api/chats/starred/${encodeURIComponent(id)}`);
}

export async function updateStarredChat(
  id: string,
  data: { label?: string; notes?: string },
): Promise<void> {
  await apiPatch(`/api/chats/starred/${encodeURIComponent(id)}`, data);
}

export async function getSettings(): Promise<Record<string, string>> {
  const response = await apiGet('/api/settings');
  const payload = await parseMaybeJson(response);
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return payload as Record<string, string>;
  }
  return {};
}

export async function updateSetting(key: string, value: string): Promise<void> {
  const response = await fetch(`/api/settings/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: {
      ...DEFAULT_HEADERS,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ value }),
  });
  if (!response.ok) {
    throw new Error(`PUT /api/settings/${key} failed: ${response.status}`);
  }
}

export async function getInstructionDeliverySettings(): Promise<InstructionDeliverySettings> {
  const response = await apiGet('/api/settings/instructions-delivery');
  return await parseMaybeJson(response) as InstructionDeliverySettings;
}

export async function updateInstructionDeliverySettings(
  request: UpdateInstructionDeliveryRequest,
): Promise<InstructionDeliverySettings> {
  const response = await fetch('/api/settings/instructions-delivery', {
    method: 'PUT',
    headers: {
      ...DEFAULT_HEADERS,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  });
  const payload = await parseMaybeJson(response);
  if (!response.ok) {
    const record = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
    throw new Error(typeof record.error === 'string' ? record.error : `PUT /api/settings/instructions-delivery failed: ${response.status}`);
  }
  return payload as InstructionDeliverySettings;
}

// ── Console API ──

export async function getConsoleSessions<T>(): Promise<T[]> {
  const response = await apiGet('/api/console/sessions');
  const payload = (await parseMaybeJson(response)) as ApiList<T>;
  return normalizeList(payload);
}

export async function restartConsoleSession(sessionId: string): Promise<void> {
  await apiPost(`/api/console/sessions/${encodeURIComponent(sessionId)}/restart`);
}

export async function startConsoleSession(sessionId: string): Promise<void> {
  await apiPost(`/api/console/sessions/${encodeURIComponent(sessionId)}/start`);
}

export type ConsoleBackendType = 'pty' | 'sdk' | 'spawn';
export type ConsolePermissionDecision = 'deny' | 'allow' | 'allow_always';

export type ConsolePermissionRequest = {
  id: string;
  session_id: string;
  tool_name: string;
  tool_input: unknown;
  created_at: number;
  expires_at: number;
  title?: string;
  display_name?: string;
  description?: string;
  blocked_path?: string;
  decision_reason?: string;
  agent_id?: string;
};

export type ConsoleSessionOptions = {
  model?: string;
  systemPrompt?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions';
  allowedTools?: string[];
  maxTurns?: number;
  maxCostUsd?: number;
  /** Bug: 790433d — Preset IDs for dynamic preset switching (SDK only) */
  presetIds?: string[];
};

export async function createConsoleSession(
  label: string,
  backend: string,
  kind: string,
  backendType?: ConsoleBackendType,
  options?: { channel_enabled?: boolean },
): Promise<{ session: {
  id: string;
  label: string;
  agent_type: string;
  interaction_mode: 'inbox_only' | 'direct' | 'both';
  pinned: boolean;
  status: 'running' | 'stopped' | 'crashed';
  is_operator: boolean;
  provider_session_id: string | null;
  unread_count: number;
  created_at: number;
  started_at: number | null;
  stopped_at: number | null;
  command: string;
  args: string[];
  backend_type: ConsoleBackendType;
  allowed_tools: string[] | null;
  mandible_session_id: string | null;
} }> {
  // Bug: b949700 — translate agent_type to command+args as required by backend
  type SessionBody = {
    label: string;
    command: string;
    args: string[];
    cwd?: string;
    auto_restart?: boolean;
    is_operator?: boolean;
    backend_type?: ConsoleBackendType;
    channel_enabled?: boolean;
  };
  const body: SessionBody = { label, command: '', args: [] };
  if (options?.channel_enabled) {
    body.channel_enabled = true;
  }
  if (kind === 'operator') {
    body.command = 'claude';
    body.args = backendType === 'sdk' ? [] : ['--dangerously-skip-permissions'];
    body.auto_restart = true;
    body.is_operator = true;
    body.backend_type = backendType ?? 'sdk';
  } else if (backend === 'claude') {
    body.command = 'claude';
    body.args = backendType === 'sdk' ? [] : ['--dangerously-skip-permissions'];
    body.backend_type = backendType ?? 'sdk';
  } else if (backend === 'codex') {
    body.command = 'codex';
    body.args = [];
    body.backend_type = 'spawn';
  } else if (backend === 'gemini') {
    body.command = 'gemini';
    body.args = ['-y'];
    body.backend_type = 'spawn';
  } else {
    throw new Error(`Unsupported backend: ${backend}`);
  }
  const response = await apiPost('/api/console/sessions', body);
  const json = await parseMaybeJson(response);
  return json as {
    session: {
      id: string;
      label: string;
      agent_type: string;
      interaction_mode: 'inbox_only' | 'direct' | 'both';
      pinned: boolean;
      status: 'running' | 'stopped' | 'crashed';
      is_operator: boolean;
      provider_session_id: string | null;
      unread_count: number;
      created_at: number;
      started_at: number | null;
      stopped_at: number | null;
      command: string;
      args: string[];
      backend_type: ConsoleBackendType;
      allowed_tools: string[] | null;
      mandible_session_id: string | null;
    };
  };
}

export async function closeConsoleSession(sessionId: string): Promise<void> {
  await apiDelete(`/api/console/sessions/${encodeURIComponent(sessionId)}`);
}

export async function getConsoleStreamEvents<T = unknown>(
  sessionId: string,
  limit = 500,
): Promise<T[]> {
  const response = await apiGet(
    `/api/console/sessions/${encodeURIComponent(sessionId)}/events?limit=${encodeURIComponent(String(limit))}`
  );
  const payload = await parseMaybeJson(response) as { events?: T[] } | T[];
  if (Array.isArray(payload)) return payload;
  return payload.events ?? [];
}

/**
 * Send a prompt to a console session via the non-PTY subprocess mechanism.
 * Bug: a97f54b — --output-format stream-json requires -p; the PTY emits no JSON.
 * This spawns a separate `claude -p --continue --output-format stream-json` process
 * on the server and feeds its output through the SSE console:stream_event pipeline.
 * Returns immediately (202); events arrive asynchronously via SSE.
 */
export async function sendConsolePrompt(
  sessionId: string,
  prompt: string,
): Promise<void> {
  await apiPost(
    `/api/console/sessions/${encodeURIComponent(sessionId)}/prompt`,
    { prompt },
  );
}

export async function updateConsoleSession(
  sessionId: string,
  body: { model?: string; label?: string },
): Promise<unknown> {
  const response = await apiPatch(`/api/console/sessions/${encodeURIComponent(sessionId)}`, body);
  return parseMaybeJson(response);
}

export async function getConsolePermissions(
  sessionId: string,
): Promise<ConsolePermissionRequest[]> {
  const response = await apiGet(`/api/console/sessions/${encodeURIComponent(sessionId)}/permissions`);
  const payload = await parseMaybeJson(response) as {
    requests?: ConsolePermissionRequest[];
  } | ConsolePermissionRequest[];
  if (Array.isArray(payload)) {
    return payload;
  }
  return payload.requests ?? [];
}

export async function respondToConsolePermission(
  sessionId: string,
  requestId: string,
  decision: ConsolePermissionDecision,
): Promise<void> {
  await apiPost(
    `/api/console/sessions/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}`,
    { decision },
  );
}

export async function updateConsoleSessionOptions(
  sessionId: string,
  body: ConsoleSessionOptions,
): Promise<unknown> {
  const response = await apiPatch(`/api/console/sessions/${encodeURIComponent(sessionId)}/options`, body);
  return parseMaybeJson(response);
}

export async function getConsoleSessionUsage<T = Record<string, unknown>>(
  sessionId: string,
): Promise<T[]> {
  const response = await apiGet(`/api/console/sessions/${encodeURIComponent(sessionId)}/usage`);
  const payload = await parseMaybeJson(response) as { usage?: T[] } | T[];
  if (Array.isArray(payload)) {
    return payload;
  }
  return payload.usage ?? [];
}

// ── Message params API (Bug: 790433d) ──

export type MessageParams = {
  id: number;
  session_id: string;
  message_index: number;
  model: string | null;
  permission_mode: string | null;
  max_turns: number | null;
  max_cost_usd: number | null;
  preset_ids: string | null;
  allowed_tools: string | null;
  created_at: number;
};

/**
 * Keyframe lookup: returns the effective parameters at a given message index.
 * If no message_index is provided, returns all snapshots for the session.
 */
export async function getMessageParams(
  sessionId: string,
  messageIndex?: number,
): Promise<MessageParams | MessageParams[] | null> {
  const qs = messageIndex !== undefined ? `?message_index=${messageIndex}` : '';
  const response = await apiGet(
    `/api/console/sessions/${encodeURIComponent(sessionId)}/params${qs}`,
  );
  const payload = await parseMaybeJson(response) as { params: MessageParams | MessageParams[] | null };
  return payload.params;
}

// ── Backup API ──

export type BackupStatus = {
  enabled: boolean;
  interval_hours: number;
  destination: string;
  last_run_at: number | null;
  last_size_bytes: number | null;
  last_error: string | null;
};

export async function getBackupStatus(): Promise<BackupStatus> {
  const response = await apiGet('/api/backup/status');
  return (await parseMaybeJson(response)) as BackupStatus;
}

export async function runBackupNow(): Promise<{
  ok: boolean;
  size_bytes?: number;
  path?: string;
  destination?: string;
  error?: string;
}> {
  const response = await apiPost('/api/backup/run');
  return (await parseMaybeJson(response)) as {
    ok: boolean;
    size_bytes?: number;
    path?: string;
    destination?: string;
    error?: string;
  };
}

export async function updateBackupSettings(settings: {
  enabled?: boolean;
  interval_hours?: number;
  destination?: string;
}): Promise<void> {
  const response = await fetch('/api/backup/settings', {
    method: 'PUT',
    headers: {
      ...DEFAULT_HEADERS,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(settings),
  });
  if (!response.ok) {
    throw new Error(`PUT /api/backup/settings failed: ${response.status}`);
  }
}


// ── Conversations API ──

export async function getConversations(params?: {
  source?: string;
  starred?: boolean;
  search?: string;
  offset?: number;
  limit?: number;
  sort?: string;
  min_blocks?: number;
  group?: boolean;
  exclude_subagents?: boolean;
  parent_id?: string;
  session_id?: string;
}): Promise<{ conversations: Conversation[]; total: number }> {
  const query = new URLSearchParams();
  if (params?.source) query.set('source', params.source);
  if (params?.starred) query.set('starred', '1');
  if (params?.search) query.set('search', params.search);
  if (params?.offset != null) query.set('offset', String(params.offset));
  if (params?.limit) query.set('limit', String(params.limit));
  if (params?.sort) query.set('sort', params.sort);
  if (params?.min_blocks) query.set('min_blocks', String(params.min_blocks));
  if (params?.group) query.set('group', 'true');
  if (params?.exclude_subagents) query.set('exclude_subagents', 'true');
  if (params?.parent_id) query.set('parent_id', params.parent_id);
  if (params?.session_id) query.set('session_id', params.session_id);
  const qs = query.toString();
  const resp = await apiGet(`/api/conversations${qs ? '?' + qs : ''}`);
  return (await parseMaybeJson(resp)) as { conversations: Conversation[]; total: number };
}

export async function getConversation(id: string, leaf?: string): Promise<Conversation & { blocks: ConversationBlock[]; children: ConversationChild[] }> {
  const query = leaf ? `?leaf=${encodeURIComponent(leaf)}` : '';
  const resp = await apiGet(`/api/conversations/${encodeURIComponent(id)}${query}`);
  const payload = (await parseMaybeJson(resp)) as {
    conversation?: Conversation;
    blocks?: ConversationBlock[];
    children?: ConversationChild[];
  };
  // Flatten: merge top-level conversation fields with blocks/children arrays
  return {
    ...(payload.conversation ?? {} as Conversation),
    blocks: payload.blocks ?? [],
    children: payload.children ?? [],
  } as Conversation & { blocks: ConversationBlock[]; children: ConversationChild[] };
}

export async function getConversationBlocks(id: string, params?: {
  types?: string;
  offset?: number;
  limit?: number;
}): Promise<{ blocks: ConversationBlock[]; total: number }> {
  const query = new URLSearchParams();
  if (params?.types) query.set('types', params.types);
  if (params?.offset) query.set('offset', String(params.offset));
  if (params?.limit) query.set('limit', String(params.limit));
  const qs = query.toString();
  const resp = await apiGet(`/api/conversations/${encodeURIComponent(id)}/blocks${qs ? '?' + qs : ''}`);
  return (await parseMaybeJson(resp)) as { blocks: ConversationBlock[]; total: number };
}

export async function updateConversation(id: string, data: { starred?: boolean; label?: string; notes?: string }): Promise<Conversation> {
  const resp = await apiPatch(`/api/conversations/${encodeURIComponent(id)}`, data);
  return (await parseMaybeJson(resp)) as Conversation;
}

export async function exportConversationBlocks(id: string, data: {
  block_ids: string[];
  format: 'mdx' | 'markdown' | 'json';
}): Promise<{ content: string; filename: string }> {
  const resp = await apiPost(`/api/conversations/${encodeURIComponent(id)}/export`, data);
  return (await parseMaybeJson(resp)) as { content: string; filename: string };
}

export async function transformExport(data: {
  content: string;
  prompt: string;
}): Promise<{ transformed: string }> {
  const resp = await apiPost('/api/conversations/export/transform', data);
  return (await parseMaybeJson(resp)) as { transformed: string };
}

export async function triggerIngestion(source?: string): Promise<{ ingested: number; updated: number; errors: string[] }> {
  const resp = await apiPost('/api/conversations/ingest', source ? { source } : {});
  return (await parseMaybeJson(resp)) as { ingested: number; updated: number; errors: string[] };
}

// Bug: 40f0298 — DAG branching: fork points, fork, and resume API

export type ForkBranch = {
  dag_uuid: string;
  first_text: string;
  block_count: number;
};

export type ForkPoint = {
  parent_dag_uuid: string;
  branches: ForkBranch[];
};

export type ForkData = {
  forks: ForkPoint[];
};

export async function getConversationForks(conversationId: string): Promise<ForkData> {
  const resp = await apiGet(`/api/conversations/${encodeURIComponent(conversationId)}/forks`);
  return (await parseMaybeJson(resp)) as ForkData;
}

export async function forkConversation(
  conversationId: string,
  messageDagUuid: string,
): Promise<{ session_id: string }> {
  const resp = await apiPost(`/api/conversations/${encodeURIComponent(conversationId)}/fork`, {
    message_dag_uuid: messageDagUuid,
  });
  return (await parseMaybeJson(resp)) as { session_id: string };
}

export async function resumeConversation(
  conversationId: string,
  messageDagUuid: string,
  label?: string,
  model?: string,
): Promise<{ console_session_id: string }> {
  const resp = await apiPost(`/api/conversations/${encodeURIComponent(conversationId)}/resume`, {
    message_dag_uuid: messageDagUuid,
    label,
    ...(model ? { model } : {}),
  });
  return (await parseMaybeJson(resp)) as { console_session_id: string };
}

// ── Work Units API — Bug: 8a281b3 ──

export type WorkUnitKind = ContractWorkUnitKind;
export type WorkUnitState = ContractWorkUnitState;

export type WorkUnitLiveness = ContractWorkUnitLiveness;

export type WorkUnit = ContractWorkUnit;

export type WorkUnitWithLiveness = ContractWorkUnitWithLiveness;

export type WorkUnitFilters = {
  state?: WorkUnitState;
  repo_id?: string;
  branch?: string;
  issue_id?: string;
};

export type WorkUnitPatch = {
  state?: WorkUnitState;
  assigned_session_id?: string | null;
  continuation?: string | null;
  continuation_by?: string | null;
  continuation_at?: number | null;
  auth_request_id?: string | null;
};

export async function getWorkUnits(
  filters?: WorkUnitFilters,
): Promise<WorkUnitWithLiveness[]> {
  const query = filters ? buildQuery(filters as Record<string, string | undefined>) : '';
  const response = await apiGet(`/api/work-units${query}`);
  const payload = (await parseMaybeJson(response)) as { work_units?: WorkUnitWithLiveness[] };
  return payload.work_units ?? [];
}

export async function getWorkUnit(id: string): Promise<WorkUnitWithLiveness> {
  const response = await apiGet(`/api/work-units/${encodeURIComponent(id)}`);
  return (await parseMaybeJson(response)) as WorkUnitWithLiveness;
}

export async function updateWorkUnit(
  id: string,
  patch: WorkUnitPatch,
): Promise<WorkUnitWithLiveness> {
  const response = await apiPatch(`/api/work-units/${encodeURIComponent(id)}`, patch);
  return (await parseMaybeJson(response)) as WorkUnitWithLiveness;
}

// ── Logs API — Bug: af91bdd ──

export type LogsResponse = {
  entries: Array<{ level: string; message: string; time?: string; [key: string]: unknown }>;
  total: number;
  limit: number;
  offset: number;
  log_file: string;
  exists: boolean;
};

export async function getLogs(params?: {
  level?: string;
  limit?: number;
  offset?: number;
}): Promise<LogsResponse> {
  const query = new URLSearchParams();
  if (params?.level) query.set('level', params.level);
  if (params?.limit != null) query.set('limit', String(params.limit));
  if (params?.offset != null) query.set('offset', String(params.offset));
  const qs = query.toString();
  const resp = await apiGet(`/api/system/logs${qs ? '?' + qs : ''}`);
  return (await parseMaybeJson(resp)) as LogsResponse;
}

export type DesktopDaemonLaunchMode = 'on_demand' | 'manual';
export type DesktopDaemonState = 'running' | 'starting' | 'stopped' | 'stale_pid' | 'port_conflict';

export type DesktopDaemonStatus = {
  state: DesktopDaemonState;
  launch_mode: DesktopDaemonLaunchMode;
  port: number;
  pid: number | null;
  pid_file: string;
  log_file: string;
  detail: string | null;
  healthy: boolean;
};

function hasTauriRuntime(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const tauriWindow = window as Window & { __TAURI__?: unknown; __TAURI_INTERNALS__?: unknown };
  return Boolean(tauriWindow.__TAURI__ || tauriWindow.__TAURI_INTERNALS__);
}

export function isDesktopShell(): boolean {
  return hasTauriRuntime();
}

async function invokeDesktop<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!hasTauriRuntime()) {
    throw new Error('Desktop daemon controls are only available in the Tauri app.');
  }
  const tauriCoreModule = '@tauri-apps/api/core';
  const { invoke } = await import(/* @vite-ignore */ tauriCoreModule);
  return invoke<T>(command, args);
}

export async function getDesktopDaemonStatus(): Promise<DesktopDaemonStatus | null> {
  if (!hasTauriRuntime()) {
    return null;
  }
  return invokeDesktop<DesktopDaemonStatus>('daemon_status');
}

export async function setDesktopDaemonLaunchMode(
  launchMode: DesktopDaemonLaunchMode,
): Promise<DesktopDaemonStatus> {
  return invokeDesktop<DesktopDaemonStatus>('daemon_set_launch_mode', { launchMode });
}

export async function startDesktopDaemon(): Promise<DesktopDaemonStatus> {
  return invokeDesktop<DesktopDaemonStatus>('daemon_start');
}

export async function stopDesktopDaemon(): Promise<DesktopDaemonStatus> {
  return invokeDesktop<DesktopDaemonStatus>('daemon_stop');
}

export async function restartDesktopDaemon(): Promise<DesktopDaemonStatus> {
  return invokeDesktop<DesktopDaemonStatus>('daemon_restart');
}

export async function navigateToDesktopBootstrap(): Promise<void> {
  if (!hasTauriRuntime()) {
    return;
  }
  const tauriWebviewModule = '@tauri-apps/api/webview';
  const { getCurrentWebview } = await import(/* @vite-ignore */ tauriWebviewModule);
  await getCurrentWebview().navigate('/index.html');
}

// ── Conversation types ──

export type BlockType = ContractBlockType;
export type Role = ContractRole;
export type ConversationSource = ContractConversationSource;

export type ConversationBlock = ContractConversationBlock;

export type Conversation = ContractConversation;

export type ConversationChild = ContractConversationChild;

// ── Graph API ──

export type GraphQueryParams = {
  repo?: string;
  since?: string;
  limit?: number;
  status?: 'open' | 'all';
};

export type { GraphNode, GraphEdge };

export async function getGraph(
  params: GraphQueryParams = {},
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const query = new URLSearchParams();
  if (params.repo) query.set('repo', params.repo);
  if (params.since) query.set('since', params.since);
  if (params.limit != null) query.set('limit', String(params.limit));
  if (params.status) query.set('status', params.status);
  const qs = query.toString();
  const response = await apiGet(`/api/graph${qs ? '?' + qs : ''}`);
  return (await parseMaybeJson(response)) as { nodes: GraphNode[]; edges: GraphEdge[] };
}

// ── Artifact API ──

export type ArtifactAliasResolutionStatus = ContractArtifactAliasResolutionStatus;

export type ArtifactAliasRecord = ContractArtifactAliasRecord;

export type ArtifactLinkRecord = ContractArtifactLinkRecord;

export type ArtifactRecord = ContractArtifactRecord;

export type ArtifactResolveResult = ContractArtifactResolveResult;

export type ArtifactContentResult = {
  artifact_id: string;
  status: 'available' | 'unavailable';
  kind: 'text' | 'markdown' | 'json' | 'binary' | 'unavailable';
  media_type: string;
  size_bytes: number;
  source: {
    kind: 'managed_file' | 'repo_locator' | 'local_file';
    locator: string;
  } | null;
  preview: {
    encoding: 'utf-8';
    text: string;
    truncated: boolean;
  } | null;
  download: {
    available: boolean;
    media_type: string;
    size_bytes: number;
    filename: string | null;
    reason?: string;
  };
  reason?: string;
  warnings?: string[];
};

export type KnowledgeBackrefRecord = {
  id: string;
  source_type: 'artifact' | 'document';
  source_id: string;
  provider_id: string;
  ref_type: 'document' | 'entity' | 'claim';
  external_id: string;
  external_ref: string;
  status: 'offered' | 'indexed' | 'returned';
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
};

export type ArtifactQueryParams = {
  q?: string;
  hash?: string;
  repo?: string;
  provider?: string;
  role?: string;
  custody?: string;
  availability?: string;
  scheme?: string;
  location?: string;
  linked_entity?: string;
  limit?: number;
};

export async function getArtifacts(params: ArtifactQueryParams = {}): Promise<ArtifactRecord[]> {
  const query = buildQuery(params);
  const response = await apiGet(`/api/artifacts${query}`);
  const payload = (await parseMaybeJson(response)) as { artifacts?: ArtifactRecord[] };
  return payload.artifacts ?? [];
}

export async function getArtifact(id: string): Promise<ArtifactRecord> {
  const response = await apiGet(`/api/artifacts/${encodeURIComponent(id)}`);
  const payload = (await parseMaybeJson(response)) as { artifact: ArtifactRecord };
  return payload.artifact;
}

export async function getArtifactContent(id: string): Promise<ArtifactContentResult> {
  const response = await apiGet(`/api/artifacts/${encodeURIComponent(id)}/content`);
  const payload = (await parseMaybeJson(response)) as { content: ArtifactContentResult };
  return payload.content;
}

export async function getArtifactKnowledgeBackrefs(id: string): Promise<KnowledgeBackrefRecord[]> {
  const response = await apiGet(`/api/artifacts/${encodeURIComponent(id)}/knowledge-backrefs`);
  const payload = (await parseMaybeJson(response)) as { backrefs?: KnowledgeBackrefRecord[] };
  return payload.backrefs ?? [];
}

export async function resolveArtifact(ref: string): Promise<ArtifactResolveResult> {
  const query = buildQuery({ ref });
  const response = await apiGet(`/api/artifacts/resolve${query}`);
  const payload = (await parseMaybeJson(response)) as { resolution: ArtifactResolveResult };
  return payload.resolution;
}

// ── Presets API — Bug: e20c88e, Bug: 11f4f47 ──

export async function fetchPresets(): Promise<Preset[]> {
  const response = await apiGet('/api/presets');
  const payload = (await parseMaybeJson(response)) as ApiList<Preset>;
  return normalizeList(payload);
}

export const getPresets = fetchPresets;

export async function createPreset(data: {
  name: string;
  description?: string;
  markdown?: string;
}): Promise<Preset> {
  const response = await apiPost('/api/presets', data);
  const payload = (await parseMaybeJson(response)) as { preset?: Preset } | Preset;
  return (payload && typeof payload === 'object' && 'preset' in payload) ? payload.preset as Preset : payload as Preset;
}

export async function fetchPreset(id: string): Promise<PresetWithNodes> {
  const response = await apiGet(`/api/presets/${encodeURIComponent(id)}`);
  return (await parseMaybeJson(response)) as PresetWithNodes;
}

export async function getPreset(id: string): Promise<Preset> {
  const response = await apiGet(`/api/presets/${encodeURIComponent(id)}`);
  const payload = (await parseMaybeJson(response)) as { preset?: Preset } | Preset;
  return (payload && typeof payload === 'object' && 'preset' in payload) ? payload.preset as Preset : payload as Preset;
}

export async function updatePreset(
  id: string,
  data: Partial<Preset>,
): Promise<Preset> {
  const response = await apiPut(`/api/presets/${encodeURIComponent(id)}`, data);
  const payload = (await parseMaybeJson(response)) as { preset?: Preset } | Preset;
  return (payload && typeof payload === 'object' && 'preset' in payload) ? payload.preset as Preset : payload as Preset;
}

export async function deletePreset(id: string): Promise<void> {
  await apiDelete(`/api/presets/${encodeURIComponent(id)}`);
}

export async function fetchPresetNodes(presetId: string): Promise<PresetNode[]> {
  const response = await apiGet(`/api/presets/${encodeURIComponent(presetId)}/nodes`);
  const payload = (await parseMaybeJson(response)) as ApiList<PresetNode>;
  return normalizeList(payload);
}

export async function updatePresetNodes(
  presetId: string,
  nodes: PresetNode[],
): Promise<void> {
  await apiPut(`/api/presets/${encodeURIComponent(presetId)}/nodes`, { nodes });
}

export async function addPresetNode(
  presetId: string,
  node: Partial<PresetNode>,
): Promise<PresetNode> {
  const response = await apiPost(
    `/api/presets/${encodeURIComponent(presetId)}/nodes`,
    node,
  );
  const payload = (await parseMaybeJson(response)) as { node?: PresetNode } | PresetNode;
  return (payload && typeof payload === 'object' && 'node' in payload) ? payload.node as PresetNode : payload as PresetNode;
}

export async function updatePresetNode(
  presetId: string,
  nodeId: string,
  data: Partial<PresetNode>,
): Promise<PresetNode> {
  const response = await apiPut(
    `/api/presets/${encodeURIComponent(presetId)}/nodes/${encodeURIComponent(nodeId)}`,
    data,
  );
  const payload = (await parseMaybeJson(response)) as { node?: PresetNode } | PresetNode;
  return (payload && typeof payload === 'object' && 'node' in payload) ? payload.node as PresetNode : payload as PresetNode;
}

export async function deletePresetNode(
  presetId: string,
  nodeId: string,
): Promise<void> {
  await apiDelete(
    `/api/presets/${encodeURIComponent(presetId)}/nodes/${encodeURIComponent(nodeId)}`,
  );
}

export async function reorderPresetNode(
  presetId: string,
  data: { nodeId: string; newParentId: string | null; newPosition: number },
): Promise<void> {
  await apiPatch(
    `/api/presets/${encodeURIComponent(presetId)}/nodes/reorder`,
    data,
  );
}

export async function fetchConventionLibrary(
  query?: string,
  limit?: number,
  offset?: number,
): Promise<LibraryConvention[]> {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (limit != null) params.set('limit', String(limit));
  if (offset != null) params.set('offset', String(offset));
  const qs = params.toString();
  const response = await apiGet(`/api/presets/library${qs ? '?' + qs : ''}`);
  const payload = (await parseMaybeJson(response)) as ApiList<LibraryConvention>;
  return normalizeList(payload);
}

export async function exportPreset(id: string): Promise<string> {
  const response = await apiGet(`/api/presets/${encodeURIComponent(id)}/export`);
  const payload = await parseMaybeJson(response);
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object' && 'markdown' in payload) {
    return String((payload as { markdown?: unknown }).markdown || '');
  }
  if (payload && typeof payload === 'object' && 'content' in payload) {
    return String((payload as { content?: unknown }).content ?? '');
  }
  return '';
}

export async function importPreset(markdown: string): Promise<Preset> {
  const response = await apiPost('/api/presets/import', { markdown });
  const payload = (await parseMaybeJson(response)) as { preset?: Preset } | Preset;
  return (payload && typeof payload === 'object' && 'preset' in payload) ? payload.preset as Preset : payload as Preset;
}

export async function fetchPresetDiffs(sessionId: string): Promise<PresetDiff[]> {
  const response = await apiGet(
    `/api/presets/diffs?session_id=${encodeURIComponent(sessionId)}`,
  );
  const payload = (await parseMaybeJson(response)) as ApiList<PresetDiff>;
  return normalizeList(payload);
}

export async function updatePresetDiff(
  id: string,
  status: string,
): Promise<PresetDiff> {
  const response = await apiPut(
    `/api/presets/diffs/${encodeURIComponent(id)}`,
    { status },
  );
  const payload = (await parseMaybeJson(response)) as { diff?: PresetDiff } | PresetDiff;
  return (payload && typeof payload === 'object' && 'diff' in payload) ? payload.diff as PresetDiff : payload as PresetDiff;
}

export async function fetchPresetUnion(
  sessionId: string,
): Promise<{ text: string; tokenEstimate: number }> {
  const response = await apiGet(
    `/api/presets/union?session_id=${encodeURIComponent(sessionId)}`,
  );
  return (await parseMaybeJson(response)) as { text: string; tokenEstimate: number };
}

export type PresetUnion = {
  systemPrompt: string;
  settingSources: string[];
  totalTokens: number;
};

export type SessionPreset = {
  preset_id: string;
  preset_name: string;
  version: number;
  position: number;
};

export async function getPresetUnion(params: {
  session_id?: string;
  preset_ids?: string[];
}): Promise<PresetUnion> {
  const query = new URLSearchParams();
  if (params.session_id) query.set('session_id', params.session_id);
  if (params.preset_ids) query.set('preset_ids', params.preset_ids.join(','));
  const qs = query.toString();
  const response = await apiGet(`/api/presets/union${qs ? '?' + qs : ''}`);
  const payload = await parseMaybeJson(response) as Record<string, unknown>;
  // Server returns { text, tokenEstimate }; map to client type
  return {
    systemPrompt: (payload.systemPrompt ?? payload.text ?? '') as string,
    settingSources: (payload.settingSources ?? []) as string[],
    totalTokens: (payload.totalTokens ?? payload.tokenEstimate ?? 0) as number,
  };
}

export async function getSessionPresets(
  sessionId: string,
): Promise<SessionPreset[]> {
  const response = await apiGet(
    `/api/console/sessions/${encodeURIComponent(sessionId)}/presets`,
  );
  const payload = (await parseMaybeJson(response)) as { presets?: SessionPreset[] } | SessionPreset[];
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload?.presets) ? payload.presets : [];
}

export async function addSessionPreset(
  sessionId: string,
  presetId: string,
  _position?: number,
): Promise<void> {
  await apiPost(
    `/api/console/sessions/${encodeURIComponent(sessionId)}/presets`,
    { presetIds: [presetId] },
  );
}

export async function removeSessionPreset(
  sessionId: string,
  presetId: string,
): Promise<void> {
  await apiDelete(
    `/api/console/sessions/${encodeURIComponent(sessionId)}/presets/${encodeURIComponent(presetId)}`,
  );
}

// ── Convention-Setting Links API — Bug: 8baedeb ──

export async function getSettingLinks(settingKey: string): Promise<ConventionSettingLink[]> {
  const response = await apiGet(`/api/presets/links?setting_key=${encodeURIComponent(settingKey)}`);
  const payload = (await parseMaybeJson(response)) as { links?: ConventionSettingLink[] };
  return payload.links ?? [];
}

export async function getNodeLinks(nodeId: string): Promise<ConventionSettingLink[]> {
  const response = await apiGet(`/api/presets/nodes/${encodeURIComponent(nodeId)}/links`);
  const payload = (await parseMaybeJson(response)) as { links?: ConventionSettingLink[] };
  return payload.links ?? [];
}

export async function createNodeLink(
  nodeId: string,
  settingKey: string,
  linkType?: string,
): Promise<ConventionSettingLink> {
  const response = await apiPost(
    `/api/presets/nodes/${encodeURIComponent(nodeId)}/links`,
    { settingKey, linkType },
  );
  const payload = (await parseMaybeJson(response)) as { link?: ConventionSettingLink };
  return payload.link as ConventionSettingLink;
}

export async function deleteSettingLink(linkId: string): Promise<void> {
  await apiDelete(`/api/presets/links/${encodeURIComponent(linkId)}`);
}

export async function validateSessionPresets(sessionId: string): Promise<SessionValidationResult> {
  const response = await apiGet(
    `/api/presets/validate-session?session_id=${encodeURIComponent(sessionId)}`,
  );
  return (await parseMaybeJson(response)) as SessionValidationResult;
}

export async function validatePresetIds(presetIds: string[]): Promise<SessionValidationResult> {
  // Bug: 8baedeb — delegate to backend endpoint for accurate validation
  // (client-side approach only checked link existence, not actual setting values)
  const response = await apiPost('/api/presets/validate-preset-ids', { presetIds });
  return (await parseMaybeJson(response)) as SessionValidationResult;
}

export async function getDefaultPresetIds(): Promise<string[]> {
  try {
    const response = await apiGet('/api/settings/default_preset_ids');
    const payload = await parseMaybeJson(response);
    if (payload && typeof payload === 'object' && 'value' in payload) {
      const val = (payload as { value?: unknown }).value;
      if (typeof val === 'string') {
        try {
          return JSON.parse(val) as string[];
        } catch {
          return val ? val.split(',').map((s: string) => s.trim()).filter(Boolean) : [];
        }
      }
    }
  } catch {
    // Setting doesn't exist yet — return empty defaults
  }
  return [];
}

// --- Auth hooks API (Bug: 242d0c7) ---

export type AuthHook = {
  id: string;
  repo_pattern: string;
  auth_type: string;
  command: string;
  label: string;
  enabled: boolean;
  builtin: boolean;
  position: number;
  created_at: number;
  updated_at: number;
};

export type AuthHookInput = {
  repo_pattern: string;
  auth_type?: string;
  command: string;
  label?: string;
  enabled?: boolean;
  position?: number;
};

export async function fetchAuthHooks(): Promise<AuthHook[]> {
  const response = await apiGet('/api/auth/hooks');
  const payload = await parseMaybeJson(response) as { hooks?: AuthHook[] };
  return payload?.hooks ?? [];
}

export async function createAuthHook(input: AuthHookInput): Promise<AuthHook> {
  const response = await apiPost('/api/auth/hooks', input);
  return (await parseMaybeJson(response)) as AuthHook;
}

export async function updateAuthHook(id: string, fields: Partial<AuthHookInput> & { enabled?: boolean }): Promise<AuthHook> {
  const response = await apiPut(`/api/auth/hooks/${id}`, fields);
  return (await parseMaybeJson(response)) as AuthHook;
}

export async function deleteAuthHook(id: string): Promise<void> {
  await apiDelete(`/api/auth/hooks/${id}`);
}

// ── Runtime (Zone 2) types & API ── Bug: cc4688b

export type InstallMode = 'dev' | 'release-zone2' | 'release-bundled' | 'npm-global';

export type RuntimeStatus = {
  installMode: InstallMode;
  zone2Path: string | null;
  available: boolean;
  commit: string | null;
  branch: string | null;
  patchCount: number;
};

export type RuntimePatch = {
  id: string;
  fingerprint: string | null;
  commit_hash: string;
  parent_hash: string | null;
  diff_summary: string | null;
  diff_stat: string | null;
  applied_at: number;
  reverted_at: number | null;
  source: string;
  session_id: string | null;
  submitted: number;
  submission_url: string | null;
};

export async function getRuntimeStatus(): Promise<RuntimeStatus> {
  const response = await apiGet('/api/runtime/status');
  return (await parseMaybeJson(response)) as RuntimeStatus;
}

export async function getRuntimePatches(): Promise<RuntimePatch[]> {
  const response = await apiGet('/api/runtime/patches');
  return (await parseMaybeJson(response)) as RuntimePatch[];
}

export async function bootstrapRuntime(): Promise<{ ok: boolean; message: string }> {
  const response = await apiPost('/api/runtime/bootstrap');
  return (await parseMaybeJson(response)) as { ok: boolean; message: string };
}

export async function updateRuntime(): Promise<{ ok: boolean; updated: boolean; message?: string }> {
  const response = await apiPost('/api/runtime/update');
  return (await parseMaybeJson(response)) as { ok: boolean; updated: boolean; message?: string };
}

export async function rollbackRuntime(): Promise<{ ok: boolean }> {
  const response = await apiPost('/api/runtime/rollback');
  return (await parseMaybeJson(response)) as { ok: boolean };
}

export async function resetRuntime(): Promise<{ ok: boolean }> {
  const response = await apiPost('/api/runtime/reset');
  return (await parseMaybeJson(response)) as { ok: boolean };
}

// ---------------------------------------------------------------------------
// Spaces (umbrella de56ffa) — typed client helpers over the C2 routes
// (`src/routes/spaces.ts`). Each helper returns the unwrapped record(s) the
// renderers consume; request/response envelope types come from `contracts`.
// ---------------------------------------------------------------------------

export async function listSpaces(projectId: string): Promise<ContractSpace[]> {
  const response = await apiGet(`/api/spaces${buildQuery({ project_id: projectId })}`);
  const payload = (await parseMaybeJson(response)) as { spaces: ContractSpace[] };
  return payload.spaces;
}

export async function getSpace(spaceId: string): Promise<ContractSpace> {
  const response = await apiGet(`/api/spaces/${encodeURIComponent(spaceId)}`);
  const payload = (await parseMaybeJson(response)) as { space: ContractSpace };
  return payload.space;
}

/**
 * Full Space fact packet (space + items/occurrences/edges) read from
 * `GET /api/spaces/:id` (umbrella plan §5.1). The renderers (C8 collection,
 * C9a canvas, …) assemble their `SpaceViewModel` from this single read. Older
 * responses that omit the collections degrade to empty arrays.
 */
export async function getSpaceFactPacket(spaceId: string): Promise<{
  space: ContractSpace;
  items: ContractSpaceItem[];
  occurrences: ContractSpaceOccurrence[];
  edges: ContractSpaceEdge[];
}> {
  const response = await apiGet(`/api/spaces/${encodeURIComponent(spaceId)}`);
  const payload = (await parseMaybeJson(response)) as {
    space: ContractSpace;
    items?: ContractSpaceItem[];
    occurrences?: ContractSpaceOccurrence[];
    edges?: ContractSpaceEdge[];
  };
  return {
    space: payload.space,
    items: payload.items ?? [],
    occurrences: payload.occurrences ?? [],
    edges: payload.edges ?? [],
  };
}

export async function createSpace(body: CreateSpaceRequest): Promise<ContractSpace> {
  const response = await apiPost('/api/spaces', body);
  const payload = (await parseMaybeJson(response)) as { space: ContractSpace };
  return payload.space;
}

export async function updateSpace(spaceId: string, body: UpdateSpaceRequest): Promise<ContractSpace> {
  const response = await apiPatch(`/api/spaces/${encodeURIComponent(spaceId)}`, body);
  const payload = (await parseMaybeJson(response)) as { space: ContractSpace };
  return payload.space;
}

export async function deleteSpace(spaceId: string): Promise<void> {
  await apiDelete(`/api/spaces/${encodeURIComponent(spaceId)}`);
}

// --- items ---

export async function addSpaceItem(spaceId: string, body: AddSpaceItemRequest): Promise<AddSpaceItemResponse> {
  const response = await apiPost(`/api/spaces/${encodeURIComponent(spaceId)}/items`, body);
  return (await parseMaybeJson(response)) as AddSpaceItemResponse;
}

export async function updateSpaceItem(
  spaceId: string,
  itemId: string,
  body: UpdateSpaceItemRequest,
): Promise<ContractSpaceItem> {
  const response = await apiPatch(
    `/api/spaces/${encodeURIComponent(spaceId)}/items/${encodeURIComponent(itemId)}`,
    body,
  );
  const payload = (await parseMaybeJson(response)) as { item: ContractSpaceItem };
  return payload.item;
}

export async function deleteSpaceItem(spaceId: string, itemId: string): Promise<void> {
  await apiDelete(`/api/spaces/${encodeURIComponent(spaceId)}/items/${encodeURIComponent(itemId)}`);
}

// --- occurrences ---

export async function createSpaceOccurrence(
  spaceId: string,
  body: CreateSpaceOccurrenceRequest,
): Promise<ContractSpaceOccurrence> {
  const response = await apiPost(`/api/spaces/${encodeURIComponent(spaceId)}/occurrences`, body);
  const payload = (await parseMaybeJson(response)) as { occurrence: ContractSpaceOccurrence };
  return payload.occurrence;
}

export async function updateSpaceOccurrence(
  spaceId: string,
  occurrenceId: string,
  body: UpdateSpaceOccurrenceRequest,
): Promise<ContractSpaceOccurrence> {
  const response = await apiPatch(
    `/api/spaces/${encodeURIComponent(spaceId)}/occurrences/${encodeURIComponent(occurrenceId)}`,
    body,
  );
  const payload = (await parseMaybeJson(response)) as { occurrence: ContractSpaceOccurrence };
  return payload.occurrence;
}

export async function deleteSpaceOccurrence(spaceId: string, occurrenceId: string): Promise<void> {
  await apiDelete(
    `/api/spaces/${encodeURIComponent(spaceId)}/occurrences/${encodeURIComponent(occurrenceId)}`,
  );
}

/** Batch occurrence write (drag persistence / re-layout): entries with a known `id` update, others create. */
export async function batchWriteSpaceOccurrences(
  spaceId: string,
  occurrences: BatchSpaceOccurrenceEntry[],
): Promise<BatchSpaceOccurrenceResponse> {
  const response = await apiPost(
    `/api/spaces/${encodeURIComponent(spaceId)}/occurrences/batch`,
    { occurrences },
  );
  return (await parseMaybeJson(response)) as BatchSpaceOccurrenceResponse;
}

// --- edges ---

export async function createSpaceEdge(
  spaceId: string,
  body: CreateSpaceEdgeRequest,
): Promise<ContractSpaceEdge> {
  const response = await apiPost(`/api/spaces/${encodeURIComponent(spaceId)}/edges`, body);
  const payload = (await parseMaybeJson(response)) as { edge: ContractSpaceEdge };
  return payload.edge;
}

export async function updateSpaceEdge(
  spaceId: string,
  edgeId: string,
  body: UpdateSpaceEdgeRequest,
): Promise<ContractSpaceEdge> {
  const response = await apiPatch(
    `/api/spaces/${encodeURIComponent(spaceId)}/edges/${encodeURIComponent(edgeId)}`,
    body,
  );
  const payload = (await parseMaybeJson(response)) as { edge: ContractSpaceEdge };
  return payload.edge;
}

export async function deleteSpaceEdge(spaceId: string, edgeId: string): Promise<void> {
  await apiDelete(`/api/spaces/${encodeURIComponent(spaceId)}/edges/${encodeURIComponent(edgeId)}`);
}

// --- seed-from-filter ---

export async function seedSpace(spaceId: string, body: SeedSpaceRequest): Promise<SeedSpaceResult> {
  const response = await apiPost(`/api/spaces/${encodeURIComponent(spaceId)}/seed`, body);
  return (await parseMaybeJson(response)) as SeedSpaceResult;
}

// --- unified ref resolver ---

export async function resolveSpaceRef(ref: string): Promise<ResolverResult> {
  const response = await apiGet(`/api/refs/resolve${buildQuery({ ref })}`);
  const payload = (await parseMaybeJson(response)) as { resolution: ResolverResult };
  return payload.resolution;
}
