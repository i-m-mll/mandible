// @vitest-environment node
import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

async function bootBootstrap({ search = "", available = false, status }: {
  search?: string;
  available?: boolean;
  status?: Record<string, unknown>;
}) {
  const calls: string[] = [];
  const listeners = new Map<string, () => void>();
  const elements = new Map<string, { textContent: string; disabled: boolean; hidden: boolean }>();
  const document = {
    getElementById(id: string) {
      const element = {
        textContent: "",
        disabled: false,
        hidden: true,
        getBoundingClientRect: () => ({ height: 42 }),
        addEventListener: (event: string, listener: () => void) => listeners.set(`${id}:${event}`, listener),
      };
      elements.set(id, element);
      return element;
    },
  };
  const window = {
    __TAURI__: {
      core: {
        invoke: async (command: string, args?: { fastOnly?: boolean }) => {
          calls.push(command === "navigate_to_desktop_dashboard" ? (args?.fastOnly ? "probe" : "navigate") : command);
          if (command === "navigate_to_desktop_dashboard" && args?.fastOnly && !available) throw new Error("not ready");
          return status;
        },
      },
    },
    location: { search },
    setTimeout: () => 1,
    clearTimeout: () => undefined,
  };
  const script = fs.readFileSync("src-tauri/bootstrap/bootstrap.js", "utf8");
  vm.runInNewContext(script, {
    document, window, URLSearchParams, requestAnimationFrame: (callback: () => void) => callback(),
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  return { calls, elements, listeners };
}

function stopped(overrides: Record<string, unknown> = {}) {
  return { state: "stopped", launch_mode: "on_demand", dashboard_ready: false, ...overrides };
}

describe("desktop bootstrap navigation", () => {
  it("opens a ready dashboard without a runtime controller status subprocess", async () => {
    const result = await bootBootstrap({ available: true });
    expect(result.calls).toEqual(["desktop_frame_ready", "probe", "desktop_frame_painted"]);
    expect(result.elements.get("bootstrap-controls")?.hidden).toBe(true);
  });

  it("keeps a stopped daemon stopped in manual launch mode", async () => {
    const result = await bootBootstrap({ status: stopped({ launch_mode: "manual" }) });
    expect(result.calls).toEqual(["desktop_frame_ready", "probe", "desktop_frame_painted", "daemon_status"]);
    expect(result.elements.get("start-btn")?.hidden).toBe(false);
  });

  it("recovers a missing dashboard gateway without navigating prematurely", async () => {
    const result = await bootBootstrap({ status: {
      state: "gateway_unavailable", dashboard_ready: false, launch_mode: "on_demand",
    } });
    expect(result.calls).toEqual(["desktop_frame_ready", "probe", "desktop_frame_painted", "daemon_status", "daemon_start"]);
    expect(result.elements.get("bootstrap-controls")?.hidden).toBe(true);
  });

  it("keeps an explicit Stop stopped when the bootstrap page is reopened", async () => {
    const result = await bootBootstrap({ search: "?skip_autostart=1", status: stopped() });
    expect(result.calls).toEqual(["desktop_frame_ready", "probe", "desktop_frame_painted", "daemon_status"]);
    expect(result.elements.get("start-btn")?.hidden).toBe(false);
  });

  it("retries failed dashboard navigation only on user action", async () => {
    const result = await bootBootstrap({
      search: "?skip_autostart=1&dashboard_navigation_failed=1", status: { dashboard_ready: true },
    });
    expect(result.calls).toEqual(["desktop_frame_ready", "desktop_frame_painted"]);
    expect(result.elements.get("bootstrap-error")?.hidden).toBe(false);
    result.listeners.get("retry-btn:click")?.();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(result.calls).toEqual(["desktop_frame_ready", "desktop_frame_painted", "probe", "daemon_status", "navigate"]);
  });
});
