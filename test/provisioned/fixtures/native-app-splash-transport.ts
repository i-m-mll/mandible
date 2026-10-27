export function controlledReadinessFetch(transport: typeof fetch, pageUrl: URL, reason: 'starting' | 'rebuilding'): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), pageUrl);
    const daemonApi = (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === pageUrl.origin
      && (url.pathname === '/api' || url.pathname.startsWith('/api/'));
    // Tauri protocol IPC also uses POST fetches. It must retain the real transport.
    if (!daemonApi) return transport(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return new Response('Controlled readiness proof is read-only', { status: 503 });
    const response = await transport(input, init);
    if (url.pathname !== '/api/health' || !response.ok || method === 'HEAD') return response;
    const health = await response.json();
    return new Response(JSON.stringify({ ...health, ready: false, warm: false, rebuilding: reason === 'rebuilding' }), {
      status: response.status, headers: response.headers,
    });
  };
}
