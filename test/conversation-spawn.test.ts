import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db.js";
import { ConversationSpawnService } from "../src/conversation-spawn/service.js";
import { CONVERSATION_SPAWN_REQUEST_SCHEMA, type ConversationSpawnRequest } from "../src/conversation-spawn/types.js";
import { readConversationSpawnPlacementBatch } from "../src/routes/console.js";

let root = "";
let db: Db;
let clock = 100;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-conversation-spawn-"));
  db = openDb(path.join(root, "mandible.db"));
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
    idempotency_key: "request-1",
    provider: "codex",
    label: "Investigate",
    initial_message: "Find the exact cause.",
    placement: { project_id: "project-a", checkout_id: "checkout-a" },
    topology: { kind: "top-level" },
    command: { name: "codex", backend_type: "acp", transport_lane: "acp", channel_enabled: false, run_options: {} },
    ...overrides,
  };
}

describe("Mandible conversation spawn authority", () => {
  it("reserves one canonical request and replays the same receipt idempotently", () => {
    const service = new ConversationSpawnService(db, () => clock++);
    const first = service.reserve(request());
    const replay = service.reserve(request());
    expect(first.ok && replay.ok && replay.value.reservation_id).toBe(first.ok ? first.value.reservation_id : "");
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversation_spawn_requests").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversations").get()).toEqual({ count: 0 });
  });

  it("projects canonical placement only from exact spawn reservation identities", () => {
    const service = new ConversationSpawnService(db);
    const scoped = service.reserve(request());
    const unscoped = service.reserve(request({
      idempotency_key: "request-unscoped",
      placement: { project_id: null, checkout_id: null },
    }));
    if (!scoped.ok || !unscoped.ok) throw new Error("reservation failed");

    const placements = readConversationSpawnPlacementBatch(db, [
      scoped.value.reservation_id,
      unscoped.value.reservation_id,
      "cwd-lookalike-without-reservation",
    ]);

    expect(placements.get(scoped.value.reservation_id)).toEqual({
      canonical_project_id: "project-a",
      canonical_checkout_id: "checkout-a",
    });
    expect(placements.get(unscoped.value.reservation_id)).toEqual({
      canonical_project_id: null,
      canonical_checkout_id: null,
    });
    expect(placements.has("cwd-lookalike-without-reservation")).toBe(false);
  });

  it("fails closed when an idempotency key is reused for different intent", () => {
    const service = new ConversationSpawnService(db);
    expect(service.reserve(request()).ok).toBe(true);
    expect(service.reserve(request({ initial_message: "Do something else." }))).toEqual({
      ok: false, error: { kind: "idempotency-conflict", idempotency_key: "request-1" },
    });
  });

  it("retries delivery against the recorded native session without authorizing another creation", () => {
    const service = new ConversationSpawnService(db, () => clock++);
    const reserved = service.reserve(request());
    if (!reserved.ok) throw new Error("reservation failed");
    expect(service.begin(reserved.value.reservation_id).ok).toBe(true);
    expect(service.recordProviderReceipt(reserved.value.reservation_id, "native-1", "provider-1", { request_id: "provider-request-1" }).ok).toBe(true);
    const failed = service.failed(reserved.value.reservation_id, { code: "transport", message: "connection closed", retryable: true });
    expect(failed.ok && failed.value.native_session_id).toBe("native-1");
    const retry = service.begin(reserved.value.reservation_id);
    expect(retry.ok && retry.value).toMatchObject({ state: "delivering", attempt_count: 2, native_session_id: "native-1" });
    expect(service.recordProviderReceipt(reserved.value.reservation_id, "native-2", null, {})).toMatchObject({
      ok: false, error: { kind: "idempotency-conflict" },
    });
  });

  it("accepts lineage only from an exact existing conversation or reservation identity", () => {
    const service = new ConversationSpawnService(db);
    expect(service.reserve(request({ topology: { kind: "child", parent_conversation_id: "guessed-parent" } }))).toEqual({
      ok: false, error: { kind: "topology-target-not-found", conversation_id: "guessed-parent" },
    });
    const parent = service.reserve(request());
    if (!parent.ok) throw new Error("parent reservation failed");
    const child = service.reserve(request({ idempotency_key: "request-2", topology: { kind: "child", parent_conversation_id: parent.value.reservation_id } }));
    expect(child.ok && child.value.request.topology).toEqual({ kind: "child", parent_conversation_id: parent.value.reservation_id });
  });

  it("rejects a checkout that does not belong to the named canonical project", () => {
    db.prepare(`INSERT INTO ledger_projects
      (id, display_name, remote_identity, upstream_identity, namespace_policy, created_at, updated_at, project_key)
      VALUES ('project-b', 'Project B', '', '', 'local', 1, 1, 'project-b')`).run();
    const service = new ConversationSpawnService(db);
    expect(service.reserve(request({ placement: { project_id: "project-b", checkout_id: "checkout-a" } }))).toEqual({
      ok: false, error: { kind: "checkout-project-mismatch", project_id: "project-b", checkout_id: "checkout-a" },
    });
  });
});
