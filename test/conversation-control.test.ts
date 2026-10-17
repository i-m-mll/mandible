import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AdapterProbe,
  ConversationControllerAdapter,
  ControllerAcquisitionRequest,
  ControllerAdapterCapabilities,
} from "../src/conversation-control/adapter.js";
import { ConversationControlService } from "../src/conversation-control/service.js";
import { ChatAttachmentStore } from "../src/conversation-control/attachment-store.js";
import {
  chatItemIdentityKey,
  emptyProviderLiveProjection,
  mergeProviderLiveProjection,
} from "../src/conversation-control/provider-live.js";
import { ConversationControlStore } from "../src/conversation-control/store.js";
import {
  CONVERSATION_CONTROL_KNOWN_OWNERSHIP_MIGRATION_SQL,
  CONVERSATION_CONTROL_PENDING_IDENTITY_MIGRATION_SQL,
} from "../src/conversation-control/schema.js";
import { ConversationSourceStore } from "../src/conversations/source-store.js";
import { getConversationStructureCache } from "../src/conversations/structure-cache.js";
import { CURRENT_CONVERSATION_SOURCE_EPOCHS } from "../src/conversations/source-types.js";
import { CodexParser } from "../src/parsers/codex.js";
import type { ActivityItem, ChatItem, MessageItem } from "../src/parsers/types.js";
import type {
  ConversationControlError,
  ConversationLifecycleEvent,
  ConversationOutboxItem,
  Result,
} from "../src/conversation-control/types.js";
import { migrate, openDb, type Db } from "../src/db.js";
import { SessionRegistry } from "../src/registry.js";

const capabilities: ControllerAdapterCapabilities = {
  mode: "app-server-managed",
  resume_provider_session: true,
  resume_message_anchor: false,
  send: true,
  steer: true,
  queue: true,
  stop: true,
  remove: false,
  structured_deltas: true,
  lifecycle_callbacks: true,
  permission_callbacks: true,
  terminal_attach: false,
  logs: false,
  initial_message_acceptance: "provider-protocol",
};

class FakeAdapter implements ConversationControllerAdapter {
  readonly id = "fake-codex";
  readonly provider = "codex";
  readonly capabilities = capabilities;
  acquisitions = 0;
  deliveries = 0;
  stops = 0;
  lastAcquisition: ControllerAcquisitionRequest | null = null;
  invalidateOnAcquire = false;
  invalidLeaseOnAcquire = false;
  pid: number | undefined;
  delivered = new Set<string>();
  probeResult: AdapterProbe = {
    kind: "owned",
    controller_instance_id: "controller-1",
    provider_session_id: "provider-1",
    state: "ready",
  };
  private listeners = new Set<(event: ConversationLifecycleEvent & { conversation_id: string; generation: number }) => Result<void, ConversationControlError>>();
  private providerListeners = new Set<(event: import("../src/conversation-control/types.js").ProviderAdapterEvent) => void>();

  async acquire(input: ControllerAcquisitionRequest): Promise<Result<{ controller_instance_id: string; provider_session_id: string; pid?: number }, ConversationControlError>> {
    this.acquisitions += 1;
    this.lastAcquisition = input;
    if (this.invalidateOnAcquire) {
      this.emit({
        conversation_id: input.conversation_id,
        generation: input.generation,
        kind: "controller-failed",
        error: { kind: "adapter-failure", adapter_id: this.id, code: "lost", message: "lost", retryable: true },
        at: Date.now(),
      });
    }
    return {
      ok: true,
      value: {
        controller_instance_id: this.invalidLeaseOnAcquire ? "wrong-controller" : input.controller_instance_id,
        provider_session_id: input.kind === "start" ? "provider-1" : input.provider_session_id,
        pid: this.pid,
      },
    };
  }

  async deliver(item: ConversationOutboxItem): Promise<Result<import("../src/conversation-control/types.js").ProviderDeliveryReceipt, ConversationControlError>> {
    if (!this.delivered.has(item.id)) {
      this.deliveries += 1;
      this.delivered.add(item.id);
    }
    return { ok: true, value: {
      provider_receipt_id: `receipt:${item.id}`,
      acceptance: { kind: "codex-turn-response", provider_session_id: "provider-1", provider_turn_id: item.turn_id },
    } };
  }

  async probe(): Promise<Result<AdapterProbe, ConversationControlError>> {
    return { ok: true, value: this.probeResult };
  }

  async stop(): Promise<Result<void, ConversationControlError>> {
    this.stops += 1;
    return { ok: true, value: undefined };
  }

