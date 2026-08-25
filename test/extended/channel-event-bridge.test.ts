// Bug: 7ab2f3e — Tests for the channel event bridge
//
// Tests that ChannelRegistry events are correctly bridged into PTYBackend's
// structured event stream, including late registration, timeout, cleanup,
// and event format.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// Mock dependencies before imports
vi.mock("../../src/db.js", () => ({
  getDb: vi.fn(() => ({
    prepare: vi.fn(() => ({
      run: vi.fn(),
      get: vi.fn(),
      all: vi.fn(() => []),
    })),
  })),
}));

vi.mock("../../src/sse.js", () => ({
  broadcast: vi.fn(),
}));

describe("ChannelEventBridge", () => {
  let getChannelRegistry: typeof import("../../src/channel-registry.js")["getChannelRegistry"];
  let bridgeChannelEvents: typeof import("../../src/channel-event-bridge.js")["bridgeChannelEvents"];
  let logger: ReturnType<typeof vi.fn>;

  // Minimal mock backend that implements the AgenticBackend interface
  // enough for the bridge to work
  function createMockBackend(id: string, mandibleSessionId: string | null) {
    const emitter = new EventEmitter();
    const ingestedEvents: unknown[] = [];

    return Object.assign(emitter, {
      id,
      meta: {
        id,
        label: "test",
        command: "claude",
        args: [],
        provider_session_id: null,
        cwd: "/tmp",
        env: {},
        cols: 80,
        rows: 24,
        status: "running" as const,
        pid: 123,
        exit_code: null,
        auto_restart: false,
        is_operator: false,
        interaction_mode: "both" as const,
        created_at: Date.now(),
        updated_at: Date.now(),
        started_at: Date.now(),
        stopped_at: null,
        backend_type: "pty" as const,
        allowed_tools: null,
        mandible_session_id: mandibleSessionId,
        resume_at_message: null,
        agent_type: "claude" as const,
      },
      ingestStructuredEvent: vi.fn((event: unknown) => {
        ingestedEvents.push(event);
      }),
      ingestText: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      destroy: vi.fn(),
      clear: vi.fn(),
      sendPrompt: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      addWsClient: vi.fn(),
      removeWsClient: vi.fn(),
      getBufferSnapshot: vi.fn(() => Buffer.alloc(0)),
      getStreamEvents: vi.fn(() => []),
      _ingestedEvents: ingestedEvents,
    });
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    logger = vi.fn();
    const registryMod = await import("../../src/channel-registry.js");
    getChannelRegistry = registryMod.getChannelRegistry;
    const bridgeMod = await import("../../src/channel-event-bridge.js");
    bridgeChannelEvents = bridgeMod.bridgeChannelEvents;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("bridges events immediately when channel session already exists", () => {
    const registry = getChannelRegistry();
    const sessionId = "session-abc";

    // Register the channel session first
    registry.register(sessionId, "/tmp", "main");

    // Create backend and bridge
    const backend = createMockBackend("console-1", sessionId);
    const handle = bridgeChannelEvents(backend as any, sessionId, logger);

    expect(handle.active).toBe(true);

    // Emit a tool call event
    registry.recordToolCall(sessionId, "mandible_check_inbox");

    expect(backend.ingestStructuredEvent).toHaveBeenCalledTimes(1);
    const event = backend.ingestStructuredEvent.mock.calls[0][0];
    expect(event.type).toBe("system");
    expect(event.subtype).toBe("channel_event");
    expect(event.source).toBe("channel_bridge");
    expect(event.channel_event_type).toBe("tool_call");
    expect(event.tool_name).toBe("mandible_check_inbox");

    handle.dispose();
  });

  it("waits for late channel registration and then bridges", () => {
    const registry = getChannelRegistry();
    const sessionId = "session-late";

    // Create backend and bridge BEFORE the channel session exists
    const backend = createMockBackend("console-2", sessionId);
    const handle = bridgeChannelEvents(backend as any, sessionId, logger, 5000);

    expect(handle.active).toBe(false);

    // Now register the channel session
    registry.register(sessionId, "/tmp", "feature/test");

    expect(handle.active).toBe(true);

    // Emit a tool call — should be bridged
    registry.recordToolCall(sessionId, "mandible_get_issues");

    expect(backend.ingestStructuredEvent).toHaveBeenCalled();
    // The connect event that activated the bridge is NOT captured by
    // onChannelEvent (listener added mid-emit is not called for the
    // current event). Only the subsequent tool_call is bridged.
    const toolEvent = backend.ingestStructuredEvent.mock.calls[0][0];
    expect(toolEvent.channel_event_type).toBe("tool_call");
    expect(toolEvent.tool_name).toBe("mandible_get_issues");

    handle.dispose();
  });

  it("times out on late registration and logs a warning", () => {
    const sessionId = "session-timeout";

    const backend = createMockBackend("console-3", sessionId);
    const handle = bridgeChannelEvents(backend as any, sessionId, logger, 5000);

    expect(handle.active).toBe(false);

    // Advance past the timeout
    vi.advanceTimersByTime(6000);

    expect(handle.active).toBe(false);

    // Should have logged a timeout warning
    const warnCalls = logger.mock.calls.filter(
      (c: unknown[]) => c[0] === "warn" && c[1] === "channel_bridge_timeout"
    );
    expect(warnCalls.length).toBe(1);

    handle.dispose();
  });

  it("ignores events for other session IDs", () => {
    const registry = getChannelRegistry();
    const sessionId = "session-mine";
    const otherSessionId = "session-other";

    registry.register(sessionId, "/tmp", "main");
    registry.register(otherSessionId, "/tmp", "main");

    const backend = createMockBackend("console-4", sessionId);
    const handle = bridgeChannelEvents(backend as any, sessionId, logger);

    // Emit tool call for OTHER session
    registry.recordToolCall(otherSessionId, "mandible_check_inbox");

    expect(backend.ingestStructuredEvent).not.toHaveBeenCalled();

    handle.dispose();
  });

  it("disposes cleanly and stops bridging", () => {
    const registry = getChannelRegistry();
    const sessionId = "session-dispose";

    registry.register(sessionId, "/tmp", "main");

    const backend = createMockBackend("console-5", sessionId);
    const handle = bridgeChannelEvents(backend as any, sessionId, logger);

    expect(handle.active).toBe(true);

    handle.dispose();
    expect(handle.active).toBe(false);

    // Events after dispose should NOT be bridged
    registry.recordToolCall(sessionId, "mandible_check_inbox");
    expect(backend.ingestStructuredEvent).not.toHaveBeenCalled();
  });

  it("auto-disposes when backend emits a stop status event", () => {
    const registry = getChannelRegistry();
    const sessionId = "session-autostop";

    registry.register(sessionId, "/tmp", "main");

    const backend = createMockBackend("console-6", sessionId);
    const handle = bridgeChannelEvents(backend as any, sessionId, logger);

    expect(handle.active).toBe(true);

    // Simulate backend stopping
    backend.emit("status", { kind: "stopped", status: "stopped" });

    expect(handle.active).toBe(false);

    // Events after auto-dispose should NOT be bridged
    registry.recordToolCall(sessionId, "mandible_check_inbox");
    // ingestStructuredEvent should not have been called (other than potentially
    // from the register which happened before the bridge was set up — but
    // register happened before bridge, so no connect event was emitted to bridge)
    expect(backend.ingestStructuredEvent).not.toHaveBeenCalled();
  });

  it("bridges notification events", () => {
    const registry = getChannelRegistry();
    const sessionId = "session-notif";

    registry.register(sessionId, "/tmp", "main");

    const backend = createMockBackend("console-7", sessionId);
    const handle = bridgeChannelEvents(backend as any, sessionId, logger);

    registry.recordNotification(sessionId, "auth_resolved", "Merge approved");

    expect(backend.ingestStructuredEvent).toHaveBeenCalledTimes(1);
    const event = backend.ingestStructuredEvent.mock.calls[0][0];
    expect(event.channel_event_type).toBe("notification");
    expect(event.notification_type).toBe("auth_resolved");
    expect(event.notification_content).toBe("Merge approved");

    handle.dispose();
  });

  it("bridges disconnect events", () => {
    const registry = getChannelRegistry();
    const sessionId = "session-disconn";

    registry.register(sessionId, "/tmp", "main");

    const backend = createMockBackend("console-8", sessionId);
    const handle = bridgeChannelEvents(backend as any, sessionId, logger);

    registry.disconnect(sessionId);

    expect(backend.ingestStructuredEvent).toHaveBeenCalledTimes(1);
    const event = backend.ingestStructuredEvent.mock.calls[0][0];
    expect(event.channel_event_type).toBe("disconnect");

    handle.dispose();
  });

  it("includes tool_input and tool_output in tool_call events", () => {
    const registry = getChannelRegistry();
    const sessionId = "session-io";

    registry.register(sessionId, "/tmp", "main");

    const backend = createMockBackend("console-9", sessionId);
    const handle = bridgeChannelEvents(backend as any, sessionId, logger);

    const input = { branch: "feature/test" };
    const output = { text: "Inbox is empty" };
    registry.recordToolCall(sessionId, "mandible_check_inbox", input, output);

    expect(backend.ingestStructuredEvent).toHaveBeenCalledTimes(1);
    const event = backend.ingestStructuredEvent.mock.calls[0][0];
    expect(event.tool_input).toEqual(input);
    expect(event.tool_output).toEqual(output);

    handle.dispose();
  });

  it("all bridged events have source: channel_bridge marker", () => {
    const registry = getChannelRegistry();
    const sessionId = "session-marker";

    registry.register(sessionId, "/tmp", "main");

    const backend = createMockBackend("console-10", sessionId);
    const handle = bridgeChannelEvents(backend as any, sessionId, logger);

    // Trigger multiple event types
    registry.recordToolCall(sessionId, "tool1");
    registry.recordNotification(sessionId, "test", "content");
    registry.disconnect(sessionId);

    for (const call of backend.ingestStructuredEvent.mock.calls) {
      expect(call[0].source).toBe("channel_bridge");
    }

    handle.dispose();
  });
});
