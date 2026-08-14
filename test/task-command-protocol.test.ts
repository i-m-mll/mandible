import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setSetting } from "../src/client-auth/settings-kv.js";
import { TASK_COMMAND_EVENT_SCHEMA, TASK_COMMAND_SCHEMA } from "../src/contracts.js";
import { migrate, setDb, type Db } from "../src/db.js";
import { FileRpcTransport } from "../src/file-rpc-transport.js";
import { resolveInstanceInfo } from "../src/instance-policy.js";
import { registerTaskRoutes } from "../src/routes/tasks.js";
import { Router, type ClientAuthGate, type ResolvedClientIdentity } from "../src/server.js";
import { taskCommandEventDigest } from "../src/task-commands.js";
import { TASK_INVENTORY_EXECUTORS_KEY } from "../src/task-inventory.js";
import { createUser, OPERATOR_SETTING_KEY } from "../src/users/store.js";

let db: Db;
let router: Router;
let operatorId: string;
let executorId: string;

class SlugGate implements ClientAuthGate {
  authenticate(
    credential: string | null | undefined,
    source: ResolvedClientIdentity["source"] = "in_process",
  ): ResolvedClientIdentity | null {
    if (!credential) return null;
    const ephemeral = credential.startsWith("session:");
    const slug = ephemeral ? credential.slice("session:".length) : credential;
    const user = db.prepare(
      "SELECT id, slug FROM users WHERE slug = ? AND status = 'active'",
    ).get(slug) as { id: string; slug: string } | undefined;
    return user ? {
      user_id: user.id,
      slug: user.slug,
      method: ephemeral ? "ephemeral" : "api_token",
      credential_id: null,
      source,
    } : null;
  }
  mode(): "compat" { return "compat"; }
  recordUnattributedWrite(): void {}
}

function createBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: TASK_COMMAND_SCHEMA,
    request_key: "disable-1",
    executor: "agent-schedule",
    task_id: "daily-digest",
    verb: "disable",
    payload: {},
    ...overrides,
  };
}

async function create(credential = "operator", body = createBody()) {
  return router.invoke({ method: "POST", url: "/api/tasks/commands", credential, body });
}

async function executorEvent(
  commandId: string,
  event: { event: "accepted" } | { event: "applied"; no_op: boolean }
    | { event: "rejected"; reason: "unknown_task" },
  credential = "agent-schedule",
) {
  return router.invoke({
    method: "POST",
    url: `/api/tasks/commands/${commandId}/events`,
    credential,
    body: {
      schema: TASK_COMMAND_EVENT_SCHEMA,
      ...event,
      event_digest: taskCommandEventDigest(commandId, event),
    },
  });
}

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  setDb(db);
  operatorId = createUser(db, { slug: "operator", kind: "human", display_name: "Operator" }).id;
  setSetting(db, OPERATOR_SETTING_KEY, operatorId);
  executorId = createUser(db, {
    slug: "agent-schedule", kind: "agent", display_name: "Agent Schedule",
  }).id;
  createUser(db, { slug: "other-agent", kind: "agent", display_name: "Other" });
  router = new Router({
    clientAuth: new SlugGate(),
    instance: resolveInstanceInfo({
      env: { MANDIBLE_OPERATIONAL_MUTATIONS: "allow" } as NodeJS.ProcessEnv,
    }),
  });
  registerTaskRoutes(router, db);
});

afterEach(() => db.close());

