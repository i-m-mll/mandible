import fs from "node:fs";
import { runCli, scratchDir } from "./helpers/cli-process.js";
import { ConversationControlService } from "../src/conversation-control/service.js";
import { SessionExecutionStore } from "../src/session-execution.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";
import { waitUntil } from "./helpers/wait-until.js";
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

const waitFor = (predicate: () => boolean) => waitUntil(predicate, "controller state", 5);

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
    await waitFor(() => events.some((event) => event.kind === "provisional-content"
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
 const events=lifecycle(adapter);const usage:unknown[]=[];adapter.subscribeRuntimeEvents(event=>{if(event.kind === "usage") usage.push(event);});
 expect((await adapter.acquire(acquisition('codex-thread'))).ok).toBe(true);
 expect((await adapter.deliver(delivery('send','approval-turn','permission'))).ok).toBe(true);
 await waitFor(()=>adapter.permissions('conversation-1').length===1);
 expect(usage).toEqual([expect.objectContaining({conversation_id:'conversation-1',generation:4,snapshot:{usage:{total:{inputTokens:12,outputTokens:3,totalTokens:15}}}})]);
 expect((await adapter.decidePermission({conversation_id:'conversation-1',generation:5,request_id:'approval-1',decision:'allow'})).ok).toBe(false);
 expect((await adapter.decidePermission({conversation_id:'conversation-1',generation:4,request_id:'approval-1',decision:'deny'})).ok).toBe(true);
 await waitFor(()=>events.some(event=>event.kind==='turn-completed'));
 expect(adapter.permissions('conversation-1')).toEqual([]);
 expect((await adapter.deliver(delivery('send','interrupt-turn','hold'))).ok).toBe(true);
 expect((await adapter.interrupt({conversation_id:'conversation-1',generation:4})).ok).toBe(true);
 await waitFor(()=>events.some(event=>event.kind==='turn-cancelled'));
 expect(await adapter.probe({conversation_id:'conversation-1',generation:4,controller_instance_id:'controller-1',provider_session_id:'codex-thread'})).toMatchObject({ok:true,value:{kind:'owned'}});
});

it("persists authoritative Codex terminal errors through retries, duplicates and idle updates until the next accepted turn", async () => {
  const db = migratedMemoryDb();
  const spawned: NodeJS.ProcessEnv[] = [];
  const nativeState = scratchDir("codex-managed");
  const fixtureSpawn = spawner("codex", [], { FAKE_CODEX_NATIVE_STATE: nativeState });
  const adapter = new CodexAppServerControllerAdapter({ codexExecutable: "codex", spawnProcess: (command, args, options) => {
    spawned.push(options.env ?? {}); return fixtureSpawn(command, args, options);
  } });
  const events = lifecycle(adapter);
  const service = new ConversationControlService(db);
  const unregister = service.registerAdapter(adapter);
  const execution = new SessionExecutionStore(db);
  try {
    expect((await service.acquireNew({ conversation_id: "conversation-1", provider: "codex", generation: 4, cwd: "/tmp" }, (lease) => {
      db.prepare(`INSERT INTO conversations (id, source, source_path, source_hash, source_mtime, title, started_at, block_count, session_id, created_at, updated_at)
        VALUES ('conversation-1', 'codex', '/tmp/codex-transcript', 'hash', 1, 'Codex', '2026-01-01', 0, ?, '2026-01-01', '2026-01-01')`).run(lease.provider_session_id);
    })).ok).toBe(true);
    const childEnv = spawned.at(-1)!;
    const observer = await runCli([path.resolve("hooks/session-execution.sh"), "codex"], {
      command: "bash", input: JSON.stringify({ session_id: "codex-new-thread", hook_event_name: "Stop" }),
      env: { ...childEnv, MANDIBLE_BASE: "", MANDIBLE_SOCKET: path.join(nativeState, "absent.sock") },
    });
    expect(observer).toEqual({ status: 0, stdout: "", stderr: "" });
    expect(execution.read("codex", "codex-new-thread")?.state).toEqual({ kind: "unknown" });
    const submit = async (message: string) => {
      const snapshot = service.getSnapshot("conversation-1");
      if (!snapshot.ok) throw new Error(JSON.stringify(snapshot.error));
      const submitted = await service.submit({ conversation_id: "conversation-1", operation: "send", expected_revision: snapshot.value.revision,
        expected_generation: 4, idempotency_key: crypto.randomUUID(), message });
      expect(submitted.ok, JSON.stringify(submitted)).toBe(true);
    };
    for (const [message, type, data] of [
      ["retry-failure", "usageLimitExceeded", null],
      ["object-failure", "responseStreamDisconnected", { responseStreamDisconnected: { httpStatusCode: 429 } }],
      ["no-code-failure", null, null],
    ] as const) {
      await submit(message);
      await waitFor(() => execution.read("codex", "codex-new-thread")?.state.kind === "failure");
      expect(execution.read("codex", "codex-new-thread")).toMatchObject({ source: "codex_app_server", controller_generation: 4,
        event: "turn/completed", turn_id: expect.stringMatching(/^native-/), state: { kind: "failure", error: { type, data, message: "native failure", details: "native detail" } } });
    }
    expect(events.filter(event => event.kind === "turn-failed")).toHaveLength(3);
    expect(events.some(event => event.kind === "turn-unknown" || event.kind === "controller-released")).toBe(false);
    await submit("hold");
    expect(execution.read("codex", "codex-new-thread")?.state).toEqual({ kind: "working" });
    expect((await service.interrupt("conversation-1", 4)).ok).toBe(true);
    await waitFor(() => execution.read("codex", "codex-new-thread")?.state.kind === "interrupted");
    await submit("normal");
    await waitFor(() => execution.read("codex", "codex-new-thread")?.state.kind === "stopped");
    expect((await service.stop("conversation-1", 4)).ok).toBe(true);
    expect(execution.read("codex", "codex-new-thread")?.state).toEqual({ kind: "ended", reason: "mandible:controller-relinquished" });
    const stopped = service.getSnapshot("conversation-1");
    if (!stopped.ok) throw new Error(JSON.stringify(stopped.error));
    expect((await service.resume({ conversation_id: "conversation-1", expected_generation: 4,
      expected_revision: stopped.value.revision, cwd: "/tmp" })).ok).toBe(true);
    expect(spawned.at(-1)?.MANDIBLE_EXECUTION_OBSERVER_SESSION_ID).toBe("codex-new-thread");
    expect(execution.read("codex", "codex-new-thread")).toMatchObject({ controller_generation: 5, state: { kind: "unknown" } });
    await service.close();
    expect(execution.read("codex", "codex-new-thread")?.state).toEqual({ kind: "ended", reason: "mandible:controller-released" });
  } finally { await service.close(); unregister(); db.close(); fs.rmSync(nativeState, { recursive: true, force: true }); }
});