  subscribe(listener: (event: ConversationLifecycleEvent & { conversation_id: string; generation: number }) => Result<void, ConversationControlError>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeProviderEvents(listener: (event: import("../src/conversation-control/types.js").ProviderAdapterEvent) => void): () => void {
    this.providerListeners.add(listener);
    return () => this.providerListeners.delete(listener);
  }

  emitProvider(event: import("../src/conversation-control/types.js").ProviderAdapterEvent): void {
    for (const listener of this.providerListeners) listener(event);
  }

  emit(event: ConversationLifecycleEvent & { conversation_id: string; generation: number }): Result<void, ConversationControlError>[] {
    return [...this.listeners].map((listener) => listener(event));
  }

  async close(): Promise<void> {}
}

let root = "";
let db: Db;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-conversation-control-"));
  db = openDb(path.join(root, "mandible.db"));
  migrate(db);
  db.prepare(`INSERT INTO conversations (
    id, source, source_path, source_hash, source_mtime, title, started_at,
    block_count, session_id, created_at, updated_at
  ) VALUES ('conversation-1', 'codex', '/tmp/transcript.jsonl', 'hash', 1, 'Test',
    '2026-01-01T00:00:00Z', 0, 'provider-1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run();
});

afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function request(revision: number, idempotencyKey: string, generation = 0) {
  return {
    conversation_id: "conversation-1",
    operation: "resume-provider-session" as const,
    expected_revision: revision,
    expected_generation: generation,
    message: "hello",
    idempotency_key: idempotencyKey,
  };
}

function liveMessage(id: string, text: string, contentIndex?: number): MessageItem {
  return {
    type: "message",
    role: id.startsWith("intent") ? "user" : "assistant",
    identity: {
      provider: "codex",
      session_id: "provider-1",
      native_item_id: id,
      ...(contentIndex !== undefined ? { native_content_index: contentIndex } : {}),
      source_record_ordinal: 0,
      source_sub_block_ordinal: contentIndex ?? 0,
    },
    provenance: { source: "live-provider-event", provider: "codex", source_event_type: "message" },
    parts: [{ type: "text", text, ...(contentIndex !== undefined ? { native_index: contentIndex } : {}) }],
    content_completion: "streaming",
  };
}

function liveEvent(item: ChatItem, generation: number, sequence: number) {
  const identity = chatItemIdentityKey(item);
  if (!identity) throw new Error("test live item lacks identity");
  return {
    kind: "provisional-content" as const,
    conversation_id: "conversation-1",
    provider_session_id: "provider-1",
    generation,
    sequence,
    observed_at: sequence,
    identity,
    item,
  };
}

function liveActivity(id: string, text: string): ActivityItem {
  return {
    type: "activity",
    role: "assistant",
    activity_kind: "reasoning-summary",
    identity: {
      provider: "codex",
      session_id: "provider-1",
      native_item_id: id,
      source_record_ordinal: 0,
      source_sub_block_ordinal: 0,
    },
    provenance: { source: "live-provider-event", provider: "codex", source_event_type: "reasoning_summary" },
    parts: [{ type: "text", text }],
    content_completion: "streaming",
  };
}

describe("authoritative conversation control", () => {
  it("adopts a new native controller as the continued-Chat authority", async () => {
    const service = new ConversationControlService(db);
    const adapter = new FakeAdapter();
    service.registerAdapter(adapter);

    const started = await service.acquireNew({
      conversation_id: "conversation-1",
      provider: "codex",
      generation: 1,
      cwd: "/work/exact",
      runtime_options: { model: "gpt-5.6-sol", permission_mode: "agent-full-access" },
    }, () => undefined);

    expect(started).toMatchObject({
      ok: true,
      value: { adapter_id: "fake-codex", provider_session_id: "provider-1" },
    });
    expect(adapter.lastAcquisition).toMatchObject({
      kind: "start",
      conversation_id: "conversation-1",
      generation: 1,
      cwd: "/work/exact",
      runtime_options: { model: "gpt-5.6-sol", permission_mode: "agent-full-access" },
    });
    expect(service.getSnapshot("conversation-1")).toMatchObject({
      ok: true,
      value: {
        provider_session_id: "provider-1",
        ownership: { kind: "mandible", generation: 1, adapter_id: "fake-codex" },
        controller: { kind: "ready" },
        capability: { kind: "live-send", generation: 1 },
      },
    });
  });

  it("stops a new native controller when its durable commit fails", async () => {
    const service = new ConversationControlService(db);
    const adapter = new FakeAdapter();
    service.registerAdapter(adapter);

    const started = await service.acquireNew({
      conversation_id: "conversation-1",
      provider: "codex",
      generation: 1,
      cwd: "/work/exact",
      runtime_options: {},
    }, () => { throw new Error("commit failed"); });

    expect(started).toMatchObject({ ok: false, error: { kind: "adapter-contract-violation" } });
    expect(adapter.stops).toBe(1);
    expect(service.getSnapshot("conversation-1")).toMatchObject({
      ok: true,
      value: { ownership: { kind: "none", generation: 0 }, controller: { kind: "stopped" } },
    });
  });

  it("stops a new native controller whose lease violates the requested identity", async () => {
    const service = new ConversationControlService(db);
    const adapter = new FakeAdapter();
    adapter.invalidLeaseOnAcquire = true;
    service.registerAdapter(adapter);

    const started = await service.acquireNew({
      conversation_id: "conversation-1",
      provider: "codex",
      generation: 1,
      cwd: "/work/exact",
      runtime_options: {},
    }, () => undefined);

    expect(started).toMatchObject({ ok: false, error: { kind: "adapter-contract-violation" } });
    expect(adapter.stops).toBe(1);
  });

  it("does not derive control or capability from transcript activity", () => {
    const service = new ConversationControlService(db);
    const adapter = new FakeAdapter();
    service.registerAdapter(adapter);
    const before = service.getSnapshot("conversation-1");
    expect(before.ok && before.value.capability.kind).toBe("provider-session-resume");

    db.prepare("UPDATE conversations SET source_mtime = ?, ended_at = ? WHERE id = ?")
      .run(Date.now(), null, "conversation-1");

    expect(service.getSnapshot("conversation-1")).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversation_control_state").get()).toEqual({ count: 0 });
  });

  it("atomically accepts one of two simultaneous submissions", async () => {
    const service = new ConversationControlService(db);
    const adapter = new FakeAdapter();
    service.registerAdapter(adapter);
    const initial = service.getSnapshot("conversation-1");
    expect(initial.ok).toBe(true);
    const revision = initial.ok ? initial.value.revision : -1;

    const [first, second] = await Promise.all([
      service.submit(request(revision, "request-a")),
      service.submit(request(revision, "request-b")),
    ]);

    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    const refused = first.ok ? second : first;
    expect(refused.ok ? null : refused.error.kind).toBe("capability-drift");
    expect(adapter.acquisitions).toBe(1);
    expect(adapter.deliveries).toBe(1);
    const accepted = first.ok ? first : second;
    expect(accepted.ok && accepted.value.provider_receipt).toMatchObject({
      acceptance: { kind: "codex-turn-response", provider_session_id: "provider-1" },
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversation_control_outbox").get()).toEqual({ count: 1 });

    const acceptedRequest = first.ok ? request(revision, "request-a") : request(revision, "request-b");
    const retried = await service.submit(acceptedRequest);
    expect(retried.ok).toBe(true);
    expect(adapter.acquisitions).toBe(1);
    expect(adapter.deliveries).toBe(1);
  });

  it("releases a Codex startup failure before delivery and retries the same submission once", async () => {
    class FailsOnce extends FakeAdapter {
      override readonly id = "codex-app-server-v2";
      override async acquire(input: ControllerAcquisitionRequest) {
        if (this.acquisitions === 0) {
          this.acquisitions += 1;
          return { ok: false as const, error: {
            kind: "adapter-failure" as const, adapter_id: this.id, code: "startup-failed", message: "paginated_threads is not supported yet", retryable: true,
          } };
        }
        return super.acquire(input);
      }
    }
    const service = new ConversationControlService(db);
    const adapter = new FailsOnce();
    service.registerAdapter(adapter);
    const submission = request(0, "same-draft");

    expect(await service.submit(submission)).toMatchObject({ ok: false, error: { code: "startup-failed" } });
    const failed = service.getSnapshot("conversation-1");
    expect(failed.ok && failed.value).toMatchObject({
      ownership: { kind: "none", generation: 1 }, turn: { kind: "failed" }, capability: { kind: "provider-session-resume" },
    });
    expect(adapter.deliveries).toBe(0);

    expect(service.saveRuntimeSettings("conversation-1", 0, { model: "future-turn" }).ok).toBe(true);
    const retried = await service.submit(submission);
    expect(retried.ok).toBe(true);
    expect(adapter.lastAcquisition?.runtime_options).toEqual({});
    expect(adapter.acquisitions).toBe(2);
    expect(adapter.deliveries).toBe(1);
    expect(db.prepare("SELECT state, attempts, generation FROM conversation_control_outbox WHERE idempotency_key = 'same-draft'").get())
      .toEqual({ state: "delivered", attempts: 1, generation: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversation_control_outbox").get()).toEqual({ count: 1 });
  });

  it("recovers a previously persisted Codex acquisition failure without probing ambiguous ownership", async () => {
    class CodexAdapter extends FakeAdapter { override readonly id = "codex-app-server-v2"; }
    const service = new ConversationControlService(db);
    const adapter = new CodexAdapter();
    service.registerAdapter(adapter);
    const store = new ConversationControlStore(db);
    const submission = request(0, "persisted-draft");
    const prepared = store.prepareSubmission(submission, adapter.capabilities, adapter.id);
    if (!prepared.ok) throw new Error("test claim failed");
    const generation = prepared.value.snapshot.ownership.generation;
    const error = { kind: "adapter-failure" as const, adapter_id: adapter.id,
      code: "startup-failed", message: "paginated_threads is not supported yet", retryable: true };
    expect(store.publishLifecycle("conversation-1", generation, { kind: "controller-failed", at: Date.now(), error }).ok).toBe(true);

    expect(await service.reconcileAfterRestart()).toEqual([]);
    const recovered = service.getSnapshot("conversation-1");
    expect(recovered.ok && recovered.value).toMatchObject({
      ownership: { kind: "none", generation: 1 }, capability: { kind: "provider-session-resume" },
    });
    expect(adapter.acquisitions).toBe(0);
    expect(adapter.deliveries).toBe(0);
    expect((await service.submit(submission)).ok).toBe(true);
    expect(adapter.acquisitions).toBe(1);
    expect(adapter.deliveries).toBe(1);
  });

  it("keeps an uncertain acquisition identity blocked", async () => {
    const service = new ConversationControlService(db);
    const adapter = new FakeAdapter();
    adapter.invalidLeaseOnAcquire = true;
    service.registerAdapter(adapter);
    expect(await service.submit(request(0, "ambiguous-start"))).toMatchObject({ ok: false, error: { kind: "adapter-contract-violation" } });
    const snapshot = service.getSnapshot("conversation-1");
    expect(snapshot.ok && snapshot.value).toMatchObject({
      ownership: { kind: "mandible" }, controller: { kind: "failed" }, capability: { kind: "unavailable" },
    });
    expect(adapter.deliveries).toBe(0);
  });

  it("persists exact attachment intent and rejects idempotency reuse with changed attachments", async () => {
    const service = new ConversationControlService(db);
    service.registerAdapter(new FakeAdapter());
    const attachmentStore = new ChatAttachmentStore(db);
    const file = attachmentStore.put({ name: "context.txt", media_type: "text/plain", data_base64: Buffer.from("read only when useful").toString("base64") });
    const snapshot = service.getSnapshot("conversation-1");
    if (!snapshot.ok) throw new Error("missing test conversation");
    const submitted = { ...request(snapshot.value.revision, "same-intent"), message: "", attachments: [{ kind: "file" as const, file }] };
    const accepted = await service.submit(submitted);
    expect(accepted.ok).toBe(true);
    expect(JSON.parse((db.prepare("SELECT attachments_json FROM conversation_control_outbox WHERE idempotency_key = 'same-intent'").get() as { attachments_json: string }).attachments_json))
      .toEqual(submitted.attachments);
    expect((await service.submit(submitted)).ok).toBe(true);
    const changed = await service.submit({ ...submitted, attachments: [] });
    expect(changed).toMatchObject({ ok: false, error: { field: "idempotency_key" } });
  });

  it("keeps first-observed order while rejecting stale and repeated snapshots", () => {
    const first = liveEvent(liveMessage("native-1", "partial"), 1, 1);
    const second = liveEvent(liveMessage("native-2", "sibling"), 1, 2);
    const updated = liveEvent(liveMessage("native-1", "complete"), 1, 3);
    let projection = mergeProviderLiveProjection(emptyProviderLiveProjection("conversation-1"), first);
    projection = mergeProviderLiveProjection(projection, second);
    projection = mergeProviderLiveProjection(projection, updated);
    projection = mergeProviderLiveProjection(projection, liveEvent(liveMessage("native-1", "stale"), 1, 2));
    const repeated = mergeProviderLiveProjection(projection, liveEvent(liveMessage("native-1", "complete"), 1, 4));

    expect(repeated).toBe(projection);
    expect(projection.events.map((event) => event.kind === "provisional-content"
      ? [event.item.identity.native_item_id, event.item.parts[0]?.text]
      : [])).toEqual([["native-1", "complete"], ["native-2", "sibling"]]);
    expect(projection.revision).toBe(3);

    const replaced = mergeProviderLiveProjection(projection, liveEvent(liveMessage("native-3", "new owner"), 2, 1));
    expect(replaced).toMatchObject({
      revision: 4,
      generation: 2,
      events: [expect.objectContaining({ item: expect.objectContaining({
        identity: expect.objectContaining({ native_item_id: "native-3" }),
      }) })],
    });
    expect(mergeProviderLiveProjection(replaced, liveEvent(liveMessage("late", "old owner"), 1, 99))).toBe(replaced);
  });

  it("bounds transient projection custody by evicting the oldest observed item", () => {
    let projection = emptyProviderLiveProjection("conversation-1");
    projection = mergeProviderLiveProjection(projection, liveEvent(liveMessage("one", "1"), 1, 1), 2);
    projection = mergeProviderLiveProjection(projection, liveEvent(liveMessage("two", "2"), 1, 2), 2);
    projection = mergeProviderLiveProjection(projection, liveEvent(liveMessage("three", "3"), 1, 3), 2);
    expect(projection.events.map((event) => event.kind === "provisional-content"
      ? event.item.identity.native_item_id : null)).toEqual(["two", "three"]);
  });

  it("does not let durable text coverage erase a live reasoning sibling", () => {
    const message = liveMessage("shared-native-item", "answer");
    const reasoning = liveActivity("shared-native-item", "reasoning summary");
    const messageEvent = liveEvent(message, 1, 1);
    const reasoningIdentity = chatItemIdentityKey(reasoning);
    if (!reasoningIdentity) throw new Error("test reasoning item lacks identity");
    const reasoningEvent = liveEvent(reasoning, 1, 2);
    let projection = mergeProviderLiveProjection(emptyProviderLiveProjection("conversation-1"), messageEvent);
    projection = mergeProviderLiveProjection(projection, reasoningEvent);
    projection = mergeProviderLiveProjection(projection, {
      kind: "durable-reconciliation",
      conversation_id: "conversation-1",
      provider_session_id: "provider-1",
      generation: 1,
      sequence: 3,
      observed_at: 3,
      provider_event_id: "durable-message-only",
      covered_identities: [messageEvent.identity],
    });

    expect(projection.events).toEqual([expect.objectContaining({
      identity: reasoningIdentity,
      item: expect.objectContaining({ type: "activity", activity_kind: "reasoning-summary" }),
    })]);
  });

  it("retires a disconnected generation and rejects its late provider events", async () => {
    const emitted: import("../src/conversation-control/types.js").ProviderAdapterEvent[] = [];
    const service = new ConversationControlService(db, { onProviderEvent: (event) => emitted.push(event) });
    const adapter = new FakeAdapter();
    service.registerAdapter(adapter);
    const submitted = await service.submit(request(0, "intent-disconnect"));
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    const generation = submitted.value.snapshot.ownership.generation;
    const itemEvent = liveEvent(liveMessage("assistant-before-disconnect", "partial"), generation, 1);
    adapter.emitProvider(itemEvent);
    expect(service.getLiveProjection("conversation-1")).toMatchObject({
      ok: true,
      value: { generation, events: [expect.objectContaining({ identity: itemEvent.identity })] },
    });

    adapter.emit({
      conversation_id: "conversation-1",
      generation,
      kind: "turn-unknown",
      turn_id: submitted.value.turn_id,
      reason: "probe-ambiguous",
      at: 2,
    });
    adapter.emit({ conversation_id: "conversation-1", generation, kind: "controller-released", at: 3 });
    adapter.emitProvider(liveEvent(liveMessage("late", "stale"), generation, 3));

    expect(service.getLiveProjection("conversation-1")).toMatchObject({
      ok: true,
      value: { generation, events: [] },
    });
    expect(emitted.at(-1)).toMatchObject({
      kind: "transient-retirement",
      reason: "provider-disconnected",
      generation,
    });
  });

  it("materializes a child relationship only from the owned Codex generation and exact identities", async () => {
    db.prepare(`INSERT INTO conversations (
      id, source, source_path, source_hash, source_mtime, title, started_at,
      block_count, session_id, created_at, updated_at
    ) VALUES ('conversation-child', 'codex', '/tmp/child.jsonl', 'child-hash', 1, 'Child',
      '2026-01-01T00:00:01Z', 0, 'provider-child', '2026-01-01T00:00:01Z', '2026-01-01T00:00:01Z')`).run();
    const service = new ConversationControlService(db);
    const adapter = new FakeAdapter();
    service.registerAdapter(adapter);
    const submitted = await service.submit(request(0, "lineage-turn"));
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    adapter.emitProvider({
      kind: "provider-lineage",
      conversation_id: "conversation-1",
      provider_session_id: "provider-1",
      generation: submitted.value.snapshot.ownership.generation - 1,
      sequence: 1,
      observed_at: 1,
      provider_event_id: "stale-spawn",
      relation: "spawned-child",
      sender_provider_session_id: "provider-1",
      receiver_provider_session_id: "provider-child",
    });
    expect(db.prepare("SELECT parent_conversation_id FROM conversations WHERE id = 'conversation-child'").get())
      .toEqual({ parent_conversation_id: null });

    adapter.emitProvider({
      kind: "provider-lineage",
      conversation_id: "conversation-1",
      provider_session_id: "provider-1",
      generation: submitted.value.snapshot.ownership.generation,
      sequence: 1,
      observed_at: 1,
      provider_event_id: "spawn-1",
      relation: "spawned-child",
      sender_provider_session_id: "provider-1",
      receiver_provider_session_id: "provider-child",
    });

    expect(db.prepare("SELECT parent_conversation_id, is_sidechain FROM conversations WHERE id = 'conversation-child'").get())
      .toEqual({ parent_conversation_id: "conversation-1", is_sidechain: 1 });
  });

  it("rejects every lifecycle mutation from a stale fencing generation", async () => {
    const service = new ConversationControlService(db);
    const adapter = new FakeAdapter();
    service.registerAdapter(adapter);
    const first = await service.submit(request(0, "request-a"));
    expect(first.ok).toBe(true);
    const firstGeneration = first.ok ? first.value.snapshot.ownership.generation : -1;
    expect((await service.stop("conversation-1", firstGeneration)).ok).toBe(true);
    const released = service.getSnapshot("conversation-1");
    const second = await service.submit(request(
      released.ok ? released.value.revision : -1,
      "request-b",
      released.ok ? released.value.ownership.generation : -1,
    ));
    expect(second.ok).toBe(true);
    const secondGeneration = second.ok ? second.value.snapshot.ownership.generation : -1;
    expect(secondGeneration).toBeGreaterThan(firstGeneration);

    const [stale] = adapter.emit({
      conversation_id: "conversation-1",
      generation: firstGeneration,
      kind: "turn-completed",
      turn_id: "stale-turn",
      at: Date.now(),
    });
    expect(stale).toEqual({
      ok: false,
      error: { kind: "stale-generation", expected_generation: firstGeneration, actual_generation: secondGeneration },
    });
    expect(await service.stop("conversation-1", firstGeneration)).toEqual(stale);
    expect(new ConversationControlStore(db).release("conversation-1", firstGeneration)).toEqual(stale);
  });

  it("ends the latest controller process after a restart and frees its chat", async () => {
    const started = async () => {
      const child = spawn("/bin/sleep", ["30"]);
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      return child;
    };
    const [first, replacement] = [await started(), await started()];
    const exited = new Promise((resolve) => replacement.once("exit", resolve));
    const running = new ConversationControlService(db);
    const before = new FakeAdapter();
    before.pid = first.pid;
    running.registerAdapter(before);
    const submitted = await running.submit(request(0, "request-a"));
    if (!submitted.ok) throw new Error("submission failed");
    first.kill();
    expect(before.emit({ conversation_id: "conversation-1", generation: submitted.value.snapshot.ownership.generation,
      kind: "controller-process", pid: replacement.pid!, at: Date.now() })).toEqual([{ ok: true, value: undefined }]);

    const restarted = new ConversationControlService(db);
    const after = new FakeAdapter();
    after.probeResult = { kind: "unknown", reason: "probe-ambiguous" };
    restarted.registerAdapter(after);
    expect(await restarted.reconcileAfterRestart()).toEqual([]);

    await exited;
    const snapshot = restarted.getSnapshot("conversation-1");
    expect(snapshot.ok && snapshot.value.ownership.kind).toBe("none");
    expect(snapshot.ok && snapshot.value.capability.kind).toBe("provider-session-resume");
  });

  it("migrates legacy unresolved claims to free and settles their deliveries", () => {
    for (const statement of CONVERSATION_CONTROL_PENDING_IDENTITY_MIGRATION_SQL) db.exec(statement);
    for (const [id, owner] of [["conversation-1", "unknown"], ["conversation-2", "provider-controller"], ["conversation-3", "registered-process"]]) {
      if (id !== "conversation-1") {
        db.prepare(`INSERT INTO conversations (id, source, source_path, source_hash, source_mtime, title, started_at, block_count, session_id, created_at, updated_at)
          VALUES (?, 'codex', ?, 'hash', 1, 'Test', '2026-01-01T00:00:00Z', 0, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run(id, `/tmp/${id}.jsonl`, `provider-${id}`);
      }
      db.prepare(`INSERT INTO conversation_control_state (conversation_id, provider, provider_session_id, revision, generation, owner_kind,
          controller_state, owner_detail_json, last_authoritative_signal, turn_state, turn_id, state_detail_json, updated_at)
        VALUES (?, 'codex', ?, 3, 2, ?, 'unknown', ?, 1, 'unknown', 'turn-1', '{}', 1)`)
        .run(id, `provider-${id}`, owner === "unknown" ? "unknown" : "external", owner === "unknown" ? "{}" : JSON.stringify({ kind: owner, reference: "x" }));
    }
    for (const [id, state] of [["pending-1", "pending"], ["delivering-1", "delivering"]]) {
      db.prepare(`INSERT INTO conversation_control_outbox (id, conversation_id, generation, turn_id, operation, message, idempotency_key, state, created_at, updated_at)
        VALUES (?, 'conversation-1', 2, ?, 'send', 'hello', ?, ?, 1, 1)`).run(id, `turn-${id}`, id, state);
    }

