// Executor task inventory store — issue 0bc2279.
//
// The properties under test are the ones that make the Tasks view trustworthy:
// validation that fails closed on anything it does not recognize, an `unknown`
// that survives the round trip untouched, idempotency keyed on content, and a
// projection that shows the newest complete generation and never a blend.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  TASK_INVENTORY_SCHEMA,
  TASK_INVENTORY_SCHEMA_V1,
  type TaskInventoryEntry,
  type TaskInventoryGeneration,
} from "../src/contracts.js";
import { type Db } from "../src/db.js";
import {
  deriveExecutorFreshness,
  getTaskInventoryView,
  parseTaskInventoryGeneration,
  recordTaskInventoryGeneration,
  TASK_INVENTORY_STALE_AFTER_MS,
  taskInventoryDigest,
} from "../src/task-inventory.js";
import { createUser } from "../src/users/store.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

const HOUR = 60 * 60 * 1000;
const NOW = 1_786_650_000_000;

let db: Db;
let publisherId: string;

function configFixture(): Record<string, unknown> {
  return {
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
  };
}

function taskFixture(overrides: Partial<TaskInventoryEntry> = {}): Record<string, unknown> {
  return {
    task_id: "daily-digest",
    display_name: "Daily digest",
    management_mode: "external",
    config_hash: "sha256:config",
    prompt_hash: "sha256:prompt",
    config: configFixture(),
    bundle: {
      commit: "a".repeat(40),
      content_hash: "sha256:content",
      execution_hash: "sha256:execution",
      deployed_at: NOW - 4 * HOUR,
    },
    activation: {
      config_enabled: true,
      locally_activated: true,
      state: "activated",
      reason: "operator_enabled",
      changed_at: NOW - 4 * HOUR,
      previous_execution_hash: "none",
      required_execution_hash: "none",
      deployment_commit: "none",
      deployment_content_hash: "none",
      deployed_at: "unknown",
      required_action: "none",
      attention: "none",
    },
    guards: {
      circuit: "closed",
      retry_attempt: 0,
      retry_next_at: "none",
      kill_switch: "clear",
      staleness: "fresh",
    },
    last_run: {
      run_id: "run-1",
      started_at: NOW - HOUR,
      finished_at: NOW - HOUR + 1000,
      outcome: "success",
      bundle_commit: "a".repeat(40),
      content_hash: "sha256:content",
      execution_hash: "sha256:execution",
      config_hash: "sha256:config",
      detail: "unknown",
    },
    last_failure: "never",
    ...overrides,
  } as Record<string, unknown>;
}

function generationFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const schema = overrides.schema ?? TASK_INVENTORY_SCHEMA;
  const executor = {
    name: "agent-schedule",
    version: "0.4.2",
    capabilities: ["cron"],
    ...(schema === TASK_INVENTORY_SCHEMA ? {
      health: { status: "healthy", condition: "healthy", attention: "none" },
    } : {}),
    ...((overrides.executor as Record<string, unknown> | undefined) ?? {}),
  };
  return {
    schema,
    executor,
    observed_at: NOW,
    tasks: [taskFixture()],
    ...overrides,
    executor,
  };
}

function store(
  generation: TaskInventoryGeneration,
  now = NOW,
): ReturnType<typeof recordTaskInventoryGeneration> {
  return recordTaskInventoryGeneration(db, generation, { postedByUserId: publisherId, now });
}

beforeEach(() => {
  db = migratedMemoryDb();
  publisherId = createUser(db, {
    slug: "agent-schedule",
    kind: "agent",
    display_name: "Agent Schedule",
  }).id;
});

afterEach(() => {
  db.close();
});

