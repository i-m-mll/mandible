// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://app.mandible.localhost:19420/"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitUntilPasses } from './helpers/wait-until.js';
import { getWorkCompare, clearApiGetCache, patchSession, updateConversation } from '../ui/src/api';
import {
  __resetBrowserSessionForTests, browserSessionFetch, ensureClientAccess, getClientAccessState, retryClientAccess,
} from '../ui/src/client-auth-token';
beforeEach(async () => {
 __resetBrowserSessionForTests();
 await ensureClientAccess(async () => new Response(JSON.stringify({ authenticated: true, session: { family_id: 'test-family', audience: 'production', csrf_token: 'test-csrf', effect_ceiling: ['ledger:read', 'ledger:write'] } }), { status: 200, headers: { 'content-type': 'application/json' } }));
});
afterEach(() => { __resetBrowserSessionForTests(); clearApiGetCache(); vi.unstubAllGlobals(); });

describe('API contract helpers', () => {
  it('loads Projects compare payloads with raw unified diff text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => (
      new Response(JSON.stringify({
        repo_root: '/tmp/repo',
        from: 'main',
        to: 'feature',
        mode: 'merge-base',
        range: 'main...feature',
        raw: 'diff --git a/a.txt b/a.txt\n',
        stat: 'a.txt | 1 +',
      }), {
        headers: { 'content-type': 'application/json' },
      })
    )));

    const compare = await getWorkCompare('repo', { from: 'main', to: 'feature', mode: 'merge-base' });

    expect(compare.raw).toContain('diff --git');
    expect(compare.range).toBe('main...feature');
  });

  it('surfaces server error bodies for PATCH helpers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => (
      new Response(JSON.stringify({ error: 'specific failure' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      })
    )));

    await expect(patchSession('s1', { status: 'dead' })).rejects.toThrow('specific failure');
  });

  it('sends conversation starred updates as booleans', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo, init?: RequestInit) => (
      new Response(JSON.stringify({ id: 'c1', starred: true }), {
        headers: { 'content-type': 'application/json' },
      })
    ));
    vi.stubGlobal('fetch', fetchMock);

    await updateConversation('c1', { starred: true });

    const mutation = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    const body = JSON.parse(String(mutation?.[1]?.body));
    expect(body.starred).toBe(true);
  });
});

const ready = () => new Response(JSON.stringify({ authenticated: true, session: { csrf_token: "csrf" } }), {
  status: 200, headers: { "content-type": "application/json" },
});

describe("OS-owned browser access", () => {
  beforeEach(() => __resetBrowserSessionForTests());

  it("checks local access once and attaches CSRF to concurrent writes", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("whoami") ? ready() : new Response("{}", { status: 200 })) as typeof fetch;
    await Promise.all([
      browserSessionFetch("/api/issues", { method: "POST" }, fetchImpl),
      browserSessionFetch("/api/issues", { method: "POST" }, fetchImpl),
    ]);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes("whoami"))).toHaveLength(1);
    for (const [, init] of fetchImpl.mock.calls.filter(([url]) => String(url) === "/api/issues")) {
      expect(new Headers(init?.headers).get("X-Mandible-CSRF")).toBe("csrf");
    }
  });

  it("pauses a read through a service outage and resumes on an explicit retry", async () => {
    let available = false;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).includes("whoami")
      ? available ? ready() : Promise.reject(new Error("Service unavailable"))
      : new Response(JSON.stringify({ items: ["kept"] }), { status: 200 })) as typeof fetch;
    const read = browserSessionFetch("/api/issues", {}, fetchImpl);
    await waitUntilPasses(() => expect(getClientAccessState().phase).toBe("failed"));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    available = true;
    await retryClientAccess(fetchImpl);
    expect((await read).status).toBe(200);
  });

  it("never replays a write after its response fails", async () => {
    let writes = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("whoami")) return ready();
      writes += 1;
      return new Response(JSON.stringify({ error: "unavailable" }), { status: 503 });
    }) as typeof fetch;
    expect((await browserSessionFetch("/api/issues", { method: "POST" }, fetchImpl)).status).toBe(503);
    expect(writes).toBe(1);
  });

  it("sends no write while local access cannot be checked", async () => {
    const fetchImpl = vi.fn(async () => Promise.reject(new Error("Service unavailable"))) as typeof fetch;
    expect((await browserSessionFetch("/api/issues", { method: "POST" }, fetchImpl)).status).toBe(503);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
