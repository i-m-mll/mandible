import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { AgenticBackend } from "../src/agentic-backend.js";
import { ProviderStartupError, type ProviderStartupProvenance } from "../src/provider-startup.js";
import { SessionManager } from "../src/session-manager.js";

const provenance: ProviderStartupProvenance = {
  backend_type: "acp",
  provider: "gemini",
  implementation: {
    kind: "executable",
    name: "gemini",
    version: null,
    entrypoint: "/exact/gemini",
    launcher: "/exact/gemini",
  },
};

function harness(sendPrompt: (backend: AgenticBackend) => void = () => undefined) {
  const manager = new SessionManager(null, vi.fn());
  const backend = Object.assign(new EventEmitter(), {
    id: "session-1",
    meta: {
      id: "session-1",
      command: "gemini",
      backend_type: "acp",
      provider_session_id: null,
      status: "stopped",
    },
    getStartupProvenance: () => provenance,
    start() { this.meta.status = "running"; },
    stop: vi.fn(),
    destroy: vi.fn(),
    clear: vi.fn(),
    sendPrompt() { sendPrompt(this as unknown as AgenticBackend); },
    write: vi.fn(),
    resize: vi.fn(),
    addWsClient: vi.fn(),
    removeWsClient: vi.fn(),
    getBufferSnapshot: () => Buffer.alloc(0),
    getStreamEvents: () => [],
    ingestStructuredEvent: vi.fn(),
    ingestText: vi.fn(),
  }) as unknown as AgenticBackend;
  (manager as unknown as { sessions: Map<string, AgenticBackend> }).sessions.set(backend.id, backend);
  return { manager, backend };
}

describe("conversation provider startup", () => {
  it("times out readiness and removes every temporary listener", async () => {
    const { manager, backend } = harness();
    await expect(manager.startConversation("session-1", "hello", { timeoutMs: 5, provenance }))
      .rejects.toMatchObject({ code: "provider_startup_timeout", phase: "readiness" });
    expect(backend.listenerCount("meta_update")).toBe(0);
    expect(backend.listenerCount("status")).toBe(0);
    expect(backend.listenerCount("startup_error")).toBe(0);
  });

  it("accepts provider proof that arrives while the prompt is queued", async () => {
    const { manager } = harness((backend) => {
      backend.meta.provider_session_id = "provider-1";
    });
    await expect(manager.startConversation("session-1", "hello", { timeoutMs: 20, provenance }))
      .resolves.toEqual({ provider_session_id: "provider-1", provenance });
  });

  it("maps arbitrary startup exceptions to the typed public boundary", async () => {
    const { manager, backend } = harness((current) => {
      queueMicrotask(() => current.emit("startup_error", new Error("raw provider secret")));
    });
    const failure = await manager.startConversation("session-1", "hello", { timeoutMs: 20, provenance })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderStartupError);
    expect(failure).toMatchObject({
      code: "provider_startup_failed",
      message: "The provider failed before its native conversation was ready.",
      phase: "readiness",
    });
    expect(String(failure)).not.toContain("raw provider secret");
    expect(backend.listenerCount("startup_error")).toBe(0);
  });
});