describe("generation validation", () => {

  it("accepts a well-formed generation", () => {
    const parsed = parseTaskInventoryGeneration(generationFixture());
    expect(parsed.executor).toEqual({
      name: "agent-schedule",
      version: "0.4.2",
      capabilities: ["cron"],
      health: { status: "healthy", condition: "healthy", attention: "none" },
    });
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0].last_failure).toBe("never");
    expect(parsed.tasks[0].config).toEqual(configFixture());
  });

  it("round-trips v1 without inventing a config group", () => {
    const legacyTask = taskFixture();
    delete legacyTask.config_hash;
    delete legacyTask.prompt_hash;
    delete legacyTask.config;
    legacyTask.activation = { config_enabled: true, locally_activated: true };
    const parsed = parseTaskInventoryGeneration(generationFixture({
      schema: TASK_INVENTORY_SCHEMA_V1,
      tasks: [legacyTask],
    }));
    const receipt = store(parsed);
    const stored = JSON.parse((db.prepare(
      "SELECT payload_json FROM task_inventory_generations WHERE id = ?",
    ).get(receipt.generation_id) as { payload_json: string }).payload_json);
    const projected = getTaskInventoryView(db, { now: NOW });

    expect(stored.schema).toBe(TASK_INVENTORY_SCHEMA_V1);
    expect(stored.tasks[0]).not.toHaveProperty("config");
    expect(projected.tasks[0]).toMatchObject({ source_kind: "executor" });
    expect((projected.tasks[0] as { task: Record<string, unknown> }).task)
      .not.toHaveProperty("config");
  });

  it("rejects prototype-shaped and deep unknown keys with their exact paths", () => {
    const topLevel = generationFixture();
    Object.defineProperty(topLevel, "__proto__", {
      value: { polluted: true },
      enumerable: true,
    });
    expect(() => parseTaskInventoryGeneration(topLevel))
      .toThrow(/request body has unknown field\(s\): __proto__/);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();

    expect(() => parseTaskInventoryGeneration(generationFixture({
      executor: {
        name: "agent-schedule",
        version: "1",
        capabilities: [],
        constructor: "nope",
      },
    }))).toThrow(/executor has unknown field\(s\): constructor/);
    expect(() => parseTaskInventoryGeneration(generationFixture({
      tasks: [taskFixture({
        bundle: { ...(taskFixture().bundle as object), constructor: "nope" },
      })],
    }))).toThrow(/tasks\[0\]\.bundle has unknown field\(s\): constructor/);
    expect(() => parseTaskInventoryGeneration(generationFixture({
      tasks: [taskFixture({
        activation: { config_enabled: true, locally_activated: true, constructor: "nope" },
      })],
    }))).toThrow(/tasks\[0\]\.activation has unknown field\(s\): constructor/);
    expect(() => parseTaskInventoryGeneration(generationFixture({
      tasks: [taskFixture({
        last_run: { ...(taskFixture().last_run as object), constructor: "nope" },
      })],
    }))).toThrow(/tasks\[0\]\.last_run has unknown field\(s\): constructor/);
  });

  it("refuses null or omission where the contract wants an explicit 'unknown'", () => {
    const task = taskFixture();
    (task.activation as Record<string, unknown>).config_enabled = null;
    expect(() => parseTaskInventoryGeneration(generationFixture({ tasks: [task] })))
      .toThrow(/config_enabled is required; send 'unknown'/);

    const missing = taskFixture();
    delete (missing.guards as Record<string, unknown>).kill_switch;
    expect(() => parseTaskInventoryGeneration(generationFixture({ tasks: [missing] })))
      .toThrow(/kill_switch is required; send 'unknown'/);
  });

});

describe("receipts", () => {
  it("is idempotent by content digest", () => {
    const generation = parseTaskInventoryGeneration(generationFixture());
    const first = store(generation);
    const replay = store(generation);

    expect(first.stored).toBe(true);
    expect(replay).toEqual({ ...first, stored: false });
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM task_inventory_generations").get() as { n: number }).n,
    ).toBe(1);
  });

  it("records the authenticated principal and the full payload", () => {
    const generation = parseTaskInventoryGeneration(generationFixture());
    const result = store(generation);
    const row = db
      .prepare("SELECT * FROM task_inventory_generations WHERE id = ?")
      .get(result.generation_id) as Record<string, unknown>;
    expect(row.posted_by_user_id).toBe(publisherId);
    expect(row.digest).toBe(taskInventoryDigest(generation));
    expect(JSON.parse(row.payload_json as string)).toEqual(generation);
  });

  it("derives a digest that ignores incoming key order", () => {
    const reordered = parseTaskInventoryGeneration({
      tasks: [taskFixture()],
      observed_at: NOW,
      executor: {
        health: { attention: "none", condition: "healthy", status: "healthy" },
        capabilities: ["cron"],
        name: "agent-schedule",
        version: "0.4.2",
      },
      schema: TASK_INVENTORY_SCHEMA,
    });
    expect(taskInventoryDigest(reordered)).toBe(
      taskInventoryDigest(parseTaskInventoryGeneration(generationFixture())),
    );
  });

  it("scopes digest idempotency to the executor identity", () => {
    const first = parseTaskInventoryGeneration(generationFixture());
    const second = parseTaskInventoryGeneration(generationFixture({
      executor: { name: "other-executor", version: "1", capabilities: [] },
    }));
    const firstReceipt = store(first);

    // Synthetic collision: make the existing executor's row carry the second
    // generation's digest. A collision must not suppress a different
    // executor's authenticated receipt.
    db.prepare("UPDATE task_inventory_generations SET digest = ? WHERE id = ?")
      .run(taskInventoryDigest(second), firstReceipt.generation_id);

    const secondReceipt = store(second);
    expect(secondReceipt).toMatchObject({ stored: true, executor: "other-executor" });
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM task_inventory_generations").get() as { n: number }).n,
    ).toBe(2);
  });
});

