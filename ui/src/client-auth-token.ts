// The registered local origin belongs to the logged-in OS user. The server
// resolves that human on every browser request; the browser keeps only the
// same-origin CSRF value, never a login credential or expiring session.

type ClientAccessState = {
  phase: 'initializing' | 'ready' | 'recovering' | 'failed';
  failure: string | null;
};

let accessState: ClientAccessState = { phase: 'initializing', failure: null };
let csrfToken: string | null = null;
let accessAttempt: Promise<ClientAccessState> | null = null;
const listeners = new Set<(state: ClientAccessState) => void>();

export function getClientAccessState(): ClientAccessState { return accessState; }

export function subscribeClientAccessState(listener: (state: ClientAccessState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(phase: ClientAccessState['phase'], failure: string | null = null): ClientAccessState {
  if (accessState.phase === phase && accessState.failure === failure) return accessState;
  accessState = { phase, failure };
  for (const listener of listeners) listener(accessState);
  return accessState;
}

export function ensureClientAccess(fetchImpl: typeof fetch = fetch.bind(window)): Promise<ClientAccessState> {
  if (accessState.phase === 'ready' || accessState.phase === 'failed') return Promise.resolve(accessState);
  if (accessAttempt) return accessAttempt;
  accessAttempt = (async () => {
    try {
      const response = await fetchImpl('/api/client-auth/whoami', {
        credentials: 'same-origin', headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`Local Mandible service returned HTTP ${response.status}.`);
      const body = await response.json() as {
        authenticated?: boolean;
        session?: { csrf_token?: string } | null;
      };
      if (body.authenticated !== true || !body.session?.csrf_token) {
        throw new Error('The local OS user could not be resolved. Check Mandible operator setup.');
      }
      csrfToken = body.session.csrf_token;
      return publish('ready');
    } catch (error) {
      csrfToken = null;
      return publish('failed', error instanceof Error ? error.message : String(error));
    }
  })().finally(() => { accessAttempt = null; });
  return accessAttempt;
}

export function retryClientAccess(fetchImpl: typeof fetch = fetch.bind(window)): Promise<ClientAccessState> {
  csrfToken = null;
  publish('recovering');
  return ensureClientAccess(fetchImpl);
}

function requestPath(input: RequestInfo | URL): string | null {
  try {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const resolved = new URL(raw, window.location.origin);
    return resolved.origin === window.location.origin ? resolved.pathname : null;
  } catch { return null; }
}

function waitForReady(signal?: AbortSignal | null): Promise<void> {
  if (accessState.phase === 'ready') return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new DOMException('The request was cancelled.', 'AbortError'));
  return new Promise((resolve, reject) => {
    const unsubscribe = subscribeClientAccessState((next) => {
      if (next.phase !== 'ready') return;
      unsubscribe();
      signal?.removeEventListener('abort', abort);
      resolve();
    });
    const abort = () => {
      unsubscribe();
      signal?.removeEventListener('abort', abort);
      reject(new DOMException('The request was cancelled.', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Pause reads during a connection failure. Mutations are never replayed. */
export async function browserSessionFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch.bind(window),
): Promise<Response> {
  const pathname = requestPath(input);
  if (!pathname?.startsWith('/api/') || pathname === '/api/client-auth/whoami'
      || pathname === '/api/health') return fetchImpl(input, init);
  const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const readOnly = method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
    || pathname === '/api/events/subscribe';
  const state = await ensureClientAccess(fetchImpl);
  if (state.phase !== 'ready') {
    if (readOnly) await waitForReady(init.signal);
    else return new Response(JSON.stringify({ error: 'local_access_unavailable' }), {
      status: 503, headers: { 'Content-Type': 'application/json' },
    });
  }
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
  if (!readOnly && csrfToken) headers.set('X-Mandible-CSRF', csrfToken);
  if (pathname === '/api/events/subscribe' && csrfToken) headers.set('X-Mandible-CSRF', csrfToken);
  return fetchImpl(input, { ...init, credentials: 'same-origin', headers });
}

/** Isolated fixture reset; never part of the product access flow. */
export function __resetBrowserSessionForTests(): void {
  csrfToken = null;
  accessAttempt = null;
  publish('initializing');
}
