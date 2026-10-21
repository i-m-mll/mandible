// Bug: 1d652d5 — typed HTTP client for Mandible API
//
// Stateless adapter: all state lives in the Mandible daemon, whose base URL is
// resolved per call by resolveBaseUrl() (issue 70dffb8). Every function is a
// thin wrapper around a single HTTP call with typed request/response shapes.

import type {
  InboxResponse,
  AuthQueueResponse,
  IssueRepoSummary,
  WorkUnitsResponse,
  AuthSubmitResponse,
  SessionUpdateResponse,
  UndeliveredResponse,
  UndeliveredAuthResult,
} from "./types.js";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveBaseUrl, resolveTransport } from "./base-url.js";

const TIMEOUT_MS = 10_000;

/** The app the session's launcher (`mandible wrap`, the Console SDK
 * transport) assigned, or null when this Claude process is not managed. */
function launcherApp(): string | null {
  const app = process.env.MANDIBLE_MANAGED_APP;
  return app && /^[A-Za-z0-9._-]+$/.test(app) ? app : null;
}

export function ambientHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "X-Mandible-Managed-Client": "1" };
  const codeId = process.env.CLAUDE_CODE_SESSION_ID;
  const sessionId = process.env.CLAUDE_SESSION_ID;
  const providerId = codeId && sessionId && codeId !== sessionId ? null : (codeId || sessionId);
  if (providerId) {
    headers["X-Mandible-Ambient-Provider"] = "claude";
    headers["X-Mandible-Ambient-Provider-Session-Id"] = providerId;
  }
  const managedApp = launcherApp();
  const managedSessionId = process.env.MANDIBLE_SESSION_ID;
  if (managedApp && managedSessionId && !/[\x00-\x1f\x7f]/.test(managedSessionId)) {
    headers["X-Mandible-Managed-App"] = managedApp;
    headers["X-Mandible-Managed-Session-Id"] = managedSessionId;
  }
  return headers;
}

export function channelTransportHeaders(kind: "socket" | "http"): Record<string, string> {
  const headers = ambientHeaders();
  if (kind === "http") {
    const token = process.env.MANDIBLE_TOKEN?.trim()
      || (process.env.MANDIBLE_MANAGED_CLIENT === "1" ? localCredential() : "");
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function localRouteCredentialRule(method: string, route: string, body?: unknown): { optional: boolean } | null {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.MANDIBLE_LOCAL_CREDENTIAL_ROUTES_FILE,
    path.resolve(moduleDir, "../../cli/local-credential-routes.json"),
    path.resolve(moduleDir, "../cli/local-credential-routes.json"),
  ].filter((value): value is string => Boolean(value));
  const manifest = candidates.find((candidate) => fs.existsSync(candidate));
  if (!manifest) throw new Error("Mandible local credential route manifest is unavailable");
  const routes = JSON.parse(fs.readFileSync(manifest, "utf8")) as Array<{ method: string; path: string; body_nonempty?: string; credential_optional?: boolean }>;
  if (!Array.isArray(routes)) throw new Error("Invalid Mandible local credential route manifest");
  const pathname = route.split("?", 1)[0];
  const match = routes.find((entry) => entry.method === method &&
    entry.path.split("/").length === pathname.split("/").length &&
    entry.path.split("/").every((part, index) => part.startsWith(":") || part === pathname.split("/")[index]) &&
    (!entry.body_nonempty || (typeof body === "object" && body !== null &&
      typeof (body as Record<string, unknown>)[entry.body_nonempty] === "string" &&
      Boolean((body as Record<string, string>)[entry.body_nonempty]))));
  return match ? { optional: match.credential_optional === true } : null;
}

function localCredential(): string {
  if (process.env.MANDIBLE_NO_KEYCHAIN_TOKEN === "1") {
    throw new Error("Mandible Keychain credential use is disabled");
  }
  try {
    return execFileSync("/usr/bin/security", ["find-generic-password", "-s", "mandible-agent-claude", "-w"], {
      encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error("Mandible durable Claude credential is required in Keychain");
  }
}

async function socketRequest<T>(method: string, route: string, body: unknown): Promise<T> {
  const transport = resolveTransport();
  if (transport.kind !== "socket") throw new Error("Expected local socket transport");
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = { ...channelTransportHeaders("socket"), "Content-Type": "application/json" };
  const credentialRule = localRouteCredentialRule(method, route, body);
  if (credentialRule) {
    try { headers.Authorization = `Bearer ${localCredential()}`; }
    catch (error) { if (!credentialRule.optional) throw error; }
  }
  return new Promise<T>((resolve, reject) => {
    const req = http.request({ socketPath: transport.socketPath, host: "localhost", path: route, method, headers, timeout: TIMEOUT_MS }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if ((res.statusCode ?? 500) >= 400) {
          reject(new MandibleClientError(`${method} ${route} returned ${res.statusCode}: ${raw}`, res.statusCode ?? null));
          return;
        }
        try { resolve(raw ? JSON.parse(raw) as T : undefined as T); }
        catch (error) { reject(error); }
      });
    });
    req.on("error", (error) => reject(new MandibleClientError(
      `${method} ${route} failed on local socket ${transport.socketPath}: ${error.message}`,
      null,
      error,
    )));
    req.on("timeout", () => req.destroy(new Error("Mandible socket request timed out")));
    req.end(payload);
  });
}

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
  if (resolveTransport().kind === "socket") return socketRequest<T>(method, path, body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const opts: RequestInit = {
      method,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...channelTransportHeaders("http"),
      },
    };
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }

    const res = await fetch(`${resolveBaseUrl()}${path}`, opts);

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

/**
 * Bug: 4e32923 — fetch resolved auth_requests owned by `sessionId` that have
 * not yet been delivered. Called once at channel-server startup so a resumed
 * session can replay auth results that resolved while its SSE listener was
 * offline. Returns an empty list (not an error) if Mandible has no rows.
 */
export async function fetchUndeliveredAuthResults(
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
export async function markAuthDelivered(requestId: string): Promise<void> {
  await request<unknown>(
    "POST",
    `/api/inbox/delivered/${encodeURIComponent(requestId)}`,
  );
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
  canonical_message?: boolean;
  commit_message?: string | null;
  verification?: string | null;
  repo?: string;
  base_branch?: string;
  head_branch?: string;
  issue_references?: string[] | null;
  issue_closures?: string[] | null;
  /** @deprecated Legacy close-on-merge issue list. */
  issues?: string[] | null;
  session_id?: string | null;
}): Promise<AuthSubmitResponse> {
  return request<AuthSubmitResponse>("POST", "/api/auth/request", payload);
}

// --- Sessions ---

/**
 * Register a channel-connected session under its launcher's app, which is
 * `claude` when unmanaged: the channel server is part of that Claude session.
 */
export async function registerSession(payload: {
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
    { ...payload, app: launcherApp() ?? "claude" },
  );
}

/** Bug: 0b454df — notify Mandible that a channel tool was called. */
export async function recordChannelToolCall(
  sessionId: string,
  toolName: string,
): Promise<void> {
  await request<unknown>(
    "POST",
    `/api/sessions/${sessionId}/channel-tool-call`,
    { tool_name: toolName },
  );
}

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

export async function spawnConversation(payload: Record<string, unknown>): Promise<{
  spawn: { reservation_id: string; state: string; initial_message_state: string };
  session: { id: string } | null;
}> {
  return request("POST", "/api/conversation-spawns", payload);
}
