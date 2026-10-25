import { parseManagedChatDefaults, type ManagedChatDefaults } from "../../src/managed-chat-defaults";
import { DASHBOARD_BADGE_COUNTS, DOMAIN_EVENTS, isBriefingEvent, type DashboardBadgeCounts } from '../../src/contracts';
import { queryClient } from './query/client';
import { browserResourceKeys, browserResourceKeysForEvent, refreshBrowserResources } from './query/browserResources';
import { LIST_ENVELOPE_KEYS } from '../../src/contracts';
import type { SessionDescendant, SessionSummary } from '../../src/contracts';
export type { SessionDescendant, SessionSummary } from '../../src/contracts';
import { browserSessionFetch } from './client-auth-token';
import { invalidatePersistedDetail, ROUTE_DATA_FRESH_MS } from './detail-cache';
import type { ChatAttachment } from '../../src/conversation-control/attachments';
import type { InboxData } from './views/inbox';
import type { GraphEdge, GraphNode, GraphMode, GraphPayload } from './types/graph';
import type { ProjectTimelineInput, ProjectTimelineProjection } from './types/timeline';
import { feedbackCollectionIdentity, type FeedbackCollection } from './views/feedback/collection-model';
import type {
  ApiList,
  ListEnvelopeKey,
  ArtifactAliasRecord as ContractArtifactAliasRecord,
  ArtifactAliasResolutionStatus as ContractArtifactAliasResolutionStatus,
  ArtifactLinkRecord as ContractArtifactLinkRecord,
  ArtifactRecord as ContractArtifactRecord,
  ArtifactIdentityResolution as ContractArtifactResolveResult,
  ArtifactSeriesRecord as ContractArtifactSeriesRecord,
  ArtifactSeriesSummary as ContractArtifactSeriesSummary,
  ArtifactDraftWriteResult as ContractArtifactDraftPublishResult,
  ArtifactDraftRecord as ContractArtifactDraftRecord,
  ArtifactVersionRecord as ContractArtifactVersionRecord,
  AuthRequestAction as ContractAuthRequestAction,
  BlockType as ContractBlockType,
  Conversation as ContractConversation,
  ConversationChild as ContractConversationChild,
  ConversationParent as ContractConversationParent,
  ConversationPositionTarget as ContractConversationPositionTarget,
  ConversationPositionTargetKind as ContractConversationPositionTargetKind,
  ConversationPositionWindow as ContractConversationPositionWindow,
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
  SpaceBlock as ContractSpaceBlock,
  SpaceBlockType as ContractSpaceBlockType,
  Space as ContractSpace,
  SpaceGroup as ContractSpaceGroup,
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
  AcceptedConversationSubmission as ContractAcceptedConversationSubmission,
  ConversationControlError as ContractConversationControlError,
  ConversationControlOperation as ContractConversationControlOperation,
  ConversationRuntimeOptions as ContractConversationRuntimeOptions,
  ConversationControlSnapshot as ContractConversationControlSnapshot,
  ConversationSpawnReceipt as ContractConversationSpawnReceipt,
  ProviderAdapterEvent as ContractProviderAdapterEvent,
  ProviderLiveProjection as ContractProviderLiveProjection,
  OperationalIncidentRemediation as ContractOperationalIncidentRemediation,
  CreateSpaceEdgeRequest,
  UpdateSpaceEdgeRequest,
  AddSpaceItemResponse,
  SeedSpaceRequest,
  SeedSpaceResult,
  ResolverResult,
  SidebarOrderPreference,
  SidebarOrderPreferenceValue,
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
export type AuthRequestAction = ContractAuthRequestAction;

export type InstanceInfo = {
  role: 'main' | 'preview' | 'dev' | 'test';
  instance_id: string;
  installation_id: string;
  public_origin: string;
  backend_generation: string;
  allowed_effects: string[];
  writable_roots: string[];
  preview_root?: string | null;
  artifact_root?: string | null;
  source_artifact_root?: string | null;
  db_path: string | null;
  db_path_source: string | null;
  source_db_path?: string | null;
  source_db_path_source?: string | null;
};

type OperationHint = { method: string; path: string; effects: string[] | null };
const operationHints = new Map<string, OperationHint[]>();
const hintKey = (instance: InstanceInfo) => `${instance.instance_id}/${instance.backend_generation}`;

/** Bind affordance hints to the daemon generation that authored them. */
export function bindOperationCatalog(instance: InstanceInfo, value: unknown): boolean {
  const key = hintKey(instance);
  operationHints.delete(key);
  if (!value || typeof value !== 'object') return false;
  const catalog = value as { schema?: unknown; source?: unknown; runtime?: { instance_id?: unknown; backend_generation?: unknown; version?: unknown }; routes?: unknown };
  if (catalog.schema !== 'mandible-operation-catalog@2' || catalog.source !== 'Router.listRoutePolicies'
      || catalog.runtime?.instance_id !== instance.instance_id || catalog.runtime.backend_generation !== instance.backend_generation
      || typeof catalog.runtime.version !== 'string' || !catalog.runtime.version || !Array.isArray(catalog.routes)) return false;
  const hints: OperationHint[] = [];
  for (const value of catalog.routes) {
    if (!value || typeof value !== 'object') return false;
    const route = value as OperationHint;
    if (typeof route.method !== 'string' || typeof route.path !== 'string'
        || (route.effects !== null && (!Array.isArray(route.effects) || route.effects.some(effect => typeof effect !== 'string')))) return false;
    hints.push(route);
  }
  operationHints.set(key, hints);
  return true;
}

export async function loadOperationCatalog(instance: InstanceInfo): Promise<void> {
  if (operationHints.has(hintKey(instance))) return;
  const response = await apiGet('/api/instance');
  const payload = await response.json() as { operations?: unknown };
  if (!bindOperationCatalog(instance, payload.operations)) throw new Error('Daemon operation catalog is incompatible with this instance');
}

/** An affordance hint only; the daemon decides body, custody, and credential permissions. */
export function canPerformOperation(
  instance: InstanceInfo | null | undefined,
  method: string,
  pathname: string,
  _body?: unknown,
): boolean {
  if (!instance) return false;
  const path = pathname.split('?')[0].split('/');
  const route = operationHints.get(hintKey(instance))?.find(route => {
    const pattern = route.path.split('/');
    return route.method === method.toUpperCase() && pattern.length === path.length
      && pattern.every((part, index) => part.startsWith(':') ? path[index].length > 0 : part === path[index]);
  });
  return Boolean(route && (route.effects === null || route.effects.every(effect => instance.allowed_effects.includes(effect))));
}

export function allowsInstanceEffect(
  instance: InstanceInfo | null | undefined,
  effect: string,
): boolean {
  return !instance || instance.allowed_effects.includes(effect);
}

export function canWriteLedger(instance: InstanceInfo | null | undefined): boolean {
  return allowsInstanceEffect(instance, 'ledger:write');
}

export function canWritePreviewFiles(instance: InstanceInfo | null | undefined): boolean {
  return canWriteLedger(instance) && allowsInstanceEffect(instance, 'files:preview');
}

export function canWriteProductionFiles(instance: InstanceInfo | null | undefined): boolean {
  return allowsInstanceEffect(instance, 'files:production');
}

export function canEditUserPreferences(instance: InstanceInfo | null | undefined): boolean {
  return allowsInstanceEffect(instance, 'preferences:instance')
    || allowsInstanceEffect(instance, 'maintenance:shared');
}

export function normalizeInstanceInfo(value: unknown): InstanceInfo | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<InstanceInfo>;
  if ((candidate.role !== 'main' && candidate.role !== 'preview' && candidate.role !== 'dev' && candidate.role !== 'test')
      || typeof candidate.instance_id !== 'string'
      || typeof candidate.installation_id !== 'string'
      || typeof candidate.public_origin !== 'string'
      || typeof candidate.backend_generation !== 'string'
      || !Array.isArray(candidate.allowed_effects)
      || candidate.allowed_effects.some((effect) => typeof effect !== 'string')
      || !Array.isArray(candidate.writable_roots)
      || candidate.writable_roots.some((root) => typeof root !== 'string')
      || (typeof candidate.db_path !== 'string' && candidate.db_path !== null)
      || (typeof candidate.db_path_source !== 'string' && candidate.db_path_source !== null)
      || (candidate.source_db_path !== undefined && typeof candidate.source_db_path !== 'string' && candidate.source_db_path !== null)
      || (candidate.source_db_path_source !== undefined && typeof candidate.source_db_path_source !== 'string' && candidate.source_db_path_source !== null)) return null;
  return {
    role: candidate.role,
    instance_id: candidate.instance_id,
    installation_id: candidate.installation_id,
    public_origin: candidate.public_origin,
    backend_generation: candidate.backend_generation,
    allowed_effects: candidate.allowed_effects as string[],
    writable_roots: candidate.writable_roots as string[],
    db_path: candidate.db_path,
    db_path_source: candidate.db_path_source,
    ...(candidate.source_db_path !== undefined ? { source_db_path: candidate.source_db_path } : {}),
    ...(candidate.source_db_path_source !== undefined ? { source_db_path_source: candidate.source_db_path_source } : {}),
  };
}

/** Structural equality, so a re-probed but unchanged instance keeps its identity. */
export function sameInstanceInfo(a: InstanceInfo | null, b: InstanceInfo | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a) as Array<keyof InstanceInfo>;
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => {
    const left = a[key];
    const right = b[key];
    return Array.isArray(left) && Array.isArray(right)
      ? left.length === right.length && left.every((value, index) => value === right[index])
      : left === right;
  });
}

export type InstructionTargetMode = 'managed-block' | 'standalone';

export type InstructionTarget = {
  path: string;
  mode: InstructionTargetMode;
};

