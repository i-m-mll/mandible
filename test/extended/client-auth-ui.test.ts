// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetBrowserSessionForTests, browserSessionFetch, getClientAuthSessionState } from "../../ui/src/client-auth-token.js";
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
    await browserSessionFetch("/api/issues", { method: "POST" }, fetchImpl);
    expect(getClientAuthSessionState()).toBe("wrong-audience");
    expect(fetchImpl.mock.calls.flatMap(([, init]) => [...new Headers(init?.headers).keys()])).not.toContain("authorization");
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
