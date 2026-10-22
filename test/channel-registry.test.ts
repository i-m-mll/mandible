// @vitest-environment node
// Bug: 0b454df — Tests for channel session registry
//
// Tests the in-memory channel registry that tracks MCP channel-connected sessions.

import { describe, expect, it, vi, beforeEach } from "vitest";

// We test the channel registry in isolation by importing the module
// and using its public API. We mock getDb to avoid needing a real database.

vi.mock("../src/db.js", () => ({
  getDb: vi.fn(() => ({
    prepare: vi.fn(() => ({
      run: vi.fn(),
      get: vi.fn(),
      all: vi.fn(() => []),
    })),
  })),
}));

vi.mock("../src/sse.js", () => ({
  broadcast: vi.fn(),
}));

describe("ChannelRegistry", () => {
  // We need to isolate the singleton between tests, so we import fresh each time
  let getChannelRegistry: () => import("../src/channel-registry.js").default extends never ? never : ReturnType<typeof import("../src/channel-registry.js")["getChannelRegistry"]>;

  beforeEach(async () => {
    // Reset module cache to get a fresh singleton
    vi.resetModules();
    const mod = await import("../src/channel-registry.js");
    getChannelRegistry = mod.getChannelRegistry;
  });

  it("keeps a re-registered session's first connect time and cwd", () => {
    const registry = getChannelRegistry();
    const first = registry.register("session-1", "/tmp/repo", "feature/test");

    const second = registry.register("session-1", null, "feature/updated");

    expect(second).toMatchObject({ session_id: "session-1", branch: "feature/updated", cwd: "/tmp/repo", connected_at: first.connected_at });
  });

  it("is live while tool calls are recent and pruned once they are stale", () => {
    const registry = getChannelRegistry();
    registry.register("fresh", null, null);
    registry.register("stale", null, null);
    registry.get("stale")!.last_tool_call = Date.now() - 15 * 60 * 1000;

    expect(registry.isAlive("fresh")).toBe(true);
    expect(registry.isAlive("nonexistent")).toBe(false);
    expect(registry.pruneStale()).toEqual(["stale"]);
    expect(registry.get("stale")).toBeNull();
    expect(registry.get("fresh")).not.toBeNull();
  });

  it("forgets a disconnected session", () => {
    const registry = getChannelRegistry();
    registry.register("session-1", null, "main");

    registry.disconnect("session-1");

    expect(registry.isChannelConnected("session-1")).toBe(false);
    expect(registry.getByBranch("main")).toEqual([]);
  });
});