    for (const statement of CONVERSATION_CONTROL_KNOWN_OWNERSHIP_MIGRATION_SQL) db.exec(statement);

    expect(db.prepare("SELECT conversation_id, owner_kind, controller_state FROM conversation_control_state ORDER BY conversation_id").all()).toEqual([
      { conversation_id: "conversation-1", owner_kind: "none", controller_state: "stopped" },
      { conversation_id: "conversation-2", owner_kind: "none", controller_state: "stopped" },
      { conversation_id: "conversation-3", owner_kind: "external", controller_state: "stopped" },
    ]);
    expect(db.prepare("SELECT id, state, json_extract(error_json, '$.code') AS code FROM conversation_control_outbox ORDER BY id").all()).toEqual([
      { id: "delivering-1", state: "uncertain", code: null },
      { id: "pending-1", state: "failed", code: "controller-lost" },
    ]);
  });

  it("follows the session registry for external ownership", () => {
    const service = new ConversationControlService(db);
    service.registerAdapter(new FakeAdapter());
    const registry = new SessionRegistry(db);
    registry.onLifecycle((session) => service.syncRegisteredOwnership(session));

    registry.registerSession({ id: "terminal-1", app: "claude", pid: process.pid, conversation_id: "provider-1" });
    const held = service.getSnapshot("conversation-1");
    expect(held.ok && held.value.capability).toMatchObject({ kind: "blocked-external", evidence_kind: "registered-process" });

    registry.endSession("terminal-1");
    const freed = service.getSnapshot("conversation-1");
    expect(freed.ok && freed.value.capability.kind).toBe("provider-session-resume");
  });

  it("rolls back an acquired process when claim publication loses authority", async () => {
    const service = new ConversationControlService(db);
    const adapter = new FakeAdapter();
    adapter.invalidateOnAcquire = true;
    service.registerAdapter(adapter);

    const submitted = await service.submit(request(0, "request-a"));

    expect(submitted.ok).toBe(false);
    expect(adapter.acquisitions).toBe(1);
    expect(adapter.stops).toBe(1);
    const snapshot = service.getSnapshot("conversation-1");
    expect(snapshot.ok && snapshot.value.controller.kind).toBe("failed");
  });

  it("keeps an ambiguous native turn blocked", async () => {
    const service = new ConversationControlService(db);
    const adapter = new FakeAdapter();
    service.registerAdapter(adapter);
    const submitted = await service.submit(request(0, "request-a"));
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    adapter.emit({
      conversation_id: "conversation-1",
      generation: submitted.value.snapshot.ownership.generation,
      kind: "turn-started",
      turn_id: submitted.value.turn_id,
      at: Date.now(),
    });
    adapter.emit({
      conversation_id: "conversation-1",
      generation: submitted.value.snapshot.ownership.generation,
      kind: "turn-unknown",
      turn_id: submitted.value.turn_id,
      reason: "probe-ambiguous",
      at: Date.now(),
    });

    const snapshot = service.getSnapshot("conversation-1");
    expect(snapshot.ok && snapshot.value.capability).toMatchObject({ kind: "unavailable", reason: "turn-transition" });
  });

  it("retires only live messages covered by the terminal durable transcript barrier", async () => {
    const diagnostics: Array<Record<string, unknown>> = [];
    const emitted: import("../src/conversation-control/types.js").ProviderAdapterEvent[] = [];
    const service = new ConversationControlService(db, {
      onTerminalTurn: async () => ({ status: "ingested:fresh" }),
      onProviderEvent: (event) => emitted.push(event),
      logger: (_level, _message, details) => diagnostics.push(details!),
    });
    const adapter = new FakeAdapter();
    service.registerAdapter(adapter);
    const submitted = await service.submit(request(0, "intent-1"));
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    const generation = submitted.value.snapshot.ownership.generation;
    const userEvent = {
      ...liveEvent(liveMessage("intent-1", "hello"), generation, 1),
      correlation: { intent_id: "intent-1", delivery_id: submitted.value.delivery_id, turn_id: submitted.value.turn_id, provider_message_id: "provider-user-1" },
    };
    const assistantEvent = liveEvent(liveMessage("assistant-incomplete", "partial"), generation, 2);
    const completeLiveOnly = liveEvent({
      ...liveMessage("provider-complete-without-durable-id", "provider-only completion"),
      content_completion: "complete" as const,
    }, generation, 3);
    adapter.emitProvider(userEvent);
    adapter.emitProvider(assistantEvent);
    adapter.emitProvider(completeLiveOnly);
    const durableUserItem = {
      ...userEvent.item,
      provenance: { source: "verified-provider-transcript", provider: "codex", source_event_type: "message" },
      content_completion: "complete",
    };
    db.prepare(`INSERT INTO conversation_blocks (
      id, conversation_id, type, role, content, position, metadata_json, dag_uuid
    ) VALUES ('block-1', 'conversation-1', 'user_message', 'user', 'durable text wins', 0,
      ?, 'intent-1')`).run(JSON.stringify({ chat_item: durableUserItem }));

    adapter.emit({ conversation_id: "conversation-1", generation, kind: "turn-started", turn_id: submitted.value.turn_id, at: 3 });
    adapter.emit({ conversation_id: "conversation-1", generation, kind: "turn-completed", turn_id: submitted.value.turn_id, at: 4 });
    for (let attempt = 0; attempt < 20 && emitted.at(-1)?.kind !== "durable-reconciliation"; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }

    expect(service.getLiveProjection("conversation-1")).toMatchObject({
      ok: true,
      value: { events: [expect.objectContaining({ identity: assistantEvent.identity })] },
    });
    expect(emitted.at(-1)).toMatchObject({
      kind: "durable-reconciliation",
      covered_identities: [userEvent.identity],
      terminal_retired_identities: [completeLiveOnly.identity],
    });
    expect(diagnostics).toEqual([expect.objectContaining({
      ingest_status: "ingested:fresh", retired_live_count: 2, retained_live_count: 1,
    })]);
    expect(JSON.stringify(diagnostics)).not.toContain("hello");
  });

  it("retires a source-backed Codex prompt through its exact client identity", async () => {
    const emitted: import("../src/conversation-control/types.js").ProviderAdapterEvent[] = [];
    const diagnostics: Array<Record<string, unknown>> = [];
    const service = new ConversationControlService(db, {
      onTerminalTurn: async () => ({ status: "ingested:fresh" }),
      onProviderEvent: (event) => emitted.push(event),
      logger: (_level, _message, details) => diagnostics.push(details!),
    });
    const adapter = new FakeAdapter();
    service.registerAdapter(adapter);
    const submitted = await service.submit(request(0, "intent-native-turn"));
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    const generation = submitted.value.snapshot.ownership.generation;
    const sourceBackedEvent = {
      ...liveEvent(liveMessage("intent-native-turn", "hello"), generation, 1),
      correlation: {
        intent_id: "intent-native-turn",
        delivery_id: submitted.value.delivery_id,
        turn_id: submitted.value.turn_id,
        provider_message_id: "provider-user-without-jsonl-id",
      },
    };
    adapter.emitProvider(sourceBackedEvent);
    db.prepare(`UPDATE conversation_control_outbox
      SET provider_receipt_id = 'codex:turn:native-turn-1'
      WHERE id = ?`).run(submitted.value.delivery_id);

    const sourcePath = path.join(root, ".codex", "sessions", "2026", "09", "11", "rollout-source-backed.jsonl");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, [
      { type: "session_meta", timestamp: "2026-09-11T00:00:00Z", payload: { id: "provider-1", cwd: "/tmp/project" } },
      { type: "response_item", timestamp: "2026-09-11T00:00:01Z", payload: {
        type: "message", role: "user", content: [{ type: "input_text", text: "durable text wins" }],
        internal_chat_message_metadata_passthrough: { turn_id: "native-turn-1" },
      } },
      { type: "event_msg", timestamp: "2026-09-11T00:00:01Z", payload: {
        type: "user_message", client_id: "intent-native-turn",
      } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    const parsed = await new CodexParser().parse(sourcePath);
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(parsed.blocks[0].metadata).toMatchObject({
      client_intent_id: "intent-native-turn",
      chat_item: { type: "message", role: "user" },
    });
    db.prepare(`UPDATE conversations
      SET source_path = ?, source_hash = ?, source_mtime = ?, block_count = ?
      WHERE id = 'conversation-1'`).run(
      sourcePath, parsed.conversation.source_hash, parsed.conversation.source_mtime, parsed.blocks.length,
    );
    await new ConversationSourceStore(db).recordConversation({
      conversationId: "conversation-1",
      provider: "codex",
      nativeSessionId: "provider-1",
      filePath: sourcePath,
      expectedContentHash: parsed.conversation.source_hash,
      blocks: parsed.blocks.map((block) => ({ ...block, legacyId: `legacy-${block.position}` })),
      ...CURRENT_CONVERSATION_SOURCE_EPOCHS,
    });
    expect(getConversationStructureCache(db).captureDenseRows(db, "conversation-1", "replace").captured)
      .toBe(parsed.blocks.length);
    db.exec("DELETE FROM conversation_structural_blocks; DELETE FROM conversation_blocks;");

    adapter.emit({ conversation_id: "conversation-1", generation, kind: "turn-started", turn_id: submitted.value.turn_id, at: 3 });
    adapter.emit({ conversation_id: "conversation-1", generation, kind: "turn-completed", turn_id: submitted.value.turn_id, at: 4 });
    for (let attempt = 0; attempt < 20 && emitted.at(-1)?.kind !== "durable-reconciliation"; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }

    expect(diagnostics).toEqual([expect.objectContaining({ durable_identity_count: 1, retired_live_count: 1 })]);
    expect(service.getLiveProjection("conversation-1")).toMatchObject({
      ok: true,
      value: { events: [] },
    });
    expect(emitted.at(-1)).toMatchObject({
      kind: "durable-reconciliation",
      covered_identities: [sourceBackedEvent.identity],
    });
  });
});

