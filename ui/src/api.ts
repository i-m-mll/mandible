import type { InboxData } from './views/inbox';
import type { GraphNode, GraphEdge } from './types/graph';

export type ApiList<T> = T[] | { items?: T[]; sessions?: T[]; queue?: T[]; requests?: T[]; repos?: T[]; branches?: T[] };

const DEFAULT_HEADERS = {
  Accept: 'application/json',
};

async function apiGet(path: string): Promise<Response> {
  const response = await fetch(path, { headers: DEFAULT_HEADERS });
  if (!response.ok) {
    throw new Error(`GET ${path} failed: ${response.status}`);
  }
  return response;
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
    throw new Error(`POST ${path} failed: ${response.status}`);
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
    throw new Error(`PATCH ${path} failed: ${response.status}`);
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
    throw new Error(`PUT ${path} failed: ${response.status}`);
  }
  return response;
}

async function apiDelete(path: string): Promise<Response> {
  const response = await fetch(path, {
    method: 'DELETE',
    headers: DEFAULT_HEADERS,
  });
  if (!response.ok) {
    throw new Error(`DELETE ${path} failed: ${response.status}`);
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

export type ReviewSpecPayload = {
  markdown: string;
  commits: string[];
  meta?: Record<string, unknown>;
};

export async function getReviewSpec(
  params: Record<string, string | number | boolean | undefined>,
): Promise<ReviewSpecPayload> {
  const response = await apiGet(`/api/review/spec${buildQuery(params)}`);
  const payload = await parseMaybeJson(response);
  if (typeof payload === 'string') {
    return { markdown: payload, commits: [] };
  }
  if (!payload || typeof payload !== 'object') {
    return { markdown: '', commits: [] };
  }
  const data = payload as {
    markdown?: string;
    spec?: string;
    commits?: string[];
    meta?: Record<string, unknown>;
    content?: string;
  };
  return {
    markdown: data.markdown || data.spec || data.content || '',
    commits: Array.isArray(data.commits) ? data.commits : [],
    meta: data.meta,
  };
}

export async function getIssueRepos<T>(): Promise<T[]> {
  const response = await apiGet('/api/issues');
  const payload = (await parseMaybeJson(response)) as ApiList<T>;
  return normalizeList(payload);
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

// ── Switchboard API ──

export async function getSwitchboardPairings<T>(): Promise<T[]> {
  const response = await apiGet('/api/switchboard/pairings');
  const payload = (await parseMaybeJson(response)) as { pairings?: T[] } | T[];
  if (Array.isArray(payload)) return payload;
  return (payload as { pairings?: T[] }).pairings ?? [];
}

export async function addSwitchboardPairing(
  name: string,
  source: string,
  target: string,
  hooks?: { hook_setup?: string; hook_teardown?: string },
): Promise<void> {
  const response = await fetch('/api/switchboard/pairings', {
    method: 'POST',
    headers: { ...DEFAULT_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, source, target, ...hooks }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error((payload as { error?: string }).error ?? `POST /api/switchboard/pairings failed: ${response.status}`);
  }
}

export async function deleteSwitchboardPairing(name: string): Promise<void> {
  await apiDelete(`/api/switchboard/pairings/${encodeURIComponent(name)}`);
}

export async function updateSwitchboardPairing(
  name: string,
  source: string,
  target: string,
  hooks?: { hook_setup?: string; hook_teardown?: string },
): Promise<void> {
  const response = await fetch(`/api/switchboard/pairings/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    headers: { ...DEFAULT_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, target, ...hooks }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error((payload as { error?: string }).error ?? `PATCH /api/switchboard/pairings/${name} failed: ${response.status}`);
  }
}

export async function getSwitchboardItems<T>(name: string): Promise<{ pairing: unknown; items: T[]; consistencyErrors?: Array<{ item: string; error: string }> }> {
  const response = await apiGet(`/api/switchboard/pairings/${encodeURIComponent(name)}/items`);
  return (await parseMaybeJson(response)) as { pairing: unknown; items: T[]; consistencyErrors?: Array<{ item: string; error: string }> };
}

export async function toggleSwitchboardItem(pairingName: string, item: string): Promise<{ state: string }> {
  const response = await fetch(`/api/switchboard/pairings/${encodeURIComponent(pairingName)}/toggle`, {
    method: 'POST',
    headers: { ...DEFAULT_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ item }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error((payload as { error?: string }).error ?? `toggle failed: ${response.status}`);
  }
  return (await response.json()) as { state: string };
}

export async function syncSwitchboard(pairingName: string): Promise<{ errors: string[] }> {
  const response = await apiPost(`/api/switchboard/pairings/${encodeURIComponent(pairingName)}/sync`);
  return (await parseMaybeJson(response)) as { errors: string[] };
}

export interface HookTemplate {
  id: string;
  name: string;
  hook_setup?: string;
  hook_teardown?: string;
  builtin?: boolean;
}

export async function getSwitchboardTemplates(): Promise<{ templates: HookTemplate[] }> {
  const response = await apiGet('/api/switchboard/templates');
  return (await parseMaybeJson(response)) as { templates: HookTemplate[] };
}

export async function createSwitchboardTemplate(
  name: string,
  hooks: { hook_setup?: string; hook_teardown?: string },
): Promise<HookTemplate> {
  const response = await fetch('/api/switchboard/templates', {
    method: 'POST',
    headers: { ...DEFAULT_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, ...hooks }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error((payload as { error?: string }).error ?? `POST /api/switchboard/templates failed: ${response.status}`);
  }
  return (await response.json()) as HookTemplate;
}

export async function deleteSwitchboardTemplate(id: string): Promise<void> {
  const response = await fetch(`/api/switchboard/templates/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: DEFAULT_HEADERS,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error((payload as { error?: string }).error ?? `DELETE /api/switchboard/templates/${id} failed: ${response.status}`);
  }
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

export async function getIssueSessions(repoId: string, issueId: string): Promise<unknown[]> {
  const response = await apiGet(
    `/api/issues/${encodeURIComponent(repoId)}/${encodeURIComponent(issueId)}/sessions`
  );
  const payload = await parseMaybeJson(response);
  return Array.isArray(payload) ? payload : [];
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

export async function createConsoleSession(
  label: string,
  backend: string,
  kind: string,
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
} }> {
  // Bug: b949700 — translate agent_type to command+args as required by backend
  type SessionBody = {
    label: string;
    command: string;
    args: string[];
    cwd?: string;
    auto_restart?: boolean;
    is_operator?: boolean;
  };
  const body: SessionBody = { label, command: '', args: [] };
  if (kind === 'operator') {
    body.command = 'claude';
    body.args = ['--dangerously-skip-permissions'];
    body.auto_restart = true;
    body.is_operator = true;
  } else if (backend === 'claude') {
    body.command = 'claude';
    body.args = ['--dangerously-skip-permissions'];
  } else if (backend === 'codex') {
    body.command = 'codex';
    body.args = [];
  } else if (backend === 'gemini') {
    body.command = 'gemini';
    body.args = ['-y'];
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

// ── Backup API ──

export type BackupStatus = {
  enabled: boolean;
  interval_hours: number;
  last_run_at: number | null;
  last_size_bytes: number | null;
  last_error: string | null;
};

export async function getBackupStatus(): Promise<BackupStatus> {
  const response = await apiGet('/api/backup/status');
  return (await parseMaybeJson(response)) as BackupStatus;
}

export async function runBackupNow(): Promise<{ ok: boolean; size_bytes?: number; error?: string }> {
  const response = await apiPost('/api/backup/run');
  return (await parseMaybeJson(response)) as { ok: boolean; size_bytes?: number; error?: string };
}

export async function updateBackupSettings(settings: {
  enabled?: boolean;
  interval_hours?: number;
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
  group?: boolean;
  exclude_subagents?: boolean;
  parent_id?: string;
  session_id?: string;
}): Promise<{ conversations: Conversation[]; total: number }> {
  const query = new URLSearchParams();
  if (params?.source) query.set('source', params.source);
  if (params?.starred) query.set('starred', '1');
  if (params?.search) query.set('search', params.search);
  if (params?.offset) query.set('offset', String(params.offset));
  if (params?.limit) query.set('limit', String(params.limit));
  if (params?.sort) query.set('sort', params.sort);
  if (params?.group) query.set('group', 'true');
  if (params?.exclude_subagents) query.set('exclude_subagents', 'true');
  if (params?.parent_id) query.set('parent_id', params.parent_id);
  if (params?.session_id) query.set('session_id', params.session_id);
  const qs = query.toString();
  const resp = await apiGet(`/api/conversations${qs ? '?' + qs : ''}`);
  return (await parseMaybeJson(resp)) as { conversations: Conversation[]; total: number };
}

export async function getConversation(id: string): Promise<Conversation & { blocks: ConversationBlock[]; children: ConversationChild[] }> {
  const resp = await apiGet(`/api/conversations/${encodeURIComponent(id)}`);
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

export async function updateConversation(id: string, data: { starred?: number; label?: string; notes?: string }): Promise<Conversation> {
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

// ── Conversation types ──

export type BlockType = 'user_message' | 'assistant_message' | 'thinking' | 'tool_use' | 'tool_result' | 'system' | 'event';
export type Role = 'user' | 'assistant' | 'system' | 'tool';
export type ConversationSource = 'claude_code' | 'codex' | 'gemini';

export type ConversationBlock = {
  id: string;
  conversation_id: string;
  type: BlockType;
  role: Role;
  content: string;
  position: number;
  timestamp: string;
  parent_id: string | null;
  metadata_json: string;
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
  starred: number;
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
