// One browser-session client for fetch, SSE, and WebSocket transports.
// The reusable session credential is an HttpOnly host-only cookie; renderer
// code owns only the session-bound CSRF value returned by whoami.

const WHOAMI_PATH = '/api/client-auth/whoami';
const RENEW_PATH = '/api/client-auth/renew';
const LOGOUT_PATH = '/api/client-auth/logout';
const PENDING_LOGOUT_KEY = 'mandible.session.revocation_pending';
const LEGACY_BEARER_STORAGE_KEY = 'mandible.client_auth.token';
const PREVIEW_TRANSFER_ATTEMPT_KEY = 'mandible.preview_transfer.attempted_at';

export type ClientAuthSessionState =
  | 'enrolled'
  | 'signed-out'
  | 'unreachable'
  | 'wrong-audience'
  | 'expired'
  | 'revoked'
  | 'incompatible';

type SessionProjection = {
  family_id: string;
  audience: string;
  csrf_token: string;
  effect_ceiling: string[];
  expires_at?: number;
  absolute_expires_at?: number;
};

let state: ClientAuthSessionState = 'signed-out';
let session: SessionProjection | null = null;
let pending: Promise<ClientAuthSessionState> | null = null;
let renewal: Promise<boolean> | null = null;
let legacyBearerRetired = false;
const listeners = new Set<(value: ClientAuthSessionState) => void>();

export function getClientAuthSessionState(): ClientAuthSessionState {
  return state;
}

export function isTerminalClientAuthState(value = state): boolean {
  return value === 'signed-out' || value === 'wrong-audience'
    || value === 'expired' || value === 'revoked' || value === 'incompatible';
}

