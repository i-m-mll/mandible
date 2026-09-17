// One browser-session client for fetch, SSE, and WebSocket transports.
// The reusable session credential is an HttpOnly host-only cookie; renderer
// code owns only the session-bound CSRF value returned by whoami.
import {
  exportLegacyBrowserState,
  LEGACY_BEARER_STORAGE_KEY,
  LegacyBrowserStateError,
  PENDING_LOGOUT_STORAGE_KEY,
  restoreLegacyBrowserState,
} from '../../src/client-auth/legacy-browser-state';

const WHOAMI_PATH = '/api/client-auth/whoami';
const RENEW_PATH = '/api/client-auth/renew';
const LOGOUT_PATH = '/api/client-auth/logout';
const PENDING_REVOCATION_KEY = PENDING_LOGOUT_STORAGE_KEY;
const PREVIEW_TRANSFER_ATTEMPT_KEY = 'mandible.preview_transfer.attempted_at';

export type ClientAuthSessionState =
  | 'enrolled'
  | 'signed-out'
  | 'unreachable'
  | 'wrong-audience'
  | 'expired'
  | 'revoked'
  | 'incompatible'
  | 'migration-blocked';

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
let sessionRevision = 0;
let pending: Promise<ClientAuthSessionState> | null = null;
let renewal: Promise<boolean> | null = null;
let legacyBearerRetired = false;
let migrationFailure: string | null = null;
const listeners = new Set<(value: ClientAuthSessionState) => void>();

export type ClientAccessState = {
  phase: 'initializing' | 'ready' | 'recovering' | 'failed';
  failure: string | null;
};

let accessState: ClientAccessState = { phase: 'initializing', failure: null };
let accessAttempt: Promise<ClientAccessState> | null = null;
let unauthorizedRecoveryRevision: number | null = null;
const accessListeners = new Set<(value: ClientAccessState) => void>();
let readyGate: Promise<void> | null = null;
const pausedReadRequests = new Map<string, Promise<Response>>();

export function getClientAccessState(): ClientAccessState { return accessState; }

export function subscribeClientAccessState(listener: (value: ClientAccessState) => void): () => void {
  accessListeners.add(listener);
  return () => accessListeners.delete(listener);
}

function publishAccess(phase: ClientAccessState['phase'], failure: string | null = null): ClientAccessState {
  if (accessState.phase === phase && accessState.failure === failure) return accessState;
  accessState = { phase, failure };
  for (const listener of accessListeners) listener(accessState);
  return accessState;
}

export function getClientAuthSessionState(): ClientAuthSessionState {
  return state;
}

export function getBrowserSessionMigrationFailure(): string | null {
  return migrationFailure;
}

export function isTerminalClientAuthState(value = state): boolean {
  return value === 'signed-out' || value === 'wrong-audience'
    || value === 'expired' || value === 'revoked' || value === 'incompatible'
    || value === 'migration-blocked';
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

function pendingLegacyRevocation(): boolean {
  try {
    return window.localStorage.getItem(PENDING_REVOCATION_KEY) === '1';
  } catch {
    return false;
  }
}

function clearPendingRevocation(): void {
  try {
    window.localStorage.removeItem(PENDING_REVOCATION_KEY);
  } catch {
    // The old revocation marker remains until storage becomes available.
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
    || window.location.origin === 'http://localhost:19420'
    || window.location.origin === 'http://127.0.0.1:19421'
    || window.location.origin === 'http://localhost:19421';
}

export function isLegacyBrowserOrigin(): boolean {
  return legacyOrigin();
}

export function beginLegacyBrowserRecovery(): void {
  if (!legacyOrigin()) throw new Error('Browser recovery is available only from the old Mandible address.');
  const state = exportLegacyBrowserState(window.localStorage);
  const form = document.createElement('form');
  form.method = 'post';
  form.action = 'https://app.mandible.localhost:19419/api/client-auth/recovery/start';
  for (const [name, value] of [
    ['return_path', `${window.location.pathname}${window.location.search}${window.location.hash}`],
    ['browser_state', JSON.stringify(state)],
  ] as const) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.append(input);
  }
  document.body.append(form);
  form.submit();
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

async function beginLegacyConversion(fetchImpl: typeof fetch): Promise<boolean> {
  if (!legacyOrigin()) return false;
  const token = legacyBearer();
  if (!token) return false;
  const response = await fetchImpl('/api/client-auth/legacy-conversion/prepare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      return_path: `${window.location.pathname}${window.location.search}${window.location.hash}`,
      browser_state: exportLegacyBrowserState(window.localStorage),
    }),
  });
  const body = await readJson(response);
  if (!response.ok || typeof body.reference !== 'string' || typeof body.secret !== 'string'
      || typeof body.complete_url !== 'string') return false;
  const complete = new URL(body.complete_url);
  const exactMigrationHost = complete.hostname === 'app.mandible.localhost'
    || /^preview-[0-9a-f]{16}\.mandible\.localhost$/i.test(complete.hostname);
  if (complete.protocol !== 'https:' || !exactMigrationHost || complete.port !== '19419'
      || complete.pathname !== '/api/client-auth/legacy-conversion/complete'
      || complete.username || complete.password || complete.search || complete.hash) {
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
  if (!response.ok || typeof body.target_origin !== 'string'
      || typeof body.return_path !== 'string') return;
  const target = new URL(body.target_origin);
  const validTarget = target.origin === 'https://app.mandible.localhost:19420'
    || (target.protocol === 'https:' && target.port === '19421'
      && /^preview-[0-9a-f]{16}\.mandible\.localhost$/i.test(target.hostname));
  if (!validTarget || active.audience !== (target.port === '19421'
    ? target.hostname.replace('.mandible.localhost', '')
    : 'production')) return;
  if (body.browser_state === null || body.browser_state === undefined) {
    throw new LegacyBrowserStateError('Legacy browser state is missing from the pending conversion; this profile was not finalized.');
  }
  restoreLegacyBrowserState(window.localStorage, body.browser_state);
  if (body.finalized !== true) {
    const finalized = await fetchImpl('/api/client-auth/legacy-conversion/finalize', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-Mandible-CSRF': active.csrf_token },
    });
    if (!finalized.ok) return;
  }
  retireLegacyBrowserBearer();
  window.location.replace(`${target.origin}${body.return_path}`);
}

