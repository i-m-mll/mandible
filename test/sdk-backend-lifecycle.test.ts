import { describe, expect, it, vi } from "vitest";
import { SDKBackend } from "../src/backends/sdk-backend.js";
import type { ConsoleSession, Logger } from "../src/types.js";

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  return {
    query: () => {
      throw new Error("sdk unavailable");
    },
  };
});

function makeMeta(overrides: Partial<ConsoleSession> = {}): ConsoleSession {
  return {
    id: "sdk-test-id",
    label: "SDK Test",
    command: "claude",
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
    backend_type: "sdk",
    transport_lane: "sdk",
    transport_badge: { label: "SDK", title: "Agent SDK transport" },
    allowed_tools: null,
    mandible_session_id: null,
    resume_at_message: null,
    agent_type: "claude",
    channel_enabled: false,
    ...overrides,
  };
}

function makeLogger(): Logger {
  return vi.fn();
}

describe("SDKBackend lifecycle", () => {
  it("turns SDK setup failures into structured error results", async () => {
    const backend = new SDKBackend(makeMeta(), makeLogger());

    backend.sendPrompt("hello");

    await vi.waitFor(() => {
      expect(backend.getStreamEvents()).toEqual([
        expect.objectContaining({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["Error: sdk unavailable"],
        }),
      ]);
    });

    expect(backend.isProcessing).toBe(false);
  });
});
