import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ControllerAcquisitionRequest } from "../src/conversation-control/adapter.js";
import { codexAppServerExecutable } from "../src/conversation-control/codex-app-server-client.js";
import { CodexAppServerControllerAdapter } from "../src/conversation-control/codex-controller.js";
import { chatItemIdentityKey } from "../src/conversation-control/provider-live.js";

import type { StructuredProcessSpawner } from "../src/conversation-control/structured-process.js";
import type { ConversationLifecycleEvent, ConversationOutboxItem, ProviderAdapterEvent } from "../src/conversation-control/types.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "structured-controller-process.mjs");
const adapters: Array<{ close(): Promise<void> }> = [];

it("selects the desktop Codex runtime for paginated threads and fails visibly when it is unavailable", () => {
  const checked: string[] = [];
  expect(codexAppServerExecutable({ platform: "darwin", override: "", checkExecutable: (value) => { checked.push(value); } }))
    .toBe("/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex");
  expect(checked).toEqual(["/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"]);
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
    expect(events.some((event) => event.kind === "controller-released")).toBe(false);
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

it("keeps Codex approvals and usage on the exact owned turn and interrupts without releasing",async()=>{
 const adapter=new CodexAppServerControllerAdapter({spawnProcess:spawner('codex',[]),codexExecutable:'codex'});adapters.push(adapter);
 const events=lifecycle(adapter);const usage:unknown[]=[];adapter.subscribeRuntimeEvents(event=>usage.push(event));
 expect((await adapter.acquire(acquisition('codex-thread'))).ok).toBe(true);
 expect((await adapter.deliver(delivery('send','approval-turn','permission'))).ok).toBe(true);
 await waitUntil(()=>adapter.permissions('conversation-1').length===1);
 expect(usage).toEqual([expect.objectContaining({conversation_id:'conversation-1',generation:4,snapshot:{usage:{total:{inputTokens:12,outputTokens:3,totalTokens:15}}}})]);
 expect((await adapter.decidePermission({conversation_id:'conversation-1',generation:5,request_id:'approval-1',decision:'allow'})).ok).toBe(false);
 expect((await adapter.decidePermission({conversation_id:'conversation-1',generation:4,request_id:'approval-1',decision:'deny'})).ok).toBe(true);
 await waitUntil(()=>events.some(event=>event.kind==='turn-completed'));
 expect(adapter.permissions('conversation-1')).toEqual([]);
 expect((await adapter.deliver(delivery('send','interrupt-turn','hold'))).ok).toBe(true);
 expect((await adapter.interrupt({conversation_id:'conversation-1',generation:4})).ok).toBe(true);
 await waitUntil(()=>events.some(event=>event.kind==='turn-cancelled'));
 expect(await adapter.probe({conversation_id:'conversation-1',generation:4,controller_instance_id:'controller-1',provider_session_id:'codex-thread'})).toMatchObject({ok:true,value:{kind:'owned'}});
});