async function finishBrowserRecovery(fetchImpl: typeof fetch, active: SessionProjection): Promise<void> {
  if (window.location.hostname !== 'mandible.localhost'
      && window.location.hostname !== 'app.mandible.localhost'
      && !/^preview-[0-9a-f]{16}\.mandible\.localhost$/i.test(window.location.hostname)) return;
  const response = await fetchImpl('/api/client-auth/recovery/state', {
    credentials: 'same-origin', headers: { Accept: 'application/json' },
  });
  if (response.status === 404) return;
  const body = await readJson(response);
  if (!response.ok || typeof body.return_path !== 'string') {
    throw new LegacyBrowserStateError('Saved browser state is unavailable; this profile was not finalized.');
  }
  const returnUrl = new URL(body.return_path, window.location.origin);
  if (returnUrl.origin !== window.location.origin || !body.return_path.startsWith('/')
      || body.return_path.startsWith('//')) {
    throw new LegacyBrowserStateError('Saved browser destination is invalid; this profile was not finalized.');
  }
  restoreLegacyBrowserState(window.localStorage, body.browser_state);
  const finalized = await fetchImpl('/api/client-auth/recovery/finalize', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'X-Mandible-CSRF': active.csrf_token },
  });
  if (!finalized.ok) throw new LegacyBrowserStateError('Saved browser state was restored but could not be finalized; retry safely.');
  window.location.replace(returnUrl.href);
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
      if (pendingLegacyRevocation()) {
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
        clearPendingRevocation();
        session = null;
        sessionRevision += 1;
        return publish('signed-out');
      }
      const response = await fetchImpl(WHOAMI_PATH, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      const body = await readJson(response);
      if (!response.ok) return publish('unreachable');
      if (body.authenticated !== true) {
        session = null;
        sessionRevision += 1;
        const reason = body.failure_reason;
        if (!reason || reason === 'unknown') await beginPreviewTransfer(fetchImpl);
        return publish(reason === 'expired' ? 'expired'
          : reason === 'revoked' ? 'revoked'
            : reason === 'wrong_audience' ? 'wrong-audience' : 'signed-out');
      }
      const next = projection(body.session);
      if (!next) {
        session = null;
        sessionRevision += 1;
        return publish('incompatible');
      }
      session = next;
      sessionRevision += 1;
      if (body.legacy_conversion_pending === true) await finishLegacyConversion(fetchImpl, next);
      await finishBrowserRecovery(fetchImpl, next);
      publishAccess('ready');
      return publish('enrolled');
    } catch (error) {
      if (error instanceof LegacyBrowserStateError) {
        migrationFailure = error.message;
        session = null;
        return publish('migration-blocked');
      }
      return publish('unreachable');
    }
  })().finally(() => {
    pending = null;
  });
  return pending;
}

