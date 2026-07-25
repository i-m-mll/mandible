// Dashboard client-auth token handling (issue 708dc4c, finding 3).
//
// The served HTML carries no token (that would leak operator identity to any
// loopback-response reader). Instead the dashboard acquires an ephemeral
// operator session via an authenticated POST /api/client-auth/handshake and
// persists it in localStorage. The server persists the bounded session in a
// protected file, so a strict dashboard can renew it after daemon restart.
// Every same-origin /api request, including fetch-based SSE, carries an
// Authorization header; bearer values never ride in URLs.

const STORAGE_KEY = 'mandible.client_auth.token';
const HANDSHAKE_PATH = '/api/client-auth/handshake';
const WEBSOCKET_AUTH_PROTOCOL_PREFIX = 'mandible-auth.';

/**
 * Outcome of the last handshake attempt (issue 54b5677). The desktop shell
 * needs to distinguish "this surface holds no operator session" (offer a login
 * path) from "the daemon could not answer" (nothing to log into yet).
 */
export type ClientAuthSessionState = 'enrolled' | 'unauthenticated' | 'unreachable';

let sessionState: ClientAuthSessionState = 'unauthenticated';
const sessionStateListeners = new Set<(state: ClientAuthSessionState) => void>();

export function getClientAuthSessionState(): ClientAuthSessionState {
  return sessionState;
}

export function subscribeClientAuthSessionState(
  listener: (state: ClientAuthSessionState) => void,
): () => void {
  sessionStateListeners.add(listener);
  return () => {
    sessionStateListeners.delete(listener);
  };
}

function setSessionState(next: ClientAuthSessionState): void {
  if (next === sessionState) return;
  sessionState = next;
  for (const listener of [...sessionStateListeners]) listener(next);
}

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

/** WebSocket browser APIs cannot set Authorization; use a header subprotocol. */
export function clientAuthWebSocketProtocols(): string[] {
  const token = getStoredToken();
  return token
    ? ['mandible', `${WEBSOCKET_AUTH_PROTOCOL_PREFIX}${token}`]
    : ['mandible'];
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

function adoptTokenFromUrlFragment(): void {
  if (typeof window === 'undefined') return;
  const hash = window.location.hash;
  const queryIndex = hash.indexOf('?');
  if (queryIndex < 0) return;
  const route = hash.slice(0, queryIndex);
  const params = new URLSearchParams(hash.slice(queryIndex + 1));
  const token = params.get('mandible_auth');
  if (!token) return;
  setStoredToken(token);
  params.delete('mandible_auth');
  const remaining = params.toString();
  const nextHash = `${route}${remaining ? `?${remaining}` : ''}`;
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${window.location.search}${nextHash}`,
  );
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
    const attachedStoredToken = !headers.has('Authorization');
    if (attachedStoredToken) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    const retryInput = input instanceof Request ? input.clone() : input;
    const response = await originalFetch(input, { ...init, headers });
    if (response.status === 401 && attachedStoredToken && getStoredToken() === token) {
      const resolved = new URL(url, window.location.origin);
      if (resolved.pathname !== HANDSHAKE_PATH) {
        try {
          const renewal = await originalFetch(HANDSHAKE_PATH, {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              Authorization: `Bearer ${token}`,
            },
          });
          if (renewal.ok) {
            const body = (await renewal.json()) as { token?: unknown };
            if (typeof body.token === 'string' && body.token) {
              setStoredToken(body.token);
              setSessionState('enrolled');
              headers.set('Authorization', `Bearer ${body.token}`);
              return originalFetch(retryInput, { ...init, headers });
            }
          }
        } catch {
          // Fall through to clearing a credential that cannot be renewed.
        }
      }
      if (getStoredToken() === token) {
        clearStoredToken();
        // Losing the session mid-run (e.g. another surface enrolled and rotated
        // it away) must surface a login affordance immediately, not at the next
        // reload.
        setSessionState('unauthenticated');
      }
    }
    return response;
  };
}

/**
 * Renew an enrolled dashboard session on every boot. The handshake requires
 * the existing operator identity; an anonymous compat caller or unrelated
 * strict-mode identity can never use it to acquire operator privilege.
 */
export async function ensureClientAuthToken(): Promise<string | null> {
  adoptTokenFromUrlFragment();
  const existing = getStoredToken();
  if (!existing) {
    setSessionState('unauthenticated');
    return null;
  }
  try {
    const response = await fetch(HANDSHAKE_PATH, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      // 401/403 means the stored credential is not (or is no longer) an
      // operator session, which a login can fix; anything else is a daemon-side
      // problem that logging in again would not resolve.
      setSessionState(
        response.status === 401 || response.status === 403 ? 'unauthenticated' : 'unreachable',
      );
      return getStoredToken();
    }
    const body = (await response.json()) as { token?: unknown };
    if (typeof body.token === 'string' && body.token) {
      setStoredToken(body.token);
      setSessionState('enrolled');
      return body.token;
    }
    setSessionState('unreachable');
    return getStoredToken();
  } catch {
    setSessionState('unreachable');
    return getStoredToken();
  }
}
