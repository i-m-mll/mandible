import { afterEach, expect, it } from "vitest";
import type { Options, Query, SDKMessage, SDKUserMessage, WarmQuery } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSdkControllerAdapter } from "../src/conversation-control/claude-controller.js";
import type { ClaudeSdk } from "../src/conversation-control/claude-sdk-transport.js";
import type { ConversationOutboxItem } from "../src/conversation-control/types.js";

const adapters: ClaudeSdkControllerAdapter[] = [];
afterEach(async () => { await Promise.all(adapters.splice(0).map((adapter) => adapter.close())); });

function fakeSdk({ delay = false, identity = true } = {}) {
  let options!: Options;
  let nativeId!: string;
  let release!: () => void;
  let closed = 0;
  const sent: SDKUserMessage[] = [];
  const records: SDKMessage[] = [];
  let wake: (() => void) | undefined;
  let stopped = false;
  const emit = (record: unknown) => { records.push(record as SDKMessage); wake?.(); };
  const modelChanges: (string | undefined)[] = [];
  const query = {
    async *[Symbol.asyncIterator]() {
      while (!stopped) {
        const record = records.shift();
        if (record) yield record;
        else await new Promise<void>((resolve) => { wake = resolve; });
      }
    },
    close() { closed++; stopped = true; wake?.(); },
    async interrupt() { emit({ type: "result", subtype: "error_during_execution", is_error: true, session_id: nativeId }); },
    async setModel(model: string | undefined) { modelChanges.push(model); },
    async setPermissionMode() {},
    async initializationResult() { return {}; },
  } as unknown as Query;
  const sdk: ClaudeSdk = { async startup(input) {
    options = input?.options ?? {};
    nativeId = options.sessionId ?? options.resume!;
    if (delay) await new Promise<void>((resolve) => { release = resolve; });
    const warm = {
      query(input: AsyncIterable<SDKUserMessage>) {
        if (identity) emit({ type: "system", subtype: "init", session_id: nativeId });
        void (async () => { for await (const message of input) { sent.push(message); emit(message); } })();
        return query;
      },
      close() { query.close(); },
    } as unknown as WarmQuery;
    return warm;
  } };
  return { sdk, sent, emit, modelChanges, get options() { return options; }, get closed() { return closed; }, release() { release(); } };
}
const start = { kind: "start" as const, conversation_id: "conversation", generation: 1, controller_instance_id: "controller", cwd: "/tmp" };
function message(turn: string, operation: "send" | "queue" = "send"): ConversationOutboxItem {
  return { id: turn, conversation_id: start.conversation_id, generation: 1, turn_id: turn, operation, message: "bounded test message",
    attachments: [], attachment_db_path: "/tmp/unused", message_anchor: null, runtime_options: {}, idempotency_key: crypto.randomUUID(), state: "delivering", attempts: 1, provider_receipt_id: null };
}
async function until(condition: () => boolean) { for (let n = 0; n < 100 && !condition(); n++) await new Promise((resolve) => setTimeout(resolve, 1)); expect(condition()).toBe(true); }

it("creates without sending and closes late startup after cancellation", async () => {
  const native = fakeSdk();
  const adapter = new ClaudeSdkControllerAdapter({ sdk: native.sdk }); adapters.push(adapter);
  const ready = await adapter.acquire(start);
  expect(ready.ok, JSON.stringify(ready)).toBe(true);
  expect(native.sent).toEqual([]);
  if (ready.ok) expect(ready.value.provider_session_id).toBe(native.options.sessionId);
  const late = fakeSdk({ delay: true });
  const cancelled = new ClaudeSdkControllerAdapter({ sdk: late.sdk }); adapters.push(cancelled);
  const signal = new AbortController();
  const pending = cancelled.acquire({ ...start, signal: signal.signal });
  await until(() => Boolean(late.options));
  signal.abort(); late.release();
  expect((await pending).ok).toBe(false);
  expect(late.closed).toBeGreaterThan(0);
  expect(late.sent).toEqual([]);
});

it("preserves settings, exact continuation, queue semantics, and duplicate acceptance", async () => {
  const native = fakeSdk();
  const adapter = new ClaudeSdkControllerAdapter({ sdk: native.sdk }); adapters.push(adapter);
  const events: string[] = [];
  adapter.subscribe((event) => { events.push(event.kind); return { ok: true, value: undefined }; });
  expect((await adapter.acquire({ ...start, kind: "resume-message-anchor", provider_session_id: "native-session", message_anchor: "anchor", runtime_options: {
    model: "test-model", effort: "high", permission_mode: "default", max_turns: 2, max_cost_usd: 1, allowed_tools: ["Read"], setting_sources: ["user", "project", "local"],
  } })).ok).toBe(true);
  expect(native.options).toMatchObject({ resume: "native-session", resumeSessionAt: "anchor", effort: "high", maxTurns: 2, maxBudgetUsd: 1 });
  expect(adapter.capabilities).toMatchObject({ steer: false, queue: true, resume_message_anchor: true });
  const first = { ...message("first"), runtime_options: { model: "test-model", effort: "high", permission_mode: "default" as const, max_turns:2, max_cost_usd:1, allowed_tools:["Read"], setting_sources:["user", "project", "local"] as ("user"|"project"|"local")[] } };
  expect((await adapter.deliver(first)).ok).toBe(true);
  expect((await adapter.deliver(first)).ok).toBe(true);
  expect((await adapter.deliver(message("queued", "queue"))).ok).toBe(true);
  expect(native.sent).toHaveLength(2);
  expect(events.filter((value) => value === "turn-started")).toHaveLength(1);
  native.emit({ type: "result", session_id: "native-session", subtype: "success", is_error: false });
  await until(() => events.filter((value) => value === "turn-started").length === 2);
  native.emit({ type: "result", session_id: "native-session", subtype: "success", is_error: false });
  await until(() => events.filter((value) => value === "turn-completed").length === 2);
  expect((await adapter.deliver({ ...message("new"), runtime_options: { ...first.runtime_options, model: "next-model" } })).ok).toBe(true);
  expect(native.modelChanges).toContain("next-model");
});

