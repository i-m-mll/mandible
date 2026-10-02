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
  it("reserves a real Claude session ID for a fresh SDK channel without exporting a token", () => {
    const originalBase = process.env.MANDIBLE_BASE;
    const originalCodexId = process.env.CODEX_THREAD_ID;
    process.env.MANDIBLE_BASE = "https://app.mandible.localhost:19420";
    process.env.CODEX_THREAD_ID = "parent-codex-task";
    try {
    const backend = new SDKBackend(
      makeMeta({ env: { MANDIBLE_TOKEN: "caller-token", CLAUDE_SESSION_ID: "unrelated-claude-task" } }),
      makeLogger(),
      undefined,
      "agent-token",
    );
    const sdkEnv = (backend as unknown as { buildClientEnv(): Record<string, string> }).buildClientEnv();
    expect(sdkEnv.MANDIBLE_TOKEN).toBeUndefined();
    expect(sdkEnv.MANDIBLE_MANAGED_CLIENT).toBe("1");
    const options = (backend as unknown as { buildQueryOptions(abort: AbortController): Record<string, unknown> })
      .buildQueryOptions(new AbortController());
    const providerId = options.sessionId as string;
    expect(providerId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(options.resume).toBeUndefined();
    const launchedEnv = options.env as Record<string, string>;
    expect(launchedEnv.CLAUDE_CODE_SESSION_ID).toBe(providerId);
    expect(launchedEnv.CLAUDE_SESSION_ID).toBeUndefined();
    expect(launchedEnv.CODEX_THREAD_ID).toBeUndefined();
    expect(launchedEnv.MANDIBLE_MANAGED_APP).toBe("claude");
    expect(launchedEnv.MANDIBLE_SESSION_ID).toBe("sdk-test-id");
    expect(buildMandibleChannelEnvironment("session-1", "/repo", providerId, null,
      { MANDIBLE_SOCKET: "/tmp/preview.sock" })).toEqual({
      MANDIBLE_SESSION_ID: "session-1",
      MANDIBLE_MANAGED_APP: "claude",
      CLAUDE_CODE_SESSION_ID: providerId,
      MANDIBLE_MANAGED_CLIENT: "1",
      CLAUDE_CWD: "/repo",
      MANDIBLE_SOCKET: "/tmp/preview.sock",
    });
    } finally {
      if (originalBase === undefined) delete process.env.MANDIBLE_BASE;
      else process.env.MANDIBLE_BASE = originalBase;
      if (originalCodexId === undefined) delete process.env.CODEX_THREAD_ID;
      else process.env.CODEX_THREAD_ID = originalCodexId;
    }
  });

  it("uses the known Claude ID on resume without requesting a new one", () => {
    const providerId = "12345678-1234-4234-8234-123456789abc";
    const backend = new SDKBackend(makeMeta({ provider_session_id: providerId }), makeLogger());
    const options = (backend as unknown as { buildQueryOptions(abort: AbortController): Record<string, unknown> })
      .buildQueryOptions(new AbortController());
    expect(options.resume).toBe(providerId);
    expect(options.sessionId).toBeUndefined();
    expect((options.env as Record<string, string>).CLAUDE_CODE_SESSION_ID).toBe(providerId);
    expect((options.env as Record<string, string>).MANDIBLE_MANAGED_APP).toBe("claude");
    expect(buildMandibleChannelEnvironment("mandible-session", "/repo", providerId, null, {}).CLAUDE_CODE_SESSION_ID)
      .toBe(providerId);
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