function accessFailure(reason: ClientAuthSessionState): string {
  switch (reason) {
    case 'revoked': return 'This browser session was revoked. Check local access authority before connecting this profile again.';
    case 'wrong-audience': return 'This browser belongs to a different Mandible installation.';
    case 'migration-blocked': return migrationFailure ?? 'Saved browser state could not be restored.';
    case 'incompatible': return 'Mandible returned an incompatible session. Restart the local app after updating it.';
    case 'unreachable': return 'The local Mandible service is unavailable. Check that the installed app is running.';
    default: return 'The installed app could not establish local access for this browser.';
  }
}

async function requestInstalledAppAccess(fetchImpl: typeof fetch): Promise<boolean> {
  if (window.location.protocol !== 'https:'
      || !['mandible.localhost', 'app.mandible.localhost'].includes(window.location.hostname)) return false;
  const started = await fetchImpl('/api/client-auth/pairing/start', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ return_path: `${window.location.pathname}${window.location.search}${window.location.hash}` }),
  });
  const details = await readJson(started);
  if (!started.ok || typeof details.reference !== 'string'
      || !/^[0-9a-f]{12}$/i.test(details.reference)) return false;
  const reference = details.reference;
  const link = `mandible://access/approve?reference=${reference}`;
  const opener = document.createElement('a');
  opener.href = link;
  opener.style.display = 'none';
  document.body.append(opener);
  opener.click();
  opener.remove();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const completed = await fetchImpl('/api/client-auth/pairing/complete', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference }),
    });
    if (completed.ok) return true;
    if (completed.status !== 409) return false;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

/** One access episode gates all private reads. Native proof never enters JavaScript. */
export function ensureClientAccess(fetchImpl: typeof fetch = fetch.bind(window)): Promise<ClientAccessState> {
  if (accessState.phase === 'ready') return Promise.resolve(accessState);
  if (accessState.phase === 'failed') return Promise.resolve(accessState);
  if (accessAttempt) return accessAttempt;
  publishAccess(accessState.phase === 'initializing' ? 'initializing' : 'recovering');
  accessAttempt = (async () => {
    let result = await initializeBrowserSession(fetchImpl);
    if (result === 'enrolled') return publishAccess('ready');
    if (pendingLegacyRevocation()) {
      return publishAccess('failed', 'A prior browser revocation is pending. Restore the local service before access can resume.');
    }
    if (result !== 'wrong-audience' && result !== 'incompatible' && result !== 'migration-blocked') {
      const { isDesktopShell, enrollDesktopClientAuth } = await import('./api');
      if (isDesktopShell()) {
        for (const source of ['bootstrap', 'keychain'] as const) {
          const enrolled = await enrollDesktopClientAuth(source);
          if (!enrolled) continue;
          result = await initializeBrowserSession(fetchImpl);
          if (result === 'enrolled') return publishAccess('ready');
          if (result !== 'expired' && result !== 'signed-out'
              && result !== 'unreachable' && result !== 'revoked') break;
        }
      } else if (await requestInstalledAppAccess(fetchImpl)) {
        result = await initializeBrowserSession(fetchImpl);
        if (result === 'enrolled') return publishAccess('ready');
      }
    }
    return publishAccess('failed', accessFailure(result));
  })().catch((error) => publishAccess('failed', error instanceof Error ? error.message : String(error)))
    .finally(() => { accessAttempt = null; });
  return accessAttempt;
}

export function retryClientAccess(fetchImpl: typeof fetch = fetch.bind(window)): Promise<ClientAccessState> {
  if (accessState.phase === 'failed' || accessState.phase === 'ready') {
    publishAccess('recovering');
  }
  return ensureClientAccess(fetchImpl);
}

