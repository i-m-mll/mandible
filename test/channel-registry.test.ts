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

  it("registers a new channel session", () => {
    const registry = getChannelRegistry();
    const session = registry.register("session-1", "/tmp/repo", "feature/test");

    expect(session.session_id).toBe("session-1");
    expect(session.cwd).toBe("/tmp/repo");
    expect(session.branch).toBe("feature/test");
    expect(session.connected_at).toBeGreaterThan(0);
    expect(session.last_tool_call).toBeGreaterThan(0);
  });

  it("updates existing session on re-register", () => {
    const registry = getChannelRegistry();
    const first = registry.register("session-1", "/tmp/repo", "feature/test");
    const originalConnectedAt = first.connected_at;

    // Re-register with updated branch
    const second = registry.register("session-1", null, "feature/updated");

    expect(second.session_id).toBe("session-1");
    expect(second.branch).toBe("feature/updated");
    expect(second.cwd).toBe("/tmp/repo"); // preserved from first registration
    expect(second.connected_at).toBe(originalConnectedAt); // not changed
  });

  it("records tool calls", () => {
    const registry = getChannelRegistry();
    registry.register("session-1", null, null);

    registry.recordToolCall("session-1", "mandible_check_inbox");
    registry.recordToolCall("session-1", "mandible_get_issues");
    registry.recordToolCall("session-1", "mandible_check_inbox"); // duplicate

    const session = registry.get("session-1");
    expect(session).not.toBeNull();
    expect(session!.tools_called).toEqual(["mandible_check_inbox", "mandible_get_issues"]);
  });

  it("checks liveness based on tool call recency", () => {
    const registry = getChannelRegistry();
    registry.register("session-1", null, null);

    // Freshly registered — should be alive
    expect(registry.isAlive("session-1")).toBe(true);

    // Non-existent session — not alive
    expect(registry.isAlive("nonexistent")).toBe(false);
  });

  it("disconnects sessions", () => {
    const registry = getChannelRegistry();
    registry.register("session-1", null, null);
    expect(registry.isChannelConnected("session-1")).toBe(true);

    registry.disconnect("session-1");
    expect(registry.isChannelConnected("session-1")).toBe(false);
    expect(registry.get("session-1")).toBeNull();
  });

  it("getAll returns all sessions", () => {
    const registry = getChannelRegistry();
    registry.register("session-1", null, "main");
    registry.register("session-2", null, "feature/x");

    const all = registry.getAll();
    expect(all).toHaveLength(2);
    expect(all.map(s => s.session_id).sort()).toEqual(["session-1", "session-2"]);
  });

  it("getByBranch filters to matching branch", () => {
    const registry = getChannelRegistry();
    registry.register("session-1", null, "main");
    registry.register("session-2", null, "feature/x");
    registry.register("session-3", null, "main");

    const mainSessions = registry.getByBranch("main");
    expect(mainSessions).toHaveLength(2);
    expect(mainSessions.map(s => s.session_id).sort()).toEqual(["session-1", "session-3"]);

    const featureSessions = registry.getByBranch("feature/x");
    expect(featureSessions).toHaveLength(1);
    expect(featureSessions[0].session_id).toBe("session-2");
  });

  it("pruneStale removes old sessions", () => {
    const registry = getChannelRegistry();
    registry.register("session-1", null, null);

    // Artificially age the session
    const session = registry.get("session-1")!;
    session.last_tool_call = Date.now() - 15 * 60 * 1000; // 15 minutes ago

    const pruned = registry.pruneStale();
    expect(pruned).toEqual(["session-1"]);
    expect(registry.get("session-1")).toBeNull();
  });
});
