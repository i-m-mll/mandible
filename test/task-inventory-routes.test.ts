// Executor task inventory HTTP surface — issue 0bc2279.
//
// The route boundary owns exactly one thing the store cannot: WHO may post.
// Authenticating is not the same as being a registered executor, so the tests
// below separate anonymous, authenticated-but-unmapped, mapped, and operator
// callers, and check that the principal recorded on the receipt is the
// authenticated one rather than anything the payload claims.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setSetting } from "../src/client-auth/settings-kv.js";
import { TASK_INVENTORY_SCHEMA_V2 } from "../src/contracts.js";
import { migrate, setDb, type Db } from "../src/db.js";
import { resolveInstanceInfo } from "../src/instance-policy.js";
import { FileRpcTransport } from "../src/file-rpc-transport.js";
import { registerTaskRoutes } from "../src/routes/tasks.js";
import { Router, type ClientAuthGate, type ResolvedClientIdentity } from "../src/server.js";
import { PRODUCTION_EFFECTS } from "../src/security/effect-policy.js";
import { TASK_INVENTORY_EXECUTORS_KEY } from "../src/task-inventory.js";
import { createManagedReminder } from "../src/managed-reminders.js";
import { parseManagedReminderCreateRequest } from "../src/managed-reminder-parser.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { createUser, OPERATOR_SETTING_KEY } from "../src/users/store.js";

const NOW = 1_786_650_000_000;
const HOUR = 60 * 60 * 1000;

let db: Db;
let router: Router;
let publisherId: string;
let operatorId: string;
let projectId: string;

/** Minimal gate: a credential string is a slug that resolves to a live user. */
class SlugGate implements ClientAuthGate {
  constructor(private readonly lookup: () => Db) {}

  authenticate(
    credential: string | null | undefined,
    source: ResolvedClientIdentity["source"] = "in_process",
  ): ResolvedClientIdentity | null {
    if (!credential) return null;
    const ephemeral = credential.startsWith("session:");
    const slug = ephemeral ? credential.slice("session:".length) : credential;
    const row = this.lookup()
      .prepare("SELECT id, slug FROM users WHERE slug = ? AND status = 'active'")
      .get(slug) as { id: string; slug: string } | undefined;
    if (!row) return null;
    return {
      user_id: row.id,
      slug: row.slug,
      method: ephemeral ? "ephemeral" : "api_token",
      credential_id: null,
      source,
      effect_ceiling: PRODUCTION_EFFECTS,
    };
  }

  mode(): "compat" | "strict" {
    return "compat";
  }

  recordUnattributedWrite(): void {
    // No telemetry assertions in this suite.
  }
}

function generation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: TASK_INVENTORY_SCHEMA_V2,
    executor: { name: "agent-schedule", version: "0.4.2", capabilities: ["cron"] },
    observed_at: NOW,
    tasks: [
      {
        task_id: "daily-digest",
        display_name: "Daily digest",
        management_mode: "external",
        config_hash: "sha256:config",
        prompt_hash: "sha256:prompt",
        config: {
          schedule_text: "0 6 * * *",
          not_before: "2026-08-15T00:00:00Z",
          max_lateness_minutes: 30,
          missed_run_policy: "skip",
          timeout_seconds: 90,
          runner: "codex",
          runner_profile: "default",
          model: "gpt-5",
          max_total_tokens: 20_000,
          max_turns: 12,
          publish: true,
          output_as_source: false,
        },
        bundle: "unknown",
        activation: { config_enabled: true, locally_activated: false },
        guards: {
          circuit: "unknown",
          retry_attempt: 0,
          retry_next_at: "none",
          kill_switch: "clear",
          staleness: "unknown",
        },
        last_run: "unknown",
        last_failure: "never",
      },
    ],
    ...overrides,
  };
}

function post(body: unknown, credential?: string) {
  return router.invoke({
    method: "POST",
    url: "/api/tasks/inventory",
    body,
    ...(credential ? { credential } : {}),
  });
}