export type InstructionDeliverySettings = {
  targets: InstructionTarget[];
  postExport: string;
  configuredTargets: boolean;
  preview_only?: boolean;
  configuration_saved?: boolean;
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
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export type ConversationSpawnFailure = NonNullable<ContractConversationSpawnReceipt['error']>;
export type ConversationSpawnReceipt = ContractConversationSpawnReceipt;

export class ConversationSpawnApiError extends Error {
  readonly status: number;
  readonly failure: ConversationSpawnFailure;
  readonly spawn: ContractConversationSpawnReceipt;

  constructor(status: number, failure: ConversationSpawnFailure, spawn: ContractConversationSpawnReceipt) {
    super(failure.message);
    this.name = 'ConversationSpawnApiError';
    this.status = status;
    this.failure = failure;
    this.spawn = spawn;
  }
}

export function isApiErrorStatus(error: unknown, status: number): error is ApiError {
  return error instanceof ApiError && error.status === status;
}

async function apiGet(path: string, init: RequestInit = {}, fetchImpl?: typeof fetch): Promise<Response> {
  const headers = new Headers(DEFAULT_HEADERS);
  if (init.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }
  const response = await browserSessionFetch(path, { ...init, headers }, fetchImpl);
  if (!response.ok) {
    await throwOnError(response, 'GET', path);
  }
  return response;
}

async function throwOnError(response: Response, method: string, path: string): Promise<never> {
  let message = `${method} ${path} failed: ${response.status}`;
  let code: string | null = null;
  try {
    const body = await response.json() as { code?: string; error?: string; message?: string; missing_effects?: string[] };
    code = body.code ?? body.error ?? null;
    if (body.message) message = body.message;
    else if (body.error === 'effect_forbidden' && Array.isArray(body.missing_effects)) message = `This instance cannot perform the requested action. Required effects: ${body.missing_effects.join(', ')}.`;
    else if (body.error) message = body.error;
  } catch {
    // keep the generic message when the server did not return JSON
  }
  throw new ApiError(message, response.status, code);
}

type JsonWriteMethod = 'POST' | 'PATCH' | 'PUT';

async function apiWrite(method: JsonWriteMethod, path: string, body?: unknown, fetchImpl?: typeof fetch): Promise<Response> {
  const response = await browserSessionFetch(path, {
    method,
    headers: {
      ...DEFAULT_HEADERS,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  }, fetchImpl);
  if (!response.ok) {
    await throwOnError(response, method, path);
  }
  return response;
}

const apiPost = (path: string, body?: unknown): Promise<Response> => apiWrite('POST', path, body);
const apiPatch = (path: string, body?: unknown): Promise<Response> => apiWrite('PATCH', path, body);
const apiPut = (path: string, body?: unknown): Promise<Response> => apiWrite('PUT', path, body);

async function apiDelete(path: string, fetchImpl?: typeof fetch): Promise<Response> {
  const response = await browserSessionFetch(path, {
    method: 'DELETE',
    headers: DEFAULT_HEADERS,
  }, fetchImpl);
  if (!response.ok) {
    await throwOnError(response, 'DELETE', path);
  }
  return response;
}

function normalizeList<T>(payload: ApiList<T>): T[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  const envelope: Partial<Record<ListEnvelopeKey, T[]>> = payload;
  for (const key of LIST_ENVELOPE_KEYS) {
    const value = envelope[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
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

/**
 * A view's read of a cached GET. A fresh value answers without a request. Otherwise `onCached`
 * receives the retained value of the same path, however old or invalidated, synchronously
 * before the network answers, and the read revalidates, joining a read already in flight.
 */
export type CachedRead<T> = {
  signal?: AbortSignal;
  onCached?: (value: T) => void;
};

/**
 * A read of state that changes without a server event, such as a host preference. Only
 * `warm: true` reads (the startup warmup and a view's first load) may take a cached value;
 * every other read goes to the network, which keeps refreshes on focus authoritative.
 */
export type WarmableRead<T> = CachedRead<T> & { warm?: boolean };

type CachedJsonOptions<T> = CachedRead<T> & {
  ttlMs?: number;
  staleWhileRevalidateMs?: number;
};

type CachedJsonEntry = {
  value: unknown;
  freshUntil: number;
  staleUntil: number;
};

type InflightGetRequest = {
  promise: Promise<unknown>;
  controller: AbortController;
  consumers: number;
  settled: boolean;
  invalidated: boolean;
};

const DEFAULT_GET_CACHE_TTL_MS = 1_000;
const DEFAULT_GET_CACHE_STALE_MS = 4_000;
// Route data the startup warmup reads: an activation inside the window renders the warm value
// without a request, and the server events that change it invalidate it sooner.
const WARMED_ROUTE_GET_OPTIONS = {
  ttlMs: ROUTE_DATA_FRESH_MS,
  staleWhileRevalidateMs: 0,
};
const getJsonCache = new Map<string, CachedJsonEntry>();
const inflightGetJson = new Map<string, InflightGetRequest>();

function cacheKeyForGet(path: string): string {
  return `GET ${path}`;
}

async function fetchJsonForCache(
  path: string,
  options: { ttlMs: number; staleWhileRevalidateMs: number },
  signal: AbortSignal,
  shouldCache: () => boolean,
): Promise<unknown> {
  const response = await apiGet(path, { signal });
  const value = await parseMaybeJson(response);
  if (shouldCache()) {
    const now = Date.now();
    getJsonCache.set(cacheKeyForGet(path), {
      value,
      freshUntil: now + options.ttlMs,
      staleUntil: now + options.ttlMs + options.staleWhileRevalidateMs,
    });
  }
  return value;
}

function startCachedGet(
  key: string,
  path: string,
  options: { ttlMs: number; staleWhileRevalidateMs: number },
): InflightGetRequest {
  const request: InflightGetRequest = {
    promise: Promise.resolve(undefined),
    controller: new AbortController(),
    consumers: 0,
    settled: false,
    invalidated: false,
  };
  request.promise = fetchJsonForCache(
    path,
    options,
    request.controller.signal,
    () => !request.invalidated,
  ).finally(() => {
    request.settled = true;
    if (inflightGetJson.get(key) === request) inflightGetJson.delete(key);
  });
  inflightGetJson.set(key, request);
  return request;
}

/** Why a cached read stopped waiting: the signal's own reason, such as a refresh deadline. */
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The request was cancelled.', 'AbortError');
}

function waitForGetWithSignal<T>(request: InflightGetRequest, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  request.consumers += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    request.consumers -= 1;
    if (request.consumers === 0 && !request.settled) request.controller.abort();
  };
  if (!signal) {
    return request.promise.then(
      (value) => { release(); return value as T; },
      (error: unknown) => { release(); throw error; },
    );
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      release();
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    request.promise.then(
      (value) => {
        if (released) return;
        signal.removeEventListener('abort', onAbort);
        release();
        resolve(value as T);
      },
      (error: unknown) => {
        if (released) return;
        signal.removeEventListener('abort', onAbort);
        release();
        reject(error);
      },
    );
  });
}

async function cachedApiGetJson<T>(
  path: string,
  options: CachedJsonOptions<T> = {},
): Promise<T> {
  if (options.signal?.aborted) throw abortReason(options.signal);
  const resolvedOptions = {
    ttlMs: options.ttlMs ?? DEFAULT_GET_CACHE_TTL_MS,
    staleWhileRevalidateMs: options.staleWhileRevalidateMs ?? DEFAULT_GET_CACHE_STALE_MS,
  };
  const key = cacheKeyForGet(path);
  const cached = getJsonCache.get(key);
  const now = Date.now();
  if (cached && now < cached.freshUntil) return cached.value as T;

  const inflight = inflightGetJson.get(key);
  if (options.onCached) {
    if (cached) options.onCached(cached.value as T);
    return waitForGetWithSignal<T>(inflight ?? startCachedGet(key, path, resolvedOptions), options.signal);
  }
  if (cached && now < cached.staleUntil) {
    if (!inflight) {
      const refresh = startCachedGet(key, path, resolvedOptions);
      void refresh.promise.catch(() => undefined);
    }
    return cached.value as T;
  }
  const request = inflight ?? startCachedGet(key, path, resolvedOptions);
  return waitForGetWithSignal<T>(request, options.signal);
}

/**
 * Make matching GETs (all, without a matcher) read from the network again. Their last values
 * are retained only for `CachedRead.onCached`, which paints them while a view revalidates.
 */
export function invalidateApiGetCache(
  matcher: string | RegExp | ((key: string) => boolean) = () => true,
): void {
  const matches = (key: string) => (
    typeof matcher === 'string'
      ? key.includes(matcher)
      : matcher instanceof RegExp
        ? matcher.test(key)
        : matcher(key)
  );
  for (const [key, entry] of getJsonCache) {
    if (matches(key)) getJsonCache.set(key, { value: entry.value, freshUntil: 0, staleUntil: 0 });
  }
  for (const [key, request] of Array.from(inflightGetJson.entries())) {
    if (matches(key)) {
      request.invalidated = true;
      inflightGetJson.delete(key);
    }
  }
}

async function readWarmable<T>(path: string, read: WarmableRead<T>): Promise<T> {
  if (!read.warm) invalidateApiGetCache((key) => key === cacheKeyForGet(path));
  return cachedApiGetJson<T>(path, { ...WARMED_ROUTE_GET_OPTIONS, signal: read.signal, onCached: read.onCached });
}

/** Record a write's response as the current value of the GET that reads the same state. */
function rememberApiGet(path: string, value: unknown): void {
  const now = Date.now();
  getJsonCache.set(cacheKeyForGet(path), {
    value,
    freshUntil: now + WARMED_ROUTE_GET_OPTIONS.ttlMs,
    staleUntil: now + WARMED_ROUTE_GET_OPTIONS.ttlMs + WARMED_ROUTE_GET_OPTIONS.staleWhileRevalidateMs,
  });
}

/** Drop every cached GET, retained values included. */
export function clearApiGetCache(): void {
  getJsonCache.clear();
  for (const request of inflightGetJson.values()) request.invalidated = true;
  inflightGetJson.clear();
}

/** Exact cache families affected by a Briefing lifecycle event. */
export function briefingApiCacheFamiliesForEvent(type: string): readonly string[] {
  if (isBriefingEvent(type)) {
    return ['/api/briefings', '/api/briefing-bundles', '/api/briefing-groups'];
  }
  return [];
}

/** Narrow Briefing invalidation; returns whether the event was handled. */
export function invalidateBriefingApiCacheForEvent(type: string): boolean {
  const families = briefingApiCacheFamiliesForEvent(type);
  if (families.length) void refreshBrowserResources(queryClient, browserResourceKeysForEvent(type));
  for (const family of families) invalidateApiGetCache(family);
  return families.length > 0;
}

/** Graph and Timeline project every entity family, so any change to one invalidates both. */
function invalidateCrossEntityProjections(): void {
  invalidateApiGetCache('/api/graph');
  invalidatePersistedDetail('graph');
  invalidatePersistedDetail('timeline');
}

function invalidateArtifactReads(): void {
  invalidateApiGetCache('/api/artifacts');
  invalidatePersistedDetail('artifact-versions');
  invalidatePersistedDetail('artifact-record');
  invalidatePersistedDetail('artifact-content');
  invalidatePersistedDetail('artifact-backrefs');
}

export function invalidateDashboardApiCacheForEvent(type: string): void {
  if (type === DOMAIN_EVENTS.HEARTBEAT) return;
  // Logs are an all-event projection. Its view refetches on each event, so
  // discard a warmed snapshot before the visible consumer asks again.
  invalidateApiGetCache('/api/system/logs');
  if (invalidateBriefingApiCacheForEvent(type)) {
    invalidateCrossEntityProjections();
    if (type === 'briefing:round-published') invalidateArtifactReads();
    return;
  }
  if (type.startsWith('conversation:')) {
    invalidateApiGetCache('/api/conversations');
    invalidateCrossEntityProjections();
  } else if (type.startsWith('session:') || type.startsWith('console:session:')) {
    invalidateApiGetCache('/api/sessions');
    invalidateApiGetCache('/api/console/sessions');
    invalidateApiGetCache('/api/conversations');
    invalidateCrossEntityProjections();
  } else if (type.startsWith('auth:')) {
    invalidateApiGetCache('/api/auth/');
    invalidateApiGetCache('/api/inbox');
    if (type !== 'auth:output') invalidateCrossEntityProjections();
  } else if (type.startsWith('work:') || type.startsWith('push:')) {
    invalidateApiGetCache('/api/work/');
    invalidateApiGetCache('/api/inbox');
    invalidateCrossEntityProjections();
  } else if (type.startsWith('ledger:')) {
    // Covers ledger:issue:*, ledger:comment:*, ledger:label:*, and other
    // ledger:* events; all can change an issue list row or detail projection.
    invalidateApiGetCache('/api/issues');
    invalidateApiGetCache('/api/ledger');
    invalidateApiGetCache('/api/inbox');
    invalidatePersistedDetail('issue-detail');
    invalidateCrossEntityProjections();
  } else if (type.startsWith('space:')) {
    invalidateApiGetCache('/api/spaces');
    invalidatePersistedDetail('spaces');
    invalidateCrossEntityProjections();
  } else if (type.startsWith('artifact:')) {
    invalidateArtifactReads();
    invalidateCrossEntityProjections();
  } else if (type.startsWith('managed-reminders.')) {
    invalidateApiGetCache('/api/tasks');
    invalidateApiGetCache('/api/inbox');
    invalidateCrossEntityProjections();
  } else if (type.startsWith('tasks.')) {
    invalidateApiGetCache('/api/tasks');
    invalidateApiGetCache('/api/tasks/commands');
    invalidateCrossEntityProjections();
  }
}

export async function getSessions<T>(query?: string, read: CachedRead<T[]> = {}): Promise<T[]> {
  const { onCached } = read;
  const payload = await cachedApiGetJson<ApiList<T>>(`/api/sessions${query || ''}`, {
    ...WARMED_ROUTE_GET_OPTIONS,
    signal: read.signal,
    onCached: onCached && ((cached) => onCached(normalizeList(cached))),
  });
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

// The Session Overview of any session alias, or of an alias prefix naming
// several sessions, which answers with the candidates.
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
  worker_provider_session_id: string | null;
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
  status: 'resolved';
  session: SessionSummary;
  children: {
    items: SessionDescendant[];
    truncated: boolean;
    depth_limit: number;
    count_limit: number;
  };
  linked_issues: { items: SessionOverviewLinkedIssue[] };
  work_units: { includes_descendants: boolean; items: SessionOverviewWorkUnit[] };
  conversations: { limit: number; items: SessionOverviewConversation[] };
};

export type SessionOverviewAmbiguous = {
  as_of: number;
  status: 'ambiguous';
  truncated: boolean;
  candidates: SessionSummary[];
};

export async function getSessionOverview(
  sessionRef: string,
  read: CachedRead<SessionOverview | SessionOverviewAmbiguous> = {},
): Promise<SessionOverview | SessionOverviewAmbiguous> {
  return cachedApiGetJson<SessionOverview | SessionOverviewAmbiguous>(
    `/api/sessions/${encodeURIComponent(sessionRef)}/overview`,
    { ...WARMED_ROUTE_GET_OPTIONS, ...read },
  );
}

export async function navigateSession(sessionId: string): Promise<void> {
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/navigate`;
  const response = await browserSessionFetch(path, {
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

export async function openConversationExternally(conversationId: string): Promise<void> {
  await apiPost(`/api/conversations/${encodeURIComponent(conversationId)}/open-external`);
}

export async function killSession(sessionId: string): Promise<void> {
  await apiPost(`/api/sessions/${encodeURIComponent(sessionId)}/kill`);
}

export async function patchSession(sessionId: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await apiPatch(`/api/sessions/${encodeURIComponent(sessionId)}`, body);
  return parseMaybeJson(response);
}

export async function getAuthQueue<T>(): Promise<T[]> {
  const payload = await cachedApiGetJson<ApiList<T>>('/api/auth/queue', WARMED_ROUTE_GET_OPTIONS);
  return normalizeList(payload);
}

export async function getAuthHistory<T>(limit?: number): Promise<T[]> {
  const query = limit != null ? `?limit=${limit}` : '';
  const payload = await cachedApiGetJson<ApiList<T>>(`/api/auth/history${query}`, WARMED_ROUTE_GET_OPTIONS);
  return normalizeList(payload);
}

export type { DashboardBadgeCounts };

/** Mount and SSE-reconnect resync only; the daemon pushes every change as `dashboard:badges`. */
export async function getDashboardBadges(): Promise<DashboardBadgeCounts> {
  const response = await apiGet('/api/dashboard/badges');
  return DASHBOARD_BADGE_COUNTS.parse(await response.json());
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
  throw new Error('Approval action response did not contain an action list.');
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

export async function cancelApprovalProof(requestId: string): Promise<void> {
  const path = `/api/auth/request/${encodeURIComponent(requestId)}/cancel-proof`;
  const response = await apiWrite('POST', path);
  if (!response.ok) throw new Error('Could not cancel operator signing.');
}

export async function approveAuthRequest(requestId: string): Promise<void> {
  // Bug: 58d93ee — extract server error message so the dashboard can surface it
  // (e.g. invalid_command: "Auth request has no command set")
  // Bug: 737df04 — wrap in AbortController so the fetch does not hang indefinitely
  // if Mandible is mid-startup-scan and the event loop is saturated.
  const APPROVE_TIMEOUT_MS = 65_000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), APPROVE_TIMEOUT_MS);

  const path = `/api/auth/request/${encodeURIComponent(requestId)}/approve`;
  let response: Response;
  try {
    response = await browserSessionFetch(path, {
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

export type DelegatedSigningStatus = {
  provider: string;
  configured: boolean;
  public_key: string | null;
  public_key_path: string;
  encrypted_passphrase_path: string;
  recipient_path: string;
  missing_tools: string[];
};

export type OperatorSigningCredential = {
  id: string;
  type: string;
  fingerprint: string;
  label: string | null;
};

export type OperatorSigningKeyStatus = {
  audit: {
    status: 'ok' | 'no_operator' | 'unconfigured' | 'unresolvable' | 'missing_credential';
    configured: boolean;
    fingerprint: string | null;
    operator_slug: string | null;
    reason: string | null;
    hint: string | null;
  };
  credentials: OperatorSigningCredential[];
  git_config_read: boolean;
};

export async function getOperatorSigningKeyStatus(): Promise<OperatorSigningKeyStatus> {
  const response = await apiGet('/api/users/operator/signing-key');
  return (await parseMaybeJson(response)) as OperatorSigningKeyStatus;
}

export async function registerOperatorSigningKey(input:
  | { source: 'configured' }
  | { source: 'public_key'; public_key: string }
): Promise<{ credential: OperatorSigningCredential; unchanged: boolean }> {
  const response = await apiPost('/api/users/operator/signing-key', input);
  return (await parseMaybeJson(response)) as { credential: OperatorSigningCredential; unchanged: boolean };
}

export async function getDelegatedSigningStatus(): Promise<DelegatedSigningStatus> {
  const response = await apiGet('/api/auth/clearances/signing');
  return (await parseMaybeJson(response)) as DelegatedSigningStatus;
}

export async function setupDelegatedSigning(input: {
  name?: string;
  email?: string;
  age_recipient?: string;
  overwrite?: boolean;
}): Promise<DelegatedSigningStatus> {
  const response = await apiPost('/api/auth/clearances/signing/setup', input);
  return (await parseMaybeJson(response)) as DelegatedSigningStatus;
}

export async function removeDelegatedSigning(): Promise<DelegatedSigningStatus> {
  const response = await apiDelete('/api/auth/clearances/signing');
  return (await parseMaybeJson(response)) as DelegatedSigningStatus;
}

export type AuthClearance = {
  id: string;
  issuer_user_id: string;
  grantee_user_id: string;
  grantee_credential_id: string;
  project_id: string;
  base_branch: string;
  issue_id: string | null;
  head_branch: string | null;
  action: 'merge';
  issued_at: number;
  expires_at: number;
  max_uses: number;
  consumed_uses: number;
  revoked_at: number | null;
  runtime_epoch: string;
};

export async function getAuthClearances(): Promise<AuthClearance[]> {
  const response = await apiGet('/api/auth/clearances');
  const body = await parseMaybeJson(response) as { clearances?: AuthClearance[] };
  return body.clearances ?? [];
}

export async function createAuthClearance(input: {
  request_id?: string;
  grantee: string;
  grantee_credential_id?: string;
  project?: string;
  base?: string;
  issue?: string;
  head?: string;
  action?: 'merge';
  duration_minutes?: number;
  max_uses?: number;
}): Promise<AuthClearance> {
  const response = await apiPost('/api/auth/clearances', input);
  return ((await parseMaybeJson(response)) as { clearance: AuthClearance }).clearance;
}

export async function revokeAuthClearance(id: string): Promise<AuthClearance> {
  const response = await apiPost(`/api/auth/clearances/${encodeURIComponent(id)}/revoke`);
  return ((await parseMaybeJson(response)) as { clearance: AuthClearance }).clearance;
}

export async function getWorkRepos<T>(): Promise<T[]> {
  const payload = await cachedApiGetJson<ApiList<T>>('/api/work/repos', WARMED_ROUTE_GET_OPTIONS);
  return normalizeList(payload);
}

export async function getRepoBranches<T>(repoId: string): Promise<T[]> {
  const payload = await cachedApiGetJson<ApiList<T>>(
    `/api/work/repos/${encodeURIComponent(repoId)}/branches`,
    WARMED_ROUTE_GET_OPTIONS,
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

/** Read a repository's branch audit; `refresh` makes the daemon rescan instead of serving a fresh stored scan. */
export async function getWorkRepoAudit(repoId: string, options: { refresh?: boolean } = {}): Promise<WorkRepoAudit> {
  const query = options.refresh ? '?refresh=1' : '';
  const response = await apiGet(`/api/work/repos/${encodeURIComponent(repoId)}/audit${query}`);
  return (await parseMaybeJson(response)) as WorkRepoAudit;
}

/**
 * Move a branch/worktree into reversible custody without discarding partial
 * outcome facts from non-2xx responses.
 */
export async function createTrashEntry(request: TrashCreateRequest): Promise<TrashCreateResult> {
  const response = await browserSessionFetch('/api/v1/trash', {
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
  const payload = await cachedApiGetJson<ApiList<T>>('/api/issues', WARMED_ROUTE_GET_OPTIONS);
  return normalizeList(payload);
}

export async function getProjectTimeline(
  input: ProjectTimelineInput,
  signal?: AbortSignal,
): Promise<ProjectTimelineProjection> {
  const response = await browserSessionFetch('/api/timeline/project', {
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
  invalidateApiGetCache('/api/work/');
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
  return cachedApiGetJson<InboxData>('/api/inbox/global', WARMED_ROUTE_GET_OPTIONS);
}

export async function acknowledgeInboxItem(
  type: 'continuation' | 'auth_result' | 'managed_reminder_occurrence',
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
  /** `unknown`: a liveness check could not complete; never read it as stopped. */
  state: 'live' | 'stopped' | 'unknown';
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

export type IssueContextSession = SessionSummary & { has_conversation: boolean };

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

import type {
  LedgerIssueDetailProjection,
} from '../../src/issue-detail-contract';
export type {
  LedgerIssueDetailAlias,
  LedgerIssueDetailActor,
  LedgerIssueDetailComment,
  LedgerIssueDetailCheckpoint,
  LedgerIssueDetailBranch,
  LedgerIssueTimelineEntry,
  LedgerIssueSummaryRef,
  LedgerIssueWorkMetadata,
  LedgerIssueDetailRelationship,
  LedgerIssueDetailProject,
  LedgerIssueDetailWorkUnit,
  LedgerIssueDetailSession,
  LedgerIssueDetailAuthRequest,
  LedgerIssueDetailArtifactLink,
  LedgerIssueDetailAssociatedArtifact,
  LedgerIssueDetailProjection,
} from '../../src/issue-detail-contract';
export type { LedgerActorType } from '../../src/ledger/types';
export type {
  ReadUserIdentity,
  MergeSignatureClaim,
  AttributionReadProjection,
} from '../../src/identity/contracts';
export type { WorkUnitLiveness as LedgerIssueDetailLiveness } from '../../src/contracts';

export type LedgerBodyRevision = {
  id: string;
  entity_type: 'issue_body' | 'comment_body' | 'issue_work_notes';
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

export async function getLedgerIssueWorkNotesRevisions(issueId: string): Promise<LedgerBodyRevision[]> {
  const response = await apiGet(`/api/ledger/issues/${encodeURIComponent(issueId)}/work-notes/history`);
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

export async function getIssueSessions(repoId: string, issueId: string): Promise<unknown[]> {
  const response = await apiGet(
    `/api/issues/${encodeURIComponent(repoId)}/${encodeURIComponent(issueId)}/sessions`
  );
  const payload = await parseMaybeJson(response);
  return Array.isArray(payload) ? payload : [];
}

// Bug: cbbb3d9 — spawn SDK console session from issue hub
export type SpawnIssueAgentResult = {
  conversation_id: string;
  continuation: string | null;
  branch: string | null;
  cwd: string | null;
};

export async function spawnIssueAgent(
  repoId: string,
  issueId: string,
  workUnit: { id: string; custody_generation: number },
): Promise<SpawnIssueAgentResult> {
  const response = await apiPost(
    `/api/issues/${encodeURIComponent(repoId)}/${encodeURIComponent(issueId)}/spawn`,
    { work_unit_id: workUnit.id, expected_custody_generation: workUnit.custody_generation },
  );
  return (await parseMaybeJson(response)) as SpawnIssueAgentResult;
}

export async function getSettings(): Promise<Record<string, string>> {
  const payload = await cachedApiGetJson<unknown>('/api/settings');
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const settings = { ...payload } as Record<string, string>;
    // app_rail_order moved to the authenticated user-settings contract. Do not
    // admit the legacy global row into app state, where stale browser-cache
    // hydration could reintroduce a second authority for writable instances.
    delete settings.app_rail_order;
    return settings;
  }
  return {};
}

export type UserAppRailOrderSetting = {
  version: 1;
  key: 'app_rail_order';
  value: string | null;
  revision: number;
};

function parseUserAppRailOrderSetting(payload: unknown): UserAppRailOrderSetting {
  const record = payload && typeof payload === 'object'
    ? payload as Record<string, unknown>
    : null;
  if (
    record?.version !== 1
    || record.key !== 'app_rail_order'
    || (record.value !== null && typeof record.value !== 'string')
    || !Number.isSafeInteger(record.revision)
    || (record.revision as number) < 0
  ) {
    throw new Error('Invalid authenticated app rail order response');
  }
  return record as UserAppRailOrderSetting;
}

export async function getUserAppRailOrderSetting(): Promise<UserAppRailOrderSetting> {
  const response = await apiGet('/api/user-settings/app_rail_order');
  return parseUserAppRailOrderSetting(await parseMaybeJson(response));
}

export async function updateUserAppRailOrderSetting(
  value: string,
): Promise<UserAppRailOrderSetting> {
  const response = await apiPut('/api/user-settings/app_rail_order', { value });
  return parseUserAppRailOrderSetting(await parseMaybeJson(response));
}

export type UserTypographySettingKey =
  | 'ui_font_face'
  | 'ui_font_size'
  | 'detail_font_face'
  | 'detail_font_size';

export type UserTypographySetting = {
  version: 1;
  key: UserTypographySettingKey;
  value: string | null;
  revision: number;
};

function parseUserTypographySetting(
  key: UserTypographySettingKey,
  payload: unknown,
): UserTypographySetting {
  const record = payload && typeof payload === 'object'
    ? payload as Record<string, unknown>
    : null;
  if (
    record?.version !== 1
    || record.key !== key
    || (record.value !== null && typeof record.value !== 'string')
    || !Number.isSafeInteger(record.revision)
    || (record.revision as number) < 0
  ) throw new Error(`Invalid authenticated ${key} response`);
  return record as UserTypographySetting;
}

export async function getUserTypographySetting(
  key: UserTypographySettingKey,
): Promise<UserTypographySetting> {
  const response = await apiGet(`/api/user-settings/${key}`);
  return parseUserTypographySetting(key, await parseMaybeJson(response));
}

export async function updateUserTypographySetting(
  key: UserTypographySettingKey,
  value: string,
): Promise<UserTypographySetting> {
  const response = await apiPut(`/api/user-settings/${key}`, { value });
  return parseUserTypographySetting(key, await parseMaybeJson(response));
}

export async function getManagedChatDefaults(): Promise<ManagedChatDefaults> {
  const response = await apiGet('/api/user-settings/managed_chat_defaults');
  const snapshot = await parseMaybeJson(response) as { value: string | null };
  return parseManagedChatDefaults(snapshot.value);
}

export async function updateManagedChatDefaults(value: ManagedChatDefaults): Promise<ManagedChatDefaults> {
  const response = await apiPut('/api/user-settings/managed_chat_defaults', { value: JSON.stringify(value) });
  const snapshot = await parseMaybeJson(response) as { value: string };
  return parseManagedChatDefaults(snapshot.value);
}

export type {
  ChatEntityClickAction,
} from '../../src/contracts';

export type ChatShownProjectPreferenceValue = {
  projectId: string;
  checkoutId: string;
};

export type ChatShownProjectsPreference = {
  version: 1;
  key: 'chat_shown_projects';
  value: ChatShownProjectPreferenceValue[];
  revision: number;
};

function parseChatShownProjectsPreference(payload: unknown): ChatShownProjectsPreference {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
  if (
    record?.version !== 1
    || record.key !== 'chat_shown_projects'
    || !Array.isArray(record.value)
    || !Number.isSafeInteger(record.revision)
    || (record.revision as number) < 0
    || record.value.some((candidate) => (
      !candidate
      || typeof candidate !== 'object'
      || Array.isArray(candidate)
      || typeof (candidate as Record<string, unknown>).projectId !== 'string'
      || typeof (candidate as Record<string, unknown>).checkoutId !== 'string'
    ))
  ) throw new Error('Invalid Chat shown-project preference response');
  return record as ChatShownProjectsPreference;
}

const CHAT_SHOWN_PROJECTS_PATH = '/api/host-preferences/chat-shown-projects';

export async function getChatShownProjectsPreference(
  read: WarmableRead<ChatShownProjectsPreference> = {},
): Promise<ChatShownProjectsPreference> {
  const { onCached } = read;
  return parseChatShownProjectsPreference(await readWarmable<unknown>(CHAT_SHOWN_PROJECTS_PATH, {
    ...read,
    onCached: onCached && ((cached) => onCached(parseChatShownProjectsPreference(cached))),
  }));
}

export async function updateChatShownProjectsPreference(
  value: ChatShownProjectPreferenceValue[],
  expectedRevision: number,
): Promise<ChatShownProjectsPreference> {
  const response = await apiPut(CHAT_SHOWN_PROJECTS_PATH, {
    value,
    expected_revision: expectedRevision,
  });
  const saved = parseChatShownProjectsPreference(await parseMaybeJson(response));
  rememberApiGet(CHAT_SHOWN_PROJECTS_PATH, saved);
  return saved;
}

export type { SidebarOrderPreferenceValue, SidebarOrderPreference } from '../../src/contracts';

function parseSidebarOrderPreference(payload: unknown): SidebarOrderPreference {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
  const value = record?.value;
  const validIds = (candidate: unknown) => candidate === null
    || (Array.isArray(candidate) && candidate.every((id) => typeof id === 'string' && id.trim()));
  if (
    record?.version !== 1
    || record.key !== 'sidebar_order'
    || !Number.isSafeInteger(record.revision)
    || (record.revision as number) < 0
    || (
      !value
      || typeof value !== 'object'
      || Array.isArray(value)
      || !validIds((value as Record<string, unknown>).pinnedConversationIds)
      || !validIds((value as Record<string, unknown>).briefingTopLevelIds)
    )
  ) throw new Error('Invalid authenticated sidebar order response');
  return record as SidebarOrderPreference;
}

const SIDEBAR_ORDER_PATH = '/api/host-preferences/sidebar-order';

export async function getSidebarOrderPreference(
  read: WarmableRead<SidebarOrderPreference> = {},
): Promise<SidebarOrderPreference> {
  const { onCached } = read;
  return parseSidebarOrderPreference(await readWarmable<unknown>(SIDEBAR_ORDER_PATH, {
    ...read,
    onCached: onCached && ((cached) => onCached(parseSidebarOrderPreference(cached))),
  }));
}

export async function updateSidebarOrderPreference(
  value: SidebarOrderPreferenceValue,
  expectedRevision: number,
): Promise<SidebarOrderPreference> {
  const response = await apiPut(SIDEBAR_ORDER_PATH, {
    value,
    expected_revision: expectedRevision,
  });
  const saved = parseSidebarOrderPreference(await parseMaybeJson(response));
  rememberApiGet(SIDEBAR_ORDER_PATH, saved);
  return saved;
}

export type AppThemePreference = {
  version: 1;
  key: 'app_theme';
  value: 'system' | 'light' | 'dark' | null;
  revision: number;
};

function parseAppThemePreference(payload: unknown): AppThemePreference {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
  if (
    record?.version !== 1
    || record.key !== 'app_theme'
    || (record.value !== null && record.value !== 'system' && record.value !== 'light' && record.value !== 'dark')
    || !Number.isSafeInteger(record.revision)
    || (record.revision as number) < 0
  ) throw new Error('Invalid app-theme preference response');
  return record as AppThemePreference;
}

export async function getAppThemePreference(): Promise<AppThemePreference> {
  const response = await apiGet('/api/host-preferences/app-theme');
  return parseAppThemePreference(await parseMaybeJson(response));
}

export async function updateAppThemePreference(
  value: 'system' | 'light' | 'dark',
  expectedRevision: number,
): Promise<AppThemePreference> {
  const response = await apiPut('/api/host-preferences/app-theme', {
    value,
    expected_revision: expectedRevision,
  });
  return parseAppThemePreference(await parseMaybeJson(response));
}

/**
 * Issue 8aadf70 — which Claude lanes this daemon ships. The Claude PTY lane
 * (terminal driving) is local-only and off by default, and the gate is
 * resolvable from an environment override as well as the settings table, so the
 * dialog asks the daemon instead of reading the setting directly.
 */
export type ConsoleLanePolicy = {
  terminal_backend_type: 'pty';
  managed_providers: ('claude_code' | 'codex')[];
};

export async function getConsoleLanePolicy(): Promise<ConsoleLanePolicy> {
  return cachedApiGetJson<ConsoleLanePolicy>('/api/console/lane-policy');
}

export async function updateSetting(key: string, value: string): Promise<void> {
  const response = await browserSessionFetch(`/api/settings/${encodeURIComponent(key)}`, {
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
  const response = await browserSessionFetch('/api/settings/instructions-delivery', {
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
  const payload = await cachedApiGetJson<ApiList<T>>('/api/console/sessions', WARMED_ROUTE_GET_OPTIONS);
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
export type ConsoleThinkingEffort = 'low' | 'medium' | 'high' | 'max';
export type SessionRunOptionValue = string | number | boolean | string[] | null;
export type SessionRunOptionChoice = { value: string | number | boolean; label: string; description?: string };
export type SessionRunOptionState = {
  id: string; label: string; description?: string; category: string;
  kind: 'select' | 'multi_select' | 'boolean' | 'integer' | 'number' | 'text';
  nullable: boolean; source: 'backend' | 'provider' | 'composed';
  availability: 'available' | 'awaiting_provider' | 'unavailable';
  currentValue: SessionRunOptionValue; allowedValues: readonly SessionRunOptionChoice[] | null;
  enforcement: { status: 'unsupported'; reason: string } | {
    status: 'awaiting_provider' | 'pending' | 'enforced' | 'indeterminate';
    owner: 'backend' | 'provider'; effectiveFrom: 'immediate' | 'next_prompt'; detail?: string;
  };
};
export type SessionRunOptionsSnapshot = {
  backendType: ConsoleBackendType; command: string;
  phase: 'declared' | 'discovering' | 'configuring' | 'ready' | 'blocked';
  revision: number; options: readonly SessionRunOptionState[];
};

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
  runOptions?: Record<string, SessionRunOptionValue>;
  model?: string;
  thinkingEffort?: ConsoleThinkingEffort;
  systemPrompt?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions';
  allowedTools?: string[];
  maxTurns?: number;
  maxCostUsd?: number;
};

export async function startProviderChat(
  idempotencyKey: string,
  provider: 'codex' | 'claude_code',
  placement: { kind: 'projectless' } | { kind: 'project'; project_id: string; checkout_id: string },
  options: { signal?: AbortSignal } = {},
): Promise<{ conversation_id: string; spawn: ContractConversationSpawnReceipt }> {
  const response = await browserSessionFetch('/api/conversation-spawns', {
    method: 'POST',
    headers: {
      ...DEFAULT_HEADERS,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      schema: 'mandible-conversation-spawn-request@3',
      idempotency_key: idempotencyKey,
      provider,
      placement,
    }),
    signal: options.signal,
  });
  type SpawnResponse = {
    ok?: boolean;
    error?: unknown;
    spawn?: ContractConversationSpawnReceipt;
    session?: unknown;
    message?: string;
  };
  const json = await parseMaybeJson(response) as SpawnResponse;
  if (!response.ok) {
    const failure = json.error;
    if (failure && typeof failure === 'object'
        && typeof (failure as ConversationSpawnFailure).code === 'string'
        && typeof (failure as ConversationSpawnFailure).message === 'string'
        && typeof (failure as ConversationSpawnFailure).retryable === 'boolean'
        && json.spawn) {
      throw new ConversationSpawnApiError(response.status, failure as ConversationSpawnFailure, json.spawn);
    }
    const fallback = failure && typeof failure === 'object'
      ? (failure as { kind?: unknown }).kind
      : failure;
    throw new ApiError(
      json.message ?? (typeof fallback === 'string' ? fallback : `POST /api/conversation-spawns failed: ${response.status}`),
      response.status,
      typeof fallback === 'string' ? fallback : null,
    );
  }
  return json as { conversation_id: string; spawn: ContractConversationSpawnReceipt };
}

export async function getProviderChat(id: string): Promise<ContractConversationSpawnReceipt> {
  const response = await apiGet(`/api/conversation-spawns/${encodeURIComponent(id)}`);
  const result = await parseMaybeJson(response) as
    | { ok: true; value: ContractConversationSpawnReceipt }
    | { ok: false; error: unknown };
  if (!result.ok) throw new Error('Conversation creation receipt is unavailable.');
  return result.value;
}

export async function closeConsoleSession(sessionId: string): Promise<void> {
  await apiDelete(`/api/console/sessions/${encodeURIComponent(sessionId)}`);
}

export async function retryProviderChat(id: string, expectedGeneration: number): Promise<ContractConversationSpawnReceipt> {
  const response = await apiPost(`/api/conversation-spawns/${encodeURIComponent(id)}/retry`, {
    expected_generation: expectedGeneration,
  });
  const payload = await parseMaybeJson(response) as { spawn: ContractConversationSpawnReceipt };
  return payload.spawn;
}

export async function cancelProviderChat(id: string, expectedGeneration: number): Promise<ContractConversationSpawnReceipt> {
  const path = `/api/conversation-spawns/${encodeURIComponent(id)}`;
  const response = await browserSessionFetch(path, {
    method: 'DELETE',
    headers: { ...DEFAULT_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expected_generation: expectedGeneration }),
  });
  if (!response.ok) await throwOnError(response, 'DELETE', path);
  const payload = await parseMaybeJson(response) as { value: ContractConversationSpawnReceipt };
  return payload.value;
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

export async function getConsoleRunOptions(
  backendType: ConsoleBackendType,
  command: string,
): Promise<SessionRunOptionsSnapshot> {
  const response = await apiGet(`/api/console/run-options?backend_type=${encodeURIComponent(backendType)}&command=${encodeURIComponent(command)}`);
  return (await parseMaybeJson(response) as { runOptions: SessionRunOptionsSnapshot }).runOptions;
}

export async function getConsoleSessionOptions(sessionId: string): Promise<{
  runOptions: SessionRunOptionsSnapshot;
  mandibleControls: { allowedTools: string[] | null };
}> {
  const response = await apiGet(`/api/console/sessions/${encodeURIComponent(sessionId)}/options`);
  return parseMaybeJson(response) as Promise<{
    runOptions: SessionRunOptionsSnapshot;
    mandibleControls: { allowedTools: string[] | null };
  }>;
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
  const response = await browserSessionFetch('/api/backup/settings', {
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

export type ChatRouteTarget = { type: 'conversation' | 'session'; id: string };
export type ChatRouteResolution =
  | { status: 'resolved'; selection: ChatRouteTarget }
  | { status: 'not_found' | 'ambiguous' };

export async function resolveChatRouteTarget(target: ChatRouteTarget, signal?: AbortSignal): Promise<ChatRouteResolution> {
  const query = new URLSearchParams({ [target.type]: target.id });
  const response = await apiGet(`/api/conversations/resolve-target?${query}`, { signal });
  return await parseMaybeJson(response) as ChatRouteResolution;
}

export async function getConversations(params?: {
  source?: string;
  starred?: boolean;
  search?: string;
  full_text?: boolean;
  offset?: number;
  limit?: number;
  sort?: string;
  min_blocks?: number;
  group?: boolean;
  exclude_subagents?: boolean;
  parent_id?: string;
  session_id?: string;
  tag?: string;
  signal?: AbortSignal;
}): Promise<{ conversations: Conversation[]; total: number }> {
  const query = new URLSearchParams();
  if (params?.source) query.set('source', params.source);
  if (params?.starred) query.set('starred', '1');
  if (params?.search) query.set('search', params.search);
  if (params?.full_text) query.set('full_text', 'true');
  if (params?.offset != null) query.set('offset', String(params.offset));
  if (params?.limit) query.set('limit', String(params.limit));
  if (params?.sort) query.set('sort', params.sort);
  if (params?.min_blocks) query.set('min_blocks', String(params.min_blocks));
  if (params?.group) query.set('group', 'true');
  if (params?.exclude_subagents) query.set('exclude_subagents', 'true');
  if (params?.parent_id) query.set('parent_id', params.parent_id);
  if (params?.session_id) query.set('session_id', params.session_id);
  if (params?.tag) query.set('tag', params.tag);
  const qs = query.toString();
  const response = await apiGet(`/api/conversations${qs ? '?' + qs : ''}`, { signal: params?.signal });
  return (await parseMaybeJson(response)) as { conversations: Conversation[]; total: number };
}

export type ConversationSidebarConversation = Conversation & {
  canonical_project_id: string | null;
  canonical_project_key: string | null;
  search_target?: { block: string };
  spawn?: ContractConversationSpawnReceipt;
};

export type ConversationSidebarGroup = {
  key: string;
  kind: 'pinned' | 'project' | 'chats';
  label: string;
  project_id?: string;
  project_key?: string;
  total: number;
  conversations: ConversationSidebarConversation[];
  next_cursor: string | null;
};

export type ConversationSidebarResponse = {
  groups: ConversationSidebarGroup[];
  limit: number;
};

export async function getConversationSidebar(params: {
  lifecycle?: 'active' | 'archived';
  source?: string;
  starred?: boolean;
  search?: string;
  full_text?: boolean;
  sort?: string;
  min_blocks?: number;
  exclude_subagents?: boolean;
  project_ids?: string[];
  pinned_ids?: string[];
  limit: number;
  group_key?: string;
  cursor?: string;
  signal?: AbortSignal;
}): Promise<ConversationSidebarResponse> {
  const query = new URLSearchParams();
  if (params.lifecycle) query.set('lifecycle', params.lifecycle);
  if (params.source) query.set('source', params.source);
  if (params.starred) query.set('starred', '1');
  if (params.search) query.set('search', params.search);
  if (params.full_text) query.set('full_text', 'true');
  if (params.sort) query.set('sort', params.sort);
  if (params.min_blocks) query.set('min_blocks', String(params.min_blocks));
  if (params.exclude_subagents) query.set('exclude_subagents', 'true');
  const projectIds = [...new Set((params.project_ids ?? []).map((id) => id.trim()).filter(Boolean))].slice(0, 500);
  if (projectIds.length > 0) query.set('project_ids', projectIds.join(','));
  const pinnedIds = [...new Set((params.pinned_ids ?? []).map((id) => id.trim()).filter(Boolean))].slice(0, 500);
  if (params.pinned_ids !== undefined) query.set('pinned_ids', pinnedIds.join(','));
  const limit = Math.min(50, Math.max(1, Math.trunc(Number.isFinite(params.limit) ? params.limit : 5)));
  query.set('limit', String(limit));
  if (params.group_key) query.set('group_key', params.group_key);
  if (params.cursor) query.set('cursor', params.cursor);
  const response = await apiGet(`/api/conversations/sidebar?${query.toString()}`, { signal: params.signal });
  return (await parseMaybeJson(response)) as ConversationSidebarResponse;
}

export type ConversationWindowRequest =
  | { target?: 'initial' | 'latest'; limit?: number; view?: 'display'; signal?: AbortSignal }
  | { block: string; limit?: number; view?: 'display'; signal?: AbortSignal }
  | { turn: string; limit?: number; view?: 'display'; signal?: AbortSignal }
  | { position: number; limit?: number; view?: 'display'; signal?: AbortSignal };

export type ConversationStructure = import('../../src/contracts').ConversationStructure;

export async function getConversationStructure(id: string, signal?: AbortSignal): Promise<ConversationStructure> {
  const resp = await apiGet(`/api/conversations/${encodeURIComponent(id)}/structure`, { signal });
  return (await parseMaybeJson(resp)) as ConversationStructure;
}

export async function getConversationWindow(
  id: string,
  request: ConversationWindowRequest = {},
): Promise<ConversationPositionWindow> {
  const query = new URLSearchParams();
  if ('target' in request && request.target) query.set('target', request.target);
  if ('block' in request) query.set('block', request.block);
  if ('turn' in request) query.set('turn', request.turn);
  if ('position' in request) query.set('position', String(request.position));
  if (request.limit) query.set('limit', String(request.limit));
  if (request.view) query.set('view', request.view);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  const resp = await apiGet(`/api/conversations/${encodeURIComponent(id)}${suffix}`, {
    signal: request.signal,
  });
  return (await parseMaybeJson(resp)) as ConversationPositionWindow;
}

export async function updateConversation(id: string, data: {
  starred?: boolean;
  tags?: string[];
  tags_add?: string[];
  tags_remove?: string[];
  notes?: string | null;
  notes_append?: string;
}): Promise<Conversation> {
  const resp = await apiPatch(`/api/conversations/${encodeURIComponent(id)}`, data);
  invalidateApiGetCache('/api/conversations');
  return (await parseMaybeJson(resp)) as Conversation;
}

export async function updateConversationArchive(id: string, archived: boolean): Promise<void> {
  await apiPatch(`/api/conversations/${encodeURIComponent(id)}`, { archived });
  invalidateApiGetCache('/api/conversations');
}

export async function exportConversationBlocks(id: string, data: {
  block_ids?: string[];
  format: 'mdx' | 'markdown' | 'json';
}): Promise<{ content: string; block_count: number; body_source: 'source' | 'legacy' }> {
  const resp = await apiPost(`/api/conversations/${encodeURIComponent(id)}/export`, data);
  return (await parseMaybeJson(resp)) as { content: string; block_count: number; body_source: 'source' | 'legacy' };
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

export type ConversationControlSnapshot = ContractConversationControlSnapshot;
export type ConversationControlOperation = ContractConversationControlOperation;
export type ConversationRuntimeOptions = ContractConversationRuntimeOptions;
export type ConversationControlError = ContractConversationControlError;
export type AcceptedConversationSubmission = ContractAcceptedConversationSubmission;
export type ProviderAdapterEvent = ContractProviderAdapterEvent;
export type ProviderLiveProjection = ContractProviderLiveProjection;

export type ConversationControlApiError = Error & {
  status: number;
  controlError: ConversationControlError;
  snapshot: ConversationControlSnapshot | null;
};

export async function getConversationControl(conversationId: string): Promise<ConversationControlSnapshot> {
  const response = await apiGet(`/api/conversations/${encodeURIComponent(conversationId)}/control`);
  const result = await parseMaybeJson(response) as
    | { ok: true; value: ConversationControlSnapshot }
    | { ok: false; error: ConversationControlError };
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}

export async function getConversationLiveProjection(conversationId: string): Promise<ProviderLiveProjection> {
  const response = await apiGet(`/api/conversations/${encodeURIComponent(conversationId)}/control/live`);
  const result = await parseMaybeJson(response) as
    | { ok: true; value: ProviderLiveProjection }
    | { ok: false; error: ConversationControlError };
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}

export async function submitConversationControl(
  snapshot: ConversationControlSnapshot,
  message: string,
  messageAnchor?: string,
  runtimeOptions?: ConversationRuntimeOptions,
  idempotencyKey: string = crypto.randomUUID(),
  attachments?: ChatAttachment[],
): Promise<AcceptedConversationSubmission> {
  const capability = snapshot.capability;
  const operation: ConversationControlOperation = capability.kind === 'live-send'
    ? 'send'
    : capability.kind === 'live-steer'
      ? 'steer'
      : capability.kind === 'owned-queue'
        ? 'queue'
        : capability.kind === 'provider-session-resume'
          ? 'resume-provider-session'
          : capability.kind === 'message-anchor-resume'
            ? 'resume-message-anchor'
            : (() => { throw new Error(`Conversation control is ${capability.kind}`); })();
  const path = `/api/conversations/${encodeURIComponent(snapshot.conversation_id)}/control/submit`;
  const response = await browserSessionFetch(path, {
    method: 'POST',
    headers: {
      ...DEFAULT_HEADERS,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      operation,
      expected_revision: capability.revision,
      expected_generation: snapshot.ownership.generation,
      message,
      ...(attachments?.length ? { attachments } : {}),
      ...(operation === 'resume-message-anchor' ? { message_anchor: messageAnchor } : {}),
      ...(runtimeOptions && Object.keys(runtimeOptions).length > 0 ? { runtime_options: runtimeOptions } : {}),
      idempotency_key: idempotencyKey,
    }),
  });
  const payload = await parseMaybeJson(response) as unknown;
  if (!response.ok) {
    const failed = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
    const candidate = failed?.error;
    if (failed?.ok === false && candidate && typeof candidate === 'object'
        && typeof (candidate as { kind?: unknown }).kind === 'string') {
      const error = new Error((candidate as ConversationControlError).kind) as ConversationControlApiError;
      error.status = response.status;
      error.controlError = candidate as ConversationControlError;
      error.snapshot = failed.snapshot && typeof failed.snapshot === 'object'
        ? failed.snapshot as ConversationControlSnapshot
        : null;
      throw error;
    }
    const message = typeof failed?.message === 'string'
      ? failed.message
      : typeof candidate === 'string'
        ? candidate
        : `POST ${path} failed: ${response.status}`;
    const code = typeof failed?.code === 'string'
      ? failed.code
      : typeof candidate === 'string'
        ? candidate
        : null;
    throw new ApiError(message, response.status, code);
  }
  const accepted = payload as
    | { ok: true; value: AcceptedConversationSubmission }
    | { ok: false; error: ConversationControlError };
  if (!accepted.ok) throw new Error(accepted.error.kind);
  return accepted.value;
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
  subsystems: string[];
  events: string[];
  entity_refs: LogEntityFacetValue[];
  latest_ts: string | null;
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
}, read: CachedRead<LogsResponse> = {}): Promise<LogsResponse> {
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
  return cachedApiGetJson<LogsResponse>(`/api/system/logs${qs ? '?' + qs : ''}`, { ...WARMED_ROUTE_GET_OPTIONS, ...read });
}

export type DesktopDaemonLaunchMode = 'on_demand' | 'manual';
export type DesktopDaemonState = 'running' | 'starting' | 'gateway_unavailable' | 'stopped' | 'port_conflict';

export type DesktopDaemonStatus = {
  state: DesktopDaemonState;
  launch_mode: DesktopDaemonLaunchMode;
  port: number;
  pid: number | null;
  pid_file: string;
  log_file: string;
  detail: string | null;
  healthy: boolean;
  dashboard_ready: boolean;
  dashboard_origin: string;
  gateway_state: 'running' | 'starting' | 'stopped';
  gateway_error: string | null;
  gateway_log_file: string;
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
type DesktopWindowTheme = 'light' | 'dark' | null;
type TauriDesktopWindow = { setTheme: (theme: DesktopWindowTheme) => Promise<void> };

type TauriGlobalWindow = Window & {
  __TAURI__?: {
    core?: { invoke?: TauriInvoke };
    window?: { getCurrentWindow?: () => TauriDesktopWindow };
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

export type NativeWindowCapabilities = {
  liquidGlassRegular: boolean;
};

export async function getNativeWindowCapabilities(): Promise<NativeWindowCapabilities> {
  if (!hasTauriRuntime()) {
    return { liquidGlassRegular: false };
  }
  return invokeDesktop<NativeWindowCapabilities>('native_window_capabilities');
}

export async function setDesktopWindowTheme(theme: DesktopWindowTheme): Promise<void> {
  if (!hasTauriRuntime()) {
    return;
  }
  const currentWindow = tauriGlobalWindow()?.__TAURI__?.window?.getCurrentWindow?.();
  if (!currentWindow) {
    throw new Error('The Tauri window API is not available in this desktop runtime.');
  }
  await currentWindow.setTheme(theme);
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

export type SecureLocalConnectionsStatus = {
  state: 'not_set_up' | 'untracked_root' | 'prepared' | 'trusted';
  storage_root: string;
  root_digest: string | null;
  verified_at: string | null;
};

export async function getSecureLocalConnectionsStatus(): Promise<SecureLocalConnectionsStatus> {
  return invokeDesktop<SecureLocalConnectionsStatus>('secure_local_connections_status');
}

export async function setupSecureLocalConnections(): Promise<SecureLocalConnectionsStatus> {
  return invokeDesktop<SecureLocalConnectionsStatus>('secure_local_connections_setup');
}

export async function navigateToDesktopBootstrap(skipAutoStart = false): Promise<void> {
  if (!hasTauriRuntime()) {
    return;
  }
  await invokeDesktop<void>('navigate_to_desktop_bootstrap', { skipAutoStart });
}

export async function navigateToDesktopDashboard(): Promise<void> {
  await invokeDesktop<void>('navigate_to_desktop_dashboard');
}

// ── Conversation types ──

export type BlockType = ContractBlockType;
export type Role = ContractRole;
export type ConversationSource = ContractConversationSource;

export type ConversationBlock = ContractConversationBlock;

export type Conversation = ContractConversation;

export type ConversationChild = ContractConversationChild;
export type ConversationParent = ContractConversationParent;
export type ConversationPositionTarget = ContractConversationPositionTarget;
export type ConversationPositionTargetKind = ContractConversationPositionTargetKind;
export type ConversationPositionWindow = ContractConversationPositionWindow;
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
  mode?: GraphMode;
  repo?: string;
  branch?: string;
  since?: string;
  limit?: number;
  status?: 'open' | 'all';
  nodeTypes?: string[];
  edgeTypes?: string[];
};

export type { GraphNode, GraphEdge };

export async function getGraph(
  params: GraphQueryParams = {},
): Promise<GraphPayload> {
  const query = new URLSearchParams();
  if (params.mode) query.set('mode', params.mode);
  if (params.repo) query.set('repo', params.repo);
  if (params.branch) query.set('branch', params.branch);
  if (params.since) query.set('since', params.since);
  if (params.limit != null) query.set('limit', String(params.limit));
  if (params.status) query.set('status', params.status);
  if (params.nodeTypes?.length) query.set('node_type', params.nodeTypes.join(','));
  if (params.edgeTypes?.length) query.set('edge_type', params.edgeTypes.join(','));
  const qs = query.toString();
  return cachedApiGetJson<GraphPayload>(`/api/graph${qs ? '?' + qs : ''}`, WARMED_ROUTE_GET_OPTIONS);
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

export type ArtifactBriefingCandidate = {
  briefing_id: string;
  title: string;
  archived_at: number | null;
  latest_round_id: string | null;
  matching_round_id: string | null;
  guidance: 'reuse_round' | 'add_round';
};

export type CreateBriefingFromArtifactVersionResult = {
  outcome: 'created' | 'created_distinct' | 'round_added' | 'round_reused';
  receipt_id: string;
  briefing_id: string;
  run_id: string;
  round_id: string;
  artifact_version_id: string;
  quiet: false;
  logical_artifact_id: string;
  active_candidates: ArtifactBriefingCandidate[];
  archived_candidates: ArtifactBriefingCandidate[];
  override_receipt_id: string | null;
} | {
  outcome: 'active_candidates';
  logical_artifact_id: string;
  active_candidates: ArtifactBriefingCandidate[];
  archived_candidates: ArtifactBriefingCandidate[];
};

export async function createBriefingFromArtifactVersion(input: {
  artifact_version_ref: string;
  comparison_base_artifact_version_ref?: string;
  title: string;
}): Promise<CreateBriefingFromArtifactVersionResult> {
  const response = await browserSessionFetch('/api/briefings', {
    method: 'POST',
    headers: { ...DEFAULT_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const payload = await parseMaybeJson(response) as CreateBriefingFromArtifactVersionResult & {
    error?: string;
    code?: string;
  };
  if (response.status === 409 && payload.code === 'briefing_active_candidates') return payload;
  if (!response.ok) {
    throw new ApiError(payload.error ?? `POST /api/briefings failed: ${response.status}`, response.status);
  }
  return payload;
}

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
  const payload = await cachedApiGetJson<{ artifacts?: ArtifactRecord[] }>(`/api/artifacts${query}`, WARMED_ROUTE_GET_OPTIONS);
  return payload.artifacts ?? [];
}

export async function getArtifactSeriesList(
  params: ArtifactQueryParams = {},
  read: CachedRead<ArtifactSeriesSummary[]> = {},
): Promise<ArtifactSeriesSummary[]> {
  const { onCached } = read;
  const payload = await cachedApiGetJson<{ series?: ArtifactSeriesSummary[] }>(`/api/artifacts/series${buildQuery(params)}`, {
    ...WARMED_ROUTE_GET_OPTIONS,
    signal: read.signal,
    onCached: onCached && ((cached) => onCached(cached.series ?? [])),
  });
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
  const payload = await cachedApiGetJson<{ groups?: ContractSpaceGroup[] }>('/api/spaces', WARMED_ROUTE_GET_OPTIONS);
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

export type CanonicalProjectCheckout = {
  id: string;
  project_id: string;
  work_repo_id: string | null;
  root: string;
  name: string;
  default_branch: string;
  remote_url: string;
};

export type CanonicalProject = ProjectPickerItem & {
  checkouts: CanonicalProjectCheckout[];
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
  return listCanonicalProjects();
}

/** Canonical registry identity and checkouts for Chat project headings and scoped actions. */
type ProjectsPayload = {
  projects?: Array<{
    id: string;
    project_key: string;
    display_name?: string | null;
    checkouts?: CanonicalProjectCheckout[];
  }>;
};

function canonicalProjects(payload: ProjectsPayload): CanonicalProject[] {
  return (payload.projects ?? []).map((project) => ({
    id: project.id,
    project_key: project.project_key,
    display_name: project.display_name ?? null,
    checkouts: project.checkouts ?? [],
  }));
}

export async function listCanonicalProjects(read: WarmableRead<CanonicalProject[]> = {}): Promise<CanonicalProject[]> {
  const { onCached } = read;
  return canonicalProjects(await readWarmable<ProjectsPayload>('/api/projects', {
    ...read,
    onCached: onCached && ((cached) => onCached(canonicalProjects(cached))),
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
  const response = await browserSessionFetch(`/api/projects/${encodeURIComponent(projectRef)}/access`, {
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
  }>(`/api/spaces/${encodeURIComponent(spaceId)}`, WARMED_ROUTE_GET_OPTIONS);
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

export type SpacePublication = import('../../src/spaces/publication').SpacePublication;
export type SpaceDocumentHistory = { id: string; kind: string; content: string | null; blocks_json: string | null; artifact_ref: string | null; provenance_json: string };
export async function getSpacePublications(spaceId: string,signal?:AbortSignal): Promise<{ publications: SpacePublication[]; history: SpaceDocumentHistory[]; destinations:import('../../src/spaces/publication').PublicationDestination[] }> {
  const result = await parseMaybeJson(await apiGet(`/api/spaces/${encodeURIComponent(spaceId)}/publications`,{signal})) as { publications: SpacePublication[]; history: SpaceDocumentHistory[]; destinations:import('../../src/spaces/publication').PublicationDestination[] };
  if (!result || !Array.isArray(result.publications) || !Array.isArray(result.history) || !Array.isArray(result.destinations)) throw new Error('The Spaces service returned invalid publication history.');
  return result;
}
export async function prepareSpacePublication(spaceId: string, body: { path: string; repo_id?: string; issue: string; message?: string }): Promise<SpacePublication> {
  return await parseMaybeJson(await apiPost(`/api/spaces/${encodeURIComponent(spaceId)}/publications`,body)) as SpacePublication;
}
export async function submitSpacePublication(spaceId: string,id: string): Promise<SpacePublication> {
  return await parseMaybeJson(await apiPost(`/api/spaces/${encodeURIComponent(spaceId)}/publications/${encodeURIComponent(id)}/submit`,{})) as SpacePublication;
}
export async function importSpaceDocument(body: { title: string; project_id?: string } & ({ ref: string } | { project: string; commit: string; path: string })): Promise<ContractSpace> {
  return await parseMaybeJson(await apiPost('/api/spaces/documents/import',body)) as ContractSpace;
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

function briefingDocumentProfile(value: unknown): BriefingDocumentProfile | null {
  return BRIEFING_DOCUMENT_PROFILES.find((candidate) => candidate === value) ?? null;
}

function briefingDirectiveBindingStatus(value: unknown): BriefingDirectiveBindingStatus | null {
  return BRIEFING_DIRECTIVE_BINDING_STATUSES.find((candidate) => candidate === value) ?? null;
}

function briefingSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

type BriefingSpan = {
  start_offset: number;
  end_offset: number;
  body_start_offset: number;
  body_end_offset: number;
};

/** Directive spans and text-variant spans share one nesting invariant. */
function briefingSpan(value: Record<string, unknown>): BriefingSpan | null {
  const start = value.start_offset;
  const end = value.end_offset;
  const bodyStart = value.body_start_offset;
  const bodyEnd = value.body_end_offset;
  if (!briefingSafeInteger(start) || !briefingSafeInteger(end)
      || !briefingSafeInteger(bodyStart) || !briefingSafeInteger(bodyEnd)) return null;
  if (start < 0 || start >= bodyStart || bodyStart >= bodyEnd || bodyEnd > end) return null;
  return { start_offset: start, end_offset: end, body_start_offset: bodyStart, body_end_offset: bodyEnd };
}

function briefingStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string');
  }
  return [];
}

// --- immutable Briefing rounds ----------------------------------------------

export type BriefingResponseType = 'verdict' | 'single_choice' | 'multi_choice' | 'short_text' | 'long_text' | 'rating' | 'text_variant';
export type BriefingResponseValue =
  | { verdict: 'keep' | 'dismiss' }
  | { text: string }
  | { option_key: string }
  | { option_keys: string[] }
  | { rating: number };

export type BriefingDirectiveOption = {
  key: string;
  label: string;
};

export type BriefingTextVariant = {
  key: string;
  label: string;
  body: string;
  start_offset: number;
  end_offset: number;
  body_start_offset: number;
  body_end_offset: number;
};

export type BriefingDirectiveItem = {
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
    response_type: BriefingResponseType | null;
    required: boolean;
    position: number;
    options: BriefingDirectiveOption[];
    variants?: BriefingTextVariant[];
  };
  effective_response: null | { response_event_id: string; value: BriefingResponseValue };
  responseVisible: boolean;
  directive?: {
    key: string;
    definition_digest: string;
    start_offset: number;
    end_offset: number;
    body_start_offset: number;
    body_end_offset: number;
  };
};

export const BRIEFING_DOCUMENT_PROFILES = ['mandible-briefing.v2', 'mandible-briefing.v3'] as const;
export type BriefingDocumentProfile = (typeof BRIEFING_DOCUMENT_PROFILES)[number];

export const BRIEFING_DIRECTIVE_BINDING_STATUSES = ['valid', 'invalid', 'unavailable'] as const;
export type BriefingDirectiveBindingStatus = (typeof BRIEFING_DIRECTIVE_BINDING_STATUSES)[number];

export type BriefingRoundProjection = {
  round_id: string;
  state: 'open' | 'submitted';
  briefing_key: string;
  binding_digest: string;
  created_at: number;
  latest_submission_for_actor: null | { id: string; ordinal: number };
  document: null | {
    artifact_version_id: string;
    content_hash: string;
    previous_round_id: string | null;
    profile: BriefingDocumentProfile;
    source: string;
    comparison_base?: null | {
      artifact_version_id: string;
      content_hash: string;
      source: string;
    };
    original_comparison_base?: null | {
      artifact_version_id: string;
      content_hash: string;
      source: string;
    };
  };
  directive_binding: null | { status: BriefingDirectiveBindingStatus; reason?: string };
  latest_frozen_membership?: null | { answer_event_ids: string[]; annotation_event_ids: string[] };
  annotations?: BriefingAnnotation[];
  submission_overlays?: BriefingSubmissionOverlaySummary[];
  selected_submission_overlay?: BriefingSubmissionOverlaySummary | null;
  items: BriefingDirectiveItem[];
  valid: boolean;
};

export type BriefingSubmissionOverlaySummary = {
  id: string;
  ordinal: number;
  supersedes_submission_id: string | null;
  actor_user_id: string;
  actor: { slug: string; display_name: string | null };
  created_at: number;
  answer_count: number;
  annotation_count: number;
};

export type BriefingRoundSummary = {
  id: string;
  ordinal: number;
  artifact_version_id: string;
  created_at: number;
  origin: null | { source: string | null; run_id: string | null; task_identity: string | null };
};

export type BriefingProjection = BriefingRoundProjection & {
  briefing_id: string;
  title: string;
  description: string | null;
  publication_mode: 'reviewed-document' | 'published-report' | null;
  latest_round_id: string;
  selected_round_id: string;
  rounds: BriefingRoundSummary[];
  submission_overlays: BriefingSubmissionOverlaySummary[];
  selected_submission_overlay: BriefingSubmissionOverlaySummary | null;
};

export type ClientAuthWhoami = {
  authenticated: boolean;
  user: null | { id: string; slug: string; kind: string | null; display_name: string | null };
};

export type BriefingAnswerOperation = {
  directive_key: string;
  operation: 'set' | 'retract';
  expected_response_event_id: string | null;
  value?: BriefingResponseValue;
};

export type BriefingSubmissionAnswer = {
  directive_key: string;
  response_event_id: string;
};

export type BriefingAnnotation = {
  annotation_event_id: string;
  annotation_kind: 'comment' | 'suggest_replacement';
  start_offset: number;
  end_offset: number;
  quote: string;
  body: string | null;
  replacement_text: string | null;
  created_at: number;
  presentation?: {
    source: 'current_draft' | 'annotation_set';
    actor: { slug: string; display_name: string | null } | null;
  };
};

export type BriefingAnnotationOperation =
  | {
    operation: 'set';
    annotation_kind: 'comment';
    start_offset: number;
    end_offset: number;
    quote: string;
    body: string;
  }
  | {
    operation: 'set';
    annotation_kind: 'suggest_replacement';
    start_offset: number;
    end_offset: number;
    quote: string;
    replacement_text: string;
    body?: string;
  }
  | { operation: 'retract'; annotation_event_id: string };

const BRIEFING_ROUND_STATES = new Set(['open', 'submitted']);
const BRIEFING_RESPONSE_TYPES = new Set<BriefingResponseType>([
  'verdict', 'single_choice', 'multi_choice', 'short_text', 'long_text', 'rating', 'text_variant',
]);

function exactBriefingValueKeys(row: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(row).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length
    && keys.every((key, index) => key === sortedExpected[index]);
}

function briefingResponseValue(
  value: unknown,
  responseType: BriefingResponseType,
  optionKeys: readonly string[],
): BriefingResponseValue | null {
  const row = briefingRecord(value);
  if (responseType === 'verdict') {
    return exactBriefingValueKeys(row, ['verdict']) && (row.verdict === 'keep' || row.verdict === 'dismiss')
      ? { verdict: row.verdict }
      : null;
  }
  if (responseType === 'short_text' || responseType === 'long_text') {
    const maximum = responseType === 'short_text' ? 240 : 4000;
    return exactBriefingValueKeys(row, ['text'])
      && typeof row.text === 'string'
      && Boolean(row.text.trim())
      && row.text.length <= maximum
      ? { text: row.text }
      : null;
  }
  if (responseType === 'rating') {
    return exactBriefingValueKeys(row, ['rating'])
      && Number.isSafeInteger(row.rating)
      && (row.rating as number) >= 1
      && (row.rating as number) <= 5
      ? { rating: row.rating as number }
      : null;
  }
  const allowed = new Set(optionKeys);
  if (responseType === 'single_choice' || responseType === 'text_variant') {
    return exactBriefingValueKeys(row, ['option_key'])
      && typeof row.option_key === 'string'
      && allowed.has(row.option_key)
      ? { option_key: row.option_key }
      : null;
  }
  if (!exactBriefingValueKeys(row, ['option_keys'])
      || !Array.isArray(row.option_keys)
      || row.option_keys.some((key) => typeof key !== 'string')
      || row.option_keys.some((key) => !allowed.has(key as string))
      || new Set(row.option_keys).size !== row.option_keys.length) return null;
  const selected = new Set(row.option_keys as string[]);
  const canonical = optionKeys.filter((key) => selected.has(key));
  return canonical.length > 0 ? { option_keys: canonical } : null;
}

function briefingAnnotation(value: unknown): BriefingAnnotation | null {
  const row = briefingRecord(value);
  const annotationKind = row.annotation_kind;
  const start = row.start_offset;
  const end = row.end_offset;
  const body = row.body;
  const replacement = row.replacement_text;
  if (!briefingString(row.annotation_event_id)
      || (annotationKind !== 'comment' && annotationKind !== 'suggest_replacement')
      || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || (start as number) < 0 || (end as number) <= (start as number)
      || typeof row.quote !== 'string' || row.quote.length === 0
      || (body !== null && typeof body !== 'string')
      || (replacement !== null && typeof replacement !== 'string')
      || !Number.isSafeInteger(row.created_at)
      || (annotationKind === 'comment' && (typeof body !== 'string' || !body.trim() || replacement !== null))
      || (annotationKind === 'suggest_replacement' && typeof replacement !== 'string')) return null;
  const annotation: BriefingAnnotation = {
    annotation_event_id: briefingString(row.annotation_event_id),
    annotation_kind: annotationKind,
    start_offset: start as number,
    end_offset: end as number,
    quote: row.quote,
    body: body as string | null,
    replacement_text: replacement as string | null,
    created_at: row.created_at as number,
  };
  const presentation = briefingRecord(row.presentation);
  if (presentation.source === 'current_draft' || presentation.source === 'annotation_set') {
    const actor = briefingRecord(presentation.actor);
    annotation.presentation = {
      source: presentation.source,
      actor: briefingString(actor.slug) ? {
        slug: briefingString(actor.slug),
        display_name: briefingOptionalString(actor.display_name),
      } : null,
    };
  }
  return annotation;
}

export function normalizeBriefingRoundProjection(payload: unknown): BriefingRoundProjection {
  const root = briefingRecord(payload);
  let valid = true;
  const roundId = briefingString(root.round_id);
  const rawState = briefingString(root.state);
  if (!roundId || !BRIEFING_ROUND_STATES.has(rawState)) valid = false;
  const rawItems = Array.isArray(root.items) ? root.items : [];
  if (!Array.isArray(root.items)) valid = false;
  const items = rawItems.map((entry): BriefingDirectiveItem | null => {
    const row = briefingRecord(entry);
    const revision = briefingRecord(row.revision);
    const id = briefingString(row.id);
    const revisionId = briefingString(revision.id);
    const itemKind = row.item_kind;
    const rawType = revision.response_type;
    const responseType = typeof rawType === 'string' && BRIEFING_RESPONSE_TYPES.has(rawType as BriefingResponseType)
      ? rawType as BriefingResponseType
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
      if (!exactBriefingValueKeys(value, ['key', 'label'])) valid = false;
      return {
        key: briefingString(value.key),
        label: briefingString(value.label),
      };
    }).filter((option) => {
      if (!option.key || !option.label) valid = false;
      return Boolean(option.key && option.label);
    });
    if (responseType === 'text_variant' && !Array.isArray(revision.variants)) valid = false;
    const variants = (Array.isArray(revision.variants) ? revision.variants : []).map((variant): BriefingTextVariant | null => {
      const value = briefingRecord(variant);
      if (!exactBriefingValueKeys(value, ['key', 'label', 'body', 'start_offset', 'end_offset', 'body_start_offset', 'body_end_offset'])) valid = false;
      const key = briefingString(value.key);
      const label = briefingString(value.label);
      const body = briefingString(value.body);
      const span = briefingSpan(value);
      if (!key || !label || !body || !span) {
        valid = false;
        return null;
      }
      return { key, label, body, ...span };
    }).filter((variant): variant is BriefingTextVariant => variant !== null);
    const choice = responseType === 'single_choice' || responseType === 'multi_choice';
    const textVariant = responseType === 'text_variant';
    if (itemKind === 'group' && (revision.required === true || options.length > 0 || variants.length > 0)) valid = false;
    if (itemKind === 'item' && ((choice && options.length === 0) || (!choice && options.length > 0)
        || (textVariant ? variants.length < 2 || variants.length > 12 : variants.length > 0))) valid = false;
    const hasEffective = Object.prototype.hasOwnProperty.call(row, 'effective_response');
    const effective = briefingRecord(row.effective_response);
    const effectiveValue = responseType && hasEffective && row.effective_response !== null
      ? briefingResponseValue(effective.value, responseType, textVariant
        ? variants.map((variant) => variant.key)
        : options.map((option) => option.key))
      : null;
    if (hasEffective && row.effective_response !== null
        && (!briefingString(effective.response_event_id) || !effectiveValue)) valid = false;
    const rawDirective = briefingRecord(row.directive);
    let directive: BriefingDirectiveItem['directive'];
    if (Object.prototype.hasOwnProperty.call(row, 'directive')) {
      const key = briefingString(rawDirective.key);
      const definitionDigest = briefingString(rawDirective.definition_digest);
      const span = briefingSpan(rawDirective);
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(key) || !/^[0-9a-f]{64}$/.test(definitionDigest) || !span) valid = false;
      else directive = { key, definition_digest: definitionDigest, ...span };
    }
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
        variants,
      },
      effective_response: effectiveValue
        ? { response_event_id: briefingString(effective.response_event_id), value: effectiveValue }
        : null,
      responseVisible: hasEffective,
      ...(directive ? { directive } : {}),
    };
  }).filter((item): item is BriefingDirectiveItem => item !== null)
    .sort((left, right) => left.revision.position - right.revision.position || left.id.localeCompare(right.id));
  const itemIds = new Set<string>();
  for (const item of items) {
    if (itemIds.has(item.id)) valid = false;
    itemIds.add(item.id);
  }
  const itemById = new Map(items.map((item) => [item.id, item]));
  for (const item of items) {
    if (item.parent_item_id && itemById.get(item.parent_item_id)?.item_kind !== 'group') valid = false;
    if (new Set(item.revision.options.map((option) => option.key)).size !== item.revision.options.length) valid = false;
    const variantKeys = (item.revision.variants ?? []).map((variant) => variant.key);
    if (new Set(variantKeys).size !== variantKeys.length) valid = false;
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
  const actorLatest = briefingRecord(root.latest_submission_for_actor);
  const latestSubmissionForActor = root.latest_submission_for_actor == null ? null : {
    id: briefingString(actorLatest.id),
    ordinal: briefingOptionalNumber(actorLatest.ordinal) ?? 0,
  };
  if (latestSubmissionForActor !== null
      && (!latestSubmissionForActor.id || latestSubmissionForActor.ordinal < 1)) valid = false;
  const rawDocument = briefingRecord(root.document);
  const profile = briefingDocumentProfile(rawDocument.profile);
  const documentShapeValid = [
    ['artifact_version_id', 'content_hash', 'previous_round_id', 'profile', 'source', 'comparison_base', 'original_comparison_base'],
    ['artifact_version_id', 'content_hash', 'previous_round_id', 'profile', 'source', 'comparison_base'],
    ['artifact_version_id', 'content_hash', 'previous_round_id', 'profile', 'source'],
  ].some((keys) => exactBriefingValueKeys(rawDocument, keys));
  const rawComparisonBase = briefingRecord(rawDocument.comparison_base);
  const comparisonBase = rawDocument.comparison_base == null ? null
    : exactBriefingValueKeys(rawComparisonBase, ['artifact_version_id', 'content_hash', 'source'])
      && briefingString(rawComparisonBase.artifact_version_id)
      && /^[0-9a-f]{64}$/.test(briefingString(rawComparisonBase.content_hash))
      && typeof rawComparisonBase.source === 'string'
      ? {
        artifact_version_id: briefingString(rawComparisonBase.artifact_version_id),
        content_hash: briefingString(rawComparisonBase.content_hash),
        source: rawComparisonBase.source,
      }
      : undefined;
  const rawOriginalComparisonBase = briefingRecord(rawDocument.original_comparison_base);
  const originalComparisonBase = rawDocument.original_comparison_base == null ? null
    : exactBriefingValueKeys(rawOriginalComparisonBase, ['artifact_version_id', 'content_hash', 'source'])
      && briefingString(rawOriginalComparisonBase.artifact_version_id)
      && /^[0-9a-f]{64}$/.test(briefingString(rawOriginalComparisonBase.content_hash))
      && typeof rawOriginalComparisonBase.source === 'string'
      ? {
        artifact_version_id: briefingString(rawOriginalComparisonBase.artifact_version_id),
        content_hash: briefingString(rawOriginalComparisonBase.content_hash),
        source: rawOriginalComparisonBase.source,
      }
      : undefined;
  const documentFieldsValid = briefingString(rawDocument.artifact_version_id)
    && /^[0-9a-f]{64}$/.test(briefingString(rawDocument.content_hash))
    && typeof rawDocument.source === 'string'
    && Boolean(rawDocument.source.trim())
    && comparisonBase !== undefined
    && originalComparisonBase !== undefined
    && (rawDocument.previous_round_id === null || typeof rawDocument.previous_round_id === 'string');
  const document = root.document !== null && documentShapeValid && documentFieldsValid && profile !== null ? {
    artifact_version_id: briefingString(rawDocument.artifact_version_id),
    content_hash: briefingString(rawDocument.content_hash),
    previous_round_id: briefingOptionalString(rawDocument.previous_round_id),
    profile,
    source: typeof rawDocument.source === 'string' ? rawDocument.source : '',
    comparison_base: comparisonBase,
    original_comparison_base: originalComparisonBase,
  } : null;
  if (!document
      || !document.artifact_version_id) valid = false;
  const bindingRow = briefingRecord(root.directive_binding);
  const bindingStatus = briefingDirectiveBindingStatus(bindingRow.status);
  const directiveBinding = root.directive_binding === null ? null : Object.prototype.hasOwnProperty.call(root, 'directive_binding')
    && bindingStatus !== null
    && (bindingRow.reason === undefined || typeof bindingRow.reason === 'string')
    ? { status: bindingStatus, ...(typeof bindingRow.reason === 'string' ? { reason: bindingRow.reason } : {}) }
    : undefined;
  if (Object.prototype.hasOwnProperty.call(root, 'directive_binding') && directiveBinding === undefined) valid = false;
  const frozenRow = briefingRecord(root.latest_frozen_membership);
  const latestFrozenMembership = root.latest_frozen_membership === null ? null : Object.prototype.hasOwnProperty.call(root, 'latest_frozen_membership')
    && Array.isArray(frozenRow.answer_event_ids) && Array.isArray(frozenRow.annotation_event_ids)
    && frozenRow.answer_event_ids.every((id) => briefingString(id))
    && frozenRow.annotation_event_ids.every((id) => briefingString(id))
    ? { answer_event_ids: briefingStringArray(frozenRow.answer_event_ids), annotation_event_ids: briefingStringArray(frozenRow.annotation_event_ids) }
    : undefined;
  if (Object.prototype.hasOwnProperty.call(root, 'latest_frozen_membership') && latestFrozenMembership === undefined) valid = false;
  if (document) {
    if (!directiveBinding) valid = false;
    const keys = new Set<string>();
    let previousEnd = -1;
    const sortedDirectives = items.map((item) => item.directive).filter((directive): directive is NonNullable<BriefingDirectiveItem['directive']> => Boolean(directive))
      .sort((left, right) => left.start_offset - right.start_offset);
    for (const directive of sortedDirectives) {
      if (directive.start_offset < previousEnd) valid = false;
      previousEnd = directive.end_offset;
    }
    for (const item of items) {
      const directive = item.directive;
      const choice = item.revision.response_type === 'single_choice' || item.revision.response_type === 'multi_choice';
      const textVariant = item.revision.response_type === 'text_variant';
      if (item.item_kind !== 'item' || !item.revision.response_type || (choice ? item.revision.options.length < 2 || item.revision.options.length > 12 : item.revision.options.length !== 0)
          || (textVariant ? (item.revision.variants?.length ?? 0) < 2 || (item.revision.variants?.length ?? 0) > 12 : (item.revision.variants?.length ?? 0) !== 0)
          || !item.client_item_key || !directive || directive.key !== item.client_item_key || keys.has(directive.key)) valid = false;
      if (directive) keys.add(directive.key);
    }
    if (items.length === 0 && document.profile !== 'mandible-briefing.v3') valid = false;
  }
  let annotations: BriefingAnnotation[] | undefined;
  if (Object.prototype.hasOwnProperty.call(root, 'annotations')) {
    if (!Array.isArray(root.annotations)) valid = false;
    annotations = (Array.isArray(root.annotations) ? root.annotations : []).map((entry) => {
      const parsed = briefingAnnotation(entry);
      if (!parsed) valid = false;
      return parsed;
    }).filter((entry): entry is BriefingAnnotation => entry !== null);
  }
  if ((rawState === 'open' && latestSubmissionForActor !== null)
      || (rawState === 'submitted' && latestSubmissionForActor === null)) valid = false;
  return {
    round_id: roundId,
    state: BRIEFING_ROUND_STATES.has(rawState) ? rawState as BriefingRoundProjection['state'] : 'open',
    briefing_key: briefingString(root.briefing_key),
    binding_digest: briefingString(root.binding_digest),
    created_at: briefingOptionalNumber(root.created_at) ?? 0,
    latest_submission_for_actor: latestSubmissionForActor,
    document,
    directive_binding: directiveBinding ?? null,
    ...(latestFrozenMembership !== undefined ? { latest_frozen_membership: latestFrozenMembership } : {}),
    ...(annotations ? { annotations } : {}),
    items,
    valid,
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

function briefingOptionalRows(value: unknown, key: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`The Briefing service returned an invalid ${key} collection.`);
  return value;
}

function briefingRows(payload: unknown, key: string): unknown[] {
  const rows = briefingRecord(payload)[key];
  if (!Array.isArray(rows)) throw new Error(`The Briefing service returned an invalid ${key} collection.`);
  return rows;
}

/** A row the Briefing service returned that the view cannot show, kept so the view can report it. */
export type InvalidBriefingRow = { id: string | null; title: string | null; reason: string };

export type BriefingList = { briefings: FeedbackCollection[]; invalid: InvalidBriefingRow[] };

function normalizeBriefingRow(entry: unknown): { briefing: FeedbackCollection } | { invalid: InvalidBriefingRow } {
  const row = briefingRecord(entry);
  const id = briefingString(row.id);
  const latestRoundId = briefingString(row.latest_round_id);
  if (!id || !latestRoundId) {
    return { invalid: {
      id: id || null,
      title: briefingOptionalString(row.title),
      reason: id ? 'it has no round' : 'it has no id',
    } };
  }
  const publicationMode: FeedbackCollection['publicationMode'] =
    row.publication_mode === 'reviewed-document' || row.publication_mode === 'published-report'
      ? row.publication_mode : null;
  return { briefing: {
    id: feedbackCollectionIdentity(id),
    collectionId: id,
    label: briefingString(row.title, `Briefing ${id.slice(0, 8)}`),
    description: briefingOptionalString(row.description),
    publicationMode,
    unansweredDirectiveCount: briefingOptionalNumber(row.unanswered_directive_count) ?? 0,
    latestRoundId,
    createdAt: briefingOptionalNumber(row.created_at) ?? 0,
    updatedAt: briefingOptionalNumber(row.updated_at) ?? 0,
  } };
}

/** Keep the valid rows and report each invalid one, so one bad row never hides the others. */
export function normalizeBriefings(payload: unknown): BriefingList {
  const list: BriefingList = { briefings: [], invalid: [] };
  for (const entry of briefingRows(payload, 'briefings')) {
    const normalized = normalizeBriefingRow(entry);
    if ('briefing' in normalized) list.briefings.push(normalized.briefing);
    else list.invalid.push(normalized.invalid);
  }
  return list;
}

/** Normalize one embedded Briefing, recording it in `invalid` when the view cannot show it. */
function normalizeMemberBriefing(entry: unknown, invalid: InvalidBriefingRow[]): FeedbackCollection | null {
  const normalized = normalizeBriefingRow(entry);
  if ('briefing' in normalized) return normalized.briefing;
  invalid.push(normalized.invalid);
  return null;
}

const BRIEFINGS_PATH = '/api/briefings';
const BRIEFING_BUNDLES_PATH = '/api/briefing-bundles';
const BRIEFING_GROUPS_PATH = '/api/briefing-groups';

export type BriefingBundleLayoutEntry =
  | { kind: 'briefing'; briefing: FeedbackCollection }
  | { kind: 'subgroup'; name: string; briefings: FeedbackCollection[] };

export type BriefingBundle = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  members: Array<{ position: number; briefing: FeedbackCollection }>;
  layout: BriefingBundleLayoutEntry[];
};

export type BriefingGroup = {
  id: string;
  key: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number | null;
  current: BriefingBundle | null;
  updates: BriefingBundle[];
  destinations: Array<{ logicalArtifactId: string; publicationMode: 'reviewed-document' | 'published-report' | null;
    routeKeys: string[] }>;
  destinationHistory: Array<{ id: string; logicalArtifactId: string; priorGroupId: string | null;
    resultingGroupId: string; actorUserId: string; createdAt: number }>;
  reviewCandidates?: BriefingGroupReviewCandidate[];
  history?: BriefingGroupDisposition[];
};

export type BriefingGroupReviewItem = {
  position: number;
  layoutPosition: number;
  subgroupPosition: number;
  proposalBriefingId: string;
  proposalRoundId: string;
  proposalArtifactVersionId: string;
  proposalContentHash: string;
  baseBriefingId: string | null;
  baseRoundId: string | null;
  baseArtifactVersionId: string | null;
  baseContentHash: string | null;
  changed: boolean;
  submissionId: string | null;
};

export type BriefingGroupReviewCandidate = {
  proposalBundleId: string;
  expectedBaseBundleId: string | null;
  compositionRunId: string | null;
  bindingDigest: string | null;
  ready: boolean;
  blockerCode: string | null;
  blockerMessage: string | null;
  layoutChanged: boolean;
  destinationChanges: Array<{
    logicalArtifactId: string;
    expectedGroupId: string | null;
    resultingGroupId: string;
  }>;
  items: BriefingGroupReviewItem[];
};

export type BriefingGroupDisposition = {
  id: string;
  kind: 'promoted' | 'dismissed' | 'accepted' | 'rejected';
  priorBase: BriefingBundle | null;
  proposal: BriefingBundle;
  resultingBase: BriefingBundle | null;
  authRequestId: string | null;
  mergeHeadSha: string | null;
  reviewBindingDigest?: string | null;
  compositionRunId?: string | null;
  reviewItems?: BriefingGroupReviewItem[];
  actorUserId?: string | null;
  createdAt: number;
};

export type BriefingSidebarSnapshot = {
  briefings: FeedbackCollection[];
  bundles: BriefingBundle[];
  groups: BriefingGroup[];
  /** Rows from any of the three listings that the view cannot show, one entry per distinct row. */
  invalidBriefings: InvalidBriefingRow[];
};

function normalizeBriefingBundle(entry: unknown, invalid: InvalidBriefingRow[]): BriefingBundle | null {
  const bundle = briefingRecord(entry);
  const id = briefingString(bundle.id);
  const memberRows = briefingOptionalRows(bundle.members, 'members');
  const members = memberRows.map((memberEntry) => {
    const member = briefingRecord(memberEntry);
    const normalized = normalizeMemberBriefing(member.briefing, invalid);
    const position = briefingOptionalNumber(member.position);
    return normalized && position !== null && position >= 0 ? { position, briefing: normalized } : null;
  }).filter((member): member is { position: number; briefing: FeedbackCollection } => member !== null)
    .sort((left, right) => left.position - right.position);
  const layoutRows = briefingOptionalRows(bundle.layout, 'layout');
  const layout = layoutRows.map((layoutEntry): BriefingBundleLayoutEntry | null => {
    const row = briefingRecord(layoutEntry);
    if (row.kind === 'briefing') {
      const briefing = normalizeMemberBriefing(row.briefing, invalid);
      return briefing ? { kind: 'briefing', briefing } : null;
    }
    if (row.kind === 'subgroup') {
      const name = briefingString(row.name);
      const briefings = (briefingOptionalRows(row.briefings, 'subgroup briefings'))
        .map((entry) => {
          const member = briefingRecord(entry);
          return normalizeMemberBriefing(member.briefing ?? entry, invalid);
        })
        .filter((briefing): briefing is FeedbackCollection => Boolean(briefing));
      return name ? { kind: 'subgroup', name, briefings } : null;
    }
    return null;
  }).filter((layoutEntry): layoutEntry is BriefingBundleLayoutEntry => layoutEntry !== null);
  const canonicalLayout = layout.length > 0
    ? layout
    : members.map((member): BriefingBundleLayoutEntry => ({ kind: 'briefing', briefing: member.briefing }));
  const canonicalMembers = canonicalLayout.flatMap((layoutEntry) => layoutEntry.kind === 'briefing'
    ? [layoutEntry.briefing]
    : layoutEntry.briefings)
    .map((briefing, position) => ({ position, briefing }));
  return id && briefingString(bundle.name) ? {
    id,
    name: briefingString(bundle.name),
    createdAt: briefingOptionalNumber(bundle.created_at) ?? 0,
    updatedAt: briefingOptionalNumber(bundle.updated_at) ?? 0,
    members: canonicalMembers,
    layout: canonicalLayout,
  } : null;
}

export function normalizeBriefingBundles(payload: unknown, invalid: InvalidBriefingRow[]): BriefingBundle[] {
  const rows = briefingRows(payload, 'bundles');
  return rows.map((entry) => normalizeBriefingBundle(entry, invalid)).filter((bundle): bundle is BriefingBundle => {
    if (!bundle) throw new Error('The Briefing service returned an invalid bundle.');
    return true;
  });
}

export function normalizeBriefingGroups(payload: unknown, invalid: InvalidBriefingRow[]): BriefingGroup[] {
  const rows = briefingRows(payload, 'groups');
  return rows.map((entry): BriefingGroup | null => {
    const group = briefingRecord(entry);
    const id = briefingString(group.id);
    const key = briefingString(group.key);
    const name = briefingString(group.name);
    const current = group.current == null ? null : normalizeBriefingBundle(group.current, invalid);
    const updates = (briefingOptionalRows(group.updates, 'updates'))
      .map((bundle) => normalizeBriefingBundle(bundle, invalid))
      .filter((update): update is BriefingBundle => update !== null);
    const parseReviewItem = (entry: unknown): BriefingGroupReviewItem | null => {
      const row = briefingRecord(entry);
      const position = briefingOptionalNumber(row.position);
      const layoutPosition = briefingOptionalNumber(row.layout_position);
      const subgroupPosition = briefingOptionalNumber(row.subgroup_position);
      const proposalBriefingId = briefingString(row.proposal_briefing_id);
      const proposalRoundId = briefingString(row.proposal_round_id);
      const proposalArtifactVersionId = briefingString(row.proposal_artifact_version_id);
      const proposalContentHash = briefingString(row.proposal_content_hash);
      if (position === null || layoutPosition === null || subgroupPosition === null
          || !proposalBriefingId || !proposalRoundId || !proposalArtifactVersionId || !proposalContentHash) return null;
      return {
        position,
        layoutPosition,
        subgroupPosition,
        proposalBriefingId,
        proposalRoundId,
        proposalArtifactVersionId,
        proposalContentHash,
        baseBriefingId: briefingOptionalString(row.base_briefing_id),
        baseRoundId: briefingOptionalString(row.base_round_id),
        baseArtifactVersionId: briefingOptionalString(row.base_artifact_version_id),
        baseContentHash: briefingOptionalString(row.base_content_hash),
        changed: row.changed === true,
        submissionId: briefingOptionalString(row.submission_id),
      };
    };
    const reviewCandidates = (Array.isArray(group.review_candidates) ? group.review_candidates : [])
      .map((entry): BriefingGroupReviewCandidate | null => {
        const row = briefingRecord(entry);
        const proposalBundleId = briefingString(row.proposal_bundle_id);
        const items = (Array.isArray(row.items) ? row.items : []).map(parseReviewItem)
          .filter((item): item is BriefingGroupReviewItem => item !== null);
        const destinationChanges = (Array.isArray(row.destination_changes) ? row.destination_changes : [])
          .map((entry) => {
            const change = briefingRecord(entry);
            const logicalArtifactId = briefingString(change.logical_artifact_id);
            const resultingGroupId = briefingString(change.resulting_group_id);
            return logicalArtifactId && resultingGroupId ? {
              logicalArtifactId,
              expectedGroupId: briefingOptionalString(change.expected_group_id),
              resultingGroupId,
            } : null;
          }).filter((change): change is NonNullable<typeof change> => change !== null);
        return proposalBundleId ? {
          proposalBundleId,
          expectedBaseBundleId: briefingOptionalString(row.expected_base_bundle_id),
          compositionRunId: briefingOptionalString(row.composition_run_id),
          bindingDigest: briefingOptionalString(row.binding_digest),
          ready: row.ready === true,
          blockerCode: briefingOptionalString(row.blocker_code),
          blockerMessage: briefingOptionalString(row.blocker_message),
          layoutChanged: row.layout_changed === true,
          destinationChanges,
          items,
        } : null;
      }).filter((entry): entry is BriefingGroupReviewCandidate => entry !== null);
    const history = (Array.isArray(group.history) ? group.history : []).map((entry): BriefingGroupDisposition | null => {
      const row = briefingRecord(entry);
      const dispositionId = briefingString(row.id);
      const priorBase = row.prior_base == null ? null : normalizeBriefingBundle(row.prior_base, invalid);
      const proposal = normalizeBriefingBundle(row.proposal, invalid);
      const resultingBase = row.resulting_base == null ? null : normalizeBriefingBundle(row.resulting_base, invalid);
      const kind = row.kind === 'promoted' || row.kind === 'dismissed'
        || row.kind === 'accepted' || row.kind === 'rejected' ? row.kind : null;
      return dispositionId && kind && proposal ? {
        id: dispositionId,
        kind,
        priorBase,
        proposal,
        resultingBase,
        authRequestId: briefingOptionalString(row.auth_request_id),
        mergeHeadSha: briefingOptionalString(row.merge_head_sha),
        reviewBindingDigest: briefingOptionalString(row.review_binding_digest),
        compositionRunId: briefingOptionalString(row.composition_run_id),
        reviewItems: (Array.isArray(row.review_items) ? row.review_items : []).map(parseReviewItem)
          .filter((item): item is BriefingGroupReviewItem => item !== null),
        actorUserId: briefingOptionalString(row.actor_user_id),
        createdAt: briefingOptionalNumber(row.created_at) ?? 0,
      } : null;
    }).filter((entry): entry is BriefingGroupDisposition => entry !== null);
    const destinations = (Array.isArray(group.destinations) ? group.destinations : [])
      .map((entry) => {
        const row = briefingRecord(entry);
        const logicalArtifactId = briefingString(row.logical_artifact_id);
        const publicationMode: BriefingGroup['destinations'][number]['publicationMode'] =
          row.publication_mode === 'reviewed-document' || row.publication_mode === 'published-report'
            ? row.publication_mode : null;
        return logicalArtifactId ? { logicalArtifactId, publicationMode,
          routeKeys: Array.isArray(row.route_keys) ? row.route_keys.filter((key): key is string => typeof key === 'string') : [] } : null;
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    const destinationHistory = (Array.isArray(group.destination_history) ? group.destination_history : [])
      .map((entry) => {
        const row = briefingRecord(entry);
        const id = briefingString(row.id);
        const logicalArtifactId = briefingString(row.logical_artifact_id);
        const resultingGroupId = briefingString(row.resulting_group_id);
        const actorUserId = briefingString(row.actor_user_id);
        return id && logicalArtifactId && resultingGroupId && actorUserId ? {
          id, logicalArtifactId, priorGroupId: briefingOptionalString(row.prior_group_id),
          resultingGroupId, actorUserId, createdAt: briefingOptionalNumber(row.created_at) ?? 0,
        } : null;
      }).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    return id && key && name ? {
      id,
      key,
      name,
      createdAt: briefingOptionalNumber(group.created_at) ?? 0,
      updatedAt: briefingOptionalNumber(group.updated_at) ?? 0,
      archivedAt: briefingOptionalNumber(group.archived_at),
      current,
      updates,
      destinations,
      destinationHistory,
      reviewCandidates,
      history,
    } : null;
  }).filter((group): group is BriefingGroup => {
    if (!group) throw new Error('The Briefing service returned an invalid group.');
    return true;
  });
}

export async function getBriefings(signal?: AbortSignal): Promise<BriefingList> {
  return normalizeBriefings(await parseMaybeJson(await apiGet(BRIEFINGS_PATH, { signal })));
}

export async function getBriefingBundles(invalid: InvalidBriefingRow[], signal?: AbortSignal): Promise<BriefingBundle[]> {
  return normalizeBriefingBundles(await parseMaybeJson(await apiGet(BRIEFING_BUNDLES_PATH, { signal })), invalid);
}

export async function getBriefingGroups(invalid: InvalidBriefingRow[], signal?: AbortSignal): Promise<BriefingGroup[]> {
  return normalizeBriefingGroups(await parseMaybeJson(await apiGet(BRIEFING_GROUPS_PATH, { signal })), invalid);
}

export async function dispositionBriefingGroupProposal(
  groupId: string,
  input: {
    decision: 'accepted' | 'rejected';
    expectedBaseBundleId: string;
    proposalBundleId: string;
    bindingDigest: string;
    destinationChanges: BriefingGroupReviewCandidate['destinationChanges'];
  },
): Promise<{ group: BriefingGroup; disposition: BriefingGroupDisposition; changed: boolean }> {
  const response = await apiPost(`/api/briefing-groups/${encodeURIComponent(groupId)}/review-dispositions`, {
    decision: input.decision,
    expected_base_bundle_ref: input.expectedBaseBundleId,
    proposal_bundle_ref: input.proposalBundleId,
    binding_digest: input.bindingDigest,
    destination_changes: input.destinationChanges.map((change) => ({
      logical_artifact_ref: change.logicalArtifactId,
      expected_group_ref: change.expectedGroupId,
    })),
  });
  const root = briefingRecord(await parseMaybeJson(response));
  const invalid: InvalidBriefingRow[] = [];
  const group = normalizeBriefingGroups({ groups: [root.group] }, invalid)[0];
  const rawDisposition = briefingRecord(root.disposition);
  const disposition = group?.history?.find((entry) => entry.id === briefingString(rawDisposition.id));
  if (!group || !disposition || invalid.length > 0 || typeof root.changed !== 'boolean') {
    throw new Error('The Briefing proposal disposition response is invalid.');
  }
  invalidateApiGetCache(BRIEFING_GROUPS_PATH);
  void refreshBrowserResources(queryClient, browserResourceKeysForEvent('briefing:group-proposal-accepted'));
  return { group, disposition, changed: root.changed };
}

export async function getBriefingSidebarSnapshot(signal?: AbortSignal): Promise<BriefingSidebarSnapshot> {
  const embeddedInvalid: InvalidBriefingRow[] = [];
  const [list, bundles, groups] = await Promise.all([
    getBriefings(signal), getBriefingBundles(embeddedInvalid, signal), getBriefingGroups(embeddedInvalid, signal),
  ]);
  const invalidBriefings = new Map<string, InvalidBriefingRow>();
  for (const row of [...list.invalid, ...embeddedInvalid]) {
    invalidBriefings.set(`${row.id ?? ''}\u0000${row.title ?? ''}\u0000${row.reason}`, row);
  }
  return { briefings: list.briefings, bundles, groups, invalidBriefings: [...invalidBriefings.values()] };
}

export function normalizeBriefingProjection(payload: unknown): BriefingProjection {
  const root = briefingRecord(payload);
  const briefing = briefingRecord(root.briefing);
  const selected = briefingRecord(root.selected_round);
  const rawSelectedOverlay = selected.selected_submission_overlay;
  const selectedOverlayRecord = briefingRecord(rawSelectedOverlay);
  const answers = Array.isArray(selectedOverlayRecord.answers)
    ? selectedOverlayRecord.answers.map(briefingRecord)
    : Array.isArray(selected.answers) ? selected.answers.map(briefingRecord) : [];
  const answerByInstance = new Map(answers.map((answer) => [
    briefingString(answer.directive_instance_id),
    answer,
  ]));
  const items = (Array.isArray(selected.items) ? selected.items : []).map((entry) => {
    const item = briefingRecord(entry);
    const id = briefingString(item.id);
    const answer = answerByInstance.get(id);
    return {
      id,
      client_item_key: briefingString(item.directive_key),
      parent_item_id: null,
      item_kind: 'item',
      revision: {
        id: briefingString(item.definition_digest),
        ordinal: 1,
        title: briefingString(item.directive_key),
        prompt: briefingString(item.prompt),
        description: null,
        response_type: item.response_type,
        required: item.required === true || item.required === 1,
        position: briefingOptionalNumber(item.position) ?? 0,
        options: Array.isArray(item.options) ? item.options : [],
        variants: Array.isArray(item.variants) ? item.variants : [],
      },
      effective_response: answer ? {
        response_event_id: briefingString(answer.response_event_id),
        value: answer.value,
      } : null,
      responseVisible: true,
      directive: {
        key: briefingString(item.directive_key),
        definition_digest: briefingString(item.definition_digest),
        start_offset: item.start_offset,
        end_offset: item.end_offset,
        body_start_offset: item.body_start_offset,
        body_end_offset: item.body_end_offset,
      },
    };
  });
  const selectedId = briefingString(selected.id);
  const latestSubmission = selected.latest_submission ?? null;
  const frozenAnnotationIds = new Set(
    Array.isArray(briefingRecord(selected.latest_frozen_membership).annotation_event_ids)
      ? briefingRecord(selected.latest_frozen_membership).annotation_event_ids as string[]
      : [],
  );
  const currentAnnotations = (Array.isArray(selected.annotations) ? selected.annotations : []).map((annotation) => ({
    ...briefingRecord(annotation),
    presentation: {
      source: frozenAnnotationIds.has(briefingString(briefingRecord(annotation).annotation_event_id))
        ? 'annotation_set'
        : 'current_draft',
      actor: null,
    },
  }));
  const overlayAnnotations = Array.isArray(selectedOverlayRecord.annotations)
    ? selectedOverlayRecord.annotations.map((annotation) => ({
      ...briefingRecord(annotation),
      presentation: { source: 'annotation_set', actor: selectedOverlayRecord.actor },
    }))
    : [];
  const projection = normalizeBriefingRoundProjection({
    round_id: selectedId,
    state: latestSubmission ? 'submitted' : 'open',
    briefing_key: briefingString(briefing.briefing_key, selectedId),
    binding_digest: briefingString(selected.binding_digest),
    created_at: briefingOptionalNumber(selected.created_at) ?? 0,
    latest_submission_for_actor: latestSubmission,
    document: selected.document ?? null,
    directive_binding: selected.binding ?? null,
    latest_frozen_membership: selected.latest_frozen_membership ?? null,
    annotations: rawSelectedOverlay == null
      ? currentAnnotations
      : [
        ...overlayAnnotations,
        ...currentAnnotations.filter((annotation) => annotation.presentation.source === 'current_draft'),
      ],
    items,
  });
  const parseOverlaySummary = (entry: unknown): BriefingSubmissionOverlaySummary | null => {
    const row = briefingRecord(entry);
    const actor = briefingRecord(row.actor);
    const id = briefingString(row.id);
    const ordinal = briefingOptionalNumber(row.ordinal);
    const actorUserId = briefingString(row.actor_user_id);
    const actorSlug = briefingString(actor.slug);
    const createdAt = briefingOptionalNumber(row.created_at);
    const answerCount = briefingOptionalNumber(row.answer_count);
    const annotationCount = briefingOptionalNumber(row.annotation_count);
    if (!id || !ordinal || !actorUserId || !actorSlug || createdAt == null || answerCount == null || annotationCount == null
        || answerCount < 0 || annotationCount < 0
        || (row.supersedes_submission_id !== null && typeof row.supersedes_submission_id !== 'string')
        || (actor.display_name !== null && typeof actor.display_name !== 'string')) return null;
    return {
      id,
      ordinal,
      supersedes_submission_id: briefingOptionalString(row.supersedes_submission_id),
      actor_user_id: actorUserId,
      actor: { slug: actorSlug, display_name: briefingOptionalString(actor.display_name) },
      created_at: createdAt,
      answer_count: answerCount,
      annotation_count: annotationCount,
    };
  };
  const rawOverlays = Array.isArray(selected.submission_overlays) ? selected.submission_overlays : [];
  const submissionOverlays = rawOverlays.map(parseOverlaySummary)
    .filter((overlay): overlay is BriefingSubmissionOverlaySummary => overlay !== null);
  const selectedSubmissionOverlay = rawSelectedOverlay == null ? null : parseOverlaySummary(rawSelectedOverlay);
  const overlaysValid = Array.isArray(selected.submission_overlays)
    && submissionOverlays.length === rawOverlays.length
    && (rawSelectedOverlay == null || Boolean(selectedSubmissionOverlay
      && submissionOverlays.some((overlay) => overlay.id === selectedSubmissionOverlay.id)));
  const rounds = (Array.isArray(root.rounds) ? root.rounds : []).map((entry): BriefingRoundSummary => {
    const row = briefingRecord(entry);
    const origin = briefingRecord(row.origin);
    return {
      id: briefingString(row.id),
      ordinal: briefingOptionalNumber(row.ordinal) ?? 0,
      artifact_version_id: briefingString(row.artifact_version_id),
      created_at: briefingOptionalNumber(row.created_at) ?? 0,
      origin: row.origin == null ? null : {
        source: briefingOptionalString(origin.source),
        run_id: briefingOptionalString(origin.run_id),
        task_identity: briefingOptionalString(origin.task_identity),
      },
    };
  }).filter((round) => Boolean(round.id && round.ordinal > 0 && round.artifact_version_id));
  const briefingId = briefingString(briefing.id);
  const latestRoundId = briefingString(briefing.latest_round_id);
  const selectedRoundId = briefingString(selected.id, projection.round_id);
  const selectedSummary = rounds.find((round) => round.id === selectedRoundId);
  const identityValid = Boolean(
    briefingId
    && latestRoundId
    && selectedRoundId
    && selectedRoundId === projection.round_id
    && rounds.some((round) => round.id === latestRoundId)
    && selectedSummary
    && selectedSummary.artifact_version_id === projection.document?.artifact_version_id
  );
  return {
    ...projection,
    valid: projection.valid && identityValid && overlaysValid,
    briefing_id: briefingId,
    title: briefingString(briefing.title),
    description: briefingOptionalString(briefing.description),
    publication_mode: briefing.publication_mode === 'reviewed-document' || briefing.publication_mode === 'published-report'
      ? briefing.publication_mode : null,
    latest_round_id: latestRoundId,
    selected_round_id: selectedRoundId,
    rounds,
    submission_overlays: submissionOverlays,
    selected_submission_overlay: selectedSubmissionOverlay,
  };
}

export async function getBriefing(
  briefingId: string,
  roundId?: string | null,
  submissionId?: string | null,
  signal?: AbortSignal,
  displayContext?: { groupId: string; proposalBundleId: string | null },
): Promise<BriefingProjection> {
  const params = new URLSearchParams();
  if (roundId) params.set('round', roundId);
  if (submissionId) params.set('submission', submissionId);
  if (displayContext) {
    params.set('group', displayContext.groupId);
    if (displayContext.proposalBundleId) params.set('proposal', displayContext.proposalBundleId);
  }
  const query = params.size > 0 ? `?${params}` : '';
  const response = await apiGet(`/api/briefings/${encodeURIComponent(briefingId)}${query}`, signal ? { signal } : {});
  return normalizeBriefingProjection(await parseMaybeJson(response));
}

export type BriefingTitleUpdate = {
  briefing_id: string;
  title: string;
  changed: boolean;
};

export async function updateBriefingTitle(briefingId: string, title: string): Promise<BriefingTitleUpdate> {
  const response = await apiPatch(`/api/briefings/${encodeURIComponent(briefingId)}`, { title });
  const payload = briefingRecord(await parseMaybeJson(response));
  const updated = {
    briefing_id: briefingString(payload.briefing_id),
    title: briefingString(payload.title),
    changed: payload.changed === true,
  };
  if (updated.briefing_id !== briefingId || !updated.title || typeof payload.changed !== 'boolean') {
    throw new Error('The Briefing title update response is invalid.');
  }
  return updated;
}

export async function getBriefingReviewedMarkdown(
  briefingId: string,
  roundId: string,
  submissionId: string,
): Promise<{ markdown: string; sha256: string | null; filename: string }> {
  const path = `/api/briefings/${encodeURIComponent(briefingId)}/rounds/${encodeURIComponent(roundId)}/submissions/${encodeURIComponent(submissionId)}/export`;
  const response = await apiGet(path);
  const payload = briefingRecord(await parseMaybeJson(response));
  const markdown = briefingString(payload.content);
  const sha256 = briefingString(payload.sha256);
  if (!markdown || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error('The reviewed Markdown export response is invalid.');
  return {
    markdown,
    sha256,
    filename: 'briefing-reviewed.md',
  };
}

/** This page wrote to the briefing: its cached reads are stale, though nothing refetches until a view asks. */
function markBriefingReadsStale(briefingId: string): void {
  invalidateApiGetCache(`/api/briefings/${encodeURIComponent(briefingId)}`);
  void queryClient.invalidateQueries({ queryKey: browserResourceKeys.briefingProjections(briefingId), refetchType: 'none' });
}

export async function postBriefingAnswers(
  briefingId: string,
  roundId: string,
  answers: readonly BriefingAnswerOperation[],
): Promise<{ answer_event_ids: string[] }> {
  const response = await apiPost(`/api/briefings/${encodeURIComponent(briefingId)}/rounds/${encodeURIComponent(roundId)}/answers`, {
    answers: answers.map((answer) => ({
      directive_key: answer.directive_key,
      operation: answer.operation,
      expected_response_event_id: answer.expected_response_event_id,
      ...(answer.operation === 'set' ? { value: answer.value } : {}),
    })),
  });
  markBriefingReadsStale(briefingId);
  const root = briefingRecord(await parseMaybeJson(response));
  return { answer_event_ids: briefingStringArray(root.answer_event_ids) };
}

export async function postBriefingAnnotations(
  briefingId: string,
  roundId: string,
  annotations: readonly BriefingAnnotationOperation[],
): Promise<{ annotation_event_ids: string[] }> {
  const response = await apiPost(`/api/briefings/${encodeURIComponent(briefingId)}/rounds/${encodeURIComponent(roundId)}/annotations`, {
    annotations: annotations.map((annotation) => annotation.operation === 'retract'
      ? annotation
      : {
        operation: 'set',
        kind: annotation.annotation_kind,
        start_offset: annotation.start_offset,
        end_offset: annotation.end_offset,
        quote: annotation.quote,
        body: annotation.body ?? null,
        replacement_text: annotation.operation === 'set' && annotation.annotation_kind === 'suggest_replacement'
          ? annotation.replacement_text
          : null,
      }),
  });
  const root = briefingRecord(await parseMaybeJson(response));
  markBriefingReadsStale(briefingId);
  return { annotation_event_ids: briefingStringArray(root.annotation_event_ids) };
}

export async function postBriefingSubmission(
  briefingId: string,
  roundId: string,
  input: {
    supersedes_submission_id?: string;
    answers: readonly BriefingSubmissionAnswer[];
    annotations?: ReadonlyArray<{ annotation_event_id: string }>;
  },
): Promise<{
  submission_id: string;
  ordinal: number;
  supersedes_submission_id: string | null;
  actor_user_id: string;
  created_at: number;
}> {
  const response = await apiPost(`/api/briefings/${encodeURIComponent(briefingId)}/rounds/${encodeURIComponent(roundId)}/submit`, {
    supersedes_submission_id: input.supersedes_submission_id ?? null,
    answers: input.answers.map((answer) => ({
      directive_key: answer.directive_key,
      response_event_id: answer.response_event_id,
    })),
    annotation_event_ids: (input.annotations ?? []).map((annotation) => annotation.annotation_event_id),
  });
  markBriefingReadsStale(briefingId);
  const root = briefingRecord(await parseMaybeJson(response));
  const result = {
    submission_id: briefingString(root.submission_id),
    ordinal: briefingOptionalNumber(root.ordinal) ?? 0,
    supersedes_submission_id: briefingOptionalString(root.supersedes_submission_id),
    actor_user_id: briefingString(root.actor_user_id),
    created_at: briefingOptionalNumber(root.created_at) ?? 0,
  };
  if (!result.submission_id || result.ordinal < 1 || !result.actor_user_id || result.created_at < 0) {
    throw new Error('The Briefing submission response is invalid.');
  }
  return result;
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

export type AgentDispatchSubjectKind = 'issue' | 'incident';

export type AgentDispatchSubject =
  | { kind: 'issue'; issue_ref: string }
  // Issue 5308097 spec §9. An incident subject is identified by the episode id
  // alone; the telemetry it carries is executor-asserted and re-read server-side
  // on every preview, which is why confirmation must pin its digest.
  | { kind: 'incident'; incident_id: string };

export type AgentDispatchPlan = {
  subject_kind: AgentDispatchSubjectKind;
  subject_label: string;
  instruction: string;
  cwd: string;
  /** The exact seed prompt. Untrusted content inside; render as text only. */
  prompt: string;
  capability_surface: string[];
  /**
   * Digest of the exact prompt above. Present for every subject kind the server
   * hashes; `null` when an older server omitted it. Confirmation sends it back
   * so a prompt that changed between preview and confirm is a 409, not a
   * silently different agent task (spec §9).
   */
  prompt_sha256: string | null;
  /** Incident subjects only; `null` otherwise. */
  incident_id: string | null;
  /**
   * Digest of the executor telemetry the plan quoted. Incident subjects only.
   * A newer observation event changes this, which invalidates the preview.
   */
  incident_telemetry_sha256: string | null;
};

export type AgentDispatchEvent = {
  id: string;
  subject_kind: AgentDispatchSubjectKind;
  comment_id: string | null;
  issue_id: string | null;
  incident_id: string | null;
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
  /**
   * Incident subjects only: the incident projection the server moved as part of
   * the confirmed dispatch (spec §7). `null` for issue subjects and for
   * servers that do not report it.
   */
  incident: { id: string; remediation: ContractOperationalIncidentRemediation } | null;
};

/**
 * Hashes returned by a preview and echoed back on confirmation. Both are
 * required for an incident confirm; sending a stale pair is a 409 that the
 * caller must resolve by taking a fresh preview.
 */
export type AgentDispatchConfirmation = {
  expected_prompt_sha256?: string | null;
  expected_incident_telemetry_sha256?: string | null;
};

function normalizeAgentDispatchSubjectKind(value: unknown): AgentDispatchSubjectKind {
  if (value === 'issue') return 'issue';
  if (value === 'incident') return 'incident';
  return 'issue';
}

function normalizeOperationalIncidentRemediation(value: unknown): ContractOperationalIncidentRemediation {
  switch (value) {
    case 'triaging':
    case 'fix_prepared':
    case 'awaiting_auth':
    case 'auth_expired':
    case 'awaiting_deploy':
    case 'awaiting_verification':
    case 'complete':
      return value;
    default:
      return 'none';
  }
}

function normalizeAgentDispatchEvent(value: unknown): AgentDispatchEvent {
  const row = briefingRecord(value);
  const status = briefingOptionalString(row.status);
  return {
    id: briefingString(row.id),
    subject_kind: normalizeAgentDispatchSubjectKind(row.subject_kind),
    comment_id: briefingOptionalString(row.comment_id),
    issue_id: briefingOptionalString(row.issue_id),
    incident_id: briefingOptionalString(row.incident_id),
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
    subject_kind: normalizeAgentDispatchSubjectKind(plan.subject_kind),
    subject_label: briefingString(plan.subject_label),
    instruction: briefingString(plan.instruction, instruction),
    cwd: briefingString(plan.cwd),
    prompt: briefingString(plan.prompt),
    capability_surface: briefingStringArray(plan.capability_surface),
    prompt_sha256: briefingOptionalString(plan.prompt_sha256),
    incident_id: briefingOptionalString(plan.incident_id),
    incident_telemetry_sha256: briefingOptionalString(plan.incident_telemetry_sha256),
  };
}

/**
 * Execute a confirmed dispatch. A spawn failure comes back as `ok: false` with
 * the recorded event, not as a thrown error: the handling event exists either
 * way and the UI must show which happened.
 *
 * `confirmation` carries the digests a preview returned. They are sent verbatim
 * and only when present, so issue callers keep the original two-argument
 * contract while an incident confirm pins the exact plan it displayed.
 */
export async function dispatchAgent(
  subject: AgentDispatchSubject,
  instruction: string,
  confirmation: AgentDispatchConfirmation = {},
): Promise<AgentDispatchResult> {
  const body: Record<string, unknown> = { subject, instruction };
  if (confirmation.expected_prompt_sha256) {
    body.expected_prompt_sha256 = confirmation.expected_prompt_sha256;
  }
  if (confirmation.expected_incident_telemetry_sha256) {
    body.expected_incident_telemetry_sha256 = confirmation.expected_incident_telemetry_sha256;
  }
  const response = await apiPost('/api/agent-dispatch/dispatch', body);
  const payload = briefingRecord(await parseMaybeJson(response));
  const incident = briefingRecord(payload.incident);
  const incidentId = briefingOptionalString(incident.id);
  return {
    ok: payload.ok === true,
    event: normalizeAgentDispatchEvent(payload.event),
    incident: incidentId
      ? {
        id: incidentId,
        remediation: normalizeOperationalIncidentRemediation(incident.remediation),
      }
      : null,
  };
}

/** Read the recorded dispatch chain for one issue. */
export async function getAgentDispatchEvents(
  filter: { issueId?: string },
  signal?: AbortSignal,
): Promise<AgentDispatchEvent[]> {
  const query = new URLSearchParams();
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
// The inventory portion of the Tasks view is a READ SURFACE over facts an
// executor reported. Disable requests are a separate operator-authored command
// protocol below; they never mutate inventory telemetry in place.
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
  TASK_COMMAND_SCHEMA_V1,
  type TaskCommand as ContractTaskCommand,
  type TaskCommandListResponse as ContractTaskCommandListResponse,
  type TaskCommandMutationResult as ContractTaskCommandMutationResult,
  type TaskCommandRejectionReason,
  type TaskCommandState,
  type TaskCommandVerb,
  type TaskActivationFacts,
  type TaskActivationCondition,
  type TaskActivationHealthFacts,
  type TaskActivationObservation,
  type TaskBundleFacts,
  type TaskCircuitState,
  type TaskConfigFacts,
  type TaskExecutorFreshness,
  type TaskExecutorSummary as ContractTaskExecutorSummary,
  type TaskGuardFacts,
  type TaskInventoryEntry,
  type TaskInventoryResponse as ContractTaskInventoryResponse,
  type TaskInventoryView as ContractTaskInventoryView,
  type ExecutorTaskInventoryView,
  type MandibleTaskInventoryView,
  type ManagedReminder,
  type ManagedReminderPredicate,
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
  TaskActivationCondition,
  TaskActivationHealthFacts,
  TaskActivationObservation,
  TaskBundleFacts,
  TaskConfigFacts,
  TaskExecutorFreshness,
  TaskGuardFacts,
  TaskInventoryEntry,
  TaskRunFacts,
  TaskRunSlot,
  ManagedReminder,
  ManagedReminderPredicate,
};

export type TaskExecutorSummary = ContractTaskExecutorSummary;
export type TaskInventoryItem = ContractTaskInventoryView;
export type ExecutorTaskInventoryItem = ExecutorTaskInventoryView;
export type MandibleTaskInventoryItem = MandibleTaskInventoryView;
export type TaskInventory = ContractTaskInventoryResponse;
export type TaskCommand = ContractTaskCommand;
export type TaskCommandList = ContractTaskCommandListResponse;
export type TaskCommandMutation = ContractTaskCommandMutationResult;

const TASK_CIRCUIT_STATES: readonly TaskCircuitState[] = ['closed', 'open', 'half_open'];
const TASK_KILL_SWITCH_STATES: readonly TaskKillSwitchState[] = ['engaged', 'clear'];
const TASK_STALENESS_CLAIMS: readonly TaskStalenessClaim[] = ['fresh', 'stale'];
const TASK_RUN_OUTCOMES: readonly TaskRunOutcome[] = ['success', 'failure', 'timeout', 'cancelled'];
const TASK_FRESHNESS: readonly TaskExecutorFreshness[] = ['current', 'stale', 'unknown'];
const TASK_ACTIVATION_STATES = [
  'never_activated', 'activated', 'operator_disabled', 'deployment_invalidated',
] as const;
const TASK_ACTIVATION_REASONS = [
  'never_activated', 'operator_enabled', 'operator_disabled', 'execution_hash_changed',
] as const;
const TASK_ACTIVATION_ACTIONS = ['none', 'dry_run', 'enable'] as const;
const TASK_EXECUTOR_HEALTH_CONDITIONS = [
  'healthy', 'no_active_bundle', 'bundle_link_mismatch', 'execution_path_mismatch',
] as const;

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
  const legacy = {
    config_enabled: taskMaybeBoolean(row.config_enabled),
    locally_activated: taskMaybeBoolean(row.locally_activated),
  };
  const state = taskMaybeEnum(row.state, TASK_ACTIVATION_STATES);
  const reason = taskMaybeEnum(row.reason, TASK_ACTIVATION_REASONS);
  const requiredAction = taskMaybeEnum(row.required_action, TASK_ACTIVATION_ACTIONS);
  if (state === TASK_INVENTORY_UNKNOWN
    || reason === TASK_INVENTORY_UNKNOWN
    || requiredAction === TASK_INVENTORY_UNKNOWN) return legacy;
  return {
    ...legacy,
    state,
    reason,
    changed_at: row.changed_at === 'none' ? 'none' : taskMaybeNumber(row.changed_at),
    previous_execution_hash: row.previous_execution_hash === 'none'
      ? 'none' : taskMaybeString(row.previous_execution_hash),
    required_execution_hash: row.required_execution_hash === 'none'
      ? 'none' : taskMaybeString(row.required_execution_hash),
    deployment_commit: row.deployment_commit === 'none'
      ? 'none' : taskMaybeString(row.deployment_commit),
    deployment_content_hash: row.deployment_content_hash === 'none'
      ? 'none' : taskMaybeString(row.deployment_content_hash),
    deployed_at: row.deployed_at === 'none' ? 'none' : taskMaybeNumber(row.deployed_at),
    required_action: requiredAction,
    attention: row.attention === 'important' ? 'important' : 'none',
  } as TaskActivationHealthFacts;
}

function normalizeTaskExecutorHealth(value: unknown): ContractTaskExecutorSummary['health'] {
  const row = briefingRecord(value);
  const condition = taskMaybeEnum(row.condition, TASK_EXECUTOR_HEALTH_CONDITIONS);
  if (condition === TASK_INVENTORY_UNKNOWN) return undefined;
  const status = condition === 'healthy' ? 'healthy' : 'operational_failure';
  const attention = condition === 'healthy' ? 'none' : 'important';
  if (row.status !== status || row.attention !== attention) return undefined;
  return { status, condition, attention };
}

function normalizeActivationObservation(value: unknown): TaskActivationObservation | null {
  const row = briefingRecord(value);
  const id = briefingOptionalString(row.id);
  const generationId = briefingOptionalString(row.generation_id);
  const state = taskMaybeEnum(row.state, TASK_ACTIVATION_STATES);
  const reason = taskMaybeEnum(row.reason, TASK_ACTIVATION_REASONS);
  const facts = normalizeTaskActivation(row.facts);
  if (!id || !generationId || state === TASK_INVENTORY_UNKNOWN
    || reason === TASK_INVENTORY_UNKNOWN || !('state' in facts)) return null;
  return {
    id,
    generation_id: generationId,
    state,
    reason,
    observed_at: briefingOptionalNumber(row.observed_at) ?? 0,
    recorded_at: briefingOptionalNumber(row.recorded_at) ?? 0,
    facts,
  };
}

function normalizeActivationCondition(value: unknown): TaskActivationCondition | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = briefingRecord(value);
  const id = briefingOptionalString(row.id);
  const dedupeKey = briefingOptionalString(row.dedupe_key);
  const executionHash = briefingOptionalString(row.required_execution_hash);
  if (!id || !dedupeKey || !executionHash || !/^[0-9a-f]{64}$/.test(executionHash)) return null;
  return {
    id,
    dedupe_key: dedupeKey,
    required_execution_hash: executionHash,
    attention: 'important',
    state: 'active',
    next_action: row.next_action === 'enable' ? 'enable' : 'dry_run',
    raised_at: briefingOptionalNumber(row.raised_at) ?? 0,
    resolved_at: null,
    resolution: null,
    enable_command_id: null,
  };
}

function normalizeTaskConfig(value: unknown): TaskConfigFacts | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = briefingRecord(value);
  return {
    schedule_text: taskMaybeString(row.schedule_text),
    not_before: taskMaybeString(row.not_before),
    max_lateness_minutes: taskMaybeNumber(row.max_lateness_minutes),
    missed_run_policy: taskMaybeString(row.missed_run_policy),
    timeout_seconds: taskMaybeNumber(row.timeout_seconds),
    runner: taskMaybeString(row.runner),
    runner_profile: taskMaybeString(row.runner_profile),
    model: taskMaybeString(row.model),
    max_total_tokens: taskMaybeNumber(row.max_total_tokens),
    max_turns: taskMaybeNumber(row.max_turns),
    publish: taskMaybeBoolean(row.publish),
    output_as_source: taskMaybeBoolean(row.output_as_source),
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
    ...(row.config === undefined ? {} : {
      config_hash: taskMaybeString(row.config_hash),
      prompt_hash: taskMaybeString(row.prompt_hash),
      config: normalizeTaskConfig(row.config),
    }),
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
  const health = normalizeTaskExecutorHealth(row.health);
  return {
    name,
    version: taskMaybeString(row.version),
    capabilities: briefingStringArray(row.capabilities),
    ...(health ? { health } : {}),
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
  if (row.source_kind === 'mandible') {
    const reminder = briefingContractRecord<ManagedReminder>(row.reminder);
    const revision = briefingContractRecord<ManagedReminder['revision']>(reminder.revision);
    const payload = briefingContractRecord<ManagedReminder['revision']['payload']>(revision.payload);
    const predicate = briefingRecord(payload.predicate);
    const id = briefingOptionalString(reminder.id);
    const projectId = briefingOptionalString(reminder.project_id);
    const projectKey = briefingOptionalString(reminder.project_key);
    const revisionId = briefingOptionalString(revision.id);
    const predicateKind = briefingOptionalString(predicate.kind);
    if (!id || !projectId || !projectKey || !revisionId
      || !['at', 'issue_closed', 'auth_merge_count_gte'].includes(predicateKind ?? '')) {
      return null;
    }
    return {
      source_kind: 'mandible',
      key: briefingOptionalString(row.key) ?? `mandible-reminder:${id}`,
      reminder: reminder as ManagedReminder,
    };
  }
  if (row.source_kind !== 'executor') return null;
  const task = normalizeTaskEntry(row.task);
  if (!task) return null;
  const executor = briefingOptionalString(row.executor) ?? 'unknown';
  return {
    source_kind: 'executor',
    key: briefingOptionalString(row.key) ?? `${executor}/${task.task_id}`,
    executor,
    freshness: taskMaybeEnum(row.freshness, TASK_FRESHNESS) === TASK_INVENTORY_UNKNOWN
      ? 'unknown'
      : (row.freshness as TaskExecutorFreshness),
    observed_at: briefingOptionalNumber(row.observed_at) ?? 0,
    observed_age_ms: briefingOptionalNumber(row.observed_age_ms) ?? 0,
    task,
    activation_condition: normalizeActivationCondition(row.activation_condition),
    activation_history: Array.isArray(row.activation_history)
      ? row.activation_history
        .map(normalizeActivationObservation)
        .filter((entry): entry is TaskActivationObservation => entry !== null)
      : [],
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
export async function getTaskInventory(read: CachedRead<TaskInventory> = {}): Promise<TaskInventory> {
  const { onCached } = read;
  const payload = await cachedApiGetJson<unknown>('/api/tasks', {
    ...WARMED_ROUTE_GET_OPTIONS,
    signal: read.signal,
    onCached: onCached && ((cached) => onCached(normalizeTaskInventory(cached))),
  });
  return normalizeTaskInventory(payload);
}

const TASK_COMMAND_VERBS: readonly TaskCommandVerb[] = ['disable', 'dry_run', 'enable'];
const TASK_COMMAND_STATES: readonly TaskCommandState[] = [
  'requested', 'accepted', 'started', 'applied', 'rejected', 'cancelled',
];
const TASK_COMMAND_REJECTION_REASONS: readonly TaskCommandRejectionReason[] = [
  'unknown_task', 'unsupported_verb', 'invalid_payload', 'stale_target',
  'busy', 'missing_receipt', 'stale_receipt', 'policy_refused', 'dry_run_failed', 'unknown',
];

function normalizeTaskCommand(value: unknown): TaskCommand | null {
  const row = briefingContractRecord<ContractTaskCommand>(value);
  const id = briefingOptionalString(row.id);
  const executor = briefingOptionalString(row.executor);
  const taskId = briefingOptionalString(row.task_id);
  const verb = taskMaybeEnum(row.verb, TASK_COMMAND_VERBS);
  if (!id || !executor || !taskId || verb === TASK_INVENTORY_UNKNOWN) return null;
  const schema = row.schema === TASK_COMMAND_SCHEMA ? TASK_COMMAND_SCHEMA : TASK_COMMAND_SCHEMA_V1;
  if (schema === TASK_COMMAND_SCHEMA_V1 && verb !== 'disable') return null;
  const executionHash = briefingString(briefingRecord(row.payload).execution_hash);
  if (verb !== 'disable' && !/^[0-9a-f]{64}$/.test(executionHash)) return null;
  const payload: TaskCommand['payload'] = verb === 'disable' ? {} : { execution_hash: executionHash };
  const state = taskMaybeEnum(row.state, TASK_COMMAND_STATES);
  if (state === TASK_INVENTORY_UNKNOWN) return null;
  const rejectionReason = row.rejection_reason === null
    ? null
    : taskMaybeEnum(row.rejection_reason, TASK_COMMAND_REJECTION_REASONS);
  return {
    id,
    schema,
    request_key: briefingString(row.request_key),
    request_digest: briefingString(row.request_digest),
    executor,
    task_id: taskId,
    verb,
    payload,
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
  read: CachedRead<TaskCommandList> = {},
): Promise<TaskCommandList> {
  const query = new URLSearchParams();
  if (filter.executor) query.set('executor', filter.executor);
  if (filter.taskId) query.set('task_id', filter.taskId);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  const { onCached } = read;
  const payload = await cachedApiGetJson<unknown>(`/api/tasks/commands${suffix}`, {
    ...WARMED_ROUTE_GET_OPTIONS,
    signal: read.signal,
    onCached: onCached && ((cached) => onCached(normalizeTaskCommands(cached))),
  });
  return normalizeTaskCommands(payload);
}

export async function getTaskCommand(
  commandId: string,
  signal?: AbortSignal,
): Promise<TaskCommand> {
  const response = await apiGet(
    `/api/tasks/commands/${encodeURIComponent(commandId)}`,
    signal ? { signal } : {},
  );
  const row = briefingContractRecord<{ command: ContractTaskCommand }>(await parseMaybeJson(response));
  const command = normalizeTaskCommand(row.command);
  if (!command) throw new Error('Server returned an invalid task command receipt.');
  return command;
}

export async function requestTaskDisable(
  executor: string,
  taskId: string,
  requestKey: string = crypto.randomUUID(),
): Promise<TaskCommandMutation> {
  const response = await apiPost('/api/tasks/commands', {
    schema: TASK_COMMAND_SCHEMA_V1,
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

async function requestTaskV2Command(
  executor: string,
  taskId: string,
  executionHash: string,
  verb: 'dry_run' | 'enable',
  requestKey: string = crypto.randomUUID(),
): Promise<TaskCommandMutation> {
  const response = await apiPost('/api/tasks/commands', {
    schema: TASK_COMMAND_SCHEMA,
    request_key: requestKey,
    executor,
    task_id: taskId,
    verb,
    payload: { execution_hash: executionHash },
  });
  const row = briefingContractRecord<ContractTaskCommandMutationResult>(await parseMaybeJson(response));
  const command = normalizeTaskCommand(row.command);
  if (!command) throw new Error('Server returned an invalid task command receipt.');
  return { command, stored: row.stored === true };
}

export const requestTaskDryRun = (
  executor: string,
  taskId: string,
  executionHash: string,
  requestKey?: string,
): Promise<TaskCommandMutation> => requestTaskV2Command(
  executor, taskId, executionHash, 'dry_run', requestKey,
);

export const requestTaskEnable = (
  executor: string,
  taskId: string,
  executionHash: string,
  requestKey?: string,
): Promise<TaskCommandMutation> => requestTaskV2Command(
  executor, taskId, executionHash, 'enable', requestKey,
);

export async function cancelTaskDisable(commandId: string): Promise<TaskCommandMutation> {
  const response = await apiPost(`/api/tasks/commands/${encodeURIComponent(commandId)}/cancel`, {});
  const row = briefingContractRecord<ContractTaskCommandMutationResult>(await parseMaybeJson(response));
  const command = normalizeTaskCommand(row.command);
  if (!command) throw new Error('Server returned an invalid task command receipt.');
  return { command, stored: row.stored === true };
}

/** Embed snapshot placeholder posted alongside an `item_id` (C11 invariant). */
export type BlockItemSnapshot = Record<string, unknown>;

/** Create-block request body (mirrors `parseBlockCreateInput`, C11). */
export type CreateBlockBody = {
  block_type: ContractSpaceBlockType;
  parent_id?: string | null;
  item_id?: string | null;
  item_snapshot?: BlockItemSnapshot | null;
  sort_key?: string | null;
  markdown?: string | null;
  metadata?: Record<string, unknown>;
};

/** Update-block request body (mirrors `parseBlockUpdateInput`, C11). */
export type UpdateBlockBody = {
  block_type?: ContractSpaceBlockType;
  parent_id?: string | null;
  item_id?: string | null;
  item_snapshot?: BlockItemSnapshot | null;
  sort_key?: string | null;
  markdown?: string | null;
  metadata?: Record<string, unknown>;
};

const spaceBlocksPath = (spaceId: string) => `/api/spaces/${encodeURIComponent(spaceId)}/blocks`;
export async function listSpaceBlocks(spaceId: string, fetchImpl?: typeof fetch, signal?: AbortSignal): Promise<ContractSpaceBlock[]> {
  const payload = await parseMaybeJson(await apiGet(spaceBlocksPath(spaceId), { signal }, fetchImpl)) as { blocks?: ContractSpaceBlock[] };
  if (!Array.isArray(payload.blocks)) throw new Error('The Spaces service returned an invalid block collection.');
  return payload.blocks;
}
export async function createSpaceBlock(spaceId: string, body: CreateBlockBody, fetchImpl?: typeof fetch): Promise<ContractSpaceBlock> {
  const payload = await parseMaybeJson(await apiWrite('POST', spaceBlocksPath(spaceId), body, fetchImpl)) as { block: ContractSpaceBlock };
  return payload.block;
}
export async function updateSpaceBlock(spaceId: string, blockId: string, body: UpdateBlockBody, fetchImpl?: typeof fetch): Promise<ContractSpaceBlock> {
  const payload = await parseMaybeJson(await apiWrite('PATCH', `${spaceBlocksPath(spaceId)}/${encodeURIComponent(blockId)}`, body, fetchImpl)) as { block: ContractSpaceBlock };
  return payload.block;
}
export async function deleteSpaceBlock(spaceId: string, blockId: string, fetchImpl?: typeof fetch): Promise<void> {
  await apiDelete(`${spaceBlocksPath(spaceId)}/${encodeURIComponent(blockId)}`, fetchImpl);
}
export async function detachItemFromBlocks(spaceId: string, itemId: string, fetchImpl?: typeof fetch): Promise<{ detached: ContractSpaceBlock[] }> {
  return await parseMaybeJson(await apiWrite('POST', `/api/spaces/${encodeURIComponent(spaceId)}/items/${encodeURIComponent(itemId)}/detach-blocks`, {}, fetchImpl)) as { detached: ContractSpaceBlock[] };
}

export async function importSpaceHistory(spaceId: string,id: string,title: string): Promise<ContractSpace> {
  return await parseMaybeJson(await apiPost(`/api/spaces/${encodeURIComponent(spaceId)}/history/${encodeURIComponent(id)}/import`,{title})) as ContractSpace;
}
