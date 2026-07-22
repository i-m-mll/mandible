// Dashboard client-auth token handling (issue 708dc4c, finding 3).
//
// The served HTML carries no token (that would leak operator identity to any
// loopback-response reader). Instead the dashboard acquires an ephemeral
// operator token via POST /api/client-auth/handshake and persists it in
// localStorage, so a dashboard that handshook in compat keeps working after a
// flip to strict (within the daemon lifetime). Every same-origin /api request
// then carries `Authorization: Bearer <token>`; SSE (which cannot set headers)
// carries the token as a query param.

const STORAGE_KEY = 'mandible.client_auth.token';
const HANDSHAKE_PATH = '/api/client-auth/handshake';

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function getStoredToken(): string | null {
  const store = storage();
  if (!store) return null;
  try {
    const value = store.getItem(STORAGE_KEY);
    return value && value.trim() ? value : null;
  } catch {
    return null;
  }
}

function setStoredToken(token: string): void {
  try {
    storage()?.setItem(STORAGE_KEY, token);
  } catch {
    // localStorage may be unavailable (private mode); the dashboard still works
    // in compat mode without a persisted token.
  }
}

function clearStoredToken(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** Query-string fragment (without leading ? or &) attaching the token for SSE. */
export function clientAuthTokenParam(): string {
  const token = getStoredToken();
  return token ? `token=${encodeURIComponent(token)}` : '';
}

function isSameOriginApiRequest(url: string): boolean {
  try {
    const resolved = new URL(url, window.location.origin);
    return resolved.origin === window.location.origin && resolved.pathname.startsWith('/api');
  } catch {
    return false;
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

let installed = false;

/**
 * Install a global fetch wrapper that attaches the client-auth bearer token to
 * every same-origin /api request. A single interception point covers the many
 * direct fetch call sites without touching each one. A 401 from an API request
 * drops the stored token (e.g. a stale ephemeral token after a daemon restart)
 * so the next dashboard boot re-handshakes.
 */
export function installClientAuthFetch(): void {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  installed = true;
  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = requestUrl(input);
    if (!isSameOriginApiRequest(url)) {
      return originalFetch(input, init);
    }
    const token = getStoredToken();
    if (!token) {
      return originalFetch(input, init);
    }
    const headers = new Headers(
      init.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    if (!headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    const response = await originalFetch(input, { ...init, headers });
    if (response.status === 401) {
      clearStoredToken();
    }
    return response;
  };
}

/**
 * Ensure a client-auth token is available: reuse the stored one, else perform
 * the compat handshake and store the result. Returns the token or null (e.g. no
 * operator configured, or strict mode with no prior token — the dashboard then
 * operates anonymously in compat or surfaces auth failures in strict).
 */
export async function ensureClientAuthToken(): Promise<string | null> {
  const existing = getStoredToken();
  if (existing) return existing;
  try {
    const response = await fetch(HANDSHAKE_PATH, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { token?: unknown };
    if (typeof body.token === 'string' && body.token) {
      setStoredToken(body.token);
      return body.token;
    }
    return null;
  } catch {
    return null;
  }
}
