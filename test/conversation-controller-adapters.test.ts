import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ControllerAcquisitionRequest } from "../src/conversation-control/adapter.js";
import { codexAppServerExecutable } from "../src/conversation-control/codex-app-server-client.js";
import { ClaudeStreamControllerAdapter } from "../src/conversation-control/claude-controller.js";
import { CodexAppServerControllerAdapter } from "../src/conversation-control/codex-controller.js";
import { chatItemIdentityKey } from "../src/conversation-control/provider-live.js";
import {
  CLAUDE_NATIVE_BACKGROUND_PROFILE,
  defaultProviderMode,
  providerAdapterProfile,
} from "../src/conversation-control/provider-capabilities.js";
import type { StructuredProcessSpawner } from "../src/conversation-control/structured-process.js";
import type { ConversationLifecycleEvent, ConversationOutboxItem, ProviderAdapterEvent } from "../src/conversation-control/types.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "structured-controller-process.mjs");
const adapters: Array<{ close(): Promise<void> }> = [];

it("selects the desktop Codex runtime for paginated threads and fails visibly when it is unavailable", () => {
  const checked: string[] = [];
  expect(codexAppServerExecutable({ platform: "darwin", override: "", checkExecutable: (value) => { checked.push(value); } }))
    .toBe("/Applications/ChatGPT.app/Contents/Resources/codex");
  expect(checked).toEqual(["/Applications/ChatGPT.app/Contents/Resources/codex"]);
  expect(codexAppServerExecutable({ platform: "darwin", override: "/custom/codex", checkExecutable: () => {} }))
    .toBe("/custom/codex");
  expect(() => codexAppServerExecutable({ platform: "darwin", override: "", checkExecutable: () => { throw new Error("missing"); } }))
    .toThrow("Set MANDIBLE_CODEX_APP_SERVER_BIN");
});

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
    attachments: [],
    attachment_db_path: "/tmp/mandible-test.db",
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

