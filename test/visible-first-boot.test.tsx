// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, cleanup, render, screen, waitFor } from "./helpers/dom.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitUntilPasses } from "./helpers/wait-until.js";
import { __resetSharedSseForTests } from "../ui/src/sse-shared";
import { __resetBrowserSessionForTests } from "../ui/src/client-auth-token";
import { h } from "preact";
import { DEFAULT_CHILD_RETENTION_SETTINGS } from "../src/conversations/retention-contract";

import { App } from "../ui/src/app";
import { clearApiGetCache } from "../ui/src/api";
import { useDashboardStartupFrame } from "../ui/src/hooks/useDashboardConnection";

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
    window.history.replaceState(null, "", "/issues");
  });

  afterEach(() => {
    __resetBrowserSessionForTests();
    clearApiGetCache();
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
      if (url === "/api/dashboard/badges") return jsonResponse({ auth: 3, notifications: 2, work: 1, briefing: 0, incidents: 0, tasks: 0 });
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
    expect(screen.getByLabelText("Notifications").textContent).toContain("2");
    expect(screen.getByLabelText("Projects").textContent).toContain("1");

    expect(requests.indexOf("/api/issues")).toBeLessThan(requests.indexOf("/api/dashboard/badges"));
    expect(requests).not.toContain("/api/auth/queue");
    expect(requests.some((url) => url.startsWith("/api/auth/history"))).toBe(false);
    expect(requests).not.toContain("/api/work/repos");
    expect(requests.some((url) => url.startsWith("/api/conversations"))).toBe(false);
    expect(requests).not.toContain("/api/notifications");
    expect(requests).not.toContain("/api/console/sessions");

    window.history.pushState(null, "", "/work");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(requests).toContain("/api/work/repos"));
  });

  it("keeps a re-probed instance and takes badge changes only from the push", async () => {
    vi.useFakeTimers();
    const instance = {
      role: "preview", instance_id: "preview-test", installation_id: "install-test",
      public_origin: "https://preview-test.mandible.localhost:19421", backend_generation: "preview-1",
      allowed_effects: ["ledger:read", "ledger:write", "maintenance:shared"], writable_roots: ["/tmp"],
      db_path: "/tmp/mandible-preview.db", db_path_source: "iab-preview-copy",
    };
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url === "/api/client-auth/whoami") return operatorSession();
      if (url === "/api/issues") return jsonResponse({ repos: [] });
      if (url === "/api/dashboard/badges") return jsonResponse({ auth: 3, notifications: 0, work: 0, briefing: 0, incidents: 0, tasks: 0 });
      if (url === "/api/health") {
        return jsonResponse({ status: "ok", ready: true, startup_commit: { hash: "test" }, instance: structuredClone(instance) });
      }
      if (url === "/api/instance") return jsonResponse({ operations: [] });
      if (url.startsWith("/api/user-settings/")) {
        return jsonResponse({ version: 1, key: url.slice("/api/user-settings/".length), value: null, revision: 0 });
      }
      return jsonResponse({});
    }));
    const count = (predicate: (url: string) => boolean) => requests.filter(predicate).length;
    const settingsReads = () => count((url) => url.startsWith("/api/user-settings/"));
    const badgeReads = () => count((url) => url === "/api/dashboard/badges");

    render(h(App, {}));
    await waitUntilPasses(() => expect(MockEventSource.instances).toHaveLength(1));
    const source = MockEventSource.instances[0];
    source.onopen?.();
    await vi.advanceTimersByTimeAsync(1_000);
    await waitUntilPasses(() => expect(screen.getByLabelText("Approvals").textContent).toContain("3"));
    const settingsAfterMount = settingsReads();
    expect(settingsAfterMount).toBeGreaterThan(0);

    for (let i = 0; i < 3; i++) {
      source.emit("message", { type: "auth:new", data: { request: { id: `a${i}`, status: "pending" } } });
    }
    await vi.advanceTimersByTimeAsync(16_000);

    expect(count((url) => url === "/api/health")).toBeGreaterThanOrEqual(4);
    expect(settingsReads()).toBe(settingsAfterMount);
    expect(badgeReads()).toBe(1);

    source.emit("message", { type: "dashboard:badges", data: { auth: 4, notifications: 0, work: 0, briefing: 0, incidents: 0, tasks: 0 } });
    await waitUntilPasses(() => expect(screen.getByLabelText("Approvals").textContent).toContain("4"));
    expect(badgeReads()).toBe(1);
  });

  it("opens Settings for packaged acceptance and refreshes its affordances on a same-document restart", async () => {
    vi.stubGlobal("ResizeObserver", class {
      observe(): void {}
      disconnect(): void {}
    });
    const instance = {
      role: "main" as const, instance_id: "hidden-settings", installation_id: "hidden-settings",
      backend_generation: "packaged-dashboard", public_origin: window.location.origin,
      allowed_effects: ["maintenance:shared", "preferences:instance"], writable_roots: [],
      db_path: null, db_path_source: "fixture",
    };
    const operations = {
      schema: "mandible-operation-catalog@2", source: "Router.listRoutePolicies",
      runtime: { instance_id: instance.instance_id, backend_generation: instance.backend_generation, version: "fixture" },
      routes: [
        { method: "PUT", path: "/api/host-preferences/app-theme", effects: ["preferences:instance"] },
        { method: "PUT", path: "/api/settings/integrations", effects: ["maintenance:shared"] },
        { method: "PUT", path: "/api/settings/instructions-delivery", effects: ["maintenance:shared"] },
      ],
    };
    let releaseCatalog!: (response: Response) => void;
    const pendingCatalog = () => new Promise<Response>(resolve => { releaseCatalog = resolve; });
    let catalog = pendingCatalog();
    let epoch = "initial";
    const settings: Record<string, string> = {};
    const fetchFixture = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/health") return jsonResponse({ status: "ok", ready: true, warm: false, instance, startup_epoch: epoch });
      if (url === "/api/client-auth/whoami") return operatorSession();
      if (url === "/api/instance") return catalog;
      if (url === "/api/settings") return jsonResponse(settings);
      if (url.startsWith("/api/interface-notes?")) return jsonResponse({ notes: [] });
      if (url === "/api/settings/child-retention") return jsonResponse(DEFAULT_CHILD_RETENTION_SETTINGS);
      if (url === "/api/settings/integrations") return jsonResponse({ available: true, items: [] });
      if (url === "/api/settings/instructions-delivery") return jsonResponse({ targets: [] });
      if (url === "/api/settings/integrations.setup" && init?.method === "PUT") {
        settings["integrations.setup"] = JSON.parse(String(init.body)).value;
      }
      if (url === "/api/host-preferences/app-theme") return jsonResponse({ version: 1, key: "app_theme", value: "system", revision: 0 });
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchFixture);
    const bootstrap = document.createElement("script");
    bootstrap.id = "mandible-bootstrap";
    bootstrap.type = "application/json";
    bootstrap.textContent = JSON.stringify({ instance });
    document.body.append(bootstrap);
    const report = vi.fn(async () => undefined);
    const reload = vi.fn();
    const script = readFileSync("src-tauri/src/acceptance-interaction.js", "utf8")
      .replace("__MANDIBLE_ACCEPTANCE_NONCE__", JSON.stringify("fixture"))
      .replace("__MANDIBLE_ACCEPTANCE_STEP_IDLE_MS__", "3000");
    const runAcceptance = new Function("window", "document", "location", "sessionStorage", "fetch", `return ${script}`);
    try {
      render(h(App, {}));
      const proof = runAcceptance(
        { __TAURI__: { core: { invoke: report } } }, document,
        { get pathname() { return window.location.pathname; }, reload }, window.sessionStorage, fetchFixture,
      ) as Promise<void>;
      try {
        await waitFor(() => expect(window.location.pathname).toBe("/settings"));
        const theme = await screen.findByLabelText("App theme") as HTMLSelectElement;
        expect(theme.disabled).toBe(true);
        releaseCatalog(await jsonResponse({ operations }));
        await proof;
        expect(report).not.toHaveBeenCalled();
        expect(theme.disabled).toBe(false);
        expect(reload).toHaveBeenCalledOnce();
        expect(settings["integrations.setup"]).toBe("skipped");

        catalog = pendingCatalog();
        epoch = "successor";
        document.dispatchEvent(new Event("visibilitychange"));
        const complete = screen.getByRole("button", { name: "Complete optional integrations" }) as HTMLButtonElement;
        await waitFor(() => expect(theme.disabled).toBe(true));
        expect(complete.disabled).toBe(true);
        releaseCatalog(await jsonResponse({ operations: {
          ...operations,
          routes: operations.routes.filter(route => route.path !== "/api/host-preferences/app-theme"),
        } }));
        await waitFor(() => expect(complete.disabled).toBe(false));
        expect(theme.disabled).toBe(true);
        expect(screen.getByLabelText("App theme")).toBe(theme);
        expect(window.location.pathname).toBe("/settings");
        expect(reload).toHaveBeenCalledOnce();
      } finally {
        await proof;
      }
    } finally {
      bootstrap.remove();
      window.sessionStorage.removeItem("mandible-candidate-interaction:fixture");
    }
  });

  it("reports a hidden dashboard frame ready before waiting for animation frames", async () => {
    const nextFrame = vi.fn(() => 1);
    const invoke = vi.fn(async () => undefined);
    vi.stubGlobal("requestAnimationFrame", nextFrame);
    vi.stubGlobal("__MANDIBLE_NATIVE_HOST__", { startupTrace: true });
    vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
    const frame = document.createElement("div");
    frame.id = "mandible-startup-frame";
    document.body.append(frame);
    function Dashboard() {
      useDashboardStartupFrame(true, "boot-epoch", { current: undefined });
      return <main>Dashboard</main>;
    }
    try {
      render(h(Dashboard, {}));
      await act(async () => undefined);
      expect(frame.hidden).toBe(true);
      expect(invoke).toHaveBeenCalledExactlyOnceWith("desktop_frame_ready", { dashboard: true, daemonStartupEpoch: "boot-epoch" });
    } finally {
      frame.remove();
    }
  });

  it("preserves the mounted dashboard through a quiet outage and resumes before warmup", async () => {
    vi.useFakeTimers();
    let health = { status: "ok", ready: true, warm: false, startup_epoch: "before", rebuilding: true };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/client-auth/whoami") return operatorSession();
      if (url === "/api/health") return jsonResponse(health);
      return jsonResponse({});
    }));

    const { container } = render(h(App, {}));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    const shell = container.querySelector(".app-shell")!;
    const content = container.querySelector("main.app-content")!;
    expect(shell.hasAttribute("inert")).toBe(false);

    health = { ...health, ready: false, rebuilding: false };
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(shell.hasAttribute("inert")).toBe(true);
    expect(screen.queryByRole("status", { name: "Restarting Mandible" })).toBeNull();
    expect(container.querySelector("main.app-content")).toBe(content);

    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    expect(screen.getByRole("status", { name: "Restarting Mandible" })).toBeTruthy();

    health = { ...health, ready: true, startup_epoch: "after" };
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(shell.hasAttribute("inert")).toBe(false);
    expect(container.querySelector("main.app-content")).toBe(content);
    expect(screen.queryByRole("status", { name: "Restarting Mandible" })).toBeNull();
    expect(window.location.pathname).toBe("/issues");
  });

  it("suppresses fallback polling while dashboard SSE is fresh", async () => {
    vi.useFakeTimers();
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url === "/api/client-auth/whoami") return operatorSession();
      if (url === "/api/issues") return jsonResponse({ repos: [] });
      if (url === "/api/dashboard/badges") return jsonResponse({ auth: 0, notifications: 0, work: 0, briefing: 0, incidents: 0, tasks: 0 });
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