it("resumes without a message and persists settings independently of delivery retries", async () => {
  const service = new ConversationControlService(db);
  const adapter = new FakeAdapter();
  service.registerAdapter(adapter);
  expect(service.saveRuntimeSettings('conversation-1', 0, { model: 'retained-model', effort: 'high', permission_mode: 'read-only' }).ok).toBe(true);
  expect(service.saveRuntimeSettings('conversation-1', 0, { model: 'stale' })).toMatchObject({ ok: false, error: { kind: 'capability-drift', actual_revision: 1 } });
  const before = service.getSnapshot('conversation-1');
  if (!before.ok) throw new Error('missing snapshot');
  const resumed = await service.resume({ conversation_id: 'conversation-1', expected_revision: before.value.revision, expected_generation: 0, cwd: '/exact/checkout' });
  expect(resumed.ok).toBe(true);
  expect(adapter.deliveries).toBe(0);
  expect(adapter.lastAcquisition).toMatchObject({ kind: 'resume-provider-session', provider_session_id: 'provider-1', cwd: '/exact/checkout', runtime_options: { model: 'retained-model' } });
  if (!resumed.ok) throw new Error('resume failed');
  const submission = { ...request(resumed.value.revision, 'settings-delivery', 1), operation: 'send' as const, message: 'one bounded prompt' };
  expect((await service.submit(submission)).ok).toBe(true);
  expect(service.saveRuntimeSettings('conversation-1', 1, { model: 'next-model' }).ok).toBe(true);
  expect((await service.submit(submission)).ok).toBe(true);
  expect(adapter.deliveries).toBe(1);
  const frozen = db.prepare('SELECT options_json FROM conversation_delivery_settings').get() as { options_json: string };
  expect(JSON.parse(frozen.options_json).model).toBe('retained-model');
  const reopened = new ConversationControlService(db);
  expect(reopened.getRuntimeSettings('conversation-1')).toMatchObject({ ok: true, value: { revision: 2, runtime_options: { model: 'next-model' } } });
  await service.close();
});

