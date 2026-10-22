// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://app.mandible.localhost:19420/"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetBrowserSessionForTests, browserSessionFetch, ensureClientAccess,
  getClientAccessState, retryClientAccess,
} from "../ui/src/client-auth-token.js";
import { DOMAIN_EVENTS } from "../src/contracts.js";
import { SSEClient } from "../ui/src/sse-client.js";

const ready = () => new Response(JSON.stringify({ authenticated: true, session: { csrf_token: "csrf" } }), {
  status: 200, headers: { "content-type": "application/json" },
});
beforeEach(() => __resetBrowserSessionForTests());
afterEach(() => { __resetBrowserSessionForTests(); vi.restoreAllMocks(); });

describe("OS-owned browser access", () => {
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
    await vi.waitFor(() => expect(getClientAccessState().phase).toBe("failed"));
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

describe("SSE transport", () => {
  it("subscribes with POST and parses an event-stream frame", async () => {
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("whoami")) return ready();
      expect(init?.method).toBe("POST");
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: DOMAIN_EVENTS.HEARTBEAT, data: { timestamp: 123 } })}\n\n`)); } }), {
        status: 200, headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const client = new SSEClient({ fetchImpl, backoffMs: 10 });
    const received = vi.fn(); client.on(DOMAIN_EVENTS.HEARTBEAT, received); client.connect();
    try {
      await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(1));
      expect(received).toHaveBeenCalledWith({ type: DOMAIN_EVENTS.HEARTBEAT, data: { timestamp: 123 } });
    } finally { client.close(); }
  });
});