function providerEvents(adapter: { subscribeProviderEvents(listener: (event: ProviderAdapterEvent) => void): () => void }) {
  const events: ProviderAdapterEvent[] = [];
  adapter.subscribeProviderEvents((event) => events.push(event));
  return events;
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`condition was not met within ${timeoutMs}ms`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

describe("structured conversation controller adapters", () => {
  it("defaults Claude Chat to SDK-managed control and keeps native background capabilities honest", () => {
    expect(defaultProviderMode("claude_code")).toBe("sdk-managed");
    expect(providerAdapterProfile("claude_code")).toMatchObject({
      adapter_id: "claude-stream-json-v1",
      capabilities: { structured_deltas: true, steer: true, terminal_attach: false, logs: false },
    });
    expect(CLAUDE_NATIVE_BACKGROUND_PROFILE.capabilities).toMatchObject({
      mode: "native-background",
      structured_deltas: false,
      send: false,
      steer: false,
      permission_callbacks: false,
      terminal_attach: true,
      logs: true,
      stop: true,
      remove: true,
      initial_message_acceptance: "unavailable",
    });
  });

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
    await waitUntil(() => events.some((event) => event.kind === "turn-completed" && event.turn_id === "turn-1"));

    expect(events.filter((event) => event.kind === "turn-started").map((event) => "turn_id" in event ? event.turn_id : null))
      .toEqual(["turn-1"]);
    expect(events.filter((event) => event.kind === "turn-completed" && event.turn_id === "turn-1")).toHaveLength(1);
    expect(events.some((event) => event.kind === "ownership-unknown")).toBe(false);
  });

  it("uses Codex managed auth and exact App Server turn identity for steering", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const adapter = new CodexAppServerControllerAdapter({ spawnProcess: spawner("codex", calls), codexExecutable: "codex" });
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

  it("accepts initial messages only with exact provider protocol receipts", async () => {
    const claude = new ClaudeStreamControllerAdapter({ spawnProcess: spawner("claude", []) });
    const codex = new CodexAppServerControllerAdapter({ spawnProcess: spawner("codex", []), codexExecutable: "codex" });
    adapters.push(claude, codex);
    expect((await claude.acquire(acquisition("claude-session"))).ok).toBe(true);
    expect((await codex.acquire(acquisition("codex-thread"))).ok).toBe(true);

    expect(await claude.deliver(delivery("resume-provider-session", "claude-turn", "hello"))).toMatchObject({
      ok: true,
      value: { acceptance: { kind: "claude-stream-user-echo", provider_session_id: "claude-session" } },
    });
    expect(await codex.deliver(delivery("resume-provider-session", "codex-turn", "hello"))).toMatchObject({
      ok: true,
      value: {
        provider_receipt_id: "codex:turn:native-key-codex-turn",
        acceptance: { kind: "codex-turn-response", provider_session_id: "codex-thread", provider_turn_id: "native-key-codex-turn" },
      },
    });
  });

  it("projects provider deltas provisionally using stable message identities", async () => {
    const claude = new ClaudeStreamControllerAdapter({ spawnProcess: spawner("claude", []) });
    const codex = new CodexAppServerControllerAdapter({ spawnProcess: spawner("codex", []), codexExecutable: "codex" });
    adapters.push(claude, codex);
    const claudeEvents = providerEvents(claude);
    const codexEvents = providerEvents(codex);
    expect((await claude.acquire(acquisition("claude-session"))).ok).toBe(true);
    expect((await codex.acquire(acquisition("codex-thread"))).ok).toBe(true);

    expect((await claude.deliver(delivery("resume-provider-session", "claude-turn", "delta"))).ok).toBe(true);
    expect((await codex.deliver(delivery("resume-provider-session", "codex-turn", "delta"))).ok).toBe(true);
    await waitUntil(() => {
      const hasFinalDelta = (events: ProviderAdapterEvent[], itemId: string) => events.some((event) =>
        event.kind === "provisional-content"
        && event.item.identity.native_item_id === itemId
        && event.item.parts.some((content) => content.text === "hello"));
      return hasFinalDelta(claudeEvents, "claude-message-1")
        && hasFinalDelta(codexEvents, "codex-message-1");
    });

    expect(claudeEvents.filter((event) => event.kind === "provisional-content"
      && event.item.identity.native_item_id === "claude-message-1").at(-1)).toMatchObject({
      item: { type: "message", parts: [{ type: "text", text: "hello", native_index: 0 }] },
    });
    expect(codexEvents.filter((event) => event.kind === "provisional-content"
      && event.item.identity.native_item_id === "codex-message-1").at(-1)).toMatchObject({
      item: { type: "message", parts: [{ type: "text", text: "hello" }] },
    });
    expect(claudeEvents.find((event) => event.kind === "provisional-content"
      && event.item.identity.native_item_id === "key-claude-turn")).toMatchObject({
      correlation: { intent_id: "key-claude-turn", delivery_id: "delivery-claude-turn", turn_id: "claude-turn" },
      item: { type: "message", role: "user" },
    });
    expect(codexEvents.filter((event) => event.kind === "provisional-content"
      && event.item.identity.native_item_id === "key-codex-turn").at(-1)).toMatchObject({
      correlation: {
        intent_id: "key-codex-turn",
        delivery_id: "delivery-codex-turn",
        turn_id: "codex-turn",
        provider_message_id: "user-key-codex-turn",
      },
      item: { type: "message", role: "user" },
    });
    for (const event of [...claudeEvents, ...codexEvents]) {
      if (event.kind === "provisional-content") expect(event.identity).toBe(chatItemIdentityKey(event.item));
    }
  });

  it("preserves Claude sibling content blocks and drops live records without message identity", async () => {
    const claude = new ClaudeStreamControllerAdapter({ spawnProcess: spawner("claude", []) });
    adapters.push(claude);
    const events = providerEvents(claude);
    expect((await claude.acquire(acquisition("claude-session"))).ok).toBe(true);

    expect((await claude.deliver(delivery("resume-provider-session", "sibling-turn", "siblings"))).ok).toBe(true);
    await waitUntil(() => events.filter((event) => event.kind === "provisional-content"
      && event.item.identity.native_item_id === "claude-siblings"
      && event.item.content_completion === "complete").length === 2);

    const siblings = events.filter((event) => event.kind === "provisional-content"
      && event.item.identity.native_item_id === "claude-siblings"
      && event.item.content_completion === "complete");
    expect(siblings.map((event) => event.kind === "provisional-content" ? [
      event.item.type === "activity" ? event.item.activity_kind : event.item.type,
      event.item.identity.native_content_index,
      event.item.parts[0]?.text,
    ] : [])).toEqual([
      ["thinking", 0, "working"],
      ["message", 1, "answer"],
    ]);
    expect(new Set(siblings.map((event) => event.kind === "provisional-content" ? event.identity : "")).size).toBe(2);

    const beforeMissing = events.length;
    expect((await claude.deliver(delivery("resume-provider-session", "missing-turn", "missing-id"))).ok).toBe(true);
    await settle();
    expect(events.slice(beforeMissing).some((event) => event.kind === "provisional-content"
      && event.item.parts.some((part) => part.text.includes("must")))).toBe(false);
  });

  it("adapts Codex reasoning, plans, and tool snapshots without hidden provider payloads", async () => {
    const codex = new CodexAppServerControllerAdapter({ spawnProcess: spawner("codex", []), codexExecutable: "codex" });
    adapters.push(codex);
    const events = providerEvents(codex);
    expect((await codex.acquire(acquisition("codex-thread"))).ok).toBe(true);
    expect((await codex.deliver(delivery("resume-provider-session", "rich-turn", "rich"))).ok).toBe(true);
    await waitUntil(() => events.some((event) => event.kind === "provisional-content"
      && event.item.identity.native_item_id === "command-rich"
      && event.item.content_completion === "complete"));

    const items = events.flatMap((event) => event.kind === "provisional-content" ? [event.item] : []);
    expect(items.find((item) => item.type === "activity" && item.activity_kind === "reasoning-summary"
      && item.content_completion === "complete")).toMatchObject({
      parts: [{ text: "first", native_index: 0 }, { text: "second", native_index: 1 }],
    });
    expect(items.find((item) => item.type === "activity" && item.activity_kind === "thinking")).toMatchObject({
      parts: [{ text: "visible reasoning", native_index: 0 }],
    });
    expect(items.find((item) => item.type === "plan")).toMatchObject({
      parts: [{ text: "Do the exact work" }], content_completion: "complete",
    });
    expect(items.find((item) => item.type === "tool-call" && item.identity.native_item_id === "command-rich"
      && item.content_completion === "complete")).toMatchObject({
      tool_kind: "commandExecution", input: "true", output: "ok", execution_outcome: "succeeded",
    });
    expect(JSON.stringify(items)).not.toContain("encrypted");
  });

  it("classifies Codex spawn lineage only with exact sender and receiver identities", async () => {
    const codex = new CodexAppServerControllerAdapter({ spawnProcess: spawner("codex", []), codexExecutable: "codex" });
    adapters.push(codex);
    const events = providerEvents(codex);
    expect((await codex.acquire(acquisition("codex-thread"))).ok).toBe(true);
    expect((await codex.deliver(delivery("resume-provider-session", "codex-turn", "lineage"))).ok).toBe(true);
    await waitUntil(() => events.some((event) => event.kind === "provider-lineage"));

    expect(events.filter((event) => event.kind === "provider-lineage")).toEqual([expect.objectContaining({
      provider_event_id: "spawn-exact",
      sender_provider_session_id: "codex-thread",
      receiver_provider_session_id: "child-thread",
      relation: "spawned-child",
    })]);
  });

  it("keeps acknowledged live content visible when a provider crashes and marks the turn unknown", async () => {
    const claude = new ClaudeStreamControllerAdapter({ spawnProcess: spawner("claude", []) });
    adapters.push(claude);
    const lifecycleEvents = lifecycle(claude);
    const liveEvents = providerEvents(claude);
    expect((await claude.acquire(acquisition("claude-session"))).ok).toBe(true);
    expect((await claude.deliver(delivery("resume-provider-session", "crash-turn", "crash"))).ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(liveEvents.some((event) => event.kind === "provisional-content"
      && event.item.identity.native_item_id === "claude-before-crash"
      && event.item.parts.some((part) => part.text === "visible before crash"))).toBe(true);
    expect(lifecycleEvents.filter((event) => event.kind === "turn-unknown")).toHaveLength(1);
    expect(lifecycleEvents.filter((event) => event.kind === "controller-released")).toHaveLength(1);
  });

  it("starts provider-native sessions without leaking queue or anchor capabilities", async () => {
    const claudeCalls: Array<{ command: string; args: readonly string[] }> = [];
    const codexCalls: Array<{ command: string; args: readonly string[] }> = [];
    const claude = new ClaudeStreamControllerAdapter({ spawnProcess: spawner("claude", claudeCalls) });
    const codex = new CodexAppServerControllerAdapter({ spawnProcess: spawner("codex", codexCalls), codexExecutable: "codex" });
    adapters.push(claude, codex);

    const start = {
      kind: "start" as const,
      conversation_id: "conversation-1",
      generation: 4,
      controller_instance_id: "controller-1",
      cwd: "/tmp",
      runtime_options: { model: "claude-opus-5", permission_mode: "bypassPermissions" as const },
    };
    const claudeStarted = await claude.acquire(start);
    const codexStarted = await codex.acquire({
      ...start,
      runtime_options: { model: "gpt-5.6-sol", permission_mode: "agent-full-access" },
    });

    expect(claudeStarted.ok && claudeStarted.value.provider_session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(claudeCalls[0].args).toContain("claude-opus-5");
    expect(claudeCalls[0].args.at(-2)).toBe("--session-id");
    expect(codexStarted).toMatchObject({ ok: true, value: { provider_session_id: "codex-new-thread" } });
    expect(codexCalls[0]).toEqual({ command: "codex", args: ["app-server", "--listen", "stdio://"] });
    expect(claude.capabilities).toMatchObject({ steer: true, queue: false, resume_message_anchor: false });
    expect(codex.capabilities).toMatchObject({ steer: true, queue: false, resume_message_anchor: false });
  });

  it("fails restart probes closed except for explicit Codex provider-authoritative idle state", async () => {
    const claude = new ClaudeStreamControllerAdapter({ spawnProcess: spawner("claude", []) });
    const codex = new CodexAppServerControllerAdapter({ spawnProcess: spawner("codex", []), codexExecutable: "codex" });
    const unloadedCodex = new CodexAppServerControllerAdapter({
      spawnProcess: spawner("codex", [], { FAKE_CODEX_THREAD_STATUS: "notLoaded" }),
      codexExecutable: "codex",
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

  it("classifies an already active Codex thread as ambiguous acquisition", async () => {
    const codex = new CodexAppServerControllerAdapter({
      spawnProcess: spawner("codex", [], { FAKE_CODEX_RESUME_STATUS: "active" }),
      codexExecutable: "codex",
    });
    adapters.push(codex);
    expect(await codex.acquire(acquisition("codex-thread"))).toMatchObject({
      ok: false, error: { kind: "adapter-failure", code: "acquisition-ambiguous" },
    });
  });
});
