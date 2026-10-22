import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db } from "../src/db.js";
import { ConversationSpawnService } from "../src/conversation-spawn/service.js";
import { CONVERSATION_SPAWN_REQUEST_SCHEMA, type ConversationSpawnRequest } from "../src/conversation-spawn/types.js";
import { readConversationSpawnPlacementBatch } from "../src/routes/console.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

let root = "";
let db: Db;
let clock = 100;
const ID = "10000000-0000-4000-8000-000000000001";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-conversation-spawn-"));
  db = migratedMemoryDb();
  db.prepare(`INSERT INTO ledger_projects
    (id, display_name, remote_identity, upstream_identity, namespace_policy, created_at, updated_at, project_key)
    VALUES ('project-a', 'Project A', '', '', 'local', 1, 1, 'project-a')`).run();
  db.prepare(`INSERT INTO ledger_project_checkouts
    (id, project_id, work_repo_id, root, name, default_branch, remote_url, created_at, updated_at)
    VALUES ('checkout-a', 'project-a', 'project-a', '/work/project-a', 'Project A', 'main', '', 1, 1)`).run();
});

afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function request(overrides: Partial<ConversationSpawnRequest> = {}): ConversationSpawnRequest {
  return {
    schema: CONVERSATION_SPAWN_REQUEST_SCHEMA,
    idempotency_key: ID,
    provider: "codex",
    placement: { kind: "project", project_id: "project-a", checkout_id: "checkout-a" },
    ...overrides,
  };
}

describe("provider-first conversation spawn authority", () => {
  it("uses one UUID for idempotency, reservation, placement projection, and replay", () => {
    const service = new ConversationSpawnService(db, () => clock++);
    const first = service.reserve(request());
    const replay = service.reserve(request());
    expect(first).toMatchObject({ ok: true, value: { reservation_id: ID, state: "reserved" } });
    expect(replay).toEqual(first);
    expect(readConversationSpawnPlacementBatch(db, [ID]).get(ID)).toEqual({
      canonical_project_id: "project-a",
      canonical_checkout_id: "checkout-a",
    });
  });

  it("represents projectless placement explicitly without consulting the project registry", () => {
    const service = new ConversationSpawnService(db, () => clock++);
    const result = service.reserve(request({ placement: { kind: "projectless" } }));
    expect(result).toMatchObject({
      ok: true,
      value: { request: { placement: { kind: "projectless" } } },
    });
    expect(readConversationSpawnPlacementBatch(db, [ID]).get(ID)).toEqual({
      canonical_project_id: null,
      canonical_checkout_id: null,
    });
  });

  it("rejects version 1, unsupported providers, and client launch controls before persistence", () => {
    const service = new ConversationSpawnService(db);
    expect(service.reserve({ ...request(), schema: "mandible-conversation-spawn-request@1" } as never))
      .toMatchObject({ ok: false, error: { kind: "invalid-request", field: "schema" } });
    expect(service.reserve({ ...request(), provider: "gemini" } as never))
      .toMatchObject({ ok: false, error: { kind: "invalid-request", field: "provider" } });
    expect(service.reserve({ ...request(), command: { name: "codex" } } as never))
      .toMatchObject({ ok: false, error: { kind: "invalid-request", field: "command" } });
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversation_spawn_requests").get()).toEqual({ count: 0 });
  });

  it("keeps provider immutable across retry and terminalizes interrupted startup", () => {
    const service = new ConversationSpawnService(db, () => clock++);
    expect(service.reserve(request()).ok).toBe(true);
    expect(service.reserve(request({ provider: "claude_code" }))).toEqual({
      ok: false,
      error: { kind: "idempotency-conflict", idempotency_key: ID },
    });
    expect(service.begin(ID)).toMatchObject({ ok: true, value: { state: "starting", attempt_count: 1 } });
    const restarted = new ConversationSpawnService(db, () => clock++);
    expect(restarted.get(ID)).toMatchObject({
      ok: true,
      value: { state: "failed", error: { code: "provider_startup_interrupted", retryable: true } },
    });
    expect(restarted.begin(ID, 1)).toMatchObject({ ok: true, value: { state: "starting", attempt_count: 2 } });
    expect(restarted.failed(ID, 1, { code: "late", message: "late", retryable: false }))
      .toMatchObject({ ok: false, error: { kind: "stale-generation", actual_generation: 2 } });
    expect(restarted.assignRuntime(ID, 2, "runtime-2")).toMatchObject({ ok: true });
    expect(restarted.stopping(ID, 2)).toMatchObject({ ok: true, value: { state: "stopping" } });
    expect(restarted.cancelled(ID, 2)).toMatchObject({ ok: true, value: { state: "cancelled" } });
    expect(restarted.ready(ID, 2, "runtime-2", "provider-2", {}))
      .toMatchObject({ ok: false, error: { kind: "spawn-in-progress" } });
    expect(restarted.get(ID)).toMatchObject({ ok: true, value: { state: "cancelled" } });
  });

  it("reads historical version-1 receipts without accepting their creation path", () => {
    const historical = {
      schema: "mandible-conversation-spawn-request@1",
      idempotency_key: "historical",
      provider: "gemini",
      label: "Old",
      initial_message: "Old prompt",
      placement: { project_id: null, checkout_id: null },
      topology: { kind: "top-level" },
      command: { name: "gemini", backend_type: "acp", transport_lane: "acp", channel_enabled: false, run_options: {} },
    };
    db.prepare(`INSERT INTO conversation_spawn_requests
      (id, schema_version, idempotency_key, request_digest, request_json, provider, project_id, checkout_id,
       topology_kind, state, initial_message_state, created_at, updated_at)
      VALUES ('historical', ?, 'historical', ?, ?, 'gemini', NULL, NULL, 'top-level', 'delivered', 'delivered', 1, 1)`)
      .run(historical.schema, "0".repeat(64), JSON.stringify(historical));
    expect(new ConversationSpawnService(db).get("historical")).toMatchObject({
      ok: true,
      value: { schema: "mandible-conversation-spawn-receipt@1", state: "delivered", request: historical },
    });
  });
});

it('materializes initialized Claude without inventing a native session and preserves the local identity',()=>{
 const service=new ConversationSpawnService(db,()=>clock++);
 expect(service.reserve(request({provider:'claude_code'})).ok).toBe(true);
 expect(service.begin(ID).ok).toBe(true);
 expect(service.assignRuntime(ID,1,'controller').ok).toBe(true);
 expect(service.materializeConversationShell(ID,1,'/work/project-a',null).ok).toBe(true);
 expect(service.ready(ID,1,'controller',null,{kind:'controller-ready-awaiting-native-identity'})).toMatchObject({ok:true,value:{state:'ready',native_session_id:null,controller_instance_id:'controller'}});
 expect(db.prepare('SELECT id,session_id FROM conversations WHERE id=?').get(ID)).toEqual({id:ID,session_id:''});
});
