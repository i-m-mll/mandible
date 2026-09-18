// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://app.mandible.localhost:19420/"}
import { afterEach, expect, it, vi } from 'vitest';
import {
  __resetBrowserSessionForTests,
  ensureClientAccess,
} from '../../ui/src/client-auth-token.js';

afterEach(() => {
  __resetBrowserSessionForTests();
  vi.restoreAllMocks();
});

it('starts a fresh installed-app handoff when the previous browser family is revoked', async () => {
  let issued = false;
  const opened: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    opened.push(this.href);
  });
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/whoami')) return new Response(JSON.stringify(issued
      ? { authenticated: true, session: {
          family_id: 'new-family', audience: 'production', csrf_token: 'csrf', effect_ceiling: ['ledger:read'],
        } }
      : { authenticated: false, failure_reason: 'revoked' }), { status: 200 });
    if (url.endsWith('/pairing/start')) return new Response(JSON.stringify({ reference: 'A1B2C3D4E5F6' }), { status: 201 });
    if (url.endsWith('/pairing/complete')) {
      issued = true;
      return new Response(JSON.stringify({ session: { family_id: 'new-family' } }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  expect((await ensureClientAccess(fetchImpl)).phase).toBe('ready');
  expect(opened).toEqual(['mandible://access/approve?reference=A1B2C3D4E5F6']);
  expect(fetchImpl.mock.calls.map(([input]) => String(input))).toEqual([
    '/api/client-auth/whoami',
    '/api/client-auth/pairing/start',
    '/api/client-auth/pairing/complete',
    '/api/client-auth/whoami',
    '/api/client-auth/recovery/state',
  ]);
});