beforeEach(() => {
  db = new SqliteDatabase(":memory:");
  migrate(db);
  setDb(db);
  operatorId = createUser(db, { slug: "operator", kind: "human", display_name: "Operator" }).id;
  setSetting(db, OPERATOR_SETTING_KEY, operatorId);
  publisherId = createUser(db, {
    slug: "agent-schedule",
    kind: "agent",
    display_name: "Agent Schedule",
  }).id;
  createUser(db, { slug: "some-agent", kind: "agent", display_name: "Some Agent" });
  projectId = resolveProjectForCheckout(db, {
    root: "/tmp/task-projection-project",
    name: "task-projection-project",
    remoteUrl: "https://example.test/task-projection.git",
    defaultBranch: "develop",
  }, NOW).project.id;
  router = new Router({
    clientAuth: new SlugGate(() => db),
    instance: resolveInstanceInfo({
      env: { MANDIBLE_OPERATIONAL_MUTATIONS: "allow" } as NodeJS.ProcessEnv,
    }),
  });
  registerTaskRoutes(router, db);
});

afterEach(() => {
  db.close();
});

describe("POST /api/tasks/inventory", () => {
  it("accepts a mapped executor and replays the same digest idempotently", async () => {
    const first = await post(generation(), "agent-schedule");
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      stored: true,
      executor: "agent-schedule",
      task_count: 1,
      observed_at: NOW,
    });

    const replay = await post(generation(), "agent-schedule");
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...(first.body as object), stored: false });
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM task_inventory_generations").get() as { n: number }).n,
    ).toBe(1);
  });

  it("records the authenticated principal, not anything the payload claims", async () => {
    await post(generation(), "agent-schedule");
    expect(
      db.prepare("SELECT posted_by_user_id FROM task_inventory_generations").get(),
    ).toEqual({ posted_by_user_id: publisherId });
  });

  it("rejects an unauthenticated caller and writes nothing", async () => {
    const response = await post(generation());
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: "authentication_required" });
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM task_inventory_generations").get() as { n: number }).n,
    ).toBe(0);
  });

  it("rejects an authenticated identity that is not a registered executor", async () => {
    const response = await post(generation(), "some-agent");
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: "executor_identity_forbidden" });
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM task_inventory_generations").get() as { n: number }).n,
    ).toBe(0);
  });

  it("rejects an ordinary session token even when its agent identity is mapped", async () => {
    const response = await post(generation(), "session:agent-schedule");
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: "executor_credential_required" });
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM task_inventory_generations").get() as { n: number }).n,
    ).toBe(0);
  });

  it("rejects a mapped non-agent identity", async () => {
    createUser(db, { slug: "human-publisher", kind: "human", display_name: "Human Publisher" });
    setSetting(
      db,
      TASK_INVENTORY_EXECUTORS_KEY,
      JSON.stringify({ "human-publisher": ["agent-schedule"] }),
    );
    const response = await post(generation(), "human-publisher");
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: "executor_agent_required" });
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM task_inventory_generations").get() as { n: number }).n,
    ).toBe(0);
  });

  it("rejects a mapped publisher posting under an executor name it does not own", async () => {
    const response = await post(
      generation({ executor: { name: "other-executor", version: "1", capabilities: [] } }),
      "agent-schedule",
    );
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: "executor_identity_forbidden" });
  });

  it("admits the local operator as the administrative principal", async () => {
    const response = await post(
      generation({ executor: { name: "other-executor", version: "1", capabilities: [] } }),
      "operator",
    );
    expect(response.status).toBe(200);
    expect(
      db.prepare("SELECT posted_by_user_id FROM task_inventory_generations").get(),
    ).toEqual({ posted_by_user_id: operatorId });
  });

  it("honors an operator-configured publisher mapping", async () => {
    setSetting(db, TASK_INVENTORY_EXECUTORS_KEY, JSON.stringify({ "some-agent": ["fleet"] }));
    // The default mapping no longer applies once overridden.
    expect((await post(generation(), "agent-schedule")).status).toBe(403);
    expect(
      (await post(
        generation({ executor: { name: "fleet", version: "unknown", capabilities: [] } }),
        "some-agent",
      )).status,
    ).toBe(200);
  });

  it("fails closed on a partially malformed publisher mapping", async () => {
    setSetting(
      db,
      TASK_INVENTORY_EXECUTORS_KEY,
      JSON.stringify({ "some-agent": ["fleet", null] }),
    );
    const response = await post(
      generation({ executor: { name: "fleet", version: "1", capabilities: [] } }),
      "some-agent",
    );
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: "executor_identity_forbidden" });
  });

  it("enforces the same identity boundary through actual file-RPC requests", async () => {
    const spool = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-tasks-file-rpc-"));
    try {
      const transport = new FileRpcTransport({ router, dir: spool, responseTtlMs: 60_000 });
      const requests = [
        { id: "anonymous", ambient_identity: { provider: "codex", provider_session_id: "x" } },
        { id: "unmapped", capability_token: "some-agent" },
        { id: "session", capability_token: "session:agent-schedule" },
        { id: "mapped", capability_token: "agent-schedule" },
      ];
      for (const request of requests) {
        fs.writeFileSync(
          path.join(spool, `${request.id}.request.json`),
          JSON.stringify({
            ...request,
            method: "POST",
            path: "/api/tasks/inventory",
            body: generation(),
          }),
          "utf8",
        );
      }

      await transport.processOnce();

      const response = (id: string) => JSON.parse(
        fs.readFileSync(path.join(spool, `${id}.response.json`), "utf8"),
      ) as { status: number; body: Record<string, unknown> };
      expect(response("anonymous")).toMatchObject({
        status: 401,
        body: { error: "authentication_required", operation: router.listRoutePolicies().find(route => route.method === "POST" && route.path === "/api/tasks/inventory")!.operationId },
      });
      expect(response("unmapped")).toMatchObject({
        status: 403,
        body: { code: "executor_identity_forbidden" },
      });
      expect(response("session")).toMatchObject({
        status: 403,
        body: { code: "executor_credential_required" },
      });
      expect(response("mapped")).toMatchObject({ status: 200, body: { stored: true } });
      expect(
        (db.prepare("SELECT COUNT(*) AS n FROM task_inventory_generations").get() as { n: number }).n,
      ).toBe(1);
    } finally {
      fs.rmSync(spool, { recursive: true, force: true });
    }
  });

  it("rejects unknown fields and unsupported schema versions with a clear error", async () => {
    const extra = await post(generation({ enabled: true }), "agent-schedule");
    expect(extra.status).toBe(400);
    expect((extra.body as { error: string }).error).toMatch(/unknown field\(s\): enabled/);

    const badSchema = await post(
      generation({ schema: "executor-inventory@4" }),
      "agent-schedule",
    );
    expect(badSchema.status).toBe(400);
    expect((badSchema.body as { error: string }).error).toMatch(
      /unsupported schema 'executor-inventory@4'; expected 'executor-inventory@3', 'executor-inventory@2', or 'executor-inventory@1'/,
    );

    const nulled = await post(
      generation({
        tasks: [
          {
            ...(generation().tasks as Array<Record<string, unknown>>)[0],
            activation: { config_enabled: null, locally_activated: true },
          },
        ],
      }),
      "agent-schedule",
    );
    expect(nulled.status).toBe(400);
    expect((nulled.body as { error: string }).error).toMatch(/send 'unknown'/);

    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM task_inventory_generations").get() as { n: number }).n,
    ).toBe(0);
  });
});

