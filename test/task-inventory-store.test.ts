// Executor task inventory store — issue 0bc2279.
//
// The properties under test are the ones that make the Tasks view trustworthy:
// validation that fails closed on anything it does not recognize, an `unknown`
// that survives the round trip untouched, idempotency keyed on content, and a
// projection that shows the newest complete generation and never a blend.

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  TASK_INVENTORY_SCHEMA,
  type TaskInventoryEntry,
  type TaskInventoryGeneration,
} from "../src/contracts.js";
import { migrate, type Db } from "../src/db.js";
import {
  deriveExecutorFreshness,
  getTaskInventoryView,
  parseTaskInventoryGeneration,
  recordTaskInventoryGeneration,
  TASK_INVENTORY_STALE_AFTER_MS,
  TaskInventoryValidationError,
  taskInventoryDigest,
} from "../src/task-inventory.js";
import { createUser } from "../src/users/store.js";

const HOUR = 60 * 60 * 1000;
const NOW = 1_786_650_000_000;

let db: Db;
let publisherId: string;

function taskFixture(overrides: Partial<TaskInventoryEntry> = {}): Record<string, unknown> {
  return {
    task_id: "daily-digest",
    display_name: "Daily digest",
    management_mode: "external",
    bundle: {
      commit: "a".repeat(40),
      content_hash: "sha256:content",
      execution_hash: "sha256:execution",
      deployed_at: NOW - 4 * HOUR,
    },
    activation: { config_enabled: true, locally_activated: true },
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
  return {
    schema: TASK_INVENTORY_SCHEMA,
    executor: { name: "agent-schedule", version: "0.4.2", capabilities: ["cron"] },
    observed_at: NOW,
    tasks: [taskFixture()],
    ...overrides,
  };
}

function store(
  generation: TaskInventoryGeneration,
  now = NOW,
): ReturnType<typeof recordTaskInventoryGeneration> {
  return recordTaskInventoryGeneration(db, generation, { postedByUserId: publisherId, now });
}

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
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
    });
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0].last_failure).toBe("never");
  });

  it("rejects an unknown field at the top level and inside a task", () => {
    expect(() => parseTaskInventoryGeneration(generationFixture({ extra: 1 })))
      .toThrow(/request body has unknown field\(s\): extra/);
    expect(() =>
      parseTaskInventoryGeneration(
        generationFixture({ tasks: [{ ...taskFixture(), enabled: true }] }),
      ),
    ).toThrow(/tasks\[0\] has unknown field\(s\): enabled/);
    expect(() =>
      parseTaskInventoryGeneration(
        generationFixture({
          tasks: [{ ...taskFixture(), guards: { ...(taskFixture().guards as object), oops: 1 } }],
        }),
      ),
    ).toThrow(/tasks\[0\]\.guards has unknown field\(s\): oops/);
  });

  it("rejects a schema it does not implement", () => {
    expect(() => parseTaskInventoryGeneration(generationFixture({ schema: "executor-inventory@2" })))
      .toThrow(/unsupported schema 'executor-inventory@2'/);
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

  it("keeps 'never' and 'unknown' distinct on run slots", () => {
    const parsed = parseTaskInventoryGeneration(
      generationFixture({
        tasks: [taskFixture({ last_run: "unknown", last_failure: "never" } as never)],
      }),
    );
    expect(parsed.tasks[0].last_run).toBe("unknown");
    expect(parsed.tasks[0].last_failure).toBe("never");
  });

  it("rejects a duplicate task id in one generation", () => {
    expect(() =>
      parseTaskInventoryGeneration(generationFixture({ tasks: [taskFixture(), taskFixture()] })),
    ).toThrow(/duplicate task_id 'daily-digest'/);
  });

  it("reports validation failures as TaskInventoryValidationError with status 400", () => {
    try {
      parseTaskInventoryGeneration({ schema: TASK_INVENTORY_SCHEMA });
      throw new Error("expected a validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(TaskInventoryValidationError);
      expect((error as TaskInventoryValidationError).status).toBe(400);
    }
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

  it("treats a new observation of identical task state as a new generation", () => {
    store(parseTaskInventoryGeneration(generationFixture()));
    store(parseTaskInventoryGeneration(generationFixture({ observed_at: NOW + HOUR })));
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM task_inventory_generations").get() as { n: number }).n,
    ).toBe(2);
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
      executor: { capabilities: ["cron"], name: "agent-schedule", version: "0.4.2" },
      schema: TASK_INVENTORY_SCHEMA,
    });
    expect(taskInventoryDigest(reordered)).toBe(
      taskInventoryDigest(parseTaskInventoryGeneration(generationFixture())),
    );
  });
});

describe("projection", () => {
  it("returns nothing at all before any executor posts", () => {
    expect(getTaskInventoryView(db, { now: NOW })).toEqual({
      executors: [],
      tasks: [],
      stale_after_ms: TASK_INVENTORY_STALE_AFTER_MS,
    });
  });

  it("projects the newest generation whole and passes `unknown` through untouched", () => {
    store(parseTaskInventoryGeneration(generationFixture()));
    store(
      parseTaskInventoryGeneration(
        generationFixture({
          observed_at: NOW + HOUR,
          tasks: [
            taskFixture({
              bundle: "unknown",
              last_run: "unknown",
            } as never),
            taskFixture({ task_id: "weekly-report", display_name: "Weekly report" }),
          ],
        }),
      ),
      NOW + HOUR,
    );

    const view = getTaskInventoryView(db, { now: NOW + HOUR });
    expect(view.executors).toHaveLength(1);
    expect(view.executors[0]).toMatchObject({
      name: "agent-schedule",
      task_count: 2,
      posted_by_user_id: publisherId,
      posted_by_slug: "agent-schedule",
      freshness: "current",
    });
    // Two tasks from the newest generation only — never a merge with the older
    // one, whose single task would otherwise still be listed.
    expect(view.tasks.map((entry) => entry.key)).toEqual([
      "agent-schedule/daily-digest",
      "agent-schedule/weekly-report",
    ]);
    const digest = view.tasks[0].task;
    expect(digest.bundle).toBe("unknown");
    expect(digest.last_run).toBe("unknown");
    expect(digest.last_failure).toBe("never");
  });

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

  it("stamps every projected task with its executor's freshness and the horizon", () => {
    store(parseTaskInventoryGeneration(generationFixture()));
    const later = NOW + TASK_INVENTORY_STALE_AFTER_MS + HOUR;
    const view = getTaskInventoryView(db, { now: later });
    expect(view.stale_after_ms).toBe(TASK_INVENTORY_STALE_AFTER_MS);
    expect(view.executors[0].freshness).toBe("stale");
    expect(view.tasks[0].freshness).toBe("stale");
    expect(view.tasks[0].observed_age_ms).toBe(later - NOW);
  });

  it("honors an explicit horizon override", () => {
    store(parseTaskInventoryGeneration(generationFixture()));
    const view = getTaskInventoryView(db, { now: NOW + 2 * HOUR, staleAfterMs: HOUR });
    expect(view.stale_after_ms).toBe(HOUR);
    expect(view.executors[0].freshness).toBe("stale");
  });
});
