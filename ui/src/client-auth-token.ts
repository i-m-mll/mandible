// Browser-profile client authentication.
//
// Each Mandible instance owns a stable protected authority directory. The raw
// bounded session stays in this browser origin; the server stores only its
// fingerprint. The public authority id lets the browser recognize that a
// different daemon temporarily occupied the same port without presenting or
// discarding its credential.

const STORAGE_KEY = 'mandible.client_auth.token';
const HANDSHAKE_PATH = '/api/client-auth/handshake';
const WHOAMI_PATH = '/api/client-auth/whoami';
const HEALTH_PATH = '/api/health';
const LOGOUT_PATH = '/api/client-auth/logout';
const WEBSOCKET_AUTH_PROTOCOL_PREFIX = 'mandible-auth.';

type StoredClientAuthSession = {
  version: 1;
  token: string;
  audience: string | null;
  expires_at: number | null;
};

export type ClientAuthSessionState =
  | 'enrolled'
  | 'unauthenticated'
  | 'unreachable'
  | 'wrong-audience'
  | 'expired'
  | 'revoked';

let sessionState: ClientAuthSessionState = 'unauthenticated';
let currentAudience: string | null = null;
const sessionStateListeners = new Set<(state: ClientAuthSessionState) => void>();

export class ClientAuthRenewalCoordinator {
  private pending: Promise<string | null> | null = null;

  run(operation: () => Promise<string | null>): Promise<string | null> {
    if (this.pending) return this.pending;
    this.pending = operation().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
}

const renewalCoordinator = new ClientAuthRenewalCoordinator();

export function getClientAuthSessionState(): ClientAuthSessionState {
  return sessionState;
}

export function isTerminalClientAuthState(
  state: ClientAuthSessionState = sessionState,
): boolean {
  return state === 'unauthenticated'
    || state === 'wrong-audience'
    || state === 'expired'
    || state === 'revoked';
}

export function subscribeClientAuthSessionState(
  listener: (state: ClientAuthSessionState) => void,
): () => void {
  sessionStateListeners.add(listener);
  return () => sessionStateListeners.delete(listener);
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

function storedSession(): StoredClientAuthSession | null {
  try {
    const raw = storage()?.getItem(STORAGE_KEY)?.trim();
    if (!raw) return null;
    if (!raw.startsWith('{')) {
      return { version: 1, token: raw, audience: null, expires_at: null };
    }
    const parsed = JSON.parse(raw) as Partial<StoredClientAuthSession>;
    if (parsed.version !== 1 || typeof parsed.token !== 'string' || !parsed.token) return null;
    return {
      version: 1,
      token: parsed.token,
      audience: typeof parsed.audience === 'string' ? parsed.audience : null,
      expires_at: typeof parsed.expires_at === 'number' ? parsed.expires_at : null,
    };
  } catch {
    return null;
  }
}

export function getStoredToken(): string | null {
  return storedSession()?.token ?? null;
}

export function clientAuthWebSocketProtocols(): string[] {
  const token = getStoredToken();
  return token ? ['mandible', `${WEBSOCKET_AUTH_PROTOCOL_PREFIX}${token}`] : ['mandible'];
}

function setStoredSession(
  token: string,
  audience: string | null,
  expiresAt: number | null,
): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      token,
      audience,
      expires_at: expiresAt,
    } satisfies StoredClientAuthSession));
  } catch {
    // A storage-disabled browser can still use the session for this page load.
  }
}

function setLegacyToken(token: string): void {
  try {
    storage()?.setItem(STORAGE_KEY, token);
  } catch {
    // The authenticated request below will report the unavailable store.
  }
}

