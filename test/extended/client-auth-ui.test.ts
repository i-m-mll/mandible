// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetBrowserSessionForTests, browserSessionFetch, getClientAccessState,
  getClientAuthSessionState, initializeBrowserSession, retryClientAccess,
} from "../../ui/src/client-auth-token.js";
import { SSEClient } from "../../ui/src/sse-client.js";

const enrolled = () => new Response(JSON.stringify({
  authenticated: true,
  session: { family_id: "family", audience: "production", csrf_token: "csrf", effect_ceiling: ["ledger:read", "ledger:write"] },
}), { status: 200, headers: { "content-type": "application/json" } });

beforeEach(() => __resetBrowserSessionForTests());
afterEach(() => { __resetBrowserSessionForTests(); vi.useRealTimers(); });

describe("cookie browser session transport", () => {
  it("shares one initialization and attaches CSRF to concurrent writes", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([String(input), init]);
      return String(input).includes("whoami") ? enrolled() : new Response("{}", { status: 200 });
    }) as typeof fetch;
    await Promise.all([
      browserSessionFetch("/api/issues", { method: "POST" }, fetchImpl),
      browserSessionFetch("/api/issues", { method: "POST" }, fetchImpl),
    ]);
    expect(calls.filter(([url]) => url.includes("whoami"))).toHaveLength(1);
    for (const [, init] of calls.filter(([url]) => url === "/api/issues")) {
      expect(new Headers(init?.headers).get("X-Mandible-CSRF")).toBe("csrf");
    }
  });

  it("reports an audience mismatch without falling back to a bearer", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ authenticated: false, failure_reason: "wrong_audience" }), {
      status: 200, headers: { "content-type": "application/json" },
    })) as typeof fetch;
    const response = await browserSessionFetch("/api/issues", { method: "POST" }, fetchImpl);
    expect(getClientAuthSessionState()).toBe("wrong-audience");
    expect(getClientAccessState().phase).toBe("failed");
    expect(response.status).toBe(503);
    expect(fetchImpl.mock.calls.flatMap(([, init]) => [...new Headers(init?.headers).keys()])).not.toContain("authorization");
  });

  it("never replays a mutation after an access failure", async () => {
    let writes = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("whoami")) return enrolled();
      writes += 1;
      return new Response(JSON.stringify({ error: "session_expired" }), { status: 401 });
    }) as typeof fetch;
    const response = await browserSessionFetch("/api/issues", { method: "POST" }, fetchImpl);
    expect(response.status).toBe(401);
    expect(writes).toBe(1);
  });

  it("pauses a private read instead of returning an empty collection while access fails", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      authenticated: false, failure_reason: "wrong_audience",
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const read = browserSessionFetch(new Request("http://localhost:3000/api/issues", {
      signal: controller.signal,
    }), {}, fetchImpl);
    await vi.waitFor(() => expect(getClientAccessState().phase).toBe("failed"));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    controller.abort();
    await expect(read).rejects.toMatchObject({ name: "AbortError" });
  });

  it("holds concurrent first-401 reads through one failed recovery and replays them after a later retry", async () => {
    let available = true;
    let reads = 0;
    let renewals = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("whoami")) return available ? enrolled() : new Response(JSON.stringify({
        authenticated: false, failure_reason: "wrong_audience",
      }), { status: 200 });
      if (url.includes("renew")) {
        renewals += 1;
        available = false;
        return new Response(JSON.stringify({ error: "session_expired" }), { status: 401 });
      }
      if (url.includes('/api/independent')) return new Response(JSON.stringify({ error: 'independent_failure' }), { status: 500 });
      reads += 1;
      return available
        ? new Response(JSON.stringify({ items: ["kept"] }), { status: 200 })
        : new Response(JSON.stringify({ error: "session_expired" }), { status: 401 });
    }) as typeof fetch;
    await initializeBrowserSession(fetchImpl);
    available = false;
    const first = browserSessionFetch("/api/issues", {}, fetchImpl);
    const second = browserSessionFetch("/api/projects", {}, fetchImpl);
    await vi.waitFor(() => expect(getClientAccessState().phase).toBe("failed"));
    expect(renewals).toBe(1);
    expect(reads).toBe(2);
    available = true;
    await retryClientAccess(fetchImpl);
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(reads).toBe(4);
    expect((await browserSessionFetch('/api/independent', {}, fetchImpl)).status).toBe(500);
  });

  it("cancels one paused read without cancelling another during recovery", async () => {
    let available = false;
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).includes("whoami")
      ? available ? enrolled() : new Response(JSON.stringify({ authenticated: false, failure_reason: "wrong_audience" }), { status: 200 })
      : new Response(JSON.stringify({ items: ["kept"] }), { status: 200 })) as typeof fetch;
    const cancelled = browserSessionFetch(new Request("http://localhost:3000/api/issues", {
      signal: controller.signal,
    }), {}, fetchImpl);
    const retained = browserSessionFetch("/api/projects", {}, fetchImpl);
    await vi.waitFor(() => expect(getClientAccessState().phase).toBe("failed"));
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    available = true;
    await retryClientAccess(fetchImpl);
    expect((await retained).status).toBe(200);
  });

  it("retries a stale in-flight read with the newer session without renewing twice", async () => {
    let releaseSecond!: (response: Response) => void;
    let firstCalls = 0;
    let secondCalls = 0;
    let renewals = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("whoami")) return enrolled();
      if (url.includes("renew")) {
        renewals += 1;
        return new Response(JSON.stringify({ session: {
          family_id: "family-2", audience: "production", csrf_token: "csrf-2", effect_ceiling: ["ledger:read"],
        } }), { status: 200 });
      }
      if (url.includes("/api/first")) {
        firstCalls += 1;
        return new Response("{}", { status: firstCalls === 1 ? 401 : 200 });
      }
      secondCalls += 1;
      return secondCalls === 1
        ? new Promise<Response>((resolve) => { releaseSecond = resolve; })
        : new Response("{}", { status: 200 });
    }) as typeof fetch;
    await initializeBrowserSession(fetchImpl);
    const delayed = browserSessionFetch("/api/second", {}, fetchImpl);
    await vi.waitFor(() => expect(secondCalls).toBe(1));
    expect((await browserSessionFetch("/api/first", {}, fetchImpl)).status).toBe(200);
    releaseSecond(new Response("{}", { status: 401 }));
    expect((await delayed).status).toBe(200);
    expect(renewals).toBe(1);
    expect(secondCalls).toBe(2);
  });

  it("shares repeated paused polls for one resource without dropping a read", async () => {
    let available = false;
    let reads = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('whoami')) return available
        ? enrolled()
        : new Response(JSON.stringify({ authenticated: false, failure_reason: 'wrong_audience' }), { status: 200 });
      reads += 1;
      return new Response(JSON.stringify({ items: ['kept'] }), { status: 200 });
    }) as typeof fetch;
    const polls = Array.from({ length: 160 }, () => browserSessionFetch('/api/issues', {}, fetchImpl));
    await vi.waitFor(() => expect(getClientAccessState().phase).toBe('failed'));
    expect(reads).toBe(0);
    available = true;
    await retryClientAccess(fetchImpl);
    expect((await Promise.all(polls)).every((response) => response.status === 200)).toBe(true);
    expect(reads).toBe(1);
  });
});

describe("authenticated SSE transport", () => {
  it("subscribes with POST and parses an event-stream frame", async () => {
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("whoami")) return enrolled();
      expect(init?.method).toBe("POST");
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode('data: {"type":"issue:updated","data":{"id":"x"}}\n\n')); } }), {
        status: 200, headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const client = new SSEClient({ fetchImpl, backoffMs: 10 });
    const received = vi.fn(); client.on("issue:updated", received); client.connect();
    await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(1));
    client.close();
  });
});

describe("native enrollment source", () => {
  it("installs an HttpOnly session cookie without renderer-visible credential URLs", () => {
    const rust = fs.readFileSync(path.resolve("src-tauri/src/lib.rs"), "utf8");
    expect(rust).toContain("__Host-mandible-session=");
    expect(rust).toContain("window.set_cookie(cookie)");
    expect(rust).not.toContain("client_auth_token=");
  });
});
