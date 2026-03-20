// Bug: 1d652d5 — typed HTTP client for Mandible API
//
// Stateless adapter: all state lives in the Mandible daemon at localhost:19420.
// Every function is a thin wrapper around a single HTTP call with typed
// request/response shapes.

import type {
  InboxResponse,
  AuthQueueResponse,
  IssueRepoSummary,
  WorkUnitsResponse,
  AuthSubmitResponse,
  SessionUpdateResponse,
} from "./types.js";

const BASE_URL = "http://localhost:19420";
const TIMEOUT_MS = 10_000;

export class MandibleClientError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number | null,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "MandibleClientError";
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const opts: RequestInit = {
      method,
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
    };
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }

    const res = await fetch(`${BASE_URL}${path}`, opts);

    if (!res.ok) {
      let detail = "";
      try {
        const errBody = (await res.json()) as { error?: string };
        detail = errBody.error ?? res.statusText;
      } catch {
        detail = res.statusText;
      }
      throw new MandibleClientError(
        `${method} ${path} returned ${res.status}: ${detail}`,
        res.status,
      );
    }

    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof MandibleClientError) throw err;

    const isAbort =
      err instanceof DOMException && err.name === "AbortError";
    if (isAbort) {
      throw new MandibleClientError(
        `${method} ${path} timed out after ${TIMEOUT_MS}ms`,
        null,
        err,
      );
    }

    // Connection refused / network error
    const msg =
      err instanceof Error ? err.message : "Unknown network error";
    throw new MandibleClientError(
      `${method} ${path} failed: ${msg} (is the Mandible daemon running?)`,
      null,
      err,
    );
  } finally {
    clearTimeout(timer);
  }
}

// --- Inbox ---

export async function checkInbox(
  branch?: string,
  repo?: string,
): Promise<InboxResponse> {
  const params = new URLSearchParams();
  if (branch) params.set("branch", branch);
  if (repo) params.set("repo", repo);
  const qs = params.toString();
  return request<InboxResponse>("GET", `/api/inbox${qs ? `?${qs}` : ""}`);
}

export async function checkInboxGlobal(): Promise<InboxResponse> {
  return request<InboxResponse>("GET", "/api/inbox/global");
}

// --- Issues ---

export async function getIssues(filters?: {
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

export async function getWorkUnits(filters?: {
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

export async function patchWorkUnit(
  id: string,
  patch: {
    state?: string;
    assigned_session_id?: string | null;
    continuation?: string | null;
    continuation_by?: string | null;
    continuation_at?: number | null;
  },
): Promise<unknown> {
  return request("PATCH", `/api/work-units/${id}`, patch);
}

// --- Auth ---

export async function getAuthQueue(): Promise<AuthQueueResponse> {
  return request<AuthQueueResponse>("GET", "/api/auth/queue");
}

export async function submitAuth(payload: {
  command: string;
  title: string;
  cwd?: string | null;
  diff_summary?: string | null;
  commit_message?: string | null;
  spec_content?: string | null;
  repo?: string;
  base_branch?: string;
  head_branch?: string;
  issues?: string[] | null;
  session_id?: string | null;
}): Promise<AuthSubmitResponse> {
  return request<AuthSubmitResponse>("POST", "/api/auth/request", payload);
}

// --- Sessions ---

export async function updateSession(
  sessionId: string,
  patch: Record<string, unknown>,
): Promise<SessionUpdateResponse> {
  return request<SessionUpdateResponse>(
    "PATCH",
    `/api/sessions/${sessionId}`,
    patch,
  );
}
