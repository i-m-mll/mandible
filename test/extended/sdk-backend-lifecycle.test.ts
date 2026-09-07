import { describe, expect, it, vi } from "vitest";
import { buildMandibleChannelEnvironment, SDKBackend } from "../../src/backends/sdk-backend.js";
import type { ConsoleSession, Logger } from "../../src/types.js";
import { ProviderStartupError } from "../../src/provider-startup.js";

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
  it("injects the provisioned token into SDK and channel-server environments", () => {
    const backend = new SDKBackend(
      makeMeta({ env: { MANDIBLE_TOKEN: "caller-token" } }),
      makeLogger(),
      undefined,
      "agent-token",
    );
    const sdkEnv = (backend as unknown as { buildClientEnv(): Record<string, string> }).buildClientEnv();
    expect(sdkEnv.MANDIBLE_TOKEN).toBe("agent-token");
    expect(sdkEnv.MANDIBLE_MANAGED_CLIENT).toBe("1");
    expect(buildMandibleChannelEnvironment("session-1", "/repo", "agent-token")).toEqual({
      MANDIBLE_SESSION_ID: "session-1",
      MANDIBLE_MANAGED_CLIENT: "1",
      CLAUDE_CWD: "/repo",
      MANDIBLE_TOKEN: "agent-token",
    });
  });

  it("turns SDK setup failures into structured error results", async () => {
    const backend = new SDKBackend(makeMeta(), makeLogger());
    const startupError = vi.fn();
    backend.on("startup_error", startupError);

    backend.sendPrompt("hello");

    await vi.waitFor(() => {
      expect(backend.getStreamEvents()).toEqual([
        expect.objectContaining({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["Claude failed before its native conversation was ready."],
        }),
      ]);
    });

    expect(backend.isProcessing).toBe(false);
    expect(startupError).toHaveBeenCalledWith(expect.any(ProviderStartupError));
    expect(startupError.mock.calls[0][0]).toMatchObject({ code: "provider_startup_failed", phase: "readiness" });
  });
});
