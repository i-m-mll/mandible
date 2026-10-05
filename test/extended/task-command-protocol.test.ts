import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import SqliteDatabase from "../../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setSetting } from "../../src/client-auth/settings-kv.js";
import {
  TASK_COMMAND_EVENT_SCHEMA,
  TASK_COMMAND_EVENT_SCHEMA_V1,
  TASK_COMMAND_SCHEMA,
  TASK_COMMAND_SCHEMA_V1,
  TASK_INVENTORY_SCHEMA_V2,
  type TaskCommand,
} from "../../src/contracts.js";
import { migrate, setDb, type Db } from "../../src/db.js";
import { FileRpcTransport } from "../../src/file-rpc-transport.js";
import { resolveInstanceInfo } from "../../src/instance-policy.js";
import { registerTaskRoutes } from "../../src/routes/tasks.js";
import { Router, type ClientAuthGate, type ResolvedClientIdentity } from "../../src/server.js";
import { PRODUCTION_EFFECTS } from "../../src/security/effect-policy.js";
import { taskCommandEventDigest } from "../../src/task-commands.js";
import {
  parseTaskInventoryGeneration,
  recordTaskInventoryGeneration,
  TASK_INVENTORY_EXECUTORS_KEY,
} from "../../src/task-inventory.js";
import { setSseManager, SseManager } from "../../src/sse.js";
import { createUser, OPERATOR_SETTING_KEY } from "../../src/users/store.js";

let db: Db;
let router: Router;
let operatorId: string;
let executorId: string;
let sseManager: SseManager;

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
      effect_ceiling: PRODUCTION_EFFECTS,
    } : null;
  }
  mode(): "compat" { return "compat"; }
  recordUnattributedWrite(): void {}
}

function createBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: TASK_COMMAND_SCHEMA_V1,
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
  schema: typeof TASK_COMMAND_EVENT_SCHEMA_V1 | typeof TASK_COMMAND_EVENT_SCHEMA = TASK_COMMAND_EVENT_SCHEMA_V1,
) {
  return router.invoke({
    method: "POST",
    url: `/api/tasks/commands/${commandId}/events`,
    credential,
    body: {
      schema,
      ...event,
      event_digest: taskCommandEventDigest(commandId, event),
    },
  });
}

async function executorV2Event(
  commandId: string,
  event: Parameters<typeof taskCommandEventDigest>[1],
) {
  return router.invoke({
    method: "POST",
    url: `/api/tasks/commands/${commandId}/events`,
    credential: "agent-schedule",
    body: {
      schema: TASK_COMMAND_EVENT_SCHEMA,
      ...event,
      event_digest: taskCommandEventDigest(commandId, event),
    },
  });
}

function declareV2Capability(): void {
  recordTaskInventoryGeneration(db, parseTaskInventoryGeneration({
    schema: TASK_INVENTORY_SCHEMA_V2,
    executor: {
      name: "agent-schedule",
      version: "test",
      capabilities: [TASK_COMMAND_SCHEMA],
    },
    observed_at: Date.now(),
    tasks: [],
  }), { postedByUserId: executorId });
}

function v2Body(
  verb: "dry_run" | "enable",
  requestKey = `${verb}-1`,
): Record<string, unknown> {
  return createBody({
    schema: TASK_COMMAND_SCHEMA,
    request_key: requestKey,
    verb,
    payload: { execution_hash: "a".repeat(64) },
  });
}