function waitForReady(signal?: AbortSignal | null): Promise<void> {
  if (accessState.phase === 'ready') return Promise.resolve();
  readyGate ??= new Promise<void>((resolve) => {
    const unsubscribe = subscribeClientAccessState((next) => {
      if (next.phase !== 'ready') return;
      unsubscribe();
      readyGate = null;
      resolve();
    });
  });
  if (!signal) return readyGate;
  if (signal.aborted) return Promise.reject(new DOMException('The request was cancelled.', 'AbortError'));
  return new Promise((resolve, reject) => {
    const unsubscribe = subscribeClientAccessState((next) => {
      if (next.phase !== 'ready') return;
      unsubscribe();
      signal.removeEventListener('abort', abort);
      resolve();
    });
    const abort = () => {
      unsubscribe();
      signal.removeEventListener('abort', abort);
      reject(new DOMException('The request was cancelled.', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
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

function pausedReadKey(input: RequestInfo | URL, init: RequestInit): string | null {
  if (accessState.phase === 'ready' || init.signal || input instanceof Request) return null;
  const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return null;
  const raw = typeof input === 'string' ? input : input.href;
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) return null;
    return JSON.stringify([method, url.href,
      [...headers.entries()].sort(([a], [b]) => a.localeCompare(b))]);
  } catch {
    return null;
  }
}

export function browserSessionFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch.bind(window),
): Promise<Response> {
  const key = pausedReadKey(input, init);
  if (key) {
    let shared = pausedReadRequests.get(key);
    if (!shared) {
      shared = browserSessionFetchCore(input, init, fetchImpl);
      pausedReadRequests.set(key, shared);
      void shared.then(() => pausedReadRequests.delete(key), () => pausedReadRequests.delete(key));
    }
    return shared.then((response) => response.clone());
  }
  return browserSessionFetchCore(input, init, fetchImpl);
}

async function browserSessionFetchCore(
  input: RequestInfo | URL,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const path = requestPath(input);
  if (!path?.startsWith('/api/')) return fetchImpl(input, init);
  if (path === WHOAMI_PATH || path === RENEW_PATH
      || path === '/api/client-auth/pairing/start'
      || path === '/api/client-auth/pairing/complete'
      || path === '/api/health') {
    return fetchImpl(input, init);
  }
  const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const unsafe = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
  const readOnly = !unsafe || path === '/api/events/subscribe';
  const signal = init.signal ?? (input instanceof Request ? input.signal : undefined);
  const access = await ensureClientAccess(fetchImpl);
  if (access.phase !== 'ready') {
    if (readOnly) await waitForReady(signal);
    else return new Response(JSON.stringify({ error: 'local_access_unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
  if (unsafe && session?.csrf_token) headers.set('X-Mandible-CSRF', session.csrf_token);
  const request = input instanceof Request ? input.clone() : input;
  const requestSessionRevision = sessionRevision;
  const response = await fetchImpl(input, { ...init, credentials: 'same-origin', headers });
  if (response.status !== 401) return response;
  if (!readOnly) {
    if (requestSessionRevision === sessionRevision
        && unauthorizedRecoveryRevision !== requestSessionRevision) {
      unauthorizedRecoveryRevision = requestSessionRevision;
      void retryClientAccess(fetchImpl);
    }
    return response;
  }
  if (requestSessionRevision !== sessionRevision) {
    await waitForReady(signal);
    if (session?.csrf_token) headers.set('X-Mandible-CSRF', session.csrf_token);
    return fetchImpl(request, { ...init, credentials: 'same-origin', headers });
  }
  renewal ??= (async () => {
    let renewed: Response;
    try {
      renewed = await fetchImpl(RENEW_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        headers: session?.csrf_token ? { 'X-Mandible-CSRF': session.csrf_token } : {},
      });
    } catch {
      session = null;
      sessionRevision += 1;
      publish('unreachable');
      publishAccess('recovering');
      return false;
    }
    if (!renewed.ok) {
      const body = await readJson(renewed);
      session = null;
      sessionRevision += 1;
      publish(body.error === 'session_revoked' ? 'revoked' : 'expired');
      publishAccess('recovering');
      return false;
    }
    const renewedBody = await readJson(renewed);
    session = projection(renewedBody.session);
    sessionRevision += 1;
    if (!session) publish('incompatible');
    return Boolean(session);
  })().finally(() => { renewal = null; });
  if (!await renewal) {
    if (unauthorizedRecoveryRevision !== requestSessionRevision) {
      unauthorizedRecoveryRevision = requestSessionRevision;
      void retryClientAccess(fetchImpl);
    }
    await waitForReady(signal);
  }
  const activeSession = session;
  if (!activeSession) return response;
  headers.set('X-Mandible-CSRF', activeSession.csrf_token);
  return fetchImpl(request, { ...init, credentials: 'same-origin', headers });
}

export function __resetBrowserSessionForTests(): void {
  state = 'signed-out';
  session = null;
  sessionRevision = 0;
  pending = null;
  renewal = null;
  legacyBearerRetired = false;
  migrationFailure = null;
  listeners.clear();
  accessState = { phase: 'initializing', failure: null };
  accessAttempt = null;
  unauthorizedRecoveryRevision = null;
  accessListeners.clear();
  readyGate = null;
  pausedReadRequests.clear();
}