it("keeps initialized Claude identity pending and binds it once", () => {
  db.prepare("UPDATE conversations SET source = 'claude_code', session_id = '' WHERE id = 'conversation-1'").run();
  const store = new ConversationControlStore(db);
  const claude = { ...capabilities, steer:false };
  expect(store.adoptNewController('conversation-1',1,'claude-agent-sdk-v1','controller',null).ok).toBe(true);
  expect(store.snapshot('conversation-1',claude,'claude-agent-sdk-v1')).toMatchObject({ok:true,value:{provider_session_id:null,controller:{kind:'ready'},capability:{kind:'live-send'}}});
  // Persist the local creation receipt without claiming a native session.
  db.prepare(`INSERT INTO conversation_spawn_requests (id,schema_version,idempotency_key,request_digest,request_json,provider,topology_kind,state,attempt_count,native_session_id,created_at,updated_at)
    VALUES ('conversation-1','mandible-conversation-spawn-request@3','draft',?,'{}','claude_code','top-level','ready',1,'controller',1,1)`).run('0'.repeat(64));
  expect(store.release('conversation-1',1)).toEqual({ok:true,value:undefined});
  const draft = store.snapshot('conversation-1',claude,'claude-agent-sdk-v1');
  expect(draft).toMatchObject({ok:true,value:{ownership:{kind:'none',generation:1},capability:{kind:'live-send'}}});
  expect(store.adoptNewController('conversation-1',2,'claude-agent-sdk-v1','replacement',null).ok).toBe(true);
  expect(store.bindProviderSession('conversation-1',2,'native').ok).toBe(true);
  const before = store.snapshot('conversation-1',claude,'claude-agent-sdk-v1');
  expect(store.bindProviderSession('conversation-1',2,'native').ok).toBe(true);
  expect(store.snapshot('conversation-1',claude,'claude-agent-sdk-v1')).toEqual(before);
  expect(store.bindProviderSession('conversation-1',2,'different').ok).toBe(false);
  expect(db.prepare("SELECT session_id FROM conversations WHERE id = 'conversation-1'").get()).toEqual({session_id:'native'});
});