describe("operator command creation and cancellation", () => {
  it("replays the same request key/body and conflicts on a changed body", async () => {
    const first = await create();
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ stored: true, command: { state: "requested" } });
    const replay = await create();
    expect(replay.body).toMatchObject({ stored: false, command: { state: "requested" } });
    expect((replay.body as { command: { id: string } }).command.id)
      .toBe((first.body as { command: { id: string } }).command.id);

    const conflict = await create("operator", createBody({ task_id: "other" }));
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ code: "request_key_conflict" });
    expect((db.prepare("SELECT count(*) AS n FROM task_command_requests").get() as { n: number }).n)
      .toBe(1);
  });

  it("requires the configured operator and persists that exact principal", async () => {
    expect((await create("agent-schedule")).body).toMatchObject({ code: "operator_required" });
    expect((await create("session:operator")).status).toBe(200);
    expect(db.prepare("SELECT requested_by_user_id FROM task_command_requests").get())
      .toEqual({ requested_by_user_id: operatorId });
    expect((await router.invoke({
      method: "GET", url: "/api/tasks/commands", credential: "agent-schedule",
    })).body).toMatchObject({ code: "operator_required" });
  });

  it("allows pre-acceptance cancellation, replays it, and refuses cancel-after-accept", async () => {
    const created = await create();
    const id = (created.body as { command: { id: string } }).command.id;
    const cancel = await router.invoke({
      method: "POST", url: `/api/tasks/commands/${id}/cancel`, credential: "operator", body: {},
    });
    expect(cancel.body).toMatchObject({ stored: true, command: { state: "cancelled" } });
    const replay = await router.invoke({
      method: "POST", url: `/api/tasks/commands/${id}/cancel`, credential: "operator", body: {},
    });
    expect(replay.body).toMatchObject({ stored: false, command: { state: "cancelled" } });

    const second = await create("operator", createBody({ request_key: "disable-2" }));
    const secondId = (second.body as { command: { id: string } }).command.id;
    expect((await executorEvent(secondId, { event: "accepted" })).status).toBe(200);
    expect((await router.invoke({
      method: "POST",
      url: `/api/tasks/commands/${secondId}/cancel`,
      credential: "agent-schedule",
      body: {},
    })).body).toMatchObject({ code: "operator_required" });
    const refused = await router.invoke({
      method: "POST", url: `/api/tasks/commands/${secondId}/cancel`, credential: "operator", body: {},
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "cancel_after_accept_refused" });
  });

  it("has no expiry semantics: old unseen requests remain pending", async () => {
    await create();
    db.prepare("UPDATE task_command_requests SET requested_at = 1").run();
    const pending = await router.invoke({
      method: "GET",
      url: "/api/tasks/commands/pending?executor=agent-schedule",
      credential: "agent-schedule",
    });
    expect(pending.body).toMatchObject({ commands: [{ state: "requested", requested_at: 1 }] });
    const columns = (db.prepare("PRAGMA table_info(task_command_requests)").all() as
      Array<{ name: string }>).map((column) => column.name);
    expect(columns).not.toContain("expires_at");
  });
});