it("decides actual SDK tool permissions and interrupts without releasing ownership", async () => {
  const native = fakeSdk();
  const adapter = new ClaudeSdkControllerAdapter({ sdk: native.sdk }); adapters.push(adapter);
  const ready = await adapter.acquire(start); expect(ready.ok, JSON.stringify(ready)).toBe(true);
  expect((await adapter.deliver(message("turn"))).ok).toBe(true);
  const permission = native.options.canUseTool!("Write", { path: "/tmp/test" }, { signal: new AbortController().signal, toolUseID: "tool" });
  await until(() => adapter.permissions("conversation").length === 1);
  const [request] = adapter.permissions("conversation");
  expect((await adapter.decidePermission({ conversation_id: "conversation", generation: 2, request_id: request.id, decision: "allow" })).ok).toBe(false);
  expect((await adapter.decidePermission({ conversation_id: "conversation", generation: 1, request_id: request.id, decision: "deny" })).ok).toBe(true);
  expect(await permission).toMatchObject({ behavior: "deny" });
  expect((await adapter.interrupt({ conversation_id: "conversation", generation: 1 })).ok).toBe(true);
  expect(native.closed).toBe(0);
});

it("accepts an initialized controller with native identity pending and never acknowledges before binding", async () => {
  const native = fakeSdk({ identity: false });
  const adapter = new ClaudeSdkControllerAdapter({ sdk: native.sdk }); adapters.push(adapter);
  const events: string[] = [];
  adapter.subscribe(event => { events.push(event.kind); return { ok:true, value:undefined }; });
  expect(await adapter.acquire(start)).toMatchObject({ ok:true, value:{ provider_session_id:null } });
  expect(native.sent).toEqual([]);
  let settled = false;
  const delivery = adapter.deliver(message("first"));
  void delivery.then(() => { settled = true; });
  await until(() => native.sent.length === 1);
  expect(settled).toBe(false);
  native.emit({ type:"system", subtype:"init", session_id:native.options.sessionId });
  expect((await delivery).ok).toBe(true);
  expect(events.filter(event => event === "provider-session-bound")).toHaveLength(1);
  native.emit({ type:"system", subtype:"init", session_id:native.options.sessionId });
  await new Promise(resolve => setTimeout(resolve,1));
  expect(events.filter(event => event === "provider-session-bound")).toHaveLength(1);
  native.emit({ type:"system", subtype:"init", session_id:"different-native" });
  await until(() => events.includes("ownership-unknown"));
});


it("hydrates streamed Claude tool arguments and publishes exact result identities", async () => {
  const native = fakeSdk();
  const adapter = new ClaudeSdkControllerAdapter({ sdk: native.sdk }); adapters.push(adapter);
  const events: import("../src/conversation-control/types.js").ProviderAdapterEvent[] = [];
  adapter.subscribeProviderEvents(event => events.push(event));
  expect((await adapter.acquire(start)).ok).toBe(true);
  expect((await adapter.deliver(message("tool-turn"))).ok).toBe(true);
  const session_id = native.options.sessionId;
  const stream = (event: unknown) => native.emit({ type: "stream_event", session_id, event });
  stream({ type: "message_start", message: { id: "assistant-message" } });
  stream({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool-1", name: "Bash", input: {} } });
  stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":' } });
  stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"pwd"}' } });
  native.emit({ type: "user", uuid: "result-message", session_id, message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "/tmp" }] } });
  await until(() => events.some(event => event.kind === "provisional-content" && event.item.type === "tool-call" && event.item.phase === "result"));
  const items = events.flatMap(event => event.kind === "provisional-content" ? [event.item] : []);
  expect(items.find(item => item.type === "tool-call" && JSON.stringify(item.input) === '{"command":"pwd"}')).toMatchObject({
    identity: { native_tool_id: "tool-1" }, input: { command: "pwd" },
  });
  expect(events.at(-1)).toMatchObject({ control_turn_id: "tool-turn" });
  expect(items.at(-1)).toMatchObject({ phase: "result", tool_id: "tool-1", output: "/tmp" });
});
