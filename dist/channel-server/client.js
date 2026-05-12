// Bug: 1d652d5 — typed HTTP client for Mandible API
//
// Stateless adapter: all state lives in the Mandible daemon at localhost:19420.
// Every function is a thin wrapper around a single HTTP call with typed
// request/response shapes.
const BASE_URL = "http://localhost:19420";
const TIMEOUT_MS = 10_000;
export class MandibleClientError extends Error {
    statusCode;
    cause;
    constructor(message, statusCode, cause) {
        super(message);
        this.statusCode = statusCode;
        this.cause = cause;
        this.name = "MandibleClientError";
    }
}
async function request(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const opts = {
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
                const errBody = (await res.json());
                detail = errBody.error ?? res.statusText;
            }
            catch {
                detail = res.statusText;
            }
            throw new MandibleClientError(`${method} ${path} returned ${res.status}: ${detail}`, res.status);
        }
        return (await res.json());
    }
    catch (err) {
        if (err instanceof MandibleClientError)
            throw err;
        const isAbort = err instanceof DOMException && err.name === "AbortError";
        if (isAbort) {
            throw new MandibleClientError(`${method} ${path} timed out after ${TIMEOUT_MS}ms`, null, err);
        }
        // Connection refused / network error
        const msg = err instanceof Error ? err.message : "Unknown network error";
        throw new MandibleClientError(`${method} ${path} failed: ${msg} (is the Mandible daemon running?)`, null, err);
    }
    finally {
        clearTimeout(timer);
    }
}
// --- Inbox ---
export async function checkInbox(branch, repo) {
    const params = new URLSearchParams();
    if (branch)
        params.set("branch", branch);
    if (repo)
        params.set("repo", repo);
    const qs = params.toString();
    return request("GET", `/api/inbox${qs ? `?${qs}` : ""}`);
}
export async function checkInboxGlobal() {
    return request("GET", "/api/inbox/global");
}
/**
 * Bug: 4e32923 — fetch resolved auth_requests owned by `sessionId` that have
 * not yet been delivered. Called once at channel-server startup so a resumed
 * session can replay auth results that resolved while its SSE listener was
 * offline. Returns an empty list (not an error) if Mandible has no rows.
 */
export async function fetchUndeliveredAuthResults(sessionId, conversationId) {
    const params = new URLSearchParams({ target_session_id: sessionId });
    // Bug: 6d7411b — pass conversation_id so the server can also match auth
    // requests submitted under a previous session id for the same conversation.
    if (conversationId)
        params.set("conversation_id", conversationId);
    const res = await request("GET", `/api/inbox/undelivered?${params.toString()}`);
    return res.undelivered;
}
/**
 * Bug: 4e32923 — mark an auth_request as delivered via the canonical
 * POST /api/inbox/delivered/<id> endpoint. Idempotent (204 on first delivery,
 * 204 on subsequent calls). Used by the startup catch-up path; live SSE
 * delivery uses the lower-level `markDelivered` in notifications.ts which
 * fires-and-forgets without awaiting a response.
 */
export async function markAuthDelivered(requestId) {
    await request("POST", `/api/inbox/delivered/${encodeURIComponent(requestId)}`);
}
// --- Issues ---
export async function getIssues(filters) {
    const params = new URLSearchParams();
    if (filters?.repo)
        params.set("repo", filters.repo);
    if (filters?.status)
        params.set("status", filters.status);
    if (filters?.label)
        params.set("label", filters.label);
    const qs = params.toString();
    return request("GET", `/api/issues${qs ? `?${qs}` : ""}`);
}
// --- Work Units ---
export async function getWorkUnits(filters) {
    const params = new URLSearchParams();
    if (filters?.state)
        params.set("state", filters.state);
    if (filters?.repo_id)
        params.set("repo_id", filters.repo_id);
    if (filters?.branch)
        params.set("branch", filters.branch);
    if (filters?.issue_id)
        params.set("issue_id", filters.issue_id);
    const qs = params.toString();
    return request("GET", `/api/work-units${qs ? `?${qs}` : ""}`);
}
export async function patchWorkUnit(id, patch) {
    return request("PATCH", `/api/work-units/${id}`, patch);
}
// --- Auth ---
export async function getAuthQueue() {
    return request("GET", "/api/auth/queue");
}
export async function submitAuth(payload) {
    return request("POST", "/api/auth/request", payload);
}
// --- Sessions ---
/** Bug: 0b454df — register a channel-connected session with Mandible. */
export async function registerSession(payload) {
    return request("POST", "/api/sessions/register", payload);
}
/** Bug: 0b454df — notify Mandible that a channel tool was called. */
export async function recordChannelToolCall(sessionId, toolName) {
    await request("POST", `/api/sessions/${sessionId}/channel-tool-call`, { tool_name: toolName });
}
export async function updateSession(sessionId, patch) {
    return request("PATCH", `/api/sessions/${sessionId}`, patch);
}