describe("executor authority, receipts, and conflicts", () => {
  it("requires a durable active mapped agent and keeps operator authority separate", async () => {
    const created = await create();
    const id = (created.body as { command: { id: string } }).command.id;
    const pendingUrl = "/api/tasks/commands/pending?executor=agent-schedule";
    expect((await router.invoke({ method: "GET", url: pendingUrl })).body)
      .toMatchObject({ code: "authentication_required" });
    expect((await router.invoke({ method: "GET", url: pendingUrl, credential: "session:agent-schedule" })).body)
      .toMatchObject({ code: "executor_credential_required" });
    expect((await router.invoke({ method: "GET", url: pendingUrl, credential: "other-agent" })).body)
      .toMatchObject({ code: "executor_identity_forbidden" });
    expect((await router.invoke({ method: "GET", url: pendingUrl, credential: "operator" })).body)
      .toMatchObject({ code: "executor_agent_required" });
    expect((await executorEvent(id, { event: "accepted" }, "operator")).body)
      .toMatchObject({ code: "executor_agent_required" });
  });

  it("replays accepted/applied receipts, persists executor principal, and records no-op", async () => {
    const created = await create();
    const id = (created.body as { command: { id: string } }).command.id;
    const accepted = await executorEvent(id, { event: "accepted" });
    expect(accepted.body).toMatchObject({ stored: true, command: { state: "accepted" } });
    expect((await executorEvent(id, { event: "accepted" })).body)
      .toMatchObject({ stored: false, command: { state: "accepted" } });
    const applied = await executorEvent(id, { event: "applied", no_op: true });
    expect(applied.body).toMatchObject({
      stored: true, command: { state: "applied", no_op: true },
    });
    expect((await executorEvent(id, { event: "applied", no_op: true })).body)
      .toMatchObject({ stored: false, command: { state: "applied", no_op: true } });
    expect(db.prepare(
      "SELECT DISTINCT actor_user_id FROM task_command_events WHERE event_type != 'cancelled'",
    ).all()).toEqual([{ actor_user_id: executorId }]);
  });

  it("refuses terminal-before-accepted, conflicting terminals, and digest/body conflicts", async () => {
    const created = await create();
    const id = (created.body as { command: { id: string } }).command.id;
    expect((await executorEvent(id, { event: "applied", no_op: false })).body)
      .toMatchObject({ code: "command_not_accepted" });

    const badDigest = await router.invoke({
      method: "POST",
      url: `/api/tasks/commands/${id}/events`,
      credential: "agent-schedule",
      body: {
        schema: TASK_COMMAND_EVENT_SCHEMA,
        event: "accepted",
        event_digest: "a".repeat(64),
      },
    });
    expect(badDigest.status).toBe(409);
    expect(badDigest.body).toMatchObject({ code: "event_digest_conflict" });

    await executorEvent(id, { event: "accepted" });
    await executorEvent(id, { event: "rejected", reason: "unknown_task" });
    const conflicting = await executorEvent(id, { event: "applied", no_op: false });
    expect(conflicting.status).toBe(409);
    expect(conflicting.body).toMatchObject({ code: "terminal_event_conflict" });
    expect((db.prepare("SELECT count(*) AS n FROM task_command_events").get() as { n: number }).n)
      .toBe(2);
  });

  it("rejects rejection reasons outside the closed vocabulary", async () => {
    const created = await create();
    const id = (created.body as { command: { id: string } }).command.id;
    await executorEvent(id, { event: "accepted" });
    const response = await router.invoke({
      method: "POST",
      url: `/api/tasks/commands/${id}/events`,
      credential: "agent-schedule",
      body: {
        schema: TASK_COMMAND_EVENT_SCHEMA,
        event: "rejected",
        reason: "temporary_error",
        event_digest: "a".repeat(64),
      },
    });
    expect(response.status).toBe(400);
    expect((response.body as { error: string }).error).toMatch(/reason must be one of/);
  });

  it("uses the same mapped durable principal through actual file RPC", async () => {
    const created = await create();
    const id = (created.body as { command: { id: string } }).command.id;
    const spool = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-command-rpc-"));
    try {
      expect(router.resolveFileRpcPolicy("GET", "/api/tasks/commands/pending?executor=agent-schedule"))
        .toBe(true);
      expect(router.resolveFileRpcPolicy("POST", `/api/tasks/commands/${id}/events`)).toBe(true);
      expect(router.resolveFileRpcPolicy("POST", "/api/tasks/commands")).toBe(false);
      expect(router.resolveFileRpcPolicy("POST", `/api/tasks/commands/${id}/cancel`)).toBe(false);
      const transport = new FileRpcTransport({ router, dir: spool, responseTtlMs: 60_000 });
      fs.writeFileSync(path.join(spool, "pending.request.json"), JSON.stringify({
        id: "pending",
        method: "GET",
        path: "/api/tasks/commands/pending?executor=agent-schedule",
        capability_token: "agent-schedule",
      }));
      await transport.processOnce();
      fs.writeFileSync(path.join(spool, "accepted.request.json"), JSON.stringify({
        id: "accepted",
        method: "POST",
        path: `/api/tasks/commands/${id}/events`,
        capability_token: "agent-schedule",
        body: {
          schema: TASK_COMMAND_EVENT_SCHEMA,
          event: "accepted",
          event_digest: taskCommandEventDigest(id, { event: "accepted" }),
        },
      }));
      await transport.processOnce();
      const response = (name: string) => JSON.parse(
        fs.readFileSync(path.join(spool, `${name}.response.json`), "utf8"),
      ) as { status: number; body: Record<string, unknown> };
      expect(response("pending")).toMatchObject({
        status: 200, body: { commands: [{ id, state: "requested" }] },
      });
      expect(response("accepted")).toMatchObject({
        status: 200, body: { command: { id, state: "accepted" } },
      });
    } finally {
      fs.rmSync(spool, { recursive: true, force: true });
    }
  });
});