export function subscribeClientAuthSessionState(
  listener: (value: ClientAuthSessionState) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(next: ClientAuthSessionState): ClientAuthSessionState {
  if (state === next) return next;
  state = next;
  for (const listener of listeners) listener(next);
  return next;
}

function pendingLogout(): boolean {
  try {
    return window.localStorage.getItem(PENDING_LOGOUT_KEY) === '1';
  } catch {
    return false;
  }
}

function setPendingLogout(value: boolean): void {
  try {
    if (value) window.localStorage.setItem(PENDING_LOGOUT_KEY, '1');
    else window.localStorage.removeItem(PENDING_LOGOUT_KEY);
  } catch {
    // A storage-disabled browser still stays signed out for this page lifetime.
  }
}

function retireLegacyBrowserBearer(): void {
  if (legacyBearerRetired) return;
  legacyBearerRetired = true;
  try { window.localStorage.removeItem(LEGACY_BEARER_STORAGE_KEY); } catch { /* storage disabled */ }
  const hash = window.location.hash;
  const queryAt = hash.indexOf('?');
  if (queryAt < 0) return;
  const route = hash.slice(0, queryAt);
  const params = new URLSearchParams(hash.slice(queryAt + 1));
  if (!params.has('mandible_auth')) return;
  params.delete('mandible_auth');
  const cleanHash = `${route}${params.size > 0 ? `?${params}` : ''}`;
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${cleanHash}`);
}

function legacyOrigin(): boolean {
  return window.location.origin === 'http://127.0.0.1:19420'
    || window.location.origin === 'http://localhost:19420';
}

function legacyBearer(): string | null {
  try {
    const raw = window.localStorage.getItem(LEGACY_BEARER_STORAGE_KEY)?.trim();
    if (!raw) return null;
    if (!raw.startsWith('{')) return raw;
    const parsed = JSON.parse(raw) as { token?: unknown };
    return typeof parsed.token === 'string' && parsed.token ? parsed.token : null;
  } catch {
    return null;
  }
}

function legacyBrowserState(): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    for (let index = 0; index < window.localStorage.length && Object.keys(result).length < 64; index += 1) {
      const key = window.localStorage.key(index);
      if (!key || key === LEGACY_BEARER_STORAGE_KEY || key === PENDING_LOGOUT_KEY
          || /auth|token|credential|secret/i.test(key) || key.length > 160) continue;
      const value = window.localStorage.getItem(key);
      if (value !== null && value.length <= 64 * 1_024) result[key] = value;
    }
  } catch {
    return {};
  }
  return result;
}

async function beginLegacyConversion(fetchImpl: typeof fetch): Promise<boolean> {
  if (!legacyOrigin()) return false;
  const token = legacyBearer();
  if (!token) return false;
  const response = await fetchImpl('/api/client-auth/legacy-conversion/prepare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      return_path: `${window.location.pathname}${window.location.search}${window.location.hash}`,
      browser_state: legacyBrowserState(),
    }),
  });
  const body = await readJson(response);
  if (!response.ok || typeof body.reference !== 'string' || typeof body.secret !== 'string'
      || typeof body.complete_url !== 'string') return false;
  const complete = new URL(body.complete_url);
  if (complete.protocol !== 'https:' || complete.hostname !== 'app.mandible.localhost'
      || complete.port !== '19419' || complete.pathname !== '/api/client-auth/legacy-conversion/complete') {
    return false;
  }
  const form = document.createElement('form');
  form.method = 'post';
  form.action = complete.href;
  for (const [name, value] of [['reference', body.reference], ['secret', body.secret]] as const) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.append(input);
  }
  document.body.append(form);
  form.submit();
  return true;
}

async function beginPreviewTransfer(fetchImpl: typeof fetch): Promise<boolean> {
  if (!/^preview-[0-9a-f]{16}\.mandible\.localhost$/i.test(window.location.hostname)) return false;
  const now = Date.now();
  try {
    const prior = Number(window.sessionStorage.getItem(PREVIEW_TRANSFER_ATTEMPT_KEY) ?? 0);
    if (Number.isFinite(prior) && now - prior < 60_000) return false;
    window.sessionStorage.setItem(PREVIEW_TRANSFER_ATTEMPT_KEY, String(now));
  } catch {
    // The server-side one-time transaction still bounds retries without storage.
  }
  const response = await fetchImpl('/api/client-auth/preview-transfer/prepare', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ return_path: `${window.location.pathname}${window.location.search}${window.location.hash}` }),
  });
  const body = await readJson(response);
  if (!response.ok || typeof body.authorize_url !== 'string') return false;
  const authorize = new URL(body.authorize_url);
  if (authorize.origin !== 'https://app.mandible.localhost:19420'
      || authorize.pathname !== '/api/client-auth/preview-transfer/authorize') return false;
  window.location.assign(authorize.href);
  return true;
}

async function finishLegacyConversion(fetchImpl: typeof fetch, active: SessionProjection): Promise<void> {
  const response = await fetchImpl('/api/client-auth/legacy-conversion/state', {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  const body = await readJson(response);
  if (!response.ok || typeof body.production_origin !== 'string'
      || typeof body.return_path !== 'string') return;
  const production = new URL(body.production_origin);
  if (production.origin !== 'https://app.mandible.localhost:19420') return;
  if (body.browser_state && typeof body.browser_state === 'object' && !Array.isArray(body.browser_state)) {
    for (const [key, value] of Object.entries(body.browser_state as Record<string, unknown>)) {
      if (typeof value === 'string' && !/auth|token|credential|secret/i.test(key)) {
        try { window.localStorage.setItem(key, value); } catch { /* storage disabled */ }
      }
    }
  }
  if (body.finalized !== true) {
    const finalized = await fetchImpl('/api/client-auth/legacy-conversion/finalize', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-Mandible-CSRF': active.csrf_token },
    });
    if (!finalized.ok) return;
  }
  window.location.replace(`${production.origin}${body.return_path}`);
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const body = await response.clone().json();
    return body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function projection(value: unknown): SessionProjection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.family_id !== 'string' || typeof row.audience !== 'string'
      || typeof row.csrf_token !== 'string' || !Array.isArray(row.effect_ceiling)) return null;
  return {
    family_id: row.family_id,
    audience: row.audience,
    csrf_token: row.csrf_token,
    effect_ceiling: row.effect_ceiling.filter((item): item is string => typeof item === 'string'),
    ...(typeof row.expires_at === 'number' ? { expires_at: row.expires_at } : {}),
    ...(typeof row.absolute_expires_at === 'number'
      ? { absolute_expires_at: row.absolute_expires_at }
      : {}),
  };
}

export function initializeBrowserSession(fetchImpl: typeof fetch = fetch.bind(window)): Promise<ClientAuthSessionState> {
  if (pending) return pending;
  pending = (async () => {
    try {
      if (legacyOrigin()) {
        const started = await beginLegacyConversion(fetchImpl);
        return publish(started ? 'signed-out' : 'unreachable');
      }
      retireLegacyBrowserBearer();
      if (pendingLogout()) {
        const inspected = await fetchImpl(WHOAMI_PATH, {
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
        });
        const inspectedBody = await readJson(inspected);
        const pendingSession = projection(inspectedBody.session);
        const logout = await fetchImpl(LOGOUT_PATH, {
          method: 'POST',
          credentials: 'same-origin',
          headers: pendingSession?.csrf_token ? { 'X-Mandible-CSRF': pendingSession.csrf_token } : {},
        });
        if (!logout.ok && logout.status !== 401) return publish('unreachable');
        setPendingLogout(false);
        session = null;
        return publish('signed-out');
      }
      const response = await fetchImpl(WHOAMI_PATH, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      const body = await readJson(response);
      if (!response.ok || body.authenticated !== true) {
        session = null;
        const reason = body.failure_reason;
        if (!reason || reason === 'unknown') await beginPreviewTransfer(fetchImpl);
        return publish(reason === 'expired' ? 'expired'
          : reason === 'revoked' ? 'revoked'
            : reason === 'wrong_audience' ? 'wrong-audience' : 'signed-out');
      }
      const next = projection(body.session);
      if (!next) {
        session = null;
        return publish('incompatible');
      }
      session = next;
      if (body.legacy_conversion_pending === true) await finishLegacyConversion(fetchImpl, next);
      return publish('enrolled');
    } catch {
      return publish('unreachable');
    }
  })().finally(() => {
    pending = null;
  });
  return pending;
}

function requestPath(input: RequestInfo | URL): string | null {
  try {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const resolved = new URL(raw, window.location.origin);
    return resolved.origin === window.location.origin ? resolved.pathname : null;
  } catch {
    return null;
  }
}

export async function browserSessionFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch.bind(window),
): Promise<Response> {
  const path = requestPath(input);
  if (!path?.startsWith('/api/')) return fetchImpl(input, init);
  const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const unsafe = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
  if (pendingLogout()) {
    return new Response(JSON.stringify({ error: 'revocation_pending' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (unsafe && !session && path !== WHOAMI_PATH && !path.startsWith('/api/client-auth/pairing/')) {
    await initializeBrowserSession(fetchImpl);
  }
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
  if (unsafe && session?.csrf_token) headers.set('X-Mandible-CSRF', session.csrf_token);
  const request = input instanceof Request ? input.clone() : input;
  const response = await fetchImpl(input, { ...init, credentials: 'same-origin', headers });
  if (response.status !== 401 || path.startsWith('/api/client-auth/')) return response;
  renewal ??= (async () => {
    const renewed = await fetchImpl(RENEW_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: session?.csrf_token ? { 'X-Mandible-CSRF': session.csrf_token } : {},
    });
    if (!renewed.ok) {
      const body = await readJson(renewed);
      session = null;
      publish(body.error === 'session_revoked' ? 'revoked' : 'expired');
      return false;
    }
    const renewedBody = await readJson(renewed);
    session = projection(renewedBody.session);
    if (!session) publish('incompatible');
    return Boolean(session);
  })().finally(() => { renewal = null; });
  if (!await renewal) {
    return response;
  }
  const activeSession = session;
  if (!activeSession) return response;
  headers.set('X-Mandible-CSRF', activeSession.csrf_token);
  return fetchImpl(request, { ...init, credentials: 'same-origin', headers });
}

export async function startBrowserPairing(): Promise<string> {
  const response = await browserSessionFetch('/api/client-auth/pairing/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ return_path: `${window.location.pathname}${window.location.search}${window.location.hash}` }),
  });
  const body = await readJson(response);
  if (!response.ok || typeof body.reference !== 'string') throw new Error('Unable to start browser pairing.');
  return body.reference;
}

export async function completeBrowserPairing(reference: string): Promise<ClientAuthSessionState> {
  const response = await browserSessionFetch('/api/client-auth/pairing/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reference }),
  });
  if (!response.ok) throw new Error(response.status === 409 ? 'Pairing has not been approved yet.' : 'Pairing failed.');
  return initializeBrowserSession();
}

export async function logoutClientAuth(fetchImpl: typeof fetch = fetch.bind(window)): Promise<void> {
  try {
    const response = await fetchImpl(LOGOUT_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: session?.csrf_token ? { 'X-Mandible-CSRF': session.csrf_token } : {},
    });
    if (!response.ok && response.status !== 401) throw new Error('logout unavailable');
    setPendingLogout(false);
  } catch {
    setPendingLogout(true);
  } finally {
    session = null;
    publish('signed-out');
  }
}

export function __resetBrowserSessionForTests(): void {
  state = 'signed-out';
  session = null;
  pending = null;
  renewal = null;
  legacyBearerRetired = false;
  listeners.clear();
}
