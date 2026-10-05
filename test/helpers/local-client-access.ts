import { __resetBrowserSessionForTests, ensureClientAccess } from '../../ui/src/client-auth-token';

/** Resolve the local human and same-origin CSRF value without starting an OS service. */
export async function establishTestClientAccess(): Promise<void> {
  __resetBrowserSessionForTests();
  await ensureClientAccess(async () => new Response(JSON.stringify({ authenticated: true,
    session: { csrf_token: 'test-csrf' } }), { headers: { 'content-type': 'application/json' } }));
}
