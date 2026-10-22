import { cleanup, render, screen, waitFor } from "./helpers/dom.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitUntilPasses } from "./helpers/wait-until.js";
import { __resetSharedSseForTests } from "../ui/src/sse-shared";
import { __resetBrowserSessionForTests } from "../ui/src/client-auth-token";
import { h } from "preact";

import { App } from "../ui/src/app";
import { invalidateApiGetCache } from "../ui/src/api";

class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  readyState = 1;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;

  constructor(_url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  removeEventListener(): void {}
  close(): void { this.readyState = 2; }

  emit(type: string, data: unknown): void {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function jsonResponse(body: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  }));
}

function operatorSession(): Promise<Response> {
  return jsonResponse({ authenticated: true, session: {
    family_id: "boot-family", audience: "production", csrf_token: "boot-csrf",
    effect_ceiling: ["ledger:read", "ledger:write"],
  } });
}

describe("visible-first dashboard boot", () => {
  beforeEach(() => {
    __resetBrowserSessionForTests();
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", MockEventSource);
    __resetSharedSseForTests(MockEventSource as unknown as typeof EventSource);
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    if (typeof window.localStorage.removeItem === "function") {
      window.localStorage.removeItem("mandible_state_cache");
      window.localStorage.removeItem("mandible.spaces.lastView:v1");
    }
    window.history.replaceState(null, "", "#/issues");
  });

  afterEach(() => {
    __resetBrowserSessionForTests();
    invalidateApiGetCache();
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("requests the visible view before badges and defers heavy off-screen tabs", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url === "/api/client-auth/whoami") return operatorSession();
      if (url === "/api/issues") return jsonResponse({ repos: [] });
      if (url === "/api/settings") return jsonResponse({});
      if (url === "/api/dashboard/badges") return jsonResponse({ auth: 3, inbox: 2, work: 1 });
      if (url === "/api/health") {
        return jsonResponse({
          status: "ok",
          ready: true,
          startup_commit: { hash: "test", summary: "test", date: "" },
          instance: null,
        });
      }
      if (url === "/api/work/repos") return jsonResponse({ repos: [] });
      return jsonResponse([]);
    }));

    render(h(App, {}));
    await waitFor(() => expect(requests).toContain("/api/dashboard/badges"));
    await waitFor(() => expect(screen.getByLabelText("Approvals").textContent).toContain("3"));
    expect(screen.getByLabelText("Inbox").textContent).toContain("2");
    expect(screen.getByLabelText("Projects").textContent).toContain("1");

    expect(requests.indexOf("/api/issues")).toBeLessThan(requests.indexOf("/api/dashboard/badges"));
    expect(requests).not.toContain("/api/auth/queue");
    expect(requests.some((url) => url.startsWith("/api/auth/history"))).toBe(false);
    expect(requests).not.toContain("/api/work/repos");
    expect(requests.some((url) => url.startsWith("/api/conversations"))).toBe(false);
    expect(requests).not.toContain("/api/inbox/global");
    expect(requests).not.toContain("/api/console/sessions");

    window.location.hash = "#/work";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await waitFor(() => expect(requests).toContain("/api/work/repos"));
  });

  it("suppresses fallback polling while dashboard SSE is fresh", async () => {
    vi.useFakeTimers();
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url === "/api/client-auth/whoami") return operatorSession();
      if (url === "/api/issues") return jsonResponse({ repos: [] });
      if (url === "/api/dashboard/badges") return jsonResponse({ auth: 0, inbox: 0, work: 0 });
      if (url === "/api/health") {
        return jsonResponse({ status: "ok", ready: true, startup_commit: { hash: "test" } });
      }
      return jsonResponse({});
    }));

    render(h(App, {}));
    await vi.runAllTicks();
    await Promise.resolve();
    await waitUntilPasses(() => expect(MockEventSource.instances).toHaveLength(1));
    const source = MockEventSource.instances[0];
    expect(source).toBeTruthy();
    // Freshness is now connection health (open socket + a signal within
    // SSE_FRESH_FOR = 45s), not bare last-event receipt, so the connection must
    // actually open before the fallback poll is suppressed. Fire onopen to move
    // the shared client into the 'open' state, then deliver a live event to bump
    // the freshness clock.
    source.onopen?.();
    source.emit("message", { type: "auth:new", data: { request: { id: "a", status: "pending" } } });
    await Promise.resolve();
    const issueRequestsAfterSse = requests.filter((url) => url === "/api/issues").length;

    // Within the 45s freshness window the live stream is authoritative, so the
    // periodic fallback fetch is skipped.
    await vi.advanceTimersByTimeAsync(20_000);

    expect(requests.filter((url) => url === "/api/issues")).toHaveLength(issueRequestsAfterSse);

    // Once the freshness window lapses (>45s with no further signal) the fallback
    // poll re-enables and refetches the visible view.
    await vi.advanceTimersByTimeAsync(40_000);

    expect(requests.filter((url) => url === "/api/issues").length).toBeGreaterThan(issueRequestsAfterSse);
  });
});