function clearStoredSession(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // Explicit logout has still dropped the renderer's in-memory state.
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
  setLegacyToken(token);
  params.delete('mandible_auth');
  const remaining = params.toString();
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${window.location.search}${route}${remaining ? `?${remaining}` : ''}`,
  );
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function sameOriginApiPath(url: string): string | null {
  try {
    const resolved = new URL(url, window.location.origin);
    return resolved.origin === window.location.origin && resolved.pathname.startsWith('/api')
      ? resolved.pathname
      : null;
  } catch {
    return null;
  }
}

function stateForFailure(reason: unknown): ClientAuthSessionState {
  if (reason === 'expired') return 'expired';
  if (reason === 'revoked') return 'revoked';
  return 'unauthenticated';
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const body = await response.clone().json();
    return body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

async function readAudience(fetchImpl: typeof fetch): Promise<string | null> {
  const response = await fetchImpl(HEALTH_PATH, { headers: { Accept: 'application/json' } });
  if (!response.ok) return null;
  const body = await responseJson(response);
  const auth = body.client_auth && typeof body.client_auth === 'object'
    ? body.client_auth as Record<string, unknown>
    : null;
  return typeof auth?.authority_id === 'string' ? auth.authority_id : null;
}

async function renewStoredSession(
  fetchImpl: typeof fetch,
  expectedToken: string,
): Promise<string | null> {
  return renewalCoordinator.run(async () => {
    try {
      const audience = await readAudience(fetchImpl);
      currentAudience = audience;
      const stored = storedSession();
      if (!stored || stored.token !== expectedToken) return stored?.token ?? null;
      if (stored.audience && audience && stored.audience !== audience) {
        setSessionState('wrong-audience');
        return null;
      }
      const response = await fetchImpl(HANDSHAKE_PATH, {
        method: 'POST',
        headers: { Accept: 'application/json', Authorization: `Bearer ${expectedToken}` },
      });
      const body = await responseJson(response);
      if (!response.ok) {
        setSessionState(response.status === 401 || response.status === 403
          ? stateForFailure(body.reason ?? body.code)
          : 'unreachable');
        return null;
      }
      if (typeof body.token !== 'string' || !body.token) {
        setSessionState('unreachable');
        return null;
      }
      const nextAudience = typeof body.audience === 'string' ? body.audience : audience;
      if (audience && nextAudience && audience !== nextAudience) {
        setSessionState('wrong-audience');
        return null;
      }
      setStoredSession(
        body.token,
        nextAudience,
        typeof body.expires_at === 'number' ? body.expires_at : null,
      );
      setSessionState('enrolled');
      return body.token;
    } catch {
      setSessionState('unreachable');
      return null;
    }
  });
}

let installed = false;

export function installClientAuthFetch(): void {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  installed = true;
  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const path = sameOriginApiPath(requestUrl(input));
    if (!path || path === HEALTH_PATH || path === '/api/instance') {
      return originalFetch(input, init);
    }
    const stored = storedSession();
    if (!stored) return originalFetch(input, init);
    if (stored.audience && currentAudience && stored.audience !== currentAudience) {
      setSessionState('wrong-audience');
      return new Response(JSON.stringify({
        error: 'authentication_required',
        reason: 'wrong_audience',
      }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    const headers = new Headers(
      init.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const attachedStoredToken = !headers.has('Authorization');
    if (attachedStoredToken) headers.set('Authorization', `Bearer ${stored.token}`);
    const retryInput = input instanceof Request ? input.clone() : input;
    const response = await originalFetch(input, { ...init, headers });
    if (response.status !== 401 || !attachedStoredToken || path === HANDSHAKE_PATH) {
      return response;
    }
    const renewed = await renewStoredSession(originalFetch, stored.token);
    if (!renewed) return response;
    headers.set('Authorization', `Bearer ${renewed}`);
    return originalFetch(retryInput, { ...init, headers });
  };
}

export async function ensureClientAuthToken(): Promise<string | null> {
  adoptTokenFromUrlFragment();
  const stored = storedSession();
  if (!stored) {
    setSessionState('unauthenticated');
    return null;
  }
  try {
    currentAudience = await readAudience(fetch.bind(window));
    if (stored.audience && currentAudience && stored.audience !== currentAudience) {
      setSessionState('wrong-audience');
      return stored.token;
    }
    const response = await fetch(WHOAMI_PATH, { headers: { Accept: 'application/json' } });
    const body = await responseJson(response);
    if (!response.ok) {
      setSessionState(response.status === 401 || response.status === 403
        ? stateForFailure(body.reason ?? body.code)
        : 'unreachable');
      return stored.token;
    }
    if (response.ok
        && body.authenticated === true
        && body.evidence_method === 'ephemeral'
        && body.ephemeral_purpose === 'dashboard_handshake') {
      const audience = typeof body.audience === 'string' ? body.audience : currentAudience;
      const session = body.session && typeof body.session === 'object'
        ? body.session as Record<string, unknown>
        : null;
      setStoredSession(
        stored.token,
        audience,
        typeof session?.expires_at === 'number' ? session.expires_at : stored.expires_at,
      );
      setSessionState('enrolled');
      return stored.token;
    }
    const renewed = await renewStoredSession(fetch.bind(window), stored.token);
    if (renewed) return renewed;
    if (sessionState === 'unreachable' || sessionState === 'wrong-audience') return stored.token;
    setSessionState(stateForFailure(body.failure_reason));
    return stored.token;
  } catch {
    setSessionState('unreachable');
    return stored.token;
  }
}

export async function logoutClientAuth(): Promise<void> {
  try {
    await fetch(LOGOUT_PATH, { method: 'POST', headers: { Accept: 'application/json' } });
  } finally {
    clearStoredSession();
    setSessionState('unauthenticated');
  }
}
