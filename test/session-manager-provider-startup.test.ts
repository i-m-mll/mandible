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
const claudeProvenance: ProviderStartupProvenance = {
  backend_type: "sdk",
  provider: "claude_code",
  implementation: {
    kind: "package",
    name: "@anthropic-ai/claude-agent-sdk",
    version: "0.3.259",
    entrypoint: "/exact/claude",
    launcher: "/exact/node",
  },
};

function harness(onStart: (backend: AgenticBackend) => void = () => undefined) {
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
    start() {
      this.meta.status = "running";
      queueMicrotask(() => onStart(this as unknown as AgenticBackend));
    },
    stop: vi.fn(),
    destroy: vi.fn(),
    clear: vi.fn(),
    sendPrompt: vi.fn(),
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
  it("accepts a warm Claude transport without inventing a provider session or prompt", async () => {
    const { manager, backend } = harness();
    backend.prepare = vi.fn(async () => undefined);
    await expect(manager.startConversation("session-1", { timeoutMs: 20, provenance: claudeProvenance }))
      .resolves.toEqual({ provider_session_id: null, provenance: claudeProvenance });
    expect(backend.prepare).toHaveBeenCalledOnce();
    expect(backend.sendPrompt).not.toHaveBeenCalled();
  });

  it("propagates client cancellation into Claude preparation", async () => {
    const { manager, backend } = harness();
    let startupSignal: AbortSignal | undefined;
    backend.prepare = vi.fn((signal?: AbortSignal) => {
      startupSignal = signal;
      return new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const controller = new AbortController();
    const starting = manager.startConversation("session-1", {
      timeoutMs: 1_000,
      signal: controller.signal,
      provenance: claudeProvenance,
    });
    await vi.waitFor(() => expect(backend.prepare).toHaveBeenCalledOnce());
    controller.abort();
    await expect(starting).rejects.toMatchObject({ code: "client_aborted", phase: "readiness" });
    expect(startupSignal?.aborted).toBe(true);
  });

  it("times out readiness and removes every temporary listener", async () => {
    const { manager, backend } = harness();
    await expect(manager.startConversation("session-1", { timeoutMs: 5, provenance }))
      .rejects.toMatchObject({ code: "provider_startup_timeout", phase: "readiness" });
    expect(backend.listenerCount("meta_update")).toBe(0);
    expect(backend.listenerCount("status")).toBe(0);
    expect(backend.listenerCount("startup_error")).toBe(0);
  });

  it("handles a readiness timeout while initial configuration is still pending", async () => {
    const { manager, backend } = harness();
    vi.spyOn(manager, "waitForInitialRunOptions").mockReturnValue(new Promise(() => undefined));
    await expect(manager.startConversation("session-1", { timeoutMs: 5, provenance }))
      .rejects.toMatchObject({ code: "provider_startup_timeout", phase: "configuration" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(backend.listenerCount("meta_update")).toBe(0);
    expect(backend.listenerCount("status")).toBe(0);
    expect(backend.listenerCount("startup_error")).toBe(0);
  });

  it("accepts Codex provider proof without sending a synthetic prompt", async () => {
    const { manager } = harness((backend) => {
      backend.meta.provider_session_id = "provider-1";
      backend.emit("meta_update", { provider_session_id: "provider-1" });
    });
    await expect(manager.startConversation("session-1", { timeoutMs: 20, provenance }))
      .resolves.toEqual({ provider_session_id: "provider-1", provenance });
  });

  it("cancels armed readiness listeners when initial configuration fails", async () => {
    const { manager, backend } = harness();
    vi.spyOn(manager, "waitForInitialRunOptions").mockRejectedValue(new Error("invalid startup option"));
    await expect(manager.startConversation("session-1", { timeoutMs: 20, provenance }))
      .rejects.toMatchObject({ code: "provider_startup_failed", phase: "configuration" });
    expect(backend.listenerCount("meta_update")).toBe(0);
    expect(backend.listenerCount("status")).toBe(0);
    expect(backend.listenerCount("startup_error")).toBe(0);
  });

  it("maps arbitrary startup exceptions to the typed public boundary", async () => {
    const { manager, backend } = harness((current) => {
      queueMicrotask(() => current.emit("startup_error", new Error("raw provider secret")));
    });
    const failure = await manager.startConversation("session-1", { timeoutMs: 20, provenance })
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
