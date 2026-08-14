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
  ArtifactSeriesRecord as ContractArtifactSeriesRecord,
  ArtifactSeriesSummary as ContractArtifactSeriesSummary,
  ArtifactDraftPublishResult as ContractArtifactDraftPublishResult,
  ArtifactDraftRecord as ContractArtifactDraftRecord,
  ArtifactVersionRecord as ContractArtifactVersionRecord,
  AuthRequestAction as ContractAuthRequestAction,
  BlockType as ContractBlockType,
  Conversation as ContractConversation,
  ConversationChild as ContractConversationChild,
  ConversationParent as ContractConversationParent,
  ConversationSource as ContractConversationSource,
  Role as ContractRole,
  StoredConversationBlock as ContractConversationBlock,
  WorkUnit as ContractWorkUnit,
  WorkUnitKind as ContractWorkUnitKind,
  WorkUnitLiveness as ContractWorkUnitLiveness,
  WorkUnitState as ContractWorkUnitState,
  WorkUnitWithLiveness as ContractWorkUnitWithLiveness,
  WorkflowRun as ContractWorkflowRun,
  WorkflowPhase as ContractWorkflowPhase,
  WorkflowWorker as ContractWorkflowWorker,
  WorkflowRunStatus as ContractWorkflowRunStatus,
  WorkflowWorkerStatus as ContractWorkflowWorkerStatus,
  WorkflowWarning as ContractWorkflowWarning,
  Space as ContractSpace,
  SpaceGroup as ContractSpaceGroup,
  SpaceItem as ContractSpaceItem,
  SpaceOccurrence as ContractSpaceOccurrence,
  SpaceEdge as ContractSpaceEdge,
  SpaceExport as ContractSpaceExport,
  SpaceExportStatus as ContractSpaceExportStatus,
  CreateSpaceRequest,
  UpdateSpaceRequest,
  AddSpaceItemRequest,
  UpdateSpaceItemRequest,
  CreateSpaceOccurrenceRequest,
  UpdateSpaceOccurrenceRequest,
  BatchSpaceOccurrenceEntry,
  BatchSpaceOccurrenceResponse,
  ConversationAttachState as ContractConversationAttachState,
  CreateSpaceEdgeRequest,
  UpdateSpaceEdgeRequest,
  AddSpaceItemResponse,
  SeedSpaceRequest,
  SeedSpaceResult,
  ResolverResult,
} from '../../src/contracts';
export type {
  Space,
  SpaceGroup,
  SpaceItem,
  SpaceOccurrence,
  SpaceEdge,
  SpaceBlock,
  SpaceExport,
  SpaceExportStatus,
  SpaceExportAuthority,
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

export type InstanceInfo = {
  role: 'main' | 'preview' | 'dev' | 'test';
  operational_mutations: 'allow' | 'reject';
  operational_mutations_overridden: boolean;
  db_path: string | null;
  db_path_source: string | null;
  source_db_path?: string | null;
  source_db_path_source?: string | null;
};

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

export type WorkCommitClassification = 'unique' | 'pre-branch-point' | 'merged-elsewhere';

export type WorkCommit = {
  hash: string;
  short_hash: string;
  message: string;
  author: string;
  date: string;
  parents: string[];
  classification: WorkCommitClassification;
  is_pre_branch_point: boolean;
  is_merged_elsewhere: boolean;
};

export type WorkCommitPage = {
  repo_root: string;
  branch: string;
  default_branch: string;
  merge_base: string | null;
  commits: WorkCommit[];
  total: number;
  limit: number;
  offset: number;
};

export type WorkCompareMode = 'merge-base' | 'range';

export type WorkCompareResult = {
  repo_root: string;
  from: string;
  to: string;
  mode: WorkCompareMode;
  range: string;
  raw: string;
  stat: string;
};

export type WorkAuditClassification =
  | 'safe_candidate'
  | 'unique_commits'
  | 'dirty_worktree'
  | 'protected'
  | 'current'
  | 'app_managed'
  | 'unknown';

export type TrashCreateRequest = {
  project: string;
  checkout_root: string;
  branch: string;
  reason: 'manual';
  issue_refs: string[];
};

export type TrashCreateOutcome = {
  worktree_removed: boolean;
  branch_removed: boolean;
  worktree_path: string | null;
};

export type TrashCreateBody = {
  entry?: Record<string, unknown>;
  outcome?: TrashCreateOutcome;
  error?: string;
  code?: string;
  detail?: {
    outcome?: TrashCreateOutcome;
    [key: string]: unknown;
  };
};

export type TrashCreateResult = {
  ok: boolean;
  status: number;
  body: TrashCreateBody;
};

export type WorkAuditEntry = {
  kind: 'branch' | 'detached_worktree';
  branch: string | null;
  classification: WorkAuditClassification;
  preserve_by_default: boolean;
  reason: string;
  blockers: string[];
  proof: {
    kind: 'reachable' | 'none' | 'unknown';
    default_branch: string | null;
    merged: boolean | null;
  };
  ahead_default: number | null;
  behind_default: number | null;
  default_branch: string | null;
  dirty: boolean | null;
  status_known: boolean;
  canonical_project: boolean;
  canonical_project_id: string | null;
  ambiguous_project: boolean;
  worktree_path: string | null;
  trash_request: TrashCreateRequest | null;
  trash_command: string | null;
};

export type WorkRepoAudit = {
  repo: Record<string, unknown>;
  maintenance_issue_ref: string | null;
  maintenance_issue_note: string;
  worktree_inventory_known: boolean;
  entries: WorkAuditEntry[];
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

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export function isApiErrorStatus(error: unknown, status: number): error is ApiError {
  return error instanceof ApiError && error.status === status;
}

async function apiGet(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(DEFAULT_HEADERS);
  if (init.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }
  const response = await fetch(path, { ...init, headers });
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
  throw new ApiError(message, response.status);
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

type CachedJsonOptions = {
  ttlMs?: number;
  staleWhileRevalidateMs?: number;
};

type CachedJsonEntry = {
  value: unknown;
  freshUntil: number;
  staleUntil: number;
};

const DEFAULT_GET_CACHE_TTL_MS = 1_000;
const DEFAULT_GET_CACHE_STALE_MS = 4_000;
const getJsonCache = new Map<string, CachedJsonEntry>();
const inflightGetJson = new Map<string, Promise<unknown>>();

function cacheKeyForGet(path: string): string {
  return `GET ${path}`;
}

async function fetchJsonForCache(path: string, options: Required<CachedJsonOptions>): Promise<unknown> {
  const response = await apiGet(path);
  const value = await parseMaybeJson(response);
  const now = Date.now();
  getJsonCache.set(cacheKeyForGet(path), {
    value,
    freshUntil: now + options.ttlMs,
    staleUntil: now + options.ttlMs + options.staleWhileRevalidateMs,
  });
  return value;
}

async function cachedApiGetJson<T>(
  path: string,
  options: CachedJsonOptions = {},
): Promise<T> {
  const resolvedOptions = {
    ttlMs: options.ttlMs ?? DEFAULT_GET_CACHE_TTL_MS,
    staleWhileRevalidateMs: options.staleWhileRevalidateMs ?? DEFAULT_GET_CACHE_STALE_MS,
  };
  const key = cacheKeyForGet(path);
  const cached = getJsonCache.get(key);
  const now = Date.now();
  if (cached && now < cached.freshUntil) {
    return cached.value as T;
  }
  const inflight = inflightGetJson.get(key);
  if (inflight) {
    return (await inflight) as T;
  }
  if (cached && now < cached.staleUntil) {
    const refresh = fetchJsonForCache(path, resolvedOptions).finally(() => {
      if (inflightGetJson.get(key) === refresh) inflightGetJson.delete(key);
    });
    inflightGetJson.set(key, refresh);
    return cached.value as T;
  }
  const request = fetchJsonForCache(path, resolvedOptions).finally(() => {
    if (inflightGetJson.get(key) === request) inflightGetJson.delete(key);
  });
  inflightGetJson.set(key, request);
  return (await request) as T;
}

export function invalidateApiGetCache(
  matcher?: string | RegExp | ((key: string) => boolean),
): void {
  if (!matcher) {
    getJsonCache.clear();
    inflightGetJson.clear();
    return;
  }
  for (const key of Array.from(getJsonCache.keys())) {
    const matches =
      typeof matcher === 'string'
        ? key.includes(matcher)
        : matcher instanceof RegExp
          ? matcher.test(key)
          : matcher(key);
    if (matches) getJsonCache.delete(key);
  }
}

const BRIEFING_FEEDBACK_EVENTS = new Set([
  'briefing:ingested',
  'briefing:decided',
  'briefing:commented',
  'briefing:expired',
]);

const ASK_FEEDBACK_EVENTS = new Set([
  'ask:created',
  'ask:submitted',
  'ask:cancelled',
  'ask:expired',
]);

/** Exact cache families affected by a feedback lifecycle event. */
export function feedbackApiCacheFamiliesForEvent(type: string): readonly string[] {
  if (BRIEFING_FEEDBACK_EVENTS.has(type)) {
    return ['/api/briefing', '/api/dashboard/badges'];
  }
  if (ASK_FEEDBACK_EVENTS.has(type)) {
    return ['/api/asks', '/api/dashboard/badges'];
  }
  return [];
}

/** Narrow feedback invalidation; returns whether the event was handled. */
export function invalidateFeedbackApiCacheForEvent(type: string): boolean {
  const families = feedbackApiCacheFamiliesForEvent(type);
  for (const family of families) invalidateApiGetCache(family);
  return families.length > 0;
}

export function invalidateDashboardApiCacheForEvent(type: string): void {
  if (invalidateFeedbackApiCacheForEvent(type)) return;
  // Streamed auth output does not change any dashboard count, so the badge
  // cache is left intact for that event; every other family below can move a
  // count and refreshes the badges key.
  if (type !== 'auth:output') {
    invalidateApiGetCache('/api/dashboard/badges');
  }
  if (type.startsWith('session:') || type.startsWith('console:session:')) {
    invalidateApiGetCache('/api/sessions');
    invalidateApiGetCache('/api/console/sessions');
    invalidateApiGetCache('/api/conversations');
  } else if (type.startsWith('auth:')) {
    invalidateApiGetCache('/api/auth/');
    invalidateApiGetCache('/api/inbox');
  } else if (type.startsWith('work:') || type.startsWith('push:')) {
    invalidateApiGetCache('/api/work/');
  } else if (type.startsWith('ledger:')) {
    // Covers ledger:issue:*, ledger:comment:*, ledger:label:*, and other
    // ledger:* events; all can change an issue list row or detail projection.
    invalidateApiGetCache('/api/issues');
    invalidateApiGetCache('/api/ledger');
  } else if (type.startsWith('space:')) {
    invalidateApiGetCache('/api/spaces');
  } else if (type.startsWith('artifact:')) {
    invalidateApiGetCache('/api/artifacts');
  }
}

export async function getSessions<T>(query?: string): Promise<T[]> {
  const payload = await cachedApiGetJson<ApiList<T>>(`/api/sessions${query || ''}`);
  return normalizeList(payload);
}

// Paginated sessions listing (issue 21502ff). The list endpoint now returns a
// bounded page by default with a stable cursor and an unfiltered total; pass
// { scope: 'all' } for full history, or a cursor to page. History is never
// hidden — total reflects every matching session and direct-id lookups plus
// deep links continue to resolve unchanged.
export interface SessionsPage<T> {
  sessions: T[];
  total: number;
  returned: number;
  nextCursor: string | null;
  scope: 'all' | 'default';
  limit: number | null;
}

export async function getSessionsPage<T>(params?: {
  status?: string;
  app?: string;
  parentId?: string | null;
  scope?: 'all';
  limit?: number;
  cursor?: string | null;
}): Promise<SessionsPage<T>> {
  const query = buildQuery({
    status: params?.status,
    app: params?.app,
    parent_id: params?.parentId === null ? 'null' : params?.parentId,
    scope: params?.scope,
    limit: params?.limit,
    cursor: params?.cursor ?? undefined,
  });
  const payload = await cachedApiGetJson<ApiList<T> & Partial<SessionsPage<T>>>(
    `/api/sessions${query}`,
  );
  return {
    sessions: normalizeList(payload),
    total: payload.total ?? 0,
    returned: payload.returned ?? 0,
    nextCursor: payload.nextCursor ?? null,
    scope: payload.scope ?? 'default',
    limit: payload.limit ?? null,
  };
}

// Issue 037fa85 / f59b5bd — Session Overview: provider-neutral session alias
// resolution with explicit zero/one/many semantics, and the aggregate
// per-session payload. The ref may be a full id or a short prefix (min 8
// chars); `matched_ref` carries the full identity each match resolved to and
// `provider` its transcript-attested provider (null when unattested).
export type SessionResolveMatch = {
  matched_ref: string;
  provider: string | null;
  mandible_session_id: string | null;
  console_session_id: string | null;
  conversation_id: string | null;
  sources: string[];
};

export type SessionResolveResult = {
  provider: string | null;
  provider_session_id: string;
  // Review C4 — true when a prefix scan hit a candidate cap: a single match
  // must not be treated as unique.
  truncated: boolean;
  matches: SessionResolveMatch[];
};

export async function resolveAgentSession(
  ref: string,
  provider?: string,
): Promise<SessionResolveResult> {
  const query = buildQuery({ provider_session_id: ref, provider });
  const response = await apiGet(`/api/sessions/resolve${query}`);
  return await response.json() as SessionResolveResult;
}

export type SessionOverviewSection<T> = {
  available: boolean;
  reason?: string;
  items: T[];
};

export type SessionOverviewChild = {
  id: string;
  parent_id: string | null;
  app: string;
  status: string;
  branch: string | null;
  cwd: string | null;
  task: string | null;
  agent_type: string | null;
  created_at: string;
  ended_at: string | null;
  last_active: string | null;
  depth: number;
};

export type SessionOverviewLinkedIssue = {
  issue_id: string;
  short_id: string;
  title: string;
  status: string;
  worker_status: string;
  kind: string;
  link_type: string;
  source: string;
  created_at: number;
  last_seen_at: number | null;
};

export type SessionOverviewWorkUnit = {
  id: string;
  issue_id: string;
  ledger_issue_id: string | null;
  repo_id: string;
  branch: string | null;
  kind: string;
  state: string;
  assigned_session_id: string | null;
  provider: string | null;
  provider_session_id: string | null;
  created_at: number;
  resolved_at: number | null;
};

export type SessionOverviewConversation = {
  id: string;
  source: string;
  title: string;
  session_id: string;
  started_at: string;
  ended_at: string | null;
  block_count: number;
  model: string | null;
  branch: string | null;
  cwd: string | null;
};

export type SessionOverview = {
  as_of: number;
  session: Record<string, unknown>;
  children: SessionOverviewSection<SessionOverviewChild> & {
    truncated: boolean;
    depth_limit: number;
    count_limit: number;
  };
  linked_issues: SessionOverviewSection<SessionOverviewLinkedIssue> & { source: string };
  work_units: SessionOverviewSection<SessionOverviewWorkUnit> & {
    includes_descendants: boolean;
    matched_provider_aliases: string[];
  };
  conversations: SessionOverviewSection<SessionOverviewConversation> & { limit: number };
};

export async function getSessionOverview(
  sessionId: string,
  providerSessionId?: string | null,
): Promise<SessionOverview> {
  const query = buildQuery({ provider_session_id: providerSessionId ?? undefined });
  const response = await apiGet(`/api/sessions/${encodeURIComponent(sessionId)}/overview${query}`);
  return await response.json() as SessionOverview;
}

// Issue 037fa85 (follow-up) — provider-scoped overview for a Codex session
// known only through its ingested transcript (no Mandible session row).
export type ProviderScopedLinkedIssue = {
  issue_id: string;
  short_id: string;
  title: string;
  status: string;
  worker_status: string | null;
  kind: string | null;
  work_unit_ids: string[];
};

export type ProviderScopedOverview = {
  as_of: number;
  binding: { kind: 'provider-scoped'; provider: string; provider_session_id: string };
  session: { available: false; reason: string };
  children: {
    available: false;
    reason: string;
    items: SessionOverviewChild[];
    truncated: boolean;
    depth_limit: number;
    count_limit: number;
  };
  linked_issues: SessionOverviewSection<ProviderScopedLinkedIssue> & {
    source: string;
    note: string;
  };
  work_units: SessionOverviewSection<SessionOverviewWorkUnit> & {
    includes_descendants: boolean;
    matched_provider_aliases: string[];
  };
  conversations: SessionOverviewSection<SessionOverviewConversation> & { limit: number };
};

export async function getProviderScopedOverview(
  provider: string,
  providerSessionId: string,
): Promise<ProviderScopedOverview> {
  const query = buildQuery({ provider, provider_session_id: providerSessionId });
  const response = await apiGet(`/api/sessions/overview/by-provider${query}`);
  return await response.json() as ProviderScopedOverview;
}

// Issue 037fa85 / f59b5bd (review S1) — explicit, user-initiated registration
// of a provider-known session as a Mandible session row. The client sends
// ONLY the server-resolved full identity; the daemon derives provider, cwd,
// and branch from the validated conversations record and rejects identities
// with no ingested transcript, so the forgeable page binding can never steer
// the registered identity. The deterministic server-side id keeps repeat
// clicks idempotent.
export async function registerProviderSession(input: {
  provider_session_id: string;
}): Promise<{ id: string; provider: string }> {
  const response = await apiPost('/api/sessions/register-provider', {
    provider_session_id: input.provider_session_id,
  });
  return await response.json() as { id: string; provider: string };
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
  const payload = await cachedApiGetJson<ApiList<T>>('/api/auth/queue');
  return normalizeList(payload);
}

export async function getAuthHistory<T>(limit?: number): Promise<T[]> {
  const query = limit != null ? `?limit=${limit}` : '';
  const payload = await cachedApiGetJson<ApiList<T>>(`/api/auth/history${query}`);
  return normalizeList(payload);
}

export type DashboardBadgeCounts = {
  auth: number;
  inbox: number;
  work: number;
  /**
   * Briefing pending-candidate count (umbrella 99b74d6, contract v1 §4). The
   * server is the only authority for this number — no client-derived fallback
   * exists in selectBadgeCounts — so it stays optional. Absent means "no count
   * reported" (e.g. an older server), not "zero pending".
   */
  briefing?: number;
};

export async function getDashboardBadges(): Promise<DashboardBadgeCounts> {
  // Served through the shared SWR cache so a burst of SSE events collapses to a
  // single in-flight fetch. Count-changing events invalidate this key via
  // invalidateDashboardApiCacheForEvent; the short TTL is burst protection only.
  return cachedApiGetJson<DashboardBadgeCounts>('/api/dashboard/badges');
}

// Bug: 0de95bf — history list rows omit diff/spec/output body blobs; the
// detail route serves the full body, fetched when a request is selected.
export async function getAuthRequestDetail(requestId: string): Promise<Record<string, unknown> | null> {
  const response = await apiGet(`/api/auth/request/${encodeURIComponent(requestId)}`);
  const payload = await parseMaybeJson(response);
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
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

export async function removeDelegatedSigning(): Promise<AuthAutoApproveStatus> {
  const response = await apiDelete('/api/auth/auto-approve/signing');
  return (await parseMaybeJson(response)) as AuthAutoApproveStatus;
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
  const payload = await cachedApiGetJson<ApiList<T>>('/api/work/repos');
  return normalizeList(payload);
}

export async function getRepoBranches<T>(repoId: string): Promise<T[]> {
  const payload = await cachedApiGetJson<ApiList<T>>(
    `/api/work/repos/${encodeURIComponent(repoId)}/branches`,
  );
  return normalizeList(payload);
}

export async function getRepoBranchCommits(
  repoId: string,
  branch: string,
  params: { limit?: number; offset?: number } = {},
): Promise<WorkCommitPage> {
  const response = await apiGet(
    `/api/work/repos/${encodeURIComponent(repoId)}/branches/${encodeURIComponent(branch)}/commits${buildQuery(params)}`,
  );
  return (await response.json()) as WorkCommitPage;
}

export async function getWorkCompare(
  repoId: string,
  params: { from: string; to: string; mode?: WorkCompareMode },
): Promise<WorkCompareResult> {
  const response = await apiGet(
    `/api/work/repos/${encodeURIComponent(repoId)}/compare${buildQuery(params)}`,
  );
  return (await response.json()) as WorkCompareResult;
}

export async function getWorkRepoAudit(repoId: string): Promise<WorkRepoAudit> {
  const response = await apiGet(`/api/work/repos/${encodeURIComponent(repoId)}/audit`);
  return (await parseMaybeJson(response)) as WorkRepoAudit;
}

/**
 * Move a branch/worktree into reversible custody without discarding partial
 * outcome facts from non-2xx responses.
 */
export async function createTrashEntry(request: TrashCreateRequest): Promise<TrashCreateResult> {
  const response = await fetch('/api/v1/trash', {
    method: 'POST',
    headers: {
      ...DEFAULT_HEADERS,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  });
  const parsed = await parseMaybeJson(response);
  const body = typeof parsed === 'object' && parsed !== null
    ? parsed as TrashCreateBody
    : { error: typeof parsed === 'string' ? parsed : `POST /api/v1/trash failed: ${response.status}` };
  return { ok: response.ok, status: response.status, body };
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
  return cachedApiGetJson<InboxData>('/api/inbox/global');
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

export type ReadUserIdentity = {
  id: string;
  display_name: string;
  kind: 'human' | 'agent' | 'system' | 'external';
};

export type AttributionReadProjection = {
  user: ReadUserIdentity | null;
  evidence_method: string | null;
  evidence_id: string | null;
  credential: {
    id: string;
    type: string;
    label: string | null;
  } | null;
};

export type LedgerIssueDetailActor = {
  id: string | null;
  type: LedgerActorType;
  display: string;
  legacy_display: string;
  attribution: AttributionReadProjection | null;
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
      kind: 'event';
      event_type: string;
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
  owner: ReadUserIdentity | null;
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
  requester: ReadUserIdentity | null;
  approver: ReadUserIdentity | null;
  execution_evidence: AttributionReadProjection | null;
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
  link_kind: 'pinned' | 'living';
  series_id: string | null;
  series_ref: string | null;
  resolved_version_no: number | null;
  target_type: 'artifact' | 'artifact_version' | 'artifact_blob' | null;
  target_id: string | null;
  created_at: number;
  updated_at: number;
};

export type LedgerIssueDetailAssociatedArtifact = {
  id: string;
  /** Public ref for the immutable bytes; present on canonical projections. */
  ref?: string;
  title: string | null;
  logical_name: string | null;
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
    project_key?: string | null;
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
  detail_stage?: 'initial' | 'full';
  timeline_partial?: boolean;
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

export async function getLedgerIssueDetailByIssueId(
  issueId: string,
): Promise<LedgerIssueDetailProjection> {
  const response = await apiGet(
    `/api/ledger/issues/${encodeURIComponent(issueId)}`
  );
  return (await parseMaybeJson(response)) as LedgerIssueDetailProjection;
}

export async function getLedgerIssueInitialDetailByRef(
  repoId: string,
  issueId: string,
): Promise<LedgerIssueDetailProjection> {
  const response = await apiGet(
    `/api/issues/${encodeURIComponent(repoId)}/${encodeURIComponent(issueId)}/ledger-detail?stage=initial`
  );
  return (await parseMaybeJson(response)) as LedgerIssueDetailProjection;
}

export async function getLedgerIssueInitialDetailByIssueId(
  issueId: string,
): Promise<LedgerIssueDetailProjection> {
  const response = await apiGet(
    `/api/ledger/issues/${encodeURIComponent(issueId)}?stage=initial`
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

export async function getSettings(): Promise<Record<string, string>> {
  const payload = await cachedApiGetJson<unknown>('/api/settings');
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return payload as Record<string, string>;
  }
  return {};
}

/**
 * Issue 8aadf70 — which Claude lanes this daemon ships. The Claude PTY lane
 * (terminal driving) is local-only and off by default, and the gate is
 * resolvable from an environment override as well as the settings table, so the
 * dialog asks the daemon instead of reading the setting directly.
 */
export type ConsoleLanePolicy = {
  claude_default_backend_type: ConsoleBackendType;
  claude_pty_lane_enabled: boolean;
};

export async function getConsoleLanePolicy(): Promise<ConsoleLanePolicy> {
  const payload = await cachedApiGetJson<unknown>('/api/console/lane-policy');
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  return {
    claude_default_backend_type: (record.claude_default_backend_type as ConsoleBackendType) ?? 'sdk',
    claude_pty_lane_enabled: record.claude_pty_lane_enabled === true,
  };
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
  invalidateApiGetCache('/api/settings');
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
  const payload = await cachedApiGetJson<ApiList<T>>('/api/console/sessions');
  return normalizeList(payload);
}

export async function restartConsoleSession(sessionId: string): Promise<void> {
  await apiPost(`/api/console/sessions/${encodeURIComponent(sessionId)}/restart`);
}

export async function startConsoleSession(sessionId: string): Promise<void> {
  await apiPost(`/api/console/sessions/${encodeURIComponent(sessionId)}/start`);
}

export type ConsoleBackendType = 'pty' | 'sdk' | 'spawn' | 'acp';
export type ConsoleTransportLane = 'sdk' | 'pty' | 'channel' | 'acp' | 'spawn';
export type ConsolePermissionDecision =
  | 'deny'
  | 'allow'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always'
  | `option:${string}`;
export type ConsoleThinkingEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

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
  options?: Array<{
    key: string;
    label: string;
    decision?: ConsolePermissionDecision;
  }>;
};

export type ConsoleSessionOptions = {
  model?: string;
  thinkingEffort?: ConsoleThinkingEffort;
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
  options?: { channel_enabled?: boolean; transport_lane?: ConsoleTransportLane; presetIds?: string[] },
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
  transport_lane: ConsoleTransportLane;
  transport_badge?: {
    label: 'SDK' | 'PTY' | 'Channel' | 'ACP' | 'Spawn';
    title: string;
  };
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
    transport_lane?: ConsoleTransportLane;
    presetIds?: string[];
  };
  const body: SessionBody = { label, command: '', args: [] };
  if (options?.channel_enabled) {
    body.channel_enabled = true;
  }
  if (options?.transport_lane) {
    body.transport_lane = options.transport_lane;
  }
  if (options?.presetIds) {
    body.presetIds = options.presetIds;
  }
  // Issue 8aadf70 — Claude sessions default to the sanctioned Agent SDK lane,
  // which gates tools through canUseTool and Mandible's permission cards.
  // `--dangerously-skip-permissions` is never sent for the default lane; it
  // stays only on the local-only, explicitly gated Claude PTY lane.
  if (kind === 'operator') {
    body.command = 'claude';
    body.backend_type = backendType ?? 'sdk';
    body.args = body.backend_type === 'pty' ? ['--dangerously-skip-permissions'] : [];
    body.auto_restart = true;
    body.is_operator = true;
  } else if (backend === 'claude') {
    body.command = 'claude';
    body.backend_type = backendType ?? 'sdk';
    body.args = body.backend_type === 'pty' ? ['--dangerously-skip-permissions'] : [];
  } else if (backend === 'codex') {
    body.command = 'codex';
    body.args = [];
    body.backend_type = backendType ?? 'acp';
  } else if (backend === 'gemini') {
    body.command = 'gemini';
    body.args = [];
    body.backend_type = backendType ?? 'acp';
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
      transport_lane: ConsoleTransportLane;
      transport_badge?: {
        label: 'SDK' | 'PTY' | 'Channel' | 'ACP' | 'Spawn';
        title: string;
      };
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

export async function cancelConsolePrompt(
  sessionId: string,
): Promise<void> {
  await apiPost(`/api/console/sessions/${encodeURIComponent(sessionId)}/cancel`);
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

export async function getStatuslineTelemetry<T = Record<string, unknown>>(params: {
  sessionRef?: string | null;
  transcriptPath?: string | null;
}): Promise<T | null> {
  const query = new URLSearchParams();
  if (params.sessionRef) query.set('sessionRef', params.sessionRef);
  if (params.transcriptPath) query.set('transcriptPath', params.transcriptPath);
  const response = await apiGet(`/api/hooks/statusline?${query.toString()}`);
  const payload = await parseMaybeJson(response) as { telemetry?: T | null };
  return payload.telemetry ?? null;
}

// ── Message params API (Bug: 790433d) ──

export type MessageParams = {
  id: number;
  session_id: string;
  message_index: number;
  model: string | null;
  thinking_effort: string | null;
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
  return cachedApiGetJson<{ conversations: Conversation[]; total: number }>(
    `/api/conversations${qs ? '?' + qs : ''}`,
  );
}

export async function getConversation(id: string, leaf?: string): Promise<Conversation & { blocks: ConversationBlock[]; children: ConversationChild[]; parent: ConversationParent | null }> {
  const query = leaf ? `?leaf=${encodeURIComponent(leaf)}` : '';
  const resp = await apiGet(`/api/conversations/${encodeURIComponent(id)}${query}`);
  const payload = (await parseMaybeJson(resp)) as {
    conversation?: Conversation;
    blocks?: ConversationBlock[];
    children?: ConversationChild[];
    parent?: ConversationParent | null;
  };
  // Flatten: merge top-level conversation fields with blocks/children arrays
  return {
    ...(payload.conversation ?? {} as Conversation),
    blocks: payload.blocks ?? [],
    children: payload.children ?? [],
    parent: payload.parent ?? null,
  } as Conversation & { blocks: ConversationBlock[]; children: ConversationChild[]; parent: ConversationParent | null };
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
  options: { force?: boolean; fork?: boolean } = {},
): Promise<{ console_session_id?: string; session_id?: string; attach_state?: ConversationAttachState }> {
  const path = `/api/conversations/${encodeURIComponent(conversationId)}/resume`;
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      ...DEFAULT_HEADERS,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message_dag_uuid: messageDagUuid,
      label,
      ...(model ? { model } : {}),
      ...(options.force ? { force: true } : {}),
      ...(options.fork ? { fork: true } : {}),
    }),
  });
  const payload = await parseMaybeJson(response) as {
    console_session_id?: string;
    session_id?: string;
    attach_state?: ConversationAttachState;
    error?: string;
    reason?: string;
    message?: string;
    details?: string;
  };
  if (!response.ok) {
    const message = payload.message || payload.error || `POST ${path} failed: ${response.status}`;
    const error = new Error(message) as Error & {
      status?: number;
      body?: typeof payload;
    };
    error.status = response.status;
    error.body = payload;
    throw error;
  }
  return payload;
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

export type LogFacetValue = {
  value: string;
  count: number;
};

export type LogEntityFacetValue = LogFacetValue & {
  type: 'issue' | 'auth_request' | 'artifact' | 'session' | 'repo';
};

export type LogFacets = {
  levels: LogFacetValue[];
  subsystems: LogFacetValue[];
  events: LogFacetValue[];
  entity_refs: LogEntityFacetValue[];
  latest_ts: string | null;
  latest_heartbeat_ts: string | null;
};

export type LogEntry = {
  id?: string;
  level: string;
  message?: string;
  event?: string;
  subsystem?: string;
  time?: string;
  issue_id?: string | null;
  auth_request_id?: string | null;
  artifact_id?: string | null;
  session_id?: string | null;
  repo_id?: string | null;
  [key: string]: unknown;
};

export type LogsResponse = {
  entries: LogEntry[];
  total: number;
  limit: number;
  offset: number;
  log_file: string;
  exists: boolean;
  source?: 'daemon_log' | 'stderr_file';
  facets?: LogFacets;
  older_cursor?: string | null;
  has_older?: boolean;
};

export async function getLogs(params?: {
  levels?: string[];
  level?: string;
  subsystem?: string;
  event?: string;
  q?: string;
  related?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
  before?: string;
}): Promise<LogsResponse> {
  const query = new URLSearchParams();
  if (params?.levels && params.levels.length > 0) query.set('levels', params.levels.join(','));
  if (params?.level) query.set('level', params.level);
  if (params?.subsystem) query.set('subsystem', params.subsystem);
  if (params?.event) query.set('event', params.event);
  if (params?.q) query.set('q', params.q);
  if (params?.related) query.set('related', params.related);
  if (params?.since) query.set('since', params.since);
  if (params?.until) query.set('until', params.until);
  if (params?.limit != null) query.set('limit', String(params.limit));
  if (params?.offset != null) query.set('offset', String(params.offset));
  if (params?.before) query.set('before', params.before);
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

/**
 * The dashboard is served over HTTP from the daemon into the desktop webview,
 * so it cannot import `@tauri-apps/api` modules at runtime: a bare specifier
 * has no URL the webview can resolve. The Tauri runtime instead publishes its
 * API on the window — `withGlobalTauri` exposes the namespaced `__TAURI__`
 * bundle, and every Tauri v2 webview carries the lower-level
 * `__TAURI_INTERNALS__.invoke` that `@tauri-apps/api/core` wraps.
 */
type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

type TauriWebview = { navigate: (url: string) => Promise<void> };

type TauriGlobalWindow = Window & {
  __TAURI__?: {
    core?: { invoke?: TauriInvoke };
    webview?: { getCurrentWebview?: () => TauriWebview };
  };
  __TAURI_INTERNALS__?: { invoke?: TauriInvoke };
};

function tauriGlobalWindow(): TauriGlobalWindow | null {
  if (typeof window === 'undefined') {
    return null;
  }
  return window as TauriGlobalWindow;
}

function hasTauriRuntime(): boolean {
  const tauriWindow = tauriGlobalWindow();
  return Boolean(tauriWindow && (tauriWindow.__TAURI__ || tauriWindow.__TAURI_INTERNALS__));
}

/**
 * Resolve the command bridge for whichever global the runtime check accepted:
 * the namespaced bundle when `withGlobalTauri` is on, the internals bridge
 * otherwise. Both are plain functions, so reading them off the namespace is
 * safe.
 */
function tauriInvoke(): TauriInvoke | null {
  const tauriWindow = tauriGlobalWindow();
  const invoke = tauriWindow?.__TAURI__?.core?.invoke ?? tauriWindow?.__TAURI_INTERNALS__?.invoke;
  return typeof invoke === 'function' ? invoke : null;
}

export function isDesktopShell(): boolean {
  return hasTauriRuntime();
}

async function invokeDesktop<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const invoke = tauriInvoke();
  if (!invoke) {
    throw new Error('Desktop daemon controls are only available in the Tauri app.');
  }
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

/**
 * Where the desktop shell reads the credential it enrolls this webview with:
 * the one-shot operator bootstrap file, or the durable `mandible-operator`
 * keychain item that outlives the first-enrollment window (issue 54b5677).
 */
export type DesktopEnrollmentSource = 'bootstrap' | 'keychain';

/**
 * Ask the desktop shell to enroll this webview. The shell reads the local
 * credential, redeems it for a bounded dashboard session against the daemon,
 * and navigates with only that session in a URL fragment — no durable
 * credential is returned across IPC or exposed to this renderer, so `true`
 * means "a session was injected". `route` keeps the operator on their current
 * view instead of resetting it. The keychain command deliberately accepts no
 * retry-control argument: renderer input cannot decide whether Rust may read
 * the durable credential.
 */
export async function enrollDesktopClientAuth(
  source: DesktopEnrollmentSource,
  options: { route?: string } = {},
): Promise<boolean> {
  if (!hasTauriRuntime()) {
    return false;
  }
  if (source === 'bootstrap') {
    return invokeDesktop<boolean>('client_auth_enroll');
  }
  return invokeDesktop<boolean>('client_auth_keychain_enroll', {
    route: options.route ?? null,
  });
}

export async function navigateToDesktopBootstrap(): Promise<void> {
  if (!hasTauriRuntime()) {
    return;
  }
  const getCurrentWebview = tauriGlobalWindow()?.__TAURI__?.webview?.getCurrentWebview;
  if (typeof getCurrentWebview !== 'function') {
    throw new Error('Desktop webview navigation is only available in the Tauri app.');
  }
  await getCurrentWebview().navigate('/index.html');
}

// ── Conversation types ──

export type BlockType = ContractBlockType;
export type Role = ContractRole;
export type ConversationSource = ContractConversationSource;

export type ConversationAttachState = ContractConversationAttachState;

export type ConversationBlock = ContractConversationBlock;

export type Conversation = ContractConversation;

export type ConversationChild = ContractConversationChild;
export type ConversationParent = ContractConversationParent;
export type WorkflowRun = ContractWorkflowRun;
export type WorkflowPhase = ContractWorkflowPhase;
export type WorkflowWorker = ContractWorkflowWorker;
export type WorkflowRunStatus = ContractWorkflowRunStatus;
export type WorkflowWorkerStatus = ContractWorkflowWorkerStatus;
export type WorkflowWarning = ContractWorkflowWarning;

export async function listWorkflows(params: {
  session_id?: string | null;
} = {}): Promise<WorkflowRun[]> {
  const query = new URLSearchParams();
  if (params.session_id) query.set('session_id', params.session_id);
  const qs = query.toString();
  const payload = await cachedApiGetJson<{ workflows?: WorkflowRun[] }>(
    `/api/workflows${qs ? '?' + qs : ''}`,
  );
  return Array.isArray(payload.workflows) ? payload.workflows : [];
}

export async function getWorkflow(id: string): Promise<WorkflowRun> {
  const payload = await cachedApiGetJson<{ workflow?: WorkflowRun }>(
    `/api/workflows/${encodeURIComponent(id)}`,
  );
  if (!payload.workflow) {
    throw new Error('Workflow run not found');
  }
  return payload.workflow;
}

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
  return cachedApiGetJson<{ nodes: GraphNode[]; edges: GraphEdge[] }>(
    `/api/graph${qs ? '?' + qs : ''}`,
  );
}

// ── Artifact API ──

export type ArtifactAliasResolutionStatus = ContractArtifactAliasResolutionStatus;

export type ArtifactAliasRecord = ContractArtifactAliasRecord;

export type ArtifactLinkRecord = Omit<
  ContractArtifactLinkRecord,
  'link_kind' | 'series_id' | 'series_ref' | 'resolved_version_no'
> & {
  link_kind: 'pinned' | 'living';
  series_id: string | null;
  series_ref: string | null;
  resolved_version_no?: number | null;
};

export type ArtifactRecord = Omit<ContractArtifactRecord, 'links'> & {
  links?: ArtifactLinkRecord[];
};

export type ArtifactResolveResult = ContractArtifactResolveResult;

export type ArtifactSeriesRecord = ContractArtifactSeriesRecord;

export type ArtifactSeriesSummary = ContractArtifactSeriesSummary;

export type ArtifactVersionRecord = ContractArtifactVersionRecord;

export type ArtifactDraftRecord = ContractArtifactDraftRecord;

export type ArtifactDraftPublishResult = ContractArtifactDraftPublishResult;

export type ArtifactVersionHistory = {
  series: ArtifactSeriesRecord;
  versions: ArtifactVersionRecord[];
  links: ArtifactLinkRecord[];
};

export type ArtifactContentResult = {
  artifact_id: string;
  status: 'available' | 'unavailable';
  kind: 'text' | 'markdown' | 'json' | 'html' | 'binary' | 'unavailable';
  media_type: string;
  size_bytes: number;
  source: {
    kind: 'managed_file' | 'repo_locator' | 'local_file';
    locator: string;
  } | null;
  preview: {
    encoding: 'utf-8';
    text: string;
    raw_text?: string;
    formatted?: 'json';
    truncated: boolean;
    preview_bytes?: number;
    total_bytes?: number;
    omitted_bytes?: number;
    format_skipped?: 'partial_preview';
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

export type ArtifactDiffResult = {
  a: {
    ref: string;
    artifact_id: string | null;
    content_hash: string | null;
    media_type: string;
    size_bytes: number | null;
    available: boolean;
    reason?: string;
  };
  b: {
    ref: string;
    artifact_id: string | null;
    content_hash: string | null;
    media_type: string;
    size_bytes: number | null;
    available: boolean;
    reason?: string;
  };
  diffable: boolean;
  identical: boolean;
  kind: string;
  unified: string | null;
  stats: { added: number; removed: number } | null;
  reason?: string;
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
  summary?: boolean;
};

export async function getArtifacts(params: ArtifactQueryParams = {}): Promise<ArtifactRecord[]> {
  const query = buildQuery(params);
  const payload = await cachedApiGetJson<{ artifacts?: ArtifactRecord[] }>(`/api/artifacts${query}`);
  return payload.artifacts ?? [];
}

export async function getArtifactSeriesList(params: ArtifactQueryParams = {}): Promise<ArtifactSeriesSummary[]> {
  const query = buildQuery(params);
  const payload = await cachedApiGetJson<{ series?: ArtifactSeriesSummary[] }>(
    `/api/artifacts/series${query}`,
  );
  return payload.series ?? [];
}

export async function getArtifactVersions(
  ref: string,
  options: { signal?: AbortSignal } = {},
): Promise<ArtifactVersionHistory> {
  const query = buildQuery({ ref });
  const response = await apiGet(`/api/artifacts/versions${query}`, { signal: options.signal });
  const payload = (await parseMaybeJson(response)) as { history: ArtifactVersionHistory };
  return payload.history;
}

export async function getArtifactDiff(from: string, to: string): Promise<ArtifactDiffResult> {
  const query = buildQuery({ a: from, b: to });
  const response = await apiGet(`/api/artifacts/diff${query}`);
  const payload = (await parseMaybeJson(response)) as { diff: ArtifactDiffResult };
  return payload.diff;
}

export async function getArtifactDraft(ref: string, options: { signal?: AbortSignal } = {}): Promise<ArtifactDraftRecord | null> {
  const query = buildQuery({ ref });
  const response = await apiGet(`/api/artifacts/drafts${query}`, { signal: options.signal });
  const payload = (await parseMaybeJson(response)) as { draft: ArtifactDraftRecord | null };
  return payload.draft ?? null;
}

export async function saveArtifactDraft(input: {
  ref: string;
  base_version_id?: string;
  content: string;
  media_type?: string | null;
  label?: string | null;
  note?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<ArtifactDraftRecord> {
  const response = await apiPost('/api/artifacts/drafts', input);
  const payload = (await parseMaybeJson(response)) as { draft: ArtifactDraftRecord };
  return payload.draft;
}

export async function rebaseArtifactDraft(ref: string): Promise<ArtifactDraftRecord> {
  const response = await apiPost('/api/artifacts/drafts/rebase', { ref });
  const payload = (await parseMaybeJson(response)) as { draft: ArtifactDraftRecord };
  return payload.draft;
}

export async function publishArtifactDraft(input: {
  ref: string;
  label?: string | null;
  note?: string | null;
  allow_stale?: boolean;
}): Promise<ArtifactDraftPublishResult> {
  const response = await apiPost('/api/artifacts/drafts/publish', input);
  return (await parseMaybeJson(response)) as ArtifactDraftPublishResult;
}

export async function deleteArtifactDraft(ref: string): Promise<{ deleted: boolean }> {
  const query = buildQuery({ ref });
  const response = await apiDelete(`/api/artifacts/drafts${query}`);
  return (await parseMaybeJson(response)) as { deleted: boolean };
}

export async function getArtifact(id: string, options: { signal?: AbortSignal } = {}): Promise<ArtifactRecord> {
  const response = await apiGet(`/api/artifacts/${encodeURIComponent(id)}`, { signal: options.signal });
  const payload = (await parseMaybeJson(response)) as { artifact: ArtifactRecord };
  return payload.artifact;
}

export async function getArtifactContent(id: string, options: { signal?: AbortSignal } = {}): Promise<ArtifactContentResult> {
  const response = await apiGet(`/api/artifacts/${encodeURIComponent(id)}/content`, { signal: options.signal });
  const payload = (await parseMaybeJson(response)) as { content: ArtifactContentResult };
  return payload.content;
}

export async function openArtifactExternally(id: string): Promise<void> {
  await apiPost(`/api/artifacts/${encodeURIComponent(id)}/open-externally`, {});
}

export async function getArtifactKnowledgeBackrefs(id: string, options: { signal?: AbortSignal } = {}): Promise<KnowledgeBackrefRecord[]> {
  const response = await apiGet(`/api/artifacts/${encodeURIComponent(id)}/knowledge-backrefs`, { signal: options.signal });
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
  const payload = await cachedApiGetJson<ApiList<Preset>>('/api/presets');
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
  const payload = await cachedApiGetJson<Record<string, unknown>>(
    `/api/presets/union${qs ? '?' + qs : ''}`,
  );
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
  const payload = await cachedApiGetJson<{ presets?: SessionPreset[] } | SessionPreset[]>(
    `/api/console/sessions/${encodeURIComponent(sessionId)}/presets`,
  );
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
  const payload = await cachedApiGetJson<{ spaces: ContractSpace[] }>(
    `/api/spaces${buildQuery({ project_id: projectId })}`,
  );
  return payload.spaces;
}

/**
 * Grouped Spaces list for the home view (issue 812df41): `GET /api/spaces` with no
 * `project_id`. Returns one group per owning project plus a single top-level group
 * (`project_id: null`) first, so the UI can render a top-level section and a section
 * per project. Each Space carries its nullable `project_id`.
 */
export async function listSpacesGrouped(): Promise<ContractSpaceGroup[]> {
  const payload = await cachedApiGetJson<{ groups?: ContractSpaceGroup[] }>('/api/spaces');
  return payload.groups ?? [];
}

/** List only the top-level / global Spaces (project_id IS NULL, issue 812df41). */
export async function listTopLevelSpaces(): Promise<ContractSpace[]> {
  const payload = await cachedApiGetJson<{ spaces: ContractSpace[] }>(
    `/api/spaces${buildQuery({ scope: 'top-level' })}`,
  );
  return payload.spaces;
}

/**
 * Minimal project summary for the space-creation project picker (issue 6fdd924).
 * Sourced from the canonical project registry (`GET /api/projects`) so projects
 * with zero spaces are still enumerable when creating the first space under them.
 */
export type ProjectPickerItem = {
  id: string;
  project_key: string;
  display_name: string | null;
};

export type ProjectPermissionGrant = {
  id: string;
  subject_type: 'user' | 'group';
  subject_id: string;
  resource_type: 'project';
  resource_id: string;
  permission: 'read' | 'write' | 'admin';
};

export type ProjectAccessSettings = {
  project_id: string;
  restricted: boolean;
  grants: ProjectPermissionGrant[];
};

export type SpaceFactPacket = {
  space: ContractSpace;
  items: ContractSpaceItem[];
  occurrences: ContractSpaceOccurrence[];
  edges: ContractSpaceEdge[];
};

function invalidateSpaceCaches(spaceId?: string): void {
  invalidateApiGetCache('/api/spaces');
  if (spaceId) {
    invalidateApiGetCache(`/api/spaces/${encodeURIComponent(spaceId)}`);
  }
}

/**
 * Fetch the project list from the registry for use in the space-creation picker
 * (issue 6fdd924). Returns a lightweight summary array; callers display
 * `display_name` (or fall back to `project_key`) as the option label.
 */
export async function listProjectsForPicker(): Promise<ProjectPickerItem[]> {
  const payload = await cachedApiGetJson<{
    projects?: Array<{ id: string; project_key: string; display_name?: string | null }>;
  }>('/api/projects');
  return (payload.projects ?? []).map((p) => ({
    id: p.id,
    project_key: p.project_key,
    display_name: p.display_name ?? null,
  }));
}

export async function getProjectAccessSettings(projectRef: string): Promise<ProjectAccessSettings> {
  const response = await apiGet(`/api/projects/${encodeURIComponent(projectRef)}/access`);
  return await parseMaybeJson(response) as ProjectAccessSettings;
}

export async function updateProjectAccessSettings(
  projectRef: string,
  restricted: boolean,
): Promise<ProjectAccessSettings> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectRef)}/access`, {
    method: 'PATCH',
    headers: { ...DEFAULT_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ restricted }),
  });
  const payload = await parseMaybeJson(response);
  if (!response.ok) {
    const error = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as { error?: unknown }).error
      : null;
    throw new Error(typeof error === 'string' ? error : `PATCH project access failed: ${response.status}`);
  }
  return payload as ProjectAccessSettings;
}

export async function getSpace(spaceId: string): Promise<ContractSpace> {
  const payload = await cachedApiGetJson<{ space: ContractSpace }>(
    `/api/spaces/${encodeURIComponent(spaceId)}`,
  );
  return payload.space;
}

/**
 * Full Space fact packet (space + items/occurrences/edges) read from
 * `GET /api/spaces/:id` (umbrella plan §5.1). The renderers (C8 collection,
 * C9a canvas, …) assemble their `SpaceViewModel` from this single read. Older
 * responses that omit the collections degrade to empty arrays.
 */
export async function getSpaceFactPacket(spaceId: string): Promise<SpaceFactPacket> {
  const payload = await cachedApiGetJson<{
    space: ContractSpace;
    items?: ContractSpaceItem[];
    occurrences?: ContractSpaceOccurrence[];
    edges?: ContractSpaceEdge[];
  }>(`/api/spaces/${encodeURIComponent(spaceId)}`, { ttlMs: 0, staleWhileRevalidateMs: 0 });
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
  invalidateSpaceCaches(payload.space.id);
  return payload.space;
}

export async function updateSpace(spaceId: string, body: UpdateSpaceRequest): Promise<ContractSpace> {
  const response = await apiPatch(`/api/spaces/${encodeURIComponent(spaceId)}`, body);
  const payload = (await parseMaybeJson(response)) as { space: ContractSpace };
  invalidateSpaceCaches(spaceId);
  return payload.space;
}

export async function deleteSpace(spaceId: string): Promise<void> {
  await apiDelete(`/api/spaces/${encodeURIComponent(spaceId)}`);
  invalidateSpaceCaches(spaceId);
}

// --- items ---

export async function addSpaceItem(spaceId: string, body: AddSpaceItemRequest): Promise<AddSpaceItemResponse> {
  const response = await apiPost(`/api/spaces/${encodeURIComponent(spaceId)}/items`, body);
  const payload = (await parseMaybeJson(response)) as AddSpaceItemResponse;
  invalidateSpaceCaches(spaceId);
  return payload;
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
  invalidateSpaceCaches(spaceId);
  return payload.item;
}

export async function deleteSpaceItem(spaceId: string, itemId: string): Promise<void> {
  await apiDelete(`/api/spaces/${encodeURIComponent(spaceId)}/items/${encodeURIComponent(itemId)}`);
  invalidateSpaceCaches(spaceId);
}

// --- occurrences ---

export async function createSpaceOccurrence(
  spaceId: string,
  body: CreateSpaceOccurrenceRequest,
): Promise<ContractSpaceOccurrence> {
  const response = await apiPost(`/api/spaces/${encodeURIComponent(spaceId)}/occurrences`, body);
  const payload = (await parseMaybeJson(response)) as { occurrence: ContractSpaceOccurrence };
  invalidateSpaceCaches(spaceId);
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
  invalidateSpaceCaches(spaceId);
  return payload.occurrence;
}

export async function deleteSpaceOccurrence(spaceId: string, occurrenceId: string): Promise<void> {
  await apiDelete(
    `/api/spaces/${encodeURIComponent(spaceId)}/occurrences/${encodeURIComponent(occurrenceId)}`,
  );
  invalidateSpaceCaches(spaceId);
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
  const payload = (await parseMaybeJson(response)) as BatchSpaceOccurrenceResponse;
  invalidateSpaceCaches(spaceId);
  return payload;
}

// --- edges ---

export async function createSpaceEdge(
  spaceId: string,
  body: CreateSpaceEdgeRequest,
): Promise<ContractSpaceEdge> {
  const response = await apiPost(`/api/spaces/${encodeURIComponent(spaceId)}/edges`, body);
  const payload = (await parseMaybeJson(response)) as { edge: ContractSpaceEdge };
  invalidateSpaceCaches(spaceId);
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
  invalidateSpaceCaches(spaceId);
  return payload.edge;
}

export async function deleteSpaceEdge(spaceId: string, edgeId: string): Promise<void> {
  await apiDelete(`/api/spaces/${encodeURIComponent(spaceId)}/edges/${encodeURIComponent(edgeId)}`);
  invalidateSpaceCaches(spaceId);
}

// --- seed-from-filter ---

export async function seedSpace(spaceId: string, body: SeedSpaceRequest): Promise<SeedSpaceResult> {
  const response = await apiPost(`/api/spaces/${encodeURIComponent(spaceId)}/seed`, body);
  const payload = (await parseMaybeJson(response)) as SeedSpaceResult;
  invalidateSpaceCaches(spaceId);
  return payload;
}

// --- unified ref resolver ---

export async function resolveSpaceRef(ref: string): Promise<ResolverResult> {
  const response = await apiGet(`/api/refs/resolve${buildQuery({ ref })}`);
  const payload = (await parseMaybeJson(response)) as { resolution: ResolverResult };
  return payload.resolution;
}

// --- Spaces document custody: export-and-track + repo-file registration (C13b
// backend, issue 8730bf9) typed client glue consumed by the export dialog + the
// repo-file registration UI (C13f, issue f7be021). Committing a document to a
// repo is ALWAYS an explicit user action: these helpers are only ever called
// from an explicit user-triggered dialog submit, never on a background tick.
// ---------------------------------------------------------------------------

/**
 * Resolved export settings for a Space: the global default repo-relative path /
 * branch, the resolved value after applying any per-repo override, and the repo
 * scope the dialog is operating against. Mirrors `resolveDocsSettings`
 * (`src/spaces/export.ts`) which the `GET .../exports` route returns.
 */
export type SpaceExportSettings = {
  /** Effective repo-relative export path after global → per-repo resolution. */
  path: string;
  /** Effective docs branch after global → per-repo resolution. */
  branch: string;
  /** True when a per-repo override (not just the global default) is in effect. */
  overridden?: boolean;
};

/**
 * The export tracking read surface for a Space: the existing `space_exports`
 * rows + the resolved export settings + the repo scope. Backs the export dialog
 * default/override resolution (custody-doc §5.1).
 */
export type SpaceExportsReadResult = {
  exports: ContractSpaceExport[];
  repo_id: string;
  settings: SpaceExportSettings;
};

/** Read the tracked exports + resolved export settings for a Space. */
export async function getSpaceExports(
  spaceId: string,
  repoId?: string,
): Promise<SpaceExportsReadResult> {
  const response = await apiGet(
    `/api/spaces/${encodeURIComponent(spaceId)}/exports${buildQuery({ repo_id: repoId })}`,
  );
  return (await parseMaybeJson(response)) as SpaceExportsReadResult;
}

/** Confirmed inputs the export dialog posts for an explicit export-and-track. */
export type ExportAndTrackRequest = {
  /** Confirmed repo-relative target path (dialog confirm/override output). */
  path?: string | null;
  /** Docs branch override; defaults to the resolved per-repo/global branch. */
  branch?: string | null;
  /** Explicit project-checkout id; defaults to the Space's project checkout. */
  repo_id?: string | null;
  /** Issue refs for the `Mandible-Issue:` trailer on the docs commit (required). */
  issues: string[];
  /** Commit subject; a deterministic default is used when omitted. */
  message?: string | null;
};

export type ExportAndTrackResult = {
  export: ContractSpaceExport;
  document_content_sha256: string;
  commit: string;
  pre_export_snapshot_artifact_id: string;
  last_export_artifact_id: string;
};

/**
 * Explicit export-and-track: serialize the Space document, write it to the
 * managed docs-branch worktree at the confirmed path, agent-key linked-commit
 * it, and upsert the `space_exports` tracking row. Re-exporting the SAME
 * document to the SAME confirmed path is idempotent (custody-doc §5.2). This is
 * ONLY ever invoked from the export dialog's explicit user confirm.
 */
export async function exportSpaceTracked(
  spaceId: string,
  body: ExportAndTrackRequest,
): Promise<ExportAndTrackResult> {
  const response = await apiPost(`/api/spaces/${encodeURIComponent(spaceId)}/exports`, body);
  return (await parseMaybeJson(response)) as ExportAndTrackResult;
}

/** Persist the global default or a per-repo export-path override. */
export type SetExportSettingsRequest = {
  /** Per-repo override target; omit/empty for the global default. */
  repo_id?: string | null;
  path?: string | null;
  branch?: string | null;
};

export async function setSpaceExportSettings(
  body: SetExportSettingsRequest,
): Promise<{ ok: boolean; scope: 'global' | 'repo'; repo_id: string | null }> {
  const response = await apiPost('/api/spaces/exports/settings', body);
  return (await parseMaybeJson(response)) as {
    ok: boolean;
    scope: 'global' | 'repo';
    repo_id: string | null;
  };
}

/**
 * Register an EXISTING tracked repo file as a Space document with link custody
 * (custody-doc §1.4): the canonical bytes stay in the repo, the document starts
 * at `authority='repo'`, and its source is a `repo://<repo>@<ref>/<path>` ref.
 * This is an explicit user action (no auto-track), so it only ever fires from
 * the registration dialog's confirm.
 *
 * Backend glue: `POST /api/spaces/:id/exports/register` (C13b owned route,
 * issue 8730bf9). The route creates the `authority='repo'` `space_exports` row
 * + the link-custody artifact and returns the new tracking row.
 */
export type RegisterRepoFileRequest = {
  /** Explicit project-checkout id; defaults to the Space's project checkout. */
  repo_id?: string | null;
  /** Docs branch / ref the existing file lives on. */
  branch?: string | null;
  /** Repo-relative path of the existing tracked file to register. */
  path: string;
};

export type RegisterRepoFileResult = {
  export: ContractSpaceExport;
  /** The `repo://<repo>@<ref>/<path>` source ref recorded for the document. */
  source_ref: string;
};

export async function registerRepoFileDocument(
  spaceId: string,
  body: RegisterRepoFileRequest,
): Promise<RegisterRepoFileResult> {
  const response = await apiPost(
    `/api/spaces/${encodeURIComponent(spaceId)}/exports/register`,
    body,
  );
  return (await parseMaybeJson(response)) as RegisterRepoFileResult;
}

/** Re-check drift for one tracked export row (custody-doc §6). */
export type ExportDriftResult = {
  export_id: string;
  status: ContractSpaceExportStatus;
  changed: boolean;
  last_seen_commit: string | null;
  last_seen_content_sha256: string | null;
};

export async function getSpaceExportDrift(
  spaceId: string,
): Promise<{ space_id: string; drift: ExportDriftResult[] }> {
  const response = await apiGet(`/api/spaces/${encodeURIComponent(spaceId)}/exports/drift`);
  return (await parseMaybeJson(response)) as { space_id: string; drift: ExportDriftResult[] };
}

// --- finding (briefing review candidate) references -------------------------
// Appended trailing section (briefing umbrella 99b74d6, lane d7e51a1). Every
// call here is READ-ONLY: Spaces displays a finding's review state and never
// mutates it. Saving a finding to a Space goes through the ordinary
// `addSpaceItem` / occurrence writes above — a placement fact that creates no
// decision event.

import type {
  SpaceFindingCandidateSummary as ContractSpaceFindingCandidateSummary,
  SpaceFindingListResponse,
  SpaceFindingRefMetadata as ContractSpaceFindingRefMetadata,
  SpaceFindingResolution as ContractSpaceFindingResolution,
  SpaceFindingResolveResponse,
} from '../../src/contracts';
import {
  feedbackCollectionIdentity,
  filterFeedbackCollections,
  orderFeedbackCollections,
  type FeedbackCollection,
} from './views/feedback/collection-model';

export { filterFeedbackCollections, orderFeedbackCollections };

export type {
  FindingReviewState,
  SpaceFindingCandidateSummary,
  SpaceFindingListResponse,
  SpaceFindingRefMetadata,
  SpaceFindingResolution,
  SpaceFindingResolveResponse,
  SpaceFindingRevisionMode,
  SpaceFindingRevisionState,
  SpaceFindingRevisionSummary,
} from '../../src/contracts';

export {
  SPACE_FINDING_REVISION_MODES,
  SPACE_FINDING_WARNING_LATEST_NOT_PINNED,
  SPACE_FINDING_WARNING_PINNED_MISSING,
  SPACE_FINDING_WARNING_PINNED_SUPERSEDED,
  SPACE_FINDING_WARNING_STORE_UNAVAILABLE,
} from '../../src/contracts';

/** Pickable review candidates for the Space item picker. */
export async function listSpaceFindings(
  options: { limit?: number; query?: string } = {},
): Promise<ContractSpaceFindingCandidateSummary[]> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.query) params.set('q', options.query);
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const response = await apiGet(`/api/spaces/findings${suffix}`);
  const payload = (await parseMaybeJson(response)) as SpaceFindingListResponse;
  return payload.findings ?? [];
}

/**
 * Resolve a candidate under caller-supplied revision semantics (preview before a
 * placement exists). Pass the same metadata the placement will carry so the
 * preview and the placed reference agree.
 */
export async function resolveSpaceFinding(
  candidateId: string,
  metadata: ContractSpaceFindingRefMetadata = { revision_mode: 'latest' },
): Promise<ContractSpaceFindingResolution> {
  const params = new URLSearchParams({ revision_mode: metadata.revision_mode });
  if (metadata.revision_mode === 'pinned' && metadata.pinned_revision_id) {
    params.set('pinned_revision_id', metadata.pinned_revision_id);
  }
  const response = await apiGet(
    `/api/spaces/findings/${encodeURIComponent(candidateId)}/resolve?${params.toString()}`,
  );
  const payload = (await parseMaybeJson(response)) as SpaceFindingResolveResponse;
  return payload.resolution;
}

/** Resolve one PLACED finding reference under the semantics stored on the item. */
export async function resolveSpaceItemFinding(
  spaceId: string,
  itemId: string,
): Promise<ContractSpaceFindingResolution> {
  const response = await apiGet(
    `/api/spaces/${encodeURIComponent(spaceId)}/items/${encodeURIComponent(itemId)}/finding`,
  );
  const payload = (await parseMaybeJson(response)) as SpaceFindingResolveResponse;
  return payload.resolution;
}

// ===========================================================================
// Briefing review queue — client section (umbrella 99b74d6, lane d304a9b).
//
// APPEND-ONLY SECTION. The server routes live in lane ce22a3a and are pinned by
// "Briefing pilot — integration contract v1" §4:
//
//   GET  /api/briefing/queue                          (read-only)
//   GET  /api/briefing/candidates/:id/history          (read-only)
//   POST /api/briefing/candidates/:id/decision         (human-only mutation)
//   POST /api/briefing/candidates/:id/comments         (human-only mutation)
//
// THE SERVER CONTRACT IS THE SOURCE OF TRUTH (issue 223d090). Every field read
// off a briefing payload below goes through a `Partial<…>` projection of the
// corresponding type in src/contracts.ts, so a name that does not exist in the
// contract is a mistake at the point of the read rather than a silently empty
// render. The types here stay UI-local only where they are deliberately weaker
// than the contract: normalization widens required fields to nullable so a
// partial payload degrades into an honest "unknown" instead of a fake value.
//
// TRUST BOUNDARY: `title`, `why_notable`, and `refs` originate from an LLM
// analyzer. They are carried as plain strings and MUST be rendered as untrusted
// text (never as HTML, never as an unfiltered href). See ui/src/views/briefing.tsx.
// ===========================================================================

import type {
  BriefingCandidateHistoryResponse as ContractBriefingHistoryResponse,
  BriefingCandidateState,
  BriefingComment as ContractBriefingComment,
  BriefingCommentResponse as ContractBriefingCommentResponse,
  BriefingDecisionAction,
  BriefingDecisionEvent as ContractBriefingDecisionEvent,
  BriefingDecisionRequest as ContractBriefingDecisionRequest,
  BriefingDecisionResponse as ContractBriefingDecisionResponse,
  BriefingEvidenceKind,
  BriefingOccurrenceStats as ContractBriefingOccurrenceStats,
  BriefingQueueEntry as ContractBriefingQueueEntry,
  BriefingQueueResponse as ContractBriefingQueueResponse,
  BriefingReviewAction,
  BriefingRevision as ContractBriefingRevision,
  BriefingSourceHealth as ContractBriefingSourceHealth,
} from '../../src/contracts';

// The plain unions are the contract's own: re-exported, never re-declared, so
// a value the server can send always has a name the view can match on.
export type {
  BriefingCandidateState,
  BriefingDecisionAction,
  BriefingEvidenceKind,
  BriefingReviewAction,
};

/** Human-initiated subset the UI is allowed to POST (contract `BriefingReviewAction`). */
export type BriefingJudgeAction = BriefingReviewAction;

const BRIEFING_CANDIDATE_STATES: readonly BriefingCandidateState[] = [
  'pending',
  'kept',
  'dismissed',
  'expired_unreviewed',
];

const BRIEFING_DECISION_ACTIONS: readonly BriefingDecisionAction[] = [
  'keep',
  'dismiss',
  'undo',
  'expire',
];

/** Contract §2 `candidate_revisions` row, with `refs_json` already parsed. */
export type BriefingRevision = {
  id: string;
  candidate_id: string;
  /** LLM-authored. Untrusted text. */
  title: string;
  /** LLM-authored one-sentence rationale. Untrusted text. */
  why_notable: string;
  /** LLM-selected refs. Untrusted; linkify only allowlisted schemes. */
  refs: string[];
  /** The finding's verbatim ref (identity input for candidate_key). */
  source_ref: string;
  evidence_hash: string;
  evidence_kind: BriefingEvidenceKind | null;
  captured_at: string | null;
  run_id: string | null;
  digest_series_ref: string | null;
  digest_version: number | null;
  rank: number | null;
  publisher_advisory: {
    code: 'admission_gate_rejected';
    reason: string;
  } | null;
  batch_key: string | null;
  ingested_at: number | null;
};

/** Contract §2 `candidate_occurrences`, aggregated per candidate. */
export type BriefingOccurrenceStats = {
  count: number;
  first_seen_at: number | null;
  last_seen_at: number | null;
};

/** Contract §2 `decision_events` row. */
export type BriefingDecisionEvent = {
  id: string;
  candidate_id: string;
  revision_id: string;
  action: BriefingDecisionAction;
  /** NULL marks a system-generated event (`expire`). */
  actor_user_id: string | null;
  comment_id: string | null;
  created_at: number | null;
};

/** Contract §2 `candidate_comments` row. Operator-authored, immutable. */
export type BriefingComment = {
  id: string;
  candidate_id: string;
  revision_id: string;
  body: string;
  actor_user_id: string | null;
  created_at: number | null;
};

/**
 * One pending candidate plus its current revision and provenance. Mirrors the
 * contract's `BriefingQueueEntry`; `candidate_id` is that entry's `id`.
 */
export type BriefingQueueItem = {
  candidate_id: string;
  source: string;
  candidate_key: string;
  created_at: number | null;
  state: BriefingCandidateState;
  revision: BriefingRevision;
  revision_count: number | null;
  occurrences: BriefingOccurrenceStats;
  /**
   * Producer of THIS entry's current revision (contract
   * `BriefingQueueEntry.task_identity`). Distinct from
   * {@link BriefingSourceHealth.last_task_identity}, which is the identity of
   * the source's most recent batch; the two agree only when the newest batch
   * is also the one that carried this revision.
   */
  task_identity: string | null;
  group: { id: string; candidate_key: string; title: string } | null;
};

/**
 * Deterministic per-source health, projected from the contract's
 * `BriefingSourceHealth`. The server reports batch-ledger FACTS and never a
 * classification, so `status` is always derived here by
 * {@link deriveBriefingSourceStatus}. Nothing in this summary is model-derived.
 *
 * There is no `failed` state: nothing in the ledger distinguishes "the
 * collector ran and failed" from "the collector has not reported", so a
 * silent source reads as `stale` (it reported once, long ago) or `unknown`
 * (it has candidates but no batch on record) — never as a failure the server
 * never observed.
 */
export type BriefingSourceStatus = 'current' | 'stale' | 'unknown';

export type BriefingSourceHealth = {
  source: string;
  status: BriefingSourceStatus;
  last_ingested_at: number | null;
  /** Server-computed age at response time; preferred over the client clock. */
  last_ingest_age_ms: number | null;
  /** The publisher task identity that produced the last batch. */
  last_task_identity: string | null;
  last_run_id: string | null;
  last_digest_version: number | null;
  last_batch_item_count: number | null;
  pending_count: number | null;
};

/** The queue envelope, matching the contract's `BriefingQueueResponse`. */
export type BriefingQueue = {
  candidates: BriefingQueueItem[];
  sources: BriefingSourceHealth[];
};

/** Contract `BriefingCandidateHistoryResponse`: revisions + decisions + comments. */
export type BriefingHistory = {
  candidate_id: string;
  state: BriefingCandidateState;
  revisions: BriefingRevision[];
  decisions: BriefingDecisionEvent[];
  comments: BriefingComment[];
};

/** Contract `BriefingDecisionResponse`. */
export type BriefingDecisionResult = {
  candidate_id: string;
  revision_id: string | null;
  action: BriefingDecisionAction;
  event_id: string | null;
  state: BriefingCandidateState;
};

/** Staleness horizon applied to the server's last-ingest facts. */
export const BRIEFING_SOURCE_STALE_AFTER_MS = 36 * 60 * 60 * 1000;

/**
 * Deterministic classification from the batch-ledger facts the server actually
 * reports. `lastIngestAgeMs` is the server's own age at response time and wins
 * over the client clock when present; `now` covers the case where it is absent.
 * Pure, testable, and never dependent on model output.
 */
export function deriveBriefingSourceStatus(
  lastIngestedAt: number | null,
  lastIngestAgeMs: number | null,
  now: number,
): BriefingSourceStatus {
  if (lastIngestedAt === null && lastIngestAgeMs === null) return 'unknown';
  const age = lastIngestAgeMs ?? now - (lastIngestedAt as number);
  return age > BRIEFING_SOURCE_STALE_AFTER_MS ? 'stale' : 'current';
}

function briefingRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Project a raw payload onto a contract type so every field read below is
 * checked against src/contracts.ts. `Partial` because the payload is untrusted
 * input, not a value the compiler has seen constructed.
 */
function briefingContractRecord<T>(value: unknown): Partial<T> {
  return briefingRecord(value) as Partial<T>;
}

function briefingString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function briefingOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function briefingOptionalNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function briefingStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string');
  }
  return [];
}

function normalizeBriefingRevision(value: unknown, candidateId: string): BriefingRevision {
  const row = briefingContractRecord<ContractBriefingRevision>(value);
  const evidenceKind = briefingOptionalString(row.evidence_kind);
  const advisory = briefingRecord(row.publisher_advisory);
  const publisherAdvisory = advisory.code === 'admission_gate_rejected'
    && typeof advisory.reason === 'string'
    && advisory.reason !== ''
    ? { code: 'admission_gate_rejected' as const, reason: advisory.reason }
    : null;
  return {
    id: briefingString(row.id),
    candidate_id: briefingString(row.candidate_id, candidateId),
    title: briefingString(row.title),
    why_notable: briefingString(row.why_notable),
    refs: briefingStringArray(row.refs),
    source_ref: briefingString(row.source_ref),
    evidence_hash: briefingString(row.evidence_hash),
    evidence_kind:
      evidenceKind === 'snapshot-item' || evidenceKind === 'finding-only' ? evidenceKind : null,
    captured_at: briefingOptionalString(row.captured_at),
    run_id: briefingOptionalString(row.run_id),
    digest_series_ref: briefingOptionalString(row.digest_series_ref),
    digest_version: briefingOptionalNumber(row.digest_version),
    rank: briefingOptionalNumber(row.rank),
    publisher_advisory: publisherAdvisory,
    batch_key: briefingOptionalString(row.batch_key),
    ingested_at: briefingOptionalNumber(row.ingested_at),
  };
}

function normalizeBriefingOccurrenceStats(value: unknown): BriefingOccurrenceStats {
  const row = briefingContractRecord<ContractBriefingOccurrenceStats>(value);
  return {
    count: briefingOptionalNumber(row.count) ?? 0,
    first_seen_at: briefingOptionalNumber(row.first_seen_at),
    last_seen_at: briefingOptionalNumber(row.last_seen_at),
  };
}

function normalizeBriefingCandidateState(value: unknown): BriefingCandidateState {
  const state = briefingOptionalString(value);
  return BRIEFING_CANDIDATE_STATES.includes(state as BriefingCandidateState)
    ? (state as BriefingCandidateState)
    : 'pending';
}

function normalizeBriefingQueueItem(value: unknown): BriefingQueueItem | null {
  const row = briefingContractRecord<ContractBriefingQueueEntry>(value);
  const candidateId = briefingString(row.id);
  if (!candidateId) return null;
  const group = briefingRecord(row.group);
  const normalizedGroup = briefingString(group.id) && briefingString(group.candidate_key)
    ? {
      id: briefingString(group.id),
      candidate_key: briefingString(group.candidate_key),
      title: briefingString(group.title),
    }
    : null;
  return {
    candidate_id: candidateId,
    source: briefingString(row.source, 'unknown'),
    candidate_key: briefingString(row.candidate_key),
    created_at: briefingOptionalNumber(row.created_at),
    state: normalizeBriefingCandidateState(row.state),
    revision: normalizeBriefingRevision(row.revision, candidateId),
    revision_count: briefingOptionalNumber(row.revision_count),
    occurrences: normalizeBriefingOccurrenceStats(row.occurrences),
    task_identity: briefingOptionalString(row.task_identity),
    group: normalizedGroup,
  };
}

function normalizeBriefingSourceHealth(value: unknown, now: number): BriefingSourceHealth {
  const row = briefingContractRecord<ContractBriefingSourceHealth>(value);
  const lastIngestedAt = briefingOptionalNumber(row.last_ingested_at);
  const lastIngestAgeMs = briefingOptionalNumber(row.last_ingest_age_ms);
  return {
    source: briefingString(row.source, 'unknown'),
    status: deriveBriefingSourceStatus(lastIngestedAt, lastIngestAgeMs, now),
    last_ingested_at: lastIngestedAt,
    last_ingest_age_ms: lastIngestAgeMs,
    last_task_identity: briefingOptionalString(row.last_task_identity),
    last_run_id: briefingOptionalString(row.last_run_id),
    last_digest_version: briefingOptionalNumber(row.last_digest_version),
    last_batch_item_count: briefingOptionalNumber(row.last_batch_item_count),
    pending_count: briefingOptionalNumber(row.pending_count),
  };
}

/**
 * Normalize a raw `/api/briefing/queue` payload (contract
 * `BriefingQueueResponse`). Exported for tests; `now` is injected so the
 * staleness classification stays deterministic.
 */
export function normalizeBriefingQueue(payload: unknown, now: number = Date.now()): BriefingQueue {
  const root = briefingContractRecord<ContractBriefingQueueResponse>(payload);
  const rawCandidates = Array.isArray(root.candidates) ? root.candidates : [];
  const rawSources = Array.isArray(root.sources) ? root.sources : [];
  return {
    candidates: rawCandidates
      .map((entry) => normalizeBriefingQueueItem(entry))
      .filter((entry): entry is BriefingQueueItem => entry !== null),
    sources: rawSources.map((entry) => normalizeBriefingSourceHealth(entry, now)),
  };
}

/**
 * Project the complete normalized queue into one recurring collection per
 * source. Health-only sources remain visible; queue-only sources degrade to an
 * honest unknown collection instead of disappearing.
 */
export function projectBriefingRecurringCollections(
  queue: Readonly<BriefingQueue>,
): FeedbackCollection[] {
  const pendingBySource = new Map<string, number>();
  for (const candidate of queue.candidates) {
    pendingBySource.set(candidate.source, (pendingBySource.get(candidate.source) ?? 0) + 1);
  }

  const collections = new Map<string, FeedbackCollection>();
  for (const source of queue.sources) {
    const publicationRecorded = source.last_ingested_at !== null
      || source.last_ingest_age_ms !== null
      || source.last_task_identity !== null
      || source.last_run_id !== null
      || source.last_digest_version !== null
      || source.last_batch_item_count !== null;
    collections.set(source.source, {
      id: feedbackCollectionIdentity('recurring_feed', source.source),
      kind: 'recurring_feed',
      state: 'open',
      source: source.source,
      label: source.source,
      pendingCount: pendingBySource.get(source.source) ?? source.pending_count ?? 0,
      recurring: {
        health: source.status,
        publicationRecorded,
        lastPublicationItemCount: source.last_batch_item_count,
        lastTaskIdentity: source.last_task_identity,
      },
    });
  }

  for (const [source, pendingCount] of pendingBySource) {
    if (collections.has(source)) continue;
    collections.set(source, {
      id: feedbackCollectionIdentity('recurring_feed', source),
      kind: 'recurring_feed',
      state: 'open',
      source,
      label: source,
      pendingCount,
      recurring: {
        health: 'unknown',
        publicationRecorded: false,
        lastPublicationItemCount: null,
        lastTaskIdentity: null,
      },
    });
  }

  return orderFeedbackCollections([...collections.values()], []);
}

// --- bounded ask form -------------------------------------------------------

export type AskResponseType = 'verdict' | 'free_text' | 'single_choice' | 'multi_choice';
export type AskResponseValue =
  | { verdict: 'keep' | 'dismiss' }
  | { text: string }
  | { option_key: string }
  | { option_keys: string[] };

export type AskOption = {
  option_key: string;
  label: string;
  description: string | null;
  position: number;
};

export type AskItem = {
  id: string;
  client_item_key: string | null;
  parent_item_id: string | null;
  item_kind: 'item' | 'group';
  revision: {
    id: string;
    ordinal: number;
    title: string;
    prompt: string;
    description: string | null;
    response_type: AskResponseType | null;
    required: boolean;
    position: number;
    options: AskOption[];
  };
  effective_response: null | { response_event_id: string; value: AskResponseValue };
  responseVisible: boolean;
};

export type AskProjection = {
  ask_id: string;
  state: 'open' | 'submitted' | 'expired' | 'cancelled' | 'closed';
  request_key: string;
  request_digest: string;
  requester_user_id: string;
  requester_session_id: string;
  responder_user_ids: string[];
  expires_at: number;
  retention_expires_at: number | null;
  created_at: number;
  lifecycle_event_id: string;
  latest_submission: null | { id: string; ordinal: number };
  items: AskItem[];
  valid: boolean;
};

export type ClientAuthWhoami = {
  authenticated: boolean;
  user: null | { id: string; slug: string; kind: string | null; display_name: string | null };
};

export type AskAnswerOperation = {
  item_id: string;
  item_revision_id: string;
  operation: 'set' | 'retract';
  expected_response_event_id: string | null;
  value?: AskResponseValue;
};

export type AskSubmissionAnswer = {
  item_id: string;
  item_revision_id: string;
  response_event_id: string;
};

const ASK_STATES = new Set(['open', 'submitted', 'expired', 'cancelled', 'closed']);
const ASK_RESPONSE_TYPES = new Set<AskResponseType>([
  'verdict', 'free_text', 'single_choice', 'multi_choice',
]);

function exactAskValueKeys(row: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(row).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length
    && keys.every((key, index) => key === sortedExpected[index]);
}

function askResponseValue(
  value: unknown,
  responseType: AskResponseType,
  optionKeys: readonly string[],
): AskResponseValue | null {
  const row = briefingRecord(value);
  if (responseType === 'verdict') {
    return exactAskValueKeys(row, ['verdict']) && (row.verdict === 'keep' || row.verdict === 'dismiss')
      ? { verdict: row.verdict }
      : null;
  }
  if (responseType === 'free_text') {
    return exactAskValueKeys(row, ['text']) && typeof row.text === 'string' ? { text: row.text } : null;
  }
  const allowed = new Set(optionKeys);
  if (responseType === 'single_choice') {
    return exactAskValueKeys(row, ['option_key'])
      && typeof row.option_key === 'string'
      && allowed.has(row.option_key)
      ? { option_key: row.option_key }
      : null;
  }
  if (!exactAskValueKeys(row, ['option_keys'])
      || !Array.isArray(row.option_keys)
      || row.option_keys.some((key) => typeof key !== 'string')
      || row.option_keys.some((key) => !allowed.has(key as string))
      || new Set(row.option_keys).size !== row.option_keys.length) return null;
  const selected = new Set(row.option_keys as string[]);
  return { option_keys: optionKeys.filter((key) => selected.has(key)) };
}

export function normalizeAskProjection(payload: unknown): AskProjection {
  const root = briefingRecord(payload);
  let valid = true;
  const askId = briefingString(root.ask_id);
  const rawState = briefingString(root.state);
  if (!askId || !ASK_STATES.has(rawState) || !briefingString(root.lifecycle_event_id)) valid = false;
  const rawItems = Array.isArray(root.items) ? root.items : [];
  if (!Array.isArray(root.items)) valid = false;
  const items = rawItems.map((entry): AskItem | null => {
    const row = briefingRecord(entry);
    const revision = briefingRecord(row.revision);
    const id = briefingString(row.id);
    const revisionId = briefingString(revision.id);
    const itemKind = row.item_kind;
    const rawType = revision.response_type;
    const responseType = typeof rawType === 'string' && ASK_RESPONSE_TYPES.has(rawType as AskResponseType)
      ? rawType as AskResponseType
      : null;
    if (!id || !revisionId || (itemKind !== 'item' && itemKind !== 'group')) {
      valid = false;
      return null;
    }
    if ((itemKind === 'group' && rawType !== null) || (itemKind === 'item' && !responseType)) valid = false;
    if (typeof revision.required !== 'boolean') valid = false;
    if (!Array.isArray(revision.options)) valid = false;
    const options = (Array.isArray(revision.options) ? revision.options : []).map((option) => {
      const value = briefingRecord(option);
      return {
        option_key: briefingString(value.option_key),
        label: briefingString(value.label),
        description: briefingOptionalString(value.description),
        position: briefingOptionalNumber(value.position) ?? 0,
      };
    }).filter((option) => {
      if (!option.option_key) valid = false;
      return Boolean(option.option_key);
    }).sort((left, right) => left.position - right.position || left.option_key.localeCompare(right.option_key));
    const choice = responseType === 'single_choice' || responseType === 'multi_choice';
    if (itemKind === 'group' && (revision.required === true || options.length > 0)) valid = false;
    if (itemKind === 'item' && ((choice && options.length === 0) || (!choice && options.length > 0))) valid = false;
    const hasEffective = Object.prototype.hasOwnProperty.call(row, 'effective_response');
    const effective = briefingRecord(row.effective_response);
    const effectiveValue = responseType && hasEffective && row.effective_response !== null
      ? askResponseValue(effective.value, responseType, options.map((option) => option.option_key))
      : null;
    if (hasEffective && row.effective_response !== null
        && (!briefingString(effective.response_event_id) || !effectiveValue)) valid = false;
    return {
      id,
      client_item_key: briefingOptionalString(row.client_item_key),
      parent_item_id: briefingOptionalString(row.parent_item_id),
      item_kind: itemKind,
      revision: {
        id: revisionId,
        ordinal: briefingOptionalNumber(revision.ordinal) ?? 0,
        title: briefingString(revision.title),
        prompt: briefingString(revision.prompt),
        description: briefingOptionalString(revision.description),
        response_type: responseType,
        required: revision.required === true,
        position: briefingOptionalNumber(revision.position) ?? 0,
        options,
      },
      effective_response: effectiveValue
        ? { response_event_id: briefingString(effective.response_event_id), value: effectiveValue }
        : null,
      responseVisible: hasEffective,
    };
  }).filter((item): item is AskItem => item !== null)
    .sort((left, right) => left.revision.position - right.revision.position || left.id.localeCompare(right.id));
  const itemIds = new Set<string>();
  for (const item of items) {
    if (itemIds.has(item.id)) valid = false;
    itemIds.add(item.id);
  }
  const itemById = new Map(items.map((item) => [item.id, item]));
  for (const item of items) {
    if (item.parent_item_id && itemById.get(item.parent_item_id)?.item_kind !== 'group') valid = false;
    if (new Set(item.revision.options.map((option) => option.option_key)).size !== item.revision.options.length) valid = false;
    const ancestors = new Set<string>([item.id]);
    let parent = item.parent_item_id;
    while (parent) {
      if (ancestors.has(parent)) {
        valid = false;
        break;
      }
      ancestors.add(parent);
      parent = itemById.get(parent)?.parent_item_id ?? null;
    }
  }
  const latest = briefingRecord(root.latest_submission);
  const latestSubmission = root.latest_submission === null ? null : {
    id: briefingString(latest.id),
    ordinal: briefingOptionalNumber(latest.ordinal) ?? 0,
  };
  if (root.latest_submission !== null && (!latestSubmission.id || latestSubmission.ordinal < 1)) valid = false;
  if ((rawState === 'open' && latestSubmission !== null)
      || (rawState === 'submitted' && latestSubmission === null)) valid = false;
  return {
    ask_id: askId,
    state: ASK_STATES.has(rawState) ? rawState as AskProjection['state'] : 'closed',
    request_key: briefingString(root.request_key),
    request_digest: briefingString(root.request_digest),
    requester_user_id: briefingString(root.requester_user_id),
    requester_session_id: briefingString(root.requester_session_id),
    responder_user_ids: briefingStringArray(root.responder_user_ids),
    expires_at: briefingOptionalNumber(root.expires_at) ?? 0,
    retention_expires_at: briefingOptionalNumber(root.retention_expires_at),
    created_at: briefingOptionalNumber(root.created_at) ?? 0,
    lifecycle_event_id: briefingString(root.lifecycle_event_id),
    latest_submission: latestSubmission,
    items,
    valid,
  };
}

export function projectBoundedAskCollection(ask: Readonly<AskProjection>): FeedbackCollection {
  const answerable = ask.items.filter((item) => item.item_kind === 'item');
  const required = answerable.filter((item) => item.revision.required);
  return {
    id: feedbackCollectionIdentity('bounded_ask', ask.ask_id),
    kind: 'bounded_ask',
    state: ask.state,
    label: ask.request_key || `Ask ${ask.ask_id}`,
    boundedAsk: {
      askId: ask.ask_id,
      itemCount: answerable.length,
      requiredCount: required.length,
      answeredRequiredCount: required.filter((item) => item.effective_response !== null).length,
    },
  };
}

export async function getClientAuthWhoami(signal?: AbortSignal): Promise<ClientAuthWhoami> {
  const response = await apiGet('/api/client-auth/whoami', signal ? { signal } : {});
  const root = briefingRecord(await parseMaybeJson(response));
  const user = briefingRecord(root.user);
  return {
    authenticated: root.authenticated === true,
    user: root.authenticated === true && briefingString(user.id) ? {
      id: briefingString(user.id),
      slug: briefingString(user.slug),
      kind: briefingOptionalString(user.kind),
      display_name: briefingOptionalString(user.display_name),
    } : null,
  };
}

export async function getAsk(askId: string, signal?: AbortSignal): Promise<AskProjection> {
  const response = await apiGet(`/api/asks/${encodeURIComponent(askId)}`, signal ? { signal } : {});
  return normalizeAskProjection(await parseMaybeJson(response));
}

export async function postAskAnswers(
  askId: string,
  answers: readonly AskAnswerOperation[],
): Promise<{ answer_event_ids: string[] }> {
  const response = await apiPost(`/api/asks/${encodeURIComponent(askId)}/answers`, { answers });
  const root = briefingRecord(await parseMaybeJson(response));
  return { answer_event_ids: briefingStringArray(root.answer_event_ids) };
}

export async function postAskSubmission(
  askId: string,
  input: {
    expected_lifecycle_event_id: string;
    supersedes_submission_id?: string;
    answers: readonly AskSubmissionAnswer[];
  },
): Promise<unknown> {
  const response = await apiPost(`/api/asks/${encodeURIComponent(askId)}/submit`, input);
  invalidateApiGetCache(`/api/asks/${encodeURIComponent(askId)}`);
  invalidateApiGetCache('/api/dashboard/badges');
  return parseMaybeJson(response);
}

/** Normalize a raw `/api/briefing/candidates/:id/history` payload. */
export function normalizeBriefingHistory(payload: unknown, candidateId: string): BriefingHistory {
  const root = briefingContractRecord<ContractBriefingHistoryResponse>(payload);
  const candidate = briefingContractRecord<ContractBriefingHistoryResponse['candidate']>(
    root.candidate,
  );
  const revisions = (Array.isArray(root.revisions) ? root.revisions : []).map((entry) =>
    normalizeBriefingRevision(entry, candidateId),
  );
  const decisions = (Array.isArray(root.decisions) ? root.decisions : []).map((entry) =>
    normalizeBriefingDecisionEvent(entry, candidateId),
  );
  const comments = (Array.isArray(root.comments) ? root.comments : []).map((entry) => {
    const row = briefingContractRecord<ContractBriefingComment>(entry);
    return {
      id: briefingString(row.id),
      candidate_id: briefingString(row.candidate_id, candidateId),
      revision_id: briefingString(row.revision_id),
      body: briefingString(row.body),
      actor_user_id: briefingOptionalString(row.actor_user_id),
      created_at: briefingOptionalNumber(row.created_at),
    } satisfies BriefingComment;
  });
  return {
    candidate_id: briefingString(candidate.id, candidateId),
    state: normalizeBriefingCandidateState(candidate.state),
    revisions,
    decisions,
    comments,
  };
}

function normalizeBriefingDecisionEvent(
  value: unknown,
  candidateId: string,
): BriefingDecisionEvent {
  const row = briefingContractRecord<ContractBriefingDecisionEvent>(value);
  const action = briefingOptionalString(row.action);
  return {
    id: briefingString(row.id),
    candidate_id: briefingString(row.candidate_id, candidateId),
    revision_id: briefingString(row.revision_id),
    action: BRIEFING_DECISION_ACTIONS.includes(action as BriefingDecisionAction)
      ? (action as BriefingDecisionAction)
      : 'expire',
    actor_user_id: briefingOptionalString(row.actor_user_id),
    comment_id: briefingOptionalString(row.comment_id),
    created_at: briefingOptionalNumber(row.created_at),
  };
}

/** Contract §4 — pending queue + deterministic per-source health. Read-only. */
const BRIEFING_QUEUE_PATH = '/api/briefing/queue';

/** Synchronously project a still-usable shared GET-cache entry for warm rendering. */
export function getCachedBriefingQueue(now: number = Date.now()): BriefingQueue | null {
  const cached = getJsonCache.get(cacheKeyForGet(BRIEFING_QUEUE_PATH));
  if (!cached || now >= cached.staleUntil) return null;
  return normalizeBriefingQueue(cached.value, now);
}

export async function getBriefingQueue(signal?: AbortSignal): Promise<BriefingQueue> {
  const response = await apiGet(BRIEFING_QUEUE_PATH, signal ? { signal } : {});
  const payload = await parseMaybeJson(response);
  const now = Date.now();
  getJsonCache.set(cacheKeyForGet(BRIEFING_QUEUE_PATH), {
    value: payload,
    freshUntil: now + DEFAULT_GET_CACHE_TTL_MS,
    staleUntil: now + DEFAULT_GET_CACHE_TTL_MS + DEFAULT_GET_CACHE_STALE_MS,
  });
  return normalizeBriefingQueue(payload, now);
}

/** Contract §4 — revisions + decisions + comments for one candidate. Read-only. */
export async function getBriefingHistory(
  candidateId: string,
  signal?: AbortSignal,
): Promise<BriefingHistory> {
  const response = await apiGet(
    `/api/briefing/candidates/${encodeURIComponent(candidateId)}/history`,
    signal ? { signal } : {},
  );
  return normalizeBriefingHistory(await parseMaybeJson(response), candidateId);
}

/**
 * The exact thing a judgment is about: a candidate AND the revision of it the
 * reviewer was shown. Both are required on purpose. A candidate-only decision
 * is resolved server-side against whatever revision is current at write time,
 * which silently misaddresses every decision made about a row the page rendered
 * before a re-ingest — most visibly, Undo on an older judged row clearing the
 * decision on a newer revision the operator never touched. Making the revision
 * part of the argument means no call site can express that decision at all.
 *
 * `expected_event_id` narrows an undo from "this revision" to "this judgment":
 * the decision event the caller was handed when it judged. The revision alone
 * does not stop an Undo from erasing a NEWER decision on the same revision made
 * elsewhere; naming the event makes that case a 409 instead.
 */
export type BriefingDecisionTarget = {
  candidate_id: string;
  revision_id: string;
  expected_event_id?: string;
};

/**
 * Contract §4 — record a human keep/dismiss/undo against one revision. The
 * server rejects publisher and agent credential classes and refuses in
 * read-only mode; the UI additionally gates every call site on
 * `operational_mutations === 'allow'`. Attribution comes from the authenticated
 * user, never from an agent_session param.
 */
export async function postBriefingDecision(
  target: BriefingDecisionTarget,
  action: BriefingJudgeAction,
): Promise<BriefingDecisionResult> {
  const candidateId = target.candidate_id;
  const request: ContractBriefingDecisionRequest = {
    action,
    revision_id: target.revision_id,
    ...(target.expected_event_id ? { expected_event_id: target.expected_event_id } : {}),
  };
  const response = await apiPost(
    `/api/briefing/candidates/${encodeURIComponent(candidateId)}/decision`,
    request,
  );
  const payload = briefingContractRecord<ContractBriefingDecisionResponse>(
    await parseMaybeJson(response),
  );
  const resolvedAction = briefingOptionalString(payload.action);
  // The pending count changed: drop the cached badge read so the nav badge
  // reconciles from the server instead of a stale SWR entry.
  invalidateApiGetCache('/api/dashboard/badges');
  return {
    candidate_id: briefingString(payload.candidate_id, candidateId),
    revision_id: briefingOptionalString(payload.revision_id),
    action: BRIEFING_DECISION_ACTIONS.includes(resolvedAction as BriefingDecisionAction)
      ? (resolvedAction as BriefingDecisionAction)
      : action,
    event_id: briefingOptionalString(payload.event_id),
    state: normalizeBriefingCandidateState(payload.state),
  };
}

/**
 * Contract §4 — append an immutable operator comment to a candidate. A non-2xx
 * response throws in `apiPost`, so reaching the return means the comment landed.
 */
export async function postBriefingComment(
  candidateId: string,
  body: string,
  // The revision the note is about — the one this client displayed. Omitting
  // it means "whatever revision is current server-side", which can silently
  // drift under a concurrent re-ingest; callers that showed a revision pass it.
  revisionId?: string,
): Promise<BriefingComment> {
  const response = await apiPost(
    `/api/briefing/candidates/${encodeURIComponent(candidateId)}/comments`,
    { body, ...(revisionId ? { revision_id: revisionId } : {}) },
  );
  const payload = briefingContractRecord<ContractBriefingCommentResponse>(
    await parseMaybeJson(response),
  );
  const row = briefingContractRecord<ContractBriefingComment>(payload.comment);
  return {
    id: briefingString(row.id),
    candidate_id: briefingString(row.candidate_id, candidateId),
    revision_id: briefingString(row.revision_id),
    body: briefingString(row.body),
    actor_user_id: briefingOptionalString(row.actor_user_id),
    created_at: briefingOptionalNumber(row.created_at),
  };
}

// ===========================================================================
// Agent dispatch — client section (umbrella 99b74d6, issue ce83a84).
//
// APPEND-ONLY SECTION. Server routes live in src/routes/agent-dispatch.ts:
//
//   POST /api/agent-dispatch/preview    (human-only; writes NOTHING)
//   POST /api/agent-dispatch/dispatch   (human-only; the confirmed act)
//   GET  /api/agent-dispatch/events     (read-only audit chain)
//
// The two-call shape is the whole point: `previewAgentDispatch` renders exactly
// the prompt the worker would receive, so the confirmation dialog shows the
// real thing rather than a client-side reconstruction of it, and declining
// costs nothing because nothing has been written.
//
// TRUST BOUNDARY: `plan.prompt` embeds LLM- and collector-authored text inside
// an explicitly untrusted block. The dialog MUST render it as plain text.
// ===========================================================================

export type AgentDispatchSubject =
  | { kind: 'finding'; candidate_id: string }
  | { kind: 'issue'; issue_ref: string };

export type AgentDispatchPlan = {
  subject_kind: 'finding' | 'issue';
  subject_label: string;
  instruction: string;
  cwd: string;
  /** The exact seed prompt. Untrusted content inside; render as text only. */
  prompt: string;
  capability_surface: string[];
};

export type AgentDispatchEvent = {
  id: string;
  subject_kind: 'finding' | 'issue';
  candidate_id: string | null;
  comment_id: string | null;
  issue_id: string | null;
  instruction: string;
  cwd: string;
  status: 'dispatching' | 'dispatched' | 'failed';
  session_handle: string | null;
  attach_command: string | null;
  error: string | null;
  created_at: number | null;
};

export type AgentDispatchResult = {
  ok: boolean;
  event: AgentDispatchEvent;
};

function normalizeAgentDispatchEvent(value: unknown): AgentDispatchEvent {
  const row = briefingRecord(value);
  const status = briefingOptionalString(row.status);
  return {
    id: briefingString(row.id),
    subject_kind: row.subject_kind === 'issue' ? 'issue' : 'finding',
    candidate_id: briefingOptionalString(row.candidate_id),
    comment_id: briefingOptionalString(row.comment_id),
    issue_id: briefingOptionalString(row.issue_id),
    instruction: briefingString(row.instruction),
    cwd: briefingString(row.cwd),
    // An unrecognized status is reported as unsettled rather than as success.
    status: status === 'dispatched' || status === 'failed' ? status : 'dispatching',
    session_handle: briefingOptionalString(row.session_handle),
    attach_command: briefingOptionalString(row.attach_command),
    error: briefingOptionalString(row.error),
    created_at: briefingOptionalNumber(row.created_at),
  };
}

/** Render the dispatch plan for confirmation. Writes nothing server-side. */
export async function previewAgentDispatch(
  subject: AgentDispatchSubject,
  instruction: string,
): Promise<AgentDispatchPlan> {
  const response = await apiPost('/api/agent-dispatch/preview', { subject, instruction });
  const plan = briefingRecord(briefingRecord(await parseMaybeJson(response)).plan);
  return {
    subject_kind: plan.subject_kind === 'issue' ? 'issue' : 'finding',
    subject_label: briefingString(plan.subject_label),
    instruction: briefingString(plan.instruction, instruction),
    cwd: briefingString(plan.cwd),
    prompt: briefingString(plan.prompt),
    capability_surface: briefingStringArray(plan.capability_surface),
  };
}

/**
 * Execute a confirmed dispatch. A spawn failure comes back as `ok: false` with
 * the recorded event, not as a thrown error: the handling event exists either
 * way and the UI must show which happened.
 */
export async function dispatchAgent(
  subject: AgentDispatchSubject,
  instruction: string,
): Promise<AgentDispatchResult> {
  const response = await apiPost('/api/agent-dispatch/dispatch', { subject, instruction });
  const payload = briefingRecord(await parseMaybeJson(response));
  return {
    ok: payload.ok === true,
    event: normalizeAgentDispatchEvent(payload.event),
  };
}

/** Read the recorded dispatch chain for one finding or issue. */
export async function getAgentDispatchEvents(
  filter: { candidateId?: string; issueId?: string },
  signal?: AbortSignal,
): Promise<AgentDispatchEvent[]> {
  const query = new URLSearchParams();
  if (filter.candidateId) query.set('candidate_id', filter.candidateId);
  if (filter.issueId) query.set('issue_id', filter.issueId);
  const response = await apiGet(
    `/api/agent-dispatch/events?${query.toString()}`,
    signal ? { signal } : {},
  );
  const payload = briefingRecord(await parseMaybeJson(response));
  const events = Array.isArray(payload.events) ? payload.events : [];
  return events.map(normalizeAgentDispatchEvent);
}

// ===========================================================================
// Executor task inventory — client section (issue 0bc2279).
//
//   POST /api/tasks/inventory   (registered executors only; never from the UI)
//   GET  /api/tasks             (read-only projection)
//
// The Tasks view is a READ SURFACE over facts an executor reported. The UI has
// no write path here at all, which is why only the GET has a client below.
//
// NORMALIZATION IS DELIBERATELY LOSSY TOWARD `'unknown'`. Every optional field
// the server may carry is either its typed value or the contract's explicit
// `'unknown'` sentinel; a payload that is missing or malformed at some field
// degrades to `'unknown'` there rather than to a blank or a zero. That is the
// same honesty rule the server enforces on publishers, applied to the wire.
//
// TRUST BOUNDARY: `display_name` and run `detail` are executor-authored. They
// are carried as plain strings and MUST be rendered as untrusted text.
// ===========================================================================

import {
  TASK_INVENTORY_UNKNOWN,
  TASK_COMMAND_SCHEMA,
  type TaskCommand as ContractTaskCommand,
  type TaskCommandListResponse as ContractTaskCommandListResponse,
  type TaskCommandMutationResult as ContractTaskCommandMutationResult,
  type TaskCommandRejectionReason,
  type TaskCommandState,
  type TaskActivationFacts,
  type TaskBundleFacts,
  type TaskCircuitState,
  type TaskExecutorFreshness,
  type TaskExecutorSummary as ContractTaskExecutorSummary,
  type TaskGuardFacts,
  type TaskInventoryEntry,
  type TaskInventoryResponse as ContractTaskInventoryResponse,
  type TaskInventoryView as ContractTaskInventoryView,
  type TaskKillSwitchState,
  type TaskManagementMode,
  type TaskRunFacts,
  type TaskRunOutcome,
  type TaskRunSlot,
  type TaskStalenessClaim,
} from '../../src/contracts';

export {
  TASK_INVENTORY_UNKNOWN,
};
export type {
  TaskActivationFacts,
  TaskBundleFacts,
  TaskExecutorFreshness,
  TaskGuardFacts,
  TaskInventoryEntry,
  TaskRunFacts,
  TaskRunSlot,
};

export type TaskExecutorSummary = ContractTaskExecutorSummary;
export type TaskInventoryItem = ContractTaskInventoryView;
export type TaskInventory = ContractTaskInventoryResponse;
export type TaskCommand = ContractTaskCommand;
export type TaskCommandList = ContractTaskCommandListResponse;
export type TaskCommandMutation = ContractTaskCommandMutationResult;

const TASK_CIRCUIT_STATES: readonly TaskCircuitState[] = ['closed', 'open', 'half_open'];
const TASK_KILL_SWITCH_STATES: readonly TaskKillSwitchState[] = ['engaged', 'clear'];
const TASK_STALENESS_CLAIMS: readonly TaskStalenessClaim[] = ['fresh', 'stale'];
const TASK_RUN_OUTCOMES: readonly TaskRunOutcome[] = ['success', 'failure', 'timeout', 'cancelled'];
const TASK_FRESHNESS: readonly TaskExecutorFreshness[] = ['current', 'stale', 'unknown'];

/** Default horizon used only when the server omits `stale_after_ms`. */
export const TASK_INVENTORY_DEFAULT_STALE_AFTER_MS = 3 * 60 * 60 * 1000;

function taskMaybeString(value: unknown): string | typeof TASK_INVENTORY_UNKNOWN {
  return typeof value === 'string' && value !== '' ? value : TASK_INVENTORY_UNKNOWN;
}

function taskMaybeNumber(value: unknown): number | typeof TASK_INVENTORY_UNKNOWN {
  return typeof value === 'number' && Number.isFinite(value) ? value : TASK_INVENTORY_UNKNOWN;
}

function taskMaybeBoolean(value: unknown): boolean | typeof TASK_INVENTORY_UNKNOWN {
  return typeof value === 'boolean' ? value : TASK_INVENTORY_UNKNOWN;
}

function taskMaybeEnum<T extends string>(
  value: unknown,
  values: readonly T[],
): T | typeof TASK_INVENTORY_UNKNOWN {
  return typeof value === 'string' && values.includes(value as T)
    ? (value as T)
    : TASK_INVENTORY_UNKNOWN;
}

function normalizeTaskBundle(value: unknown): TaskBundleFacts | typeof TASK_INVENTORY_UNKNOWN {
  const row = briefingRecord(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return TASK_INVENTORY_UNKNOWN;
  return {
    commit: taskMaybeString(row.commit),
    content_hash: taskMaybeString(row.content_hash),
    execution_hash: taskMaybeString(row.execution_hash),
    deployed_at: taskMaybeNumber(row.deployed_at),
  };
}

function normalizeTaskActivation(value: unknown): TaskActivationFacts {
  const row = briefingRecord(value);
  return {
    config_enabled: taskMaybeBoolean(row.config_enabled),
    locally_activated: taskMaybeBoolean(row.locally_activated),
  };
}

function normalizeTaskGuards(value: unknown): TaskGuardFacts {
  const row = briefingRecord(value);
  const retryNextAt = row.retry_next_at === 'none'
    ? ('none' as const)
    : taskMaybeNumber(row.retry_next_at);
  return {
    circuit: taskMaybeEnum(row.circuit, TASK_CIRCUIT_STATES),
    retry_attempt: taskMaybeNumber(row.retry_attempt),
    retry_next_at: retryNextAt,
    kill_switch: taskMaybeEnum(row.kill_switch, TASK_KILL_SWITCH_STATES),
    staleness: taskMaybeEnum(row.staleness, TASK_STALENESS_CLAIMS),
  };
}

function normalizeTaskRunSlot(value: unknown): TaskRunSlot {
  if (value === 'never') return 'never';
  if (!value || typeof value !== 'object' || Array.isArray(value)) return TASK_INVENTORY_UNKNOWN;
  const row = value as Record<string, unknown>;
  return {
    run_id: taskMaybeString(row.run_id),
    started_at: taskMaybeNumber(row.started_at),
    finished_at: taskMaybeNumber(row.finished_at),
    outcome: taskMaybeEnum(row.outcome, TASK_RUN_OUTCOMES),
    bundle_commit: taskMaybeString(row.bundle_commit),
    content_hash: taskMaybeString(row.content_hash),
    execution_hash: taskMaybeString(row.execution_hash),
    config_hash: taskMaybeString(row.config_hash),
    detail: taskMaybeString(row.detail),
  };
}

function normalizeTaskEntry(value: unknown): TaskInventoryEntry | null {
  const row = briefingContractRecord<TaskInventoryEntry>(value);
  const taskId = briefingOptionalString(row.task_id);
  if (!taskId) return null;
  // `external` is the only mode v1 defines; anything else is a server the UI is
  // older than, so it is shown as the raw string rather than silently coerced.
  const mode = (typeof row.management_mode === 'string' && row.management_mode
    ? row.management_mode
    : 'external') as TaskManagementMode;
  return {
    task_id: taskId,
    display_name: briefingOptionalString(row.display_name) ?? taskId,
    management_mode: mode,
    bundle: normalizeTaskBundle(row.bundle),
    activation: normalizeTaskActivation(row.activation),
    guards: normalizeTaskGuards(row.guards),
    last_run: normalizeTaskRunSlot(row.last_run),
    last_failure: normalizeTaskRunSlot(row.last_failure),
  };
}

function normalizeTaskExecutorSummary(value: unknown): TaskExecutorSummary | null {
  const row = briefingContractRecord<ContractTaskExecutorSummary>(value);
  const name = briefingOptionalString(row.name);
  if (!name) return null;
  return {
    name,
    version: taskMaybeString(row.version),
    capabilities: briefingStringArray(row.capabilities),
    observed_at: briefingOptionalNumber(row.observed_at) ?? 0,
    observed_age_ms: briefingOptionalNumber(row.observed_age_ms) ?? 0,
    freshness: taskMaybeEnum(row.freshness, TASK_FRESHNESS) === TASK_INVENTORY_UNKNOWN
      ? 'unknown'
      : (row.freshness as TaskExecutorFreshness),
    generation_id: briefingString(row.generation_id),
    digest: briefingString(row.digest),
    received_at: briefingOptionalNumber(row.received_at) ?? 0,
    posted_by_user_id: briefingString(row.posted_by_user_id),
    posted_by_slug: briefingOptionalString(row.posted_by_slug),
    task_count: briefingOptionalNumber(row.task_count) ?? 0,
  };
}

function normalizeTaskInventoryItem(value: unknown): TaskInventoryItem | null {
  const row = briefingContractRecord<ContractTaskInventoryView>(value);
  const task = normalizeTaskEntry(row.task);
  if (!task) return null;
  const executor = briefingOptionalString(row.executor) ?? 'unknown';
  return {
    key: briefingOptionalString(row.key) ?? `${executor}/${task.task_id}`,
    executor,
    freshness: taskMaybeEnum(row.freshness, TASK_FRESHNESS) === TASK_INVENTORY_UNKNOWN
      ? 'unknown'
      : (row.freshness as TaskExecutorFreshness),
    observed_at: briefingOptionalNumber(row.observed_at) ?? 0,
    observed_age_ms: briefingOptionalNumber(row.observed_age_ms) ?? 0,
    task,
  };
}

export function normalizeTaskInventory(payload: unknown): TaskInventory {
  const row = briefingContractRecord<ContractTaskInventoryResponse>(payload);
  const executors = Array.isArray(row.executors) ? row.executors : [];
  const tasks = Array.isArray(row.tasks) ? row.tasks : [];
  return {
    executors: executors
      .map(normalizeTaskExecutorSummary)
      .filter((entry): entry is TaskExecutorSummary => entry !== null),
    tasks: tasks
      .map(normalizeTaskInventoryItem)
      .filter((entry): entry is TaskInventoryItem => entry !== null),
    stale_after_ms:
      briefingOptionalNumber(row.stale_after_ms) ?? TASK_INVENTORY_DEFAULT_STALE_AFTER_MS,
  };
}

/** The whole Tasks read surface. Read-only: the UI never posts an inventory. */
export async function getTaskInventory(signal?: AbortSignal): Promise<TaskInventory> {
  const response = await apiGet('/api/tasks', signal ? { signal } : {});
  return normalizeTaskInventory(await parseMaybeJson(response));
}

const TASK_COMMAND_STATES: readonly TaskCommandState[] = [
  'requested', 'accepted', 'applied', 'rejected', 'cancelled',
];
const TASK_COMMAND_REJECTION_REASONS: readonly TaskCommandRejectionReason[] = [
  'unknown_task', 'unsupported_verb', 'invalid_payload', 'stale_target',
  'policy_refused', 'unknown',
];

function normalizeTaskCommand(value: unknown): TaskCommand | null {
  const row = briefingContractRecord<ContractTaskCommand>(value);
  const id = briefingOptionalString(row.id);
  const executor = briefingOptionalString(row.executor);
  const taskId = briefingOptionalString(row.task_id);
  if (!id || !executor || !taskId || row.verb !== 'disable') return null;
  const state = taskMaybeEnum(row.state, TASK_COMMAND_STATES);
  if (state === TASK_INVENTORY_UNKNOWN) return null;
  const rejectionReason = row.rejection_reason === null
    ? null
    : taskMaybeEnum(row.rejection_reason, TASK_COMMAND_REJECTION_REASONS);
  return {
    id,
    schema: TASK_COMMAND_SCHEMA,
    request_key: briefingString(row.request_key),
    request_digest: briefingString(row.request_digest),
    executor,
    task_id: taskId,
    verb: 'disable',
    payload: {},
    requested_by_user_id: briefingString(row.requested_by_user_id),
    requested_by_slug: briefingOptionalString(row.requested_by_slug),
    requested_at: briefingOptionalNumber(row.requested_at) ?? 0,
    state,
    no_op: typeof row.no_op === 'boolean' ? row.no_op : null,
    rejection_reason: rejectionReason === TASK_INVENTORY_UNKNOWN ? 'unknown' : rejectionReason,
    events: Array.isArray(row.events) ? row.events : [],
  };
}

export function normalizeTaskCommands(payload: unknown): TaskCommandList {
  const row = briefingContractRecord<ContractTaskCommandListResponse>(payload);
  const commands = Array.isArray(row.commands) ? row.commands : [];
  return {
    commands: commands.map(normalizeTaskCommand).filter((entry): entry is TaskCommand => entry !== null),
    polling: 'tick_aligned',
  };
}

export async function getTaskCommands(
  filter: { executor?: string; taskId?: string } = {},
  signal?: AbortSignal,
): Promise<TaskCommandList> {
  const query = new URLSearchParams();
  if (filter.executor) query.set('executor', filter.executor);
  if (filter.taskId) query.set('task_id', filter.taskId);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  const response = await apiGet(`/api/tasks/commands${suffix}`, signal ? { signal } : {});
  return normalizeTaskCommands(await parseMaybeJson(response));
}

export async function requestTaskDisable(
  executor: string,
  taskId: string,
  requestKey: string = crypto.randomUUID(),
): Promise<TaskCommandMutation> {
  const response = await apiPost('/api/tasks/commands', {
    schema: TASK_COMMAND_SCHEMA,
    request_key: requestKey,
    executor,
    task_id: taskId,
    verb: 'disable',
    payload: {},
  });
  const row = briefingContractRecord<ContractTaskCommandMutationResult>(await parseMaybeJson(response));
  const command = normalizeTaskCommand(row.command);
  if (!command) throw new Error('Server returned an invalid task command receipt.');
  return { command, stored: row.stored === true };
}

export async function cancelTaskDisable(commandId: string): Promise<TaskCommandMutation> {
  const response = await apiPost(`/api/tasks/commands/${encodeURIComponent(commandId)}/cancel`, {});
  const row = briefingContractRecord<ContractTaskCommandMutationResult>(await parseMaybeJson(response));
  const command = normalizeTaskCommand(row.command);
  if (!command) throw new Error('Server returned an invalid task command receipt.');
  return { command, stored: row.stored === true };
}
