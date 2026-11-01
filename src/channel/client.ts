import type { InboxResponse, AuthQueueResponse, IssueRepoSummary, WorkUnitsResponse, AuthSubmitResponse, SessionUpdateResponse, UndeliveredResponse, UndeliveredAuthResult } from "./types.js";
export class ChannelOperationError extends Error { constructor(message: string, readonly statusCode: number) { super(message); } }
function segment(value: string): string {
  if (!/^[A-Za-z0-9_:-]+$/.test(value)) throw new Error("Malformed local API route");
  return encodeURIComponent(value);
}
export function createChannelClient(request: <T>(method: string, route: string, body?: unknown) => Promise<T>, app = "claude") {
// --- Inbox ---

async function checkInbox(
  branch?: string,
  repo?: string,
): Promise<InboxResponse> {
  const params = new URLSearchParams();
  if (branch) params.set("branch", branch);
  if (repo) params.set("repo", repo);
  const qs = params.toString();
  return request<InboxResponse>("GET", `/api/inbox${qs ? `?${qs}` : ""}`);
}

async function checkInboxGlobal(): Promise<InboxResponse> {
  return request<InboxResponse>("GET", "/api/inbox/global");
}

/**
 * Bug: 4e32923 — fetch resolved auth_requests owned by `sessionId` that have
 * not yet been delivered. Called once at channel-server startup so a resumed
 * session can replay auth results that resolved while its SSE listener was
 * offline. Returns an empty list (not an error) if Mandible has no rows.
 */
async function fetchUndeliveredAuthResults(
  sessionId: string,
  conversationId?: string | null,
): Promise<UndeliveredAuthResult[]> {
  const params = new URLSearchParams({ target_session_id: sessionId });
  // Bug: 6d7411b — pass conversation_id so the server can also match auth
  // requests submitted under a previous session id for the same conversation.
  if (conversationId) params.set("conversation_id", conversationId);
  const res = await request<UndeliveredResponse>(
    "GET",
    `/api/inbox/undelivered?${params.toString()}`,
  );
  return res.undelivered;
}

/**
 * Bug: 4e32923 — mark an auth_request as delivered via the canonical
 * POST /api/inbox/delivered/<id> endpoint. Idempotent (204 on first delivery,
 * 204 on subsequent calls). Used by the startup catch-up path; live SSE
 * delivery uses the lower-level `markDelivered` in notifications.ts which
 * fires-and-forgets without awaiting a response.
 */
async function markAuthDelivered(requestId: string): Promise<void> {
  await request<unknown>(
    "POST",
    `/api/inbox/delivered/${encodeURIComponent(requestId)}`,
  );
}

// --- Issues ---

async function getIssues(filters?: {
  repo?: string;
  status?: string;
  label?: string;
}): Promise<IssueRepoSummary[]> {
  const params = new URLSearchParams();
  if (filters?.repo) params.set("repo", filters.repo);
  if (filters?.status) params.set("status", filters.status);
  if (filters?.label) params.set("label", filters.label);
  const qs = params.toString();
  return request<IssueRepoSummary[]>(
    "GET",
    `/api/issues${qs ? `?${qs}` : ""}`,
  );
}

// --- Work Units ---

async function getWorkUnits(filters?: {
  state?: string;
  repo_id?: string;
  branch?: string;
  issue_id?: string;
}): Promise<WorkUnitsResponse> {
  const params = new URLSearchParams();
  if (filters?.state) params.set("state", filters.state);
  if (filters?.repo_id) params.set("repo_id", filters.repo_id);
  if (filters?.branch) params.set("branch", filters.branch);
  if (filters?.issue_id) params.set("issue_id", filters.issue_id);
  const qs = params.toString();
  return request<WorkUnitsResponse>(
    "GET",
    `/api/work-units${qs ? `?${qs}` : ""}`,
  );
}

async function patchWorkUnit(
  id: string,
  patch: {
    state?: string;
    assigned_session_id?: string | null;
    continuation?: string | null;
    continuation_by?: string | null;
    continuation_at?: number | null;
  },
): Promise<unknown> {
  return request("PATCH", `/api/work-units/${segment(id)}`, patch);
}

// --- Auth ---

async function getAuthQueue(): Promise<AuthQueueResponse> {
  return request<AuthQueueResponse>("GET", "/api/auth/queue");
}

async function submitAuth(payload: {
  command: string;
  title: string;
  cwd?: string | null;
  diff_summary?: string | null;
  canonical_message?: boolean;
  /** The required authored Description; merges use its exact canonical Git bytes. */
  commit_message: string;
  verification?: string | null;
  repo?: string;
  base_branch?: string;
  head_branch?: string;
  depends_on_ids?: string[];
  issue_references?: string[] | null;
  issue_closures?: string[] | null;
  /** @deprecated Legacy close-on-merge issue list. */
  issues?: string[] | null;
  session_id?: string | null;
}): Promise<AuthSubmitResponse> {
  return request<AuthSubmitResponse>("POST", "/api/auth/v2/request", payload);
}

// --- Sessions ---

/**
 * Register a channel-connected session under its launcher's app, which is
 * `claude` when unmanaged: the channel server is part of that Claude session.
 */
async function registerSession(payload: {
  id: string;
  status?: string;
  cwd?: string | null;
  branch?: string | null;
  // Bug: 6d7411b — conversation_id for cross-resume matching
  conversation_id?: string | null;
}): Promise<SessionUpdateResponse> {
  return request<SessionUpdateResponse>(
    "POST",
    "/api/sessions/register",
    { ...payload, app },
  );
}

/** The pid recorded on a session row: null when the row has none, undefined when there is no row. */
async function sessionOwnerPid(sessionId: string): Promise<number | null | undefined> {
  try {
    const row = await request<{ pid?: number | null }>("GET", `/api/sessions/${encodeURIComponent(sessionId)}`);
    return row.pid ?? null;
  } catch (error) {
    if (error instanceof ChannelOperationError && error.statusCode === 404) return undefined;
    throw error;
  }
}

/** Bug: 0b454df — notify Mandible that a channel tool was called. */
async function recordChannelToolCall(
  sessionId: string,
  toolName: string,
): Promise<void> {
  await request<unknown>(
    "POST",
    `/api/sessions/${segment(sessionId)}/channel-tool-call`,
    { tool_name: toolName },
  );
}

async function updateSession(
  sessionId: string,
  patch: Record<string, unknown>,
): Promise<SessionUpdateResponse> {
  return request<SessionUpdateResponse>(
    "PATCH",
    `/api/sessions/${segment(sessionId)}`,
    patch,
  );
}

return { checkInbox, checkInboxGlobal, fetchUndeliveredAuthResults, markAuthDelivered, getIssues, getWorkUnits, patchWorkUnit, getAuthQueue, submitAuth, registerSession, sessionOwnerPid, recordChannelToolCall, updateSession };
}
export type ChannelClient = ReturnType<typeof createChannelClient>;
