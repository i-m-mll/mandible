// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

function bootBootstrap({ search = "", status }: { search?: string; status: Record<string, unknown> }) {
  const calls: string[] = [];
  const listeners = new Map<string, () => void>();
  const elements = new Map<string, Record<string, any>>();
  const document = {
    getElementById(id: string) {
      if (!elements.has(id)) {
        elements.set(id, {
          textContent: "",
          dataset: {},
          style: {},
          disabled: false,
          addEventListener: (event: string, listener: () => void) => listeners.set(`${id}:${event}`, listener),
        });
      }
      return elements.get(id);
    },
  };
  const window = {
    __TAURI__: {
      core: {
        invoke: async (command: string) => {
          calls.push(command);
          return status;
        },
      },
    },
    location: { search, replace: () => { throw new Error("bootstrap must not use a browser fallback navigation"); } },
    setTimeout: () => 1,
    clearTimeout: () => undefined,
  };
  const script = fs.readFileSync(path.resolve("src-tauri/bootstrap/bootstrap.js"), "utf8");
  vm.runInNewContext(script, { document, window, URLSearchParams });
  return new Promise<{ calls: string[]; elements: Map<string, Record<string, any>>; listeners: Map<string, () => void> }>((resolve) => {
    setImmediate(() => resolve({ calls, elements, listeners }));
  });
}

function status(overrides: Record<string, unknown> = {}) {
  return {
    state: "running",
    launch_mode: "on_demand",
    port: 29420,
    pid: 123,
    pid_file: "/tmp/mandible.pid",
    log_file: "/tmp/mandible.log",
    gateway_log_file: "/tmp/mandible-gateway.log",
    detail: null,
    healthy: true,
    dashboard_ready: true,
    dashboard_origin: "https://app.mandible.localhost:19420",
    gateway_state: "running",
    gateway_error: null,
    ...overrides,
  };
}

describe("desktop bootstrap navigation", () => {
  it("opens the dashboard only through native navigation after both readiness checks pass", async () => {
    const result = await bootBootstrap({ status: status() });
    expect(result.calls).toEqual(["daemon_status", "navigate_to_desktop_dashboard"]);
    expect(result.elements.get("status-badge")?.textContent).toBe("dashboard ready");
  });

  it("recovers a missing dashboard gateway without navigating or falsely restarting a healthy backend", async () => {
    const unavailable = status({
      state: "gateway_unavailable",
      dashboard_ready: false,
      gateway_state: "stopped",
      gateway_error: "The service is not accepting connections.",
    });
    const result = await bootBootstrap({ status: unavailable });
    expect(result.calls).toEqual(["daemon_status", "daemon_start"]);
    expect(result.elements.get("status-copy")?.textContent).toContain("backend is healthy");
  });

  it("keeps an explicit Stop stopped when the bootstrap page is reopened", async () => {
    const stopped = status({
      state: "stopped",
      launch_mode: "on_demand",
      healthy: false,
      dashboard_ready: false,
      gateway_state: "stopped",
    });
    const result = await bootBootstrap({ search: "?skip_autostart=1", status: stopped });
    expect(result.calls).toEqual(["daemon_status"]);
    expect(result.elements.get("status-copy")?.textContent).toContain("can start it on demand");
  });

  it("keeps the bootstrap visible after a failed dashboard load and retries only on user action", async () => {
    const result = await bootBootstrap({
      search: "?skip_autostart=1&dashboard_navigation_failed=1",
      status: status(),
    });
    expect(result.calls).toEqual(["daemon_status"]);
    expect(result.elements.get("status-copy")?.textContent).toContain("did not finish loading");

    result.listeners.get("retry-btn:click")?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(result.calls).toEqual(["daemon_status", "daemon_status", "navigate_to_desktop_dashboard"]);
  });
});