beforeEach(() => {
  db = new SqliteDatabase(":memory:");
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
  sseManager = new SseManager();
  setSseManager(sseManager);
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

  it("cancel_wins_only_before_acceptance", async () => {
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

  it("returns the complete pending safety queue instead of truncating at the operator history limit", async () => {
    for (let index = 0; index < 101; index += 1) {
      const result = await create("operator", createBody({ request_key: `disable-${index}` }));
      expect(result.status).toBe(200);
    }
    const pending = await router.invoke({
      method: "GET",
      url: "/api/tasks/commands/pending?executor=agent-schedule",
      credential: "agent-schedule",
    });
    expect(pending.status).toBe(200);
    expect((pending.body as { commands: unknown[] }).commands).toHaveLength(101);

    const selectedTaskHistory = await router.invoke({
      method: "GET",
      url: "/api/tasks/commands?executor=agent-schedule&task_id=daily-digest",
      credential: "operator",
    });
    expect(selectedTaskHistory.status).toBe(200);
    expect((selectedTaskHistory.body as { commands: unknown[] }).commands).toHaveLength(101);
  });
});

describe("executor authority, receipts, and conflicts", () => {
  it("executor_authority_and_sse_are_preserved", async () => {
    const broadcast = vi.spyOn(sseManager, "broadcast");
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
    expect((await router.invoke({
      method: "GET", url: `/api/tasks/commands/${id}`, credential: "operator",
    })).body).toMatchObject({ command: { id } });
    expect((await router.invoke({
      method: "GET", url: `/api/tasks/commands/${id}`, credential: "agent-schedule",
    })).body).toMatchObject({ code: "operator_required" });
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: "tasks.commands.changed",
      data: { command_id: id },
    }));
  });

  it("identical_event_replay_is_idempotent", async () => {
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
        schema: TASK_COMMAND_EVENT_SCHEMA_V1,
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
        schema: TASK_COMMAND_EVENT_SCHEMA_V1,
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
          schema: TASK_COMMAND_EVENT_SCHEMA_V1,
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

describe("task-command v2 frozen protocol", () => {
  it("v1_disable_remains_wire_compatible", async () => {
    const created = await create();
    expect(created.status).toBe(200);
    const command = (created.body as { command: { id: string; schema: string; verb: string } }).command;
    expect(command).toMatchObject({ schema: "task-command@1", verb: "disable" });
    expect((await executorEvent(command.id, { event: "accepted" })).status).toBe(200);
    expect((await executorEvent(command.id, { event: "applied", no_op: false })).body)
      .toMatchObject({ command: { state: "applied", no_op: false } });
  });

  it("v2_request_and_event_digest_fixtures_match_executor", async () => {
    declareV2Capability();
    const created = await create("operator", v2Body("dry_run"));
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      command: { request_digest: "87af17aa43cedc4427877d109f9e215ac225d3f21e1522c5f3862de533e13227" },
    });
    expect(taskCommandEventDigest("command-fixture", { event: "accepted" }))
      .toBe("155fc51a7645ae8644864ca6746d120b8295a237cdf6331c8142127c2431d6e1");
    expect(taskCommandEventDigest("command-fixture", {
      event: "started", execution_hash: "a".repeat(64), run_id: "run-7",
    })).toBe("5ba34f672330f7dcadcf13479c09c2796ece9d8dfe06775d0e04c106f4fb4cf5");
    expect(taskCommandEventDigest("command-fixture", {
      event: "progress", sequence: 1, step: "preflight_passed",
    })).toBe("aeb7ab6c37fa8518d728aab4b5f529967562c93dec68df046672c018bbc993c7");
    expect(taskCommandEventDigest("command-fixture", {
      event: "applied", execution_hash: "a".repeat(64), run_id: "run-7",
    })).toBe("f3f20fdb54ced741bdf1bc41e9089f785ce7e7acf61cf0fbacbb96589f9ea8c0");
    expect(taskCommandEventDigest("command-fixture", {
      event: "rejected", reason: "dry_run_failed", failure_class: "runner",
    })).toBe("09a1f2fd5dba299078d985ac654c2cbe674cf49235456fd1d3f5e7eaf189d223");
    // `policy_gate` follows `reason` in the canonical object.
    expect(taskCommandEventDigest("command-fixture", {
      event: "rejected", reason: "policy_refused", policy_gate: "tampered",
    })).toBe("ec2108e5eb24e547e12fa58651e225bd909d0ddb9ef1c59ed899f9c6c967605b");
    // And a refusal without one digests exactly as it did before the field
    // existed, which is what keeps a pre-amendment executor wire-compatible.
    expect(taskCommandEventDigest("command-fixture", {
      event: "rejected", reason: "policy_refused",
    })).toBe("e30b015f1580f1add58652a1bb2bdaae15084aa7b8429d6636d3829ef0177631");
  });

  it("policy_refused_names_the_gate_that_refused", async () => {
    // Every closed member round-trips: parsed, digested, stored, projected.
    const gates = [
      "kill_switch", "no_bundle", "unprotected", "tampered", "misbound",
      "unreadable_config",
    ] as const;
    for (const [index, policy_gate] of gates.entries()) {
      declareV2Capability();
      const created = await create("operator", v2Body("enable", `enable-${index}`));
      const id = (created.body as { command: { id: string } }).command.id;
      await executorV2Event(id, { event: "accepted" });
      const rejected = await executorV2Event(id, {
        event: "rejected", reason: "policy_refused", policy_gate,
      });
      expect(rejected.status).toBe(200);
      const { command } = rejected.body as { command: TaskCommand };
      expect(command.state).toBe("rejected");
      expect(command.rejection_reason).toBe("policy_refused");
      const terminal = command.events.find((event) => event.event === "rejected");
      expect(terminal?.payload).toEqual({ reason: "policy_refused", policy_gate });
    }
  });

  it("policy_refused_without_a_gate_stays_wire_compatible", async () => {
    // An executor that predates the field is supported indefinitely. Absence
    // means exactly that, and never "the gate is unknown".
    declareV2Capability();
    const created = await create("operator", v2Body("enable"));
    const id = (created.body as { command: { id: string } }).command.id;
    await executorV2Event(id, { event: "accepted" });
    const rejected = await executorV2Event(id, {
      event: "rejected", reason: "policy_refused",
    });
    expect(rejected.status).toBe(200);
    const { command } = rejected.body as { command: TaskCommand };
    expect(command.rejection_reason).toBe("policy_refused");
    expect(command.events.find((event) => event.event === "rejected")?.payload)
      .toEqual({ reason: "policy_refused" });
  });

  it("an_unknown_or_misplaced_policy_gate_is_refused", async () => {
    declareV2Capability();
    const created = await create("operator", v2Body("enable"));
    const id = (created.body as { command: { id: string } }).command.id;
    await executorV2Event(id, { event: "accepted" });

    // Refused at the wire rather than stored: an unrecognized value is
    // indistinguishable here from a string that should never have been sent,
    // and storing it is the path leak the closed enumeration prevents.
    const rejections: Record<string, unknown>[] = [
      { event: "rejected", reason: "policy_refused", policy_gate: "/Users/mll/state/bundles" },
      { event: "rejected", reason: "policy_refused", policy_gate: "TAMPERED" },
      { event: "rejected", reason: "policy_refused", policy_gate: 7 },
      { event: "rejected", reason: "policy_refused", policy_gate: null },
      // A gate belongs to a policy refusal alone, and to no other event.
      { event: "rejected", reason: "busy", policy_gate: "tampered" },
      { event: "rejected", reason: "dry_run_failed", failure_class: "runner", policy_gate: "tampered" },
      { event: "accepted", policy_gate: "tampered" },
    ];
    for (const body of rejections) {
      const response = await router.invoke({
        method: "POST",
        url: `/api/tasks/commands/${id}/events`,
        credential: "agent-schedule",
        body: { schema: TASK_COMMAND_EVENT_SCHEMA, ...body, event_digest: "a".repeat(64) },
      });
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: "invalid_task_command" });
    }

    // Nothing was stored: the command is still awaiting a terminal decision.
    const after = await router.invoke({
      method: "GET", url: `/api/tasks/commands/${id}`, credential: "operator",
    });
    expect((after.body as { command: TaskCommand }).command.state).toBe("accepted");
  });

  it("a_v1_rejection_never_carries_a_policy_gate", async () => {
    // task-command@1 reaches no policy gate at all: its rejections come only
    // from request validation. The v1 wire is untouched by the amendment.
    const created = await create("operator", createBody({ request_key: "v1-gate" }));
    const id = (created.body as { command: { id: string } }).command.id;
    await router.invoke({
      method: "POST",
      url: `/api/tasks/commands/${id}/events`,
      credential: "agent-schedule",
      body: {
        schema: TASK_COMMAND_EVENT_SCHEMA_V1,
        event: "accepted",
        event_digest: taskCommandEventDigest(id, { event: "accepted" }),
      },
    });
    const response = await router.invoke({
      method: "POST",
      url: `/api/tasks/commands/${id}/events`,
      credential: "agent-schedule",
      body: {
        schema: TASK_COMMAND_EVENT_SCHEMA_V1,
        event: "rejected",
        reason: "policy_refused",
        policy_gate: "tampered",
        event_digest: "a".repeat(64),
      },
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "invalid_task_command" });
  });

  it("started_and_progress_are_dry_run_only", async () => {
    declareV2Capability();
    const dryRun = await create("operator", v2Body("dry_run"));
    const dryId = (dryRun.body as { command: { id: string } }).command.id;
    await executorV2Event(dryId, { event: "accepted" });
    expect((await executorV2Event(dryId, {
      event: "started", execution_hash: "a".repeat(64), run_id: "run-1",
    })).status).toBe(200);

    const enable = await create("operator", v2Body("enable"));
    const enableId = (enable.body as { command: { id: string } }).command.id;
    await executorV2Event(enableId, { event: "accepted" });
    const illegal = await executorV2Event(enableId, {
      event: "started", execution_hash: "a".repeat(64), run_id: "run-2",
    });
    expect(illegal.status).toBe(400);
    expect(illegal.body).toMatchObject({ code: "invalid_task_command" });
  });

  it("progress_is_closed_ordered_and_capped_at_six", async () => {
    declareV2Capability();
    const created = await create("operator", v2Body("dry_run"));
    const id = (created.body as { command: { id: string } }).command.id;
    await executorV2Event(id, { event: "accepted" });
    await executorV2Event(id, {
      event: "started", execution_hash: "a".repeat(64), run_id: "run-1",
    });
    const outOfOrder = await executorV2Event(id, {
      event: "progress", sequence: 2, step: "collector_started",
    });
    expect(outOfOrder.status).toBe(409);
    expect(outOfOrder.body).toMatchObject({ code: "progress_sequence_conflict" });
    const pairs = [
      [1, "preflight_passed"],
      [2, "collector_started"],
      [3, "snapshot_validated"],
      [4, "runner_started"],
      [5, "runner_completed"],
      [6, "output_validated"],
    ] as const;
    for (const [sequence, step] of pairs) {
      expect((await executorV2Event(id, { event: "progress", sequence, step })).status).toBe(200);
    }
    const unknownPair = await router.invoke({
      method: "POST",
      url: `/api/tasks/commands/${id}/events`,
      credential: "agent-schedule",
      body: {
        schema: TASK_COMMAND_EVENT_SCHEMA,
        event: "progress",
        sequence: 7,
        step: "output_validated",
        event_digest: "b".repeat(64),
      },
    });
    expect(unknownPair.status).toBe(400);
    expect((db.prepare(
      "SELECT count(*) AS count FROM task_command_events WHERE command_id = ? AND event_type = 'progress'",
    ).get(id) as { count: number }).count).toBe(6);
  });

  it("v2_creation_requires_executor_capability", async () => {
    const refused = await create("operator", v2Body("enable"));
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "executor_capability_unknown" });
    expect((await create("operator", createBody({ request_key: "v1-still-available" }))).status)
      .toBe(200);
    declareV2Capability();
    expect((await create("operator", v2Body("enable", "enable-after-capability"))).status)
      .toBe(200);
  });
});
