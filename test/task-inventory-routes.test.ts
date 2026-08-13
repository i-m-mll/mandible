// Executor task inventory HTTP surface — issue 0bc2279.
//
// The route boundary owns exactly one thing the store cannot: WHO may post.
// Authenticating is not the same as being a registered executor, so the tests
// below separate anonymous, authenticated-but-unmapped, mapped, and operator
// callers, and check that the principal recorded on the receipt is the
// authenticated one rather than anything the payload claims.

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setSetting } from "../src/client-auth/settings-kv.js";
import { TASK_INVENTORY_SCHEMA } from "../src/contracts.js";
import { migrate, setDb, type Db } from "../src/db.js";
import { resolveInstanceInfo } from "../src/instance-policy.js";
import { registerTaskRoutes } from "../src/routes/tasks.js";
import { Router, type ClientAuthGate, type ResolvedClientIdentity } from "../src/server.js";
import { TASK_INVENTORY_EXECUTORS_KEY } from "../src/task-inventory.js";
import { createUser, OPERATOR_SETTING_KEY } from "../src/users/store.js";

const NOW = 1_786_650_000_000;
const HOUR = 60 * 60 * 1000;

let db: Db;
let router: Router;
let publisherId: string;
let operatorId: string;

/** Minimal gate: a credential string is a slug that resolves to a live user. */
class SlugGate implements ClientAuthGate {
  constructor(private readonly lookup: () => Db) {}

  authenticate(credential: string | null | undefined): ResolvedClientIdentity | null {
    if (!credential) return null;
    const row = this.lookup()
      .prepare("SELECT id, slug FROM users WHERE slug = ? AND status = 'active'")
      .get(credential) as { id: string; slug: string } | undefined;
    if (!row) return null;
    return {
      user_id: row.id,
      slug: row.slug,
      method: "api_token",
      credential_id: null,
      source: "in_process",
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
    schema: TASK_INVENTORY_SCHEMA,
    executor: { name: "agent-schedule", version: "0.4.2", capabilities: ["cron"] },
    observed_at: NOW,
    tasks: [
      {
        task_id: "daily-digest",
        display_name: "Daily digest",
        management_mode: "external",
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
  db = new Database(":memory:");
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

  it("rejects unknown fields and unsupported schema versions with a clear error", async () => {
    const extra = await post(generation({ enabled: true }), "agent-schedule");
    expect(extra.status).toBe(400);
    expect((extra.body as { error: string }).error).toMatch(/unknown field\(s\): enabled/);

    const badSchema = await post(
      generation({ schema: "executor-inventory@2" }),
      "agent-schedule",
    );
    expect(badSchema.status).toBe(400);
    expect((badSchema.body as { error: string }).error).toMatch(
      /unsupported schema 'executor-inventory@2'; expected 'executor-inventory@1'/,
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
  it("reports an empty surface before any executor has posted", async () => {
    const response = await router.invoke({ method: "GET", url: "/api/tasks" });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ executors: [], tasks: [] });
  });

  it("projects the latest generation with `unknown` intact", async () => {
    await post(generation(), "agent-schedule");
    const response = await router.invoke({ method: "GET", url: "/api/tasks" });
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
    expect(body.stale_after_ms).toBeGreaterThan(0);
  });

  it("marks an old generation stale without a fresh post", async () => {
    await post(generation({ observed_at: Date.now() - 12 * HOUR }), "agent-schedule");
    const response = await router.invoke({ method: "GET", url: "/api/tasks" });
    const body = response.body as { executors: Array<{ freshness: string }> };
    expect(body.executors[0].freshness).toBe("stale");
  });
});

describe("read-only instance policy", () => {
  it("refuses the ingest route on an instance that may not mutate", async () => {
    const readOnly = new Router({
      clientAuth: new SlugGate(() => db),
      instance: resolveInstanceInfo({
        env: { MANDIBLE_OPERATIONAL_MUTATIONS: "reject" } as NodeJS.ProcessEnv,
      }),
    });
    registerTaskRoutes(readOnly, db);
    const response = await readOnly.invoke({
      method: "POST",
      url: "/api/tasks/inventory",
      body: generation(),
      credential: "agent-schedule",
    });
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: "instance_mutation_forbidden", category: "tasks" });

    // Reads stay available on a read-only instance.
    expect((await readOnly.invoke({ method: "GET", url: "/api/tasks" })).status).toBe(200);
  });
});
