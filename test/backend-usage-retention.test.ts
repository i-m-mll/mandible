import { describe, expect, it } from "vitest";

import { ACP_USAGE_LOG_LIMIT, AcpBackend } from "../src/backends/acp-backend.js";
import type { AcpJsonRpcMessage } from "../src/backends/acp-protocol.js";
import { SDK_USAGE_LOG_LIMIT, SDKBackend } from "../src/backends/sdk-backend.js";
import type { ConsoleSession } from "../src/types.js";

function makeMeta(backendType: "sdk" | "acp"): ConsoleSession {
  return {
    id: `${backendType}-usage-test`,
    label: "Usage retention",
    command: backendType === "acp" ? "codex" : "claude",
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
    created_at: 1,
    updated_at: 1,
    started_at: null,
    stopped_at: null,
    backend_type: backendType,
    transport_lane: backendType,
    transport_badge: backendType === "acp"
      ? { label: "ACP", title: "Agent Client Protocol transport" }
      : { label: "SDK", title: "Agent SDK transport" },
    allowed_tools: null,
    mandible_session_id: null,
    resume_at_message: null,
    agent_type: backendType === "acp" ? "codex" : "claude",
    channel_enabled: false,
  };
}

describe("backend usage retention", () => {
  it("keeps only the newest SDK usage diagnostics", () => {
    const backend = new SDKBackend(makeMeta("sdk"), () => undefined);
    for (let index = 0; index < SDK_USAGE_LOG_LIMIT + 5; index += 1) {
      backend.ingestStructuredEvent({
        type: "result",
        subtype: "success",
        usage: { input_tokens: index },
      });
    }

    const usage = backend.getUsage();
    expect(usage).toHaveLength(SDK_USAGE_LOG_LIMIT);
    expect(usage[0]).toMatchObject({ input_tokens: 5 });
    expect(usage.at(-1)).toMatchObject({ input_tokens: SDK_USAGE_LOG_LIMIT + 4 });
  });

  it("keeps only the newest ACP cumulative usage diagnostics", () => {
    const backend = new AcpBackend(makeMeta("acp"), () => undefined);
    const handleMessage = (backend as unknown as {
      handleMessage(message: AcpJsonRpcMessage): void;
    }).handleMessage.bind(backend);

    for (let index = 0; index < ACP_USAGE_LOG_LIMIT + 5; index += 1) {
      handleMessage({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "provider-session",
          update: { type: "usage_update", usage: { inputTokens: index } },
        },
      });
    }

    const usage = backend.getUsage();
    expect(usage).toHaveLength(ACP_USAGE_LOG_LIMIT);
    expect(usage[0]).toMatchObject({ input_tokens: 5 });
    expect(usage.at(-1)).toMatchObject({ input_tokens: ACP_USAGE_LOG_LIMIT + 4 });
  });
});
