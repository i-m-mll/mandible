import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ControllerAcquisitionRequest } from "../src/conversation-control/adapter.js";
import { ClaudeStreamControllerAdapter } from "../src/conversation-control/claude-controller.js";
import { CodexAppServerControllerAdapter } from "../src/conversation-control/codex-controller.js";
import type { StructuredProcessSpawner } from "../src/conversation-control/structured-process.js";
import type { ConversationLifecycleEvent, ConversationOutboxItem } from "../src/conversation-control/types.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "structured-controller-process.mjs");
const adapters: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
});

function spawner(
  provider: "claude" | "codex",
  calls: Array<{ command: string; args: readonly string[] }>,
  env: NodeJS.ProcessEnv = {},
): StructuredProcessSpawner {
  return (command, args, options) => {
    calls.push({ command, args: [...args] });
    return spawn(process.execPath, [fixture, provider, ...args], {
      ...options,
      env: { ...options.env, ...env },
    }) as ChildProcessWithoutNullStreams;
  };
}

function acquisition(providerSessionId: string): ControllerAcquisitionRequest {
  return {
    kind: "resume-provider-session",
    conversation_id: "conversation-1",
    generation: 4,
    controller_instance_id: "controller-1",
    provider_session_id: providerSessionId,
  };
}

function delivery(operation: "resume-provider-session" | "send" | "steer", turnId: string, message: string): ConversationOutboxItem {
  return {
    id: `delivery-${turnId}`,
    conversation_id: "conversation-1",
    generation: 4,
    turn_id: turnId,
    operation,
    message,
    message_anchor: null,
    runtime_options: {},
    idempotency_key: `key-${turnId}`,
    state: "delivering",
    attempts: 1,
    provider_receipt_id: null,
  };
}

function lifecycle(adapter: { subscribe(listener: (event: ConversationLifecycleEvent & { conversation_id: string; generation: number }) => { ok: true; value: undefined }): () => void }) {
  const events: Array<ConversationLifecycleEvent & { conversation_id: string; generation: number }> = [];
  adapter.subscribe((event) => {
    events.push(event);
    return { ok: true, value: undefined };
  });
  return events;
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("structured conversation controller adapters", () => {
  it("keeps Claude stream JSON open and steers the active turn cooperatively", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const adapter = new ClaudeStreamControllerAdapter({ spawnProcess: spawner("claude", calls) });
    adapters.push(adapter);
    const events = lifecycle(adapter);

    expect((await adapter.acquire({
      ...acquisition("claude-session"),
      runtime_options: { model: "claude-opus-4-1", effort: "high", permission_mode: "bypassPermissions" },
    })).ok).toBe(true);
    expect(calls[0]).toEqual({
      command: "claude",
      args: [
        "-p",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--replay-user-messages",
        "--model", "claude-opus-4-1",
        "--effort", "high",
        "--permission-mode", "bypassPermissions",
        "--resume", "claude-session",
      ],
    });

    expect((await adapter.deliver(delivery("resume-provider-session", "turn-1", "hold"))).ok).toBe(true);
    expect((await adapter.deliver(delivery("steer", "steer-delivery", "redirect"))).ok).toBe(true);
    await settle();

    expect(events.filter((event) => event.kind === "turn-started").map((event) => "turn_id" in event ? event.turn_id : null))
      .toEqual(["turn-1"]);
    expect(events.filter((event) => event.kind === "turn-completed" && event.turn_id === "turn-1")).toHaveLength(1);
    expect(events.some((event) => event.kind === "ownership-unknown")).toBe(false);
  });

  it("uses Codex managed auth and exact App Server turn identity for steering", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const adapter = new CodexAppServerControllerAdapter({ spawnProcess: spawner("codex", calls) });
    adapters.push(adapter);
    const events = lifecycle(adapter);

    expect((await adapter.acquire(acquisition("codex-thread"))).ok).toBe(true);
    expect(calls[0]).toEqual({ command: "codex", args: ["app-server", "--listen", "stdio://"] });
    expect((await adapter.deliver(delivery("resume-provider-session", "turn-1", "hold"))).ok).toBe(true);
    expect((await adapter.deliver(delivery("steer", "steer-delivery", "redirect"))).ok).toBe(true);
    await settle();

    expect(events.filter((event) => event.kind === "turn-started").map((event) => "turn_id" in event ? event.turn_id : null))
      .toEqual(["turn-1"]);
    expect(events.filter((event) => event.kind === "turn-completed" && event.turn_id === "turn-1")).toHaveLength(1);
    expect(events.some((event) => event.kind === "ownership-unknown")).toBe(false);
  });

  it("starts provider-native sessions without leaking queue or anchor capabilities", async () => {
    const claudeCalls: Array<{ command: string; args: readonly string[] }> = [];
    const codexCalls: Array<{ command: string; args: readonly string[] }> = [];
    const claude = new ClaudeStreamControllerAdapter({ spawnProcess: spawner("claude", claudeCalls) });
    const codex = new CodexAppServerControllerAdapter({ spawnProcess: spawner("codex", codexCalls) });
    adapters.push(claude, codex);

    const start = {
      kind: "start" as const,
      conversation_id: "conversation-1",
      generation: 4,
      controller_instance_id: "controller-1",
    };
    const claudeStarted = await claude.acquire(start);
    const codexStarted = await codex.acquire(start);

    expect(claudeStarted.ok && claudeStarted.value.provider_session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(claudeCalls[0].args.at(-2)).toBe("--session-id");
    expect(codexStarted).toMatchObject({ ok: true, value: { provider_session_id: "codex-new-thread" } });
    expect(claude.capabilities).toMatchObject({ steer: true, queue: false, resume_message_anchor: false });
    expect(codex.capabilities).toMatchObject({ steer: true, queue: false, resume_message_anchor: false });
  });

  it("fails restart probes closed except for explicit Codex provider-authoritative idle state", async () => {
    const claude = new ClaudeStreamControllerAdapter({ spawnProcess: spawner("claude", []) });
    const codex = new CodexAppServerControllerAdapter({ spawnProcess: spawner("codex", []) });
    const unloadedCodex = new CodexAppServerControllerAdapter({
      spawnProcess: spawner("codex", [], { FAKE_CODEX_THREAD_STATUS: "notLoaded" }),
    });
    adapters.push(claude, codex, unloadedCodex);
    const probe = {
      conversation_id: "conversation-1",
      generation: 4,
      controller_instance_id: "controller-1",
      provider_session_id: "provider-session",
    };

    expect(await claude.probe(probe)).toEqual({ ok: true, value: { kind: "unknown", reason: "probe-ambiguous" } });
    expect(await codex.probe(probe)).toEqual({ ok: true, value: { kind: "released" } });
    expect(await unloadedCodex.probe(probe)).toEqual({ ok: true, value: { kind: "unknown", reason: "probe-ambiguous" } });
  });
});
