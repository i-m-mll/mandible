/**
 * Tests for SpawnBackend lifecycle and event handling.
 * Bug: 8d3328c
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { SpawnBackend } from "../src/backends/spawn-backend.js";
import type { ConsoleSession, ConsoleStreamEvent, Logger } from "../src/types.js";
import type { WebSocket } from "ws";

function makeMeta(overrides: Partial<ConsoleSession> = {}): ConsoleSession {
  return {
    id: "test-id",
    label: "Test",
    command: "codex",
    args: [],
    provider_session_id: null,
    cwd: "/tmp",
    env: {},
    cols: 120,
    rows: 30,
    status: "stopped",
    pid: null,
    exit_code: null,
    auto_restart: false,
    is_operator: false,
    interaction_mode: "both",
    created_at: Date.now(),
    updated_at: Date.now(),
    started_at: null,
    stopped_at: null,
    backend_type: "spawn",
    transport_lane: "spawn",
    transport_badge: { label: "Spawn", title: "Spawned process transport" },
    allowed_tools: null,
    mandible_session_id: null,
    resume_at_message: null,
    agent_type: "codex",
    channel_enabled: false,
    ...overrides,
  };
}

function makeLogger(): Logger {
  return vi.fn();
}

describe("SpawnBackend", () => {
  let backend: SpawnBackend;
  let logger: Logger;

  beforeEach(() => {
    logger = makeLogger();
    backend = new SpawnBackend(makeMeta(), logger);
  });

  it("initializes with correct id and meta", () => {
    expect(backend.id).toBe("test-id");
    expect(backend.meta.status).toBe("stopped");
    expect(backend.meta.backend_type).toBe("spawn");
  });

  it("start() transitions to running", () => {
    const events: string[] = [];
    backend.on("meta_update", (fields: Record<string, unknown>) => {
      if (fields.status) events.push(fields.status as string);
    });
    backend.on("status", (event: { kind: string }) => {
      events.push(`status:${event.kind}`);
    });

    backend.start();

    expect(backend.meta.status).toBe("running");
    expect(events).toContain("running");
    expect(events).toContain("status:started");
  });

  it("start() is idempotent when already running", () => {
    backend.start();
    const statusBefore = backend.meta.status;
    backend.start(); // should not error
    expect(backend.meta.status).toBe(statusBefore);
  });

  it("stop() transitions to stopped", () => {
    backend.start();
    backend.stop();
    expect(backend.meta.status).toBe("stopped");
  });

  it("stop() is idempotent when already stopped", () => {
    backend.stop(); // should not error
    expect(backend.meta.status).toBe("stopped");
  });

  it("destroy() prevents further operations", () => {
    backend.start();
    backend.destroy();

    // sendPrompt should be silently ignored after destroy
    backend.sendPrompt("test");
    // start should be silently ignored after destroy
    backend.start();
    expect(backend.meta.status).toBe("running"); // still in running state from before destroy
  });

  it("getBufferSnapshot() returns empty buffer", () => {
    const buf = backend.getBufferSnapshot();
    expect(buf.length).toBe(0);
  });

  it("getStreamEvents() returns empty initially", () => {
    expect(backend.getStreamEvents()).toEqual([]);
  });

  it("ingestStructuredEvent() stores and emits events", () => {
    const events: ConsoleStreamEvent[] = [];
    backend.on("stream_event", (event: ConsoleStreamEvent) => {
      events.push(event);
    });

    const testEvent: ConsoleStreamEvent = {
      type: "system",
      subtype: "init",
      session_id: "s1",
    };
    backend.ingestStructuredEvent(testEvent);

    expect(backend.getStreamEvents()).toHaveLength(1);
    expect(backend.getStreamEvents()[0]).toEqual(testEvent);
    expect(events).toHaveLength(1);
  });

  it("clear() clears event log", () => {
    backend.ingestStructuredEvent({ type: "system", subtype: "init", session_id: "s1" });
    expect(backend.getStreamEvents()).toHaveLength(1);
    backend.clear();
    expect(backend.getStreamEvents()).toHaveLength(0);
  });

  it("resize() updates meta cols/rows", () => {
    backend.resize(200, 50);
    expect(backend.meta.cols).toBe(200);
    expect(backend.meta.rows).toBe(50);
  });

  it("write() with newline triggers sendPrompt", () => {
    const spy = vi.spyOn(backend, "sendPrompt");
    backend.write("hello\n");
    expect(spy).toHaveBeenCalledWith("hello");
  });

  it("write() without newline does not trigger sendPrompt", () => {
    const spy = vi.spyOn(backend, "sendPrompt");
    backend.write("hello");
    expect(spy).not.toHaveBeenCalled();
  });

  it("tracks provider_session_id from events", () => {
    const metaUpdates: Array<Record<string, unknown>> = [];
    backend.on("meta_update", (fields: Record<string, unknown>) => {
      metaUpdates.push(fields);
    });

    backend.ingestStructuredEvent({
      type: "system",
      subtype: "init",
      session_id: "provider-123",
    });

    expect(backend.meta.provider_session_id).toBe("provider-123");
    expect(metaUpdates.some(u => u.provider_session_id === "provider-123")).toBe(true);
  });

  it("event log respects limit", () => {
    // Inject many events and verify it doesn't grow unbounded
    for (let i = 0; i < 2100; i++) {
      backend.ingestStructuredEvent({
        type: "system",
        subtype: "test",
        session_id: `s-${i}`,
      });
    }
    expect(backend.getStreamEvents().length).toBeLessThanOrEqual(2000);
  });

  it("removes websocket clients when init send fails", () => {
    const ws = {
      send: vi.fn(() => {
        throw new Error("closed");
      }),
      close: vi.fn(),
      on: vi.fn(),
    } as unknown as WebSocket;

    backend.addWsClient(ws);
    backend.ingestStructuredEvent({ type: "system", subtype: "after-close", session_id: "s1" });

    expect(ws.close).toHaveBeenCalledWith(1011, "init failed");
    expect(ws.send).toHaveBeenCalledTimes(1);
  });
});

describe("SpawnBackend for different commands", () => {
  it("constructs with gemini command", () => {
    const logger = makeLogger();
    const backend = new SpawnBackend(makeMeta({ command: "gemini", agent_type: "gemini" }), logger);
    expect(backend.meta.command).toBe("gemini");
  });

  it("constructs with shell command", () => {
    const logger = makeLogger();
    const backend = new SpawnBackend(makeMeta({ command: "bash", agent_type: "shell" }), logger);
    expect(backend.meta.command).toBe("bash");
  });
});
