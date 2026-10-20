import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { getBriefingSidebarSnapshot, invalidateApiGetCache } from '../ui/src/api';
import { ensureClientAccess, __resetBrowserSessionForTests } from '../ui/src/client-auth-token';

// Issue 2212987: one row the view cannot show must not hide every other
// Briefing. The snapshot keeps the valid rows and reports each bad row once.

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

const valid = { id: 'briefing-ok', title: 'Daily research', latest_round_id: 'round-1', round_count: 1, created_at: 1, updated_at: 2 };
const roundless = { id: 'briefing:legacy', title: 'arxiv-scan', latest_round_id: null, round_count: 0, created_at: 1, updated_at: 1 };

beforeEach(async () => {
  __resetBrowserSessionForTests();
  await ensureClientAccess(async () => jsonResponse({ authenticated: true, session: { csrf_token: 'test' } }));
  invalidateApiGetCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  invalidateApiGetCache();
});

it('keeps valid Briefings and reports a roundless row once across the list and bundle layouts', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === '/api/briefings') return jsonResponse({ briefings: [roundless, valid] });
    if (path === '/api/briefing-bundles') return jsonResponse({ bundles: [{
      id: 'bundle-1', name: 'Review set', created_at: 1, updated_at: 1,
      layout: [{ kind: 'briefing', briefing: roundless }, { kind: 'briefing', briefing: valid }],
    }] });
    if (path === '/api/briefing-groups') return jsonResponse({ groups: [] });
    return new Response('unexpected request', { status: 500 });
  }));

  const snapshot = await getBriefingSidebarSnapshot();

  expect(snapshot.briefings.map((briefing) => briefing.collectionId)).toEqual(['briefing-ok']);
  expect(snapshot.bundles[0]?.members.map((member) => member.briefing.collectionId)).toEqual(['briefing-ok']);
  expect(snapshot.invalidBriefings).toEqual([{ id: 'briefing:legacy', title: 'arxiv-scan', reason: 'it has no round' }]);
});