describe("generation retention", () => {
  it("keeps only the newest 50 generations for the executor being ingested", () => {
    const otherReceipts = Array.from({ length: 3 }, (_, index) =>
      store(parseTaskInventoryGeneration(generationFixture({
        executor: { name: "other-executor", version: `${index}`, capabilities: [] },
        observed_at: NOW + index,
      })), NOW + index));

    const receipts = Array.from({ length: 55 }, (_, index) =>
      store(parseTaskInventoryGeneration(generationFixture({
        executor: { name: "agent-schedule", version: `${index}`, capabilities: ["cron"] },
        observed_at: NOW + index,
      })), NOW + index));

    const retained = db.prepare(
      `SELECT id, observed_at
         FROM task_inventory_generations
        WHERE executor_name = ?
        ORDER BY observed_at ASC`,
    ).all("agent-schedule") as Array<{ id: string; observed_at: number }>;
    expect(retained).toHaveLength(50);
    expect(retained.map((row) => row.observed_at)).toEqual(
      Array.from({ length: 50 }, (_, index) => NOW + index + 5),
    );
    expect(retained.map((row) => row.id)).toContain(receipts[54].generation_id);
    expect(retained.map((row) => row.id)).not.toContain(receipts[0].generation_id);

    const otherIds = db.prepare(
      `SELECT id
         FROM task_inventory_generations
        WHERE executor_name = ?
        ORDER BY observed_at ASC`,
    ).all("other-executor") as Array<{ id: string }>;
    expect(otherIds.map((row) => row.id)).toEqual(
      otherReceipts.map((receipt) => receipt.generation_id),
    );
  });

});

describe("projection", () => {

  it("does not let a late-arriving older snapshot displace a newer one", () => {
    store(parseTaskInventoryGeneration(generationFixture({ observed_at: NOW })), NOW);
    // Received later, observed earlier.
    store(
      parseTaskInventoryGeneration(
        generationFixture({
          observed_at: NOW - 2 * HOUR,
          tasks: [taskFixture({ task_id: "old-task", display_name: "Old task" })],
        }),
      ),
      NOW + 60_000,
    );

    const view = getTaskInventoryView(db, { now: NOW });
    expect(view.executors[0].observed_at).toBe(NOW);
    expect(view.tasks.map((entry) => entry.key)).toEqual(["agent-schedule/daily-digest"]);
  });

  it("drops tasks absent from the newest generation instead of leaving ghosts", () => {
    store(parseTaskInventoryGeneration(generationFixture({
      tasks: [
        taskFixture(),
        taskFixture({ task_id: "retired-task", display_name: "Retired task" }),
      ],
    })), NOW);
    store(parseTaskInventoryGeneration(generationFixture({
      observed_at: NOW + HOUR,
      tasks: [],
    })), NOW + HOUR);

    const view = getTaskInventoryView(db, { now: NOW + HOUR });
    expect(view.executors).toHaveLength(1);
    expect(view.executors[0].task_count).toBe(0);
    expect(view.tasks).toEqual([]);
  });

  it("keeps executors separate", () => {
    store(parseTaskInventoryGeneration(generationFixture()));
    store(
      parseTaskInventoryGeneration(
        generationFixture({
          executor: { name: "other-executor", version: "unknown", capabilities: [] },
        }),
      ),
    );
    const view = getTaskInventoryView(db, { now: NOW });
    expect(view.executors.map((entry) => entry.name)).toEqual(["agent-schedule", "other-executor"]);
    expect(view.tasks.map((entry) => entry.executor)).toEqual(["agent-schedule", "other-executor"]);
  });

});

describe("staleness", () => {
  it("classifies an executor by the age of its own observation", () => {
    expect(deriveExecutorFreshness(NOW - HOUR, NOW)).toBe("current");
    expect(deriveExecutorFreshness(NOW - TASK_INVENTORY_STALE_AFTER_MS, NOW)).toBe("current");
    expect(deriveExecutorFreshness(NOW - TASK_INVENTORY_STALE_AFTER_MS - 1, NOW)).toBe("stale");
    expect(deriveExecutorFreshness(null, NOW)).toBe("unknown");
    // A future observation is a clock we cannot reason about, not freshness.
    expect(deriveExecutorFreshness(NOW + HOUR, NOW)).toBe("unknown");
  });

});