describe("GET /api/tasks", () => {
  it("discriminates executor rows from first-party reminder rows without identity collision", async () => {
    await post(generation(), "agent-schedule");
    const created = createManagedReminder(
      db,
      parseManagedReminderCreateRequest({
        schema: "mandible-reminder@1",
        idempotency_key: "projection-reminder",
        project: "task-projection-project",
        message: "Review the twentieth canonical merge",
        predicate: { kind: "at", at: "2026-12-01T12:00:00Z" },
      }),
      { userId: publisherId, evidenceMethod: "api_token" },
      { now: NOW, projectId },
    );

    const response = await router.invoke({ method: "GET", url: "/api/tasks", credential: "operator" });
    expect(response.status).toBe(200);
    const tasks = (response.body as { tasks: Array<Record<string, unknown>> }).tasks;
    expect(tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source_kind: "executor",
        key: "agent-schedule/daily-digest",
        executor: "agent-schedule",
      }),
      expect.objectContaining({
        source_kind: "mandible",
        key: `mandible-reminder:${created.reminder.id}`,
        reminder: expect.objectContaining({
          id: created.reminder.id,
          project_key: "task-projection",
          lifecycle: "armed",
        }),
      }),
    ]));
  });

  it("reports an empty surface before any executor has posted", async () => {
    const response = await router.invoke({ method: "GET", url: "/api/tasks", credential: "operator" });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ executors: [], tasks: [] });
  });

  it("projects the latest generation with `unknown` intact", async () => {
    await post(generation(), "agent-schedule");
    const response = await router.invoke({ method: "GET", url: "/api/tasks", credential: "operator" });
    const body = response.body as {
      executors: Array<Record<string, unknown>>;
      tasks: Array<Record<string, unknown>>;
      stale_after_ms: number;
    };
    expect(body.executors).toHaveLength(1);
    expect(body.executors[0]).toMatchObject({
      name: "agent-schedule",
      posted_by_slug: "agent-schedule",
    });
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0]).toMatchObject({ key: "agent-schedule/daily-digest" });
    const task = body.tasks[0].task as Record<string, unknown>;
    expect(task.bundle).toBe("unknown");
    expect(task.last_run).toBe("unknown");
    expect(task.last_failure).toBe("never");
    expect(task.activation).toEqual({ config_enabled: true, locally_activated: false });
    expect(task.config_hash).toBe("sha256:config");
    expect(task.prompt_hash).toBe("sha256:prompt");
    expect(task.config).toMatchObject({
      schedule_text: "0 6 * * *",
      runner: "codex",
      model: "gpt-5",
      max_total_tokens: 20_000,
    });
    expect(body.stale_after_ms).toBeGreaterThan(0);
  });

  it("marks an old generation stale without a fresh post", async () => {
    await post(generation({ observed_at: Date.now() - 12 * HOUR }), "agent-schedule");
    const response = await router.invoke({ method: "GET", url: "/api/tasks", credential: "operator" });
    const body = response.body as { executors: Array<{ freshness: string }> };
    expect(body.executors[0].freshness).toBe("stale");
  });
});

describe("read-only instance policy", () => {
  it("refuses the ingest route on an instance that may not mutate", async () => {
    const readOnly = new Router({
      clientAuth: new SlugGate(() => db),
      instance: resolveInstanceInfo({
        env: { MANDIBLE_ALLOWED_EFFECTS: JSON.stringify(["ledger:read"]) } as NodeJS.ProcessEnv,
      }),
    });
    registerTaskRoutes(readOnly, db);
    const response = await readOnly.invoke({
      method: "POST",
      url: "/api/tasks/inventory",
      body: generation(),
      credential: "agent-schedule",
      transport: "file-rpc",
    });
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      error: "effect_forbidden",
      operation: readOnly.listRoutePolicies().find(route => route.method === "POST" && route.path === "/api/tasks/inventory")!.operationId,
      missing_effects: ["process:external"],
    });

    // Reads stay available on a read-only instance.
    expect((await readOnly.invoke({
      method: "GET", url: "/api/tasks", credential: "operator", transport: "file-rpc",
    })).status).toBe(200);
  });
});
