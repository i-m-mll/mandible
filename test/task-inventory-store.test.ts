// Executor task inventory store — issue 0bc2279.
//
// The properties under test are the ones that make the Tasks view trustworthy:
// validation that fails closed on anything it does not recognize, an `unknown`
// that survives the round trip untouched, idempotency keyed on content, and a
// projection that shows the newest complete generation and never a blend.

import fs from "node:fs";
import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  TASK_INVENTORY_SCHEMA,
  TASK_INVENTORY_SCHEMA_V1,
  TASK_INVENTORY_SCHEMA_V2,
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
  db = new SqliteDatabase(":memory:");
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
  it("keeps the documented sample and field matrix aligned with the parser", () => {
    const contract = fs.readFileSync(
      "docs/executor-inventory-contract.md",
      "utf8",
    );
    const sample = [...contract.matchAll(/```json\n([\s\S]*?)\n```/g)]
      .map((match) => match[1])
      .find((block) => block.includes(`"schema": "${TASK_INVENTORY_SCHEMA_V1}"`));
    expect(sample).toBeTruthy();
    expect(() => parseTaskInventoryGeneration(JSON.parse(sample!))).not.toThrow();

    const documentedPaths = [
      "schema",
      "executor.name",
      "executor.version",
      "executor.capabilities",
      "observed_at",
      "tasks[]",
      "task_id",
      "display_name",
      "management_mode",
      "bundle",
      "bundle.commit",
      "bundle.content_hash",
      "bundle.execution_hash",
      "bundle.deployed_at",
      "activation.config_enabled",
      "activation.locally_activated",
      "guards.circuit",
      "guards.retry_attempt",
      "guards.retry_next_at",
      "guards.kill_switch",
      "guards.staleness",
      "last_run",
      "last_failure",
      "run_id",
      "started_at",
      "finished_at",
      "outcome",
      "bundle_commit",
      "content_hash",
      "execution_hash",
      "config_hash",
      "detail",
    ];
    for (const field of documentedPaths) {
      expect(contract, `missing contract field ${field}`).toContain(`\`${field}\``);
    }
  });

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

  it("accepts explicit unknown for every v2 config field", () => {
    const allUnknown = Object.fromEntries(Object.keys(configFixture()).map((key) => [key, "unknown"]));
    const parsed = parseTaskInventoryGeneration(generationFixture({
      tasks: [taskFixture({ config_hash: "unknown", prompt_hash: "unknown", config: allUnknown })],
    }));
    expect(parsed.tasks[0]).toMatchObject({
      config_hash: "unknown",
      prompt_hash: "unknown",
      config: allUnknown,
    });
  });

  it("rejects null inside a v2 config field", () => {
    expect(() => parseTaskInventoryGeneration(generationFixture({
      tasks: [taskFixture({ config: { ...configFixture(), model: null } })],
    }))).toThrow(/tasks\[0\]\.config\.model is required; send 'unknown'/);
  });

  it("rejects omission of a v2 config field", () => {
    const missing = configFixture();
    delete missing.max_turns;
    expect(() => parseTaskInventoryGeneration(generationFixture({
      tasks: [taskFixture({ config: missing })],
    }))).toThrow(/tasks\[0\]\.config\.max_turns is required; send 'unknown'/);
  });

  it("rejects an unexpected key inside v2 config", () => {
    expect(() => parseTaskInventoryGeneration(generationFixture({
      tasks: [taskFixture({ config: { ...configFixture(), surprise: true } })],
    }))).toThrow(/tasks\[0\]\.config has unknown field\(s\): surprise/);
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
    expect(() => parseTaskInventoryGeneration(generationFixture({ schema: "executor-inventory@4" })))
      .toThrow(/unsupported schema 'executor-inventory@4'/);
  });

  it("keeps already-ingested v2 generations readable during rollout", () => {
    const legacyTask = taskFixture();
    legacyTask.activation = { config_enabled: true, locally_activated: true };
    const parsed = parseTaskInventoryGeneration(generationFixture({
      schema: TASK_INVENTORY_SCHEMA_V2,
      tasks: [legacyTask],
    }));
    expect(parsed.schema).toBe(TASK_INVENTORY_SCHEMA_V2);
    expect(parsed.executor).not.toHaveProperty("health");
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

  it("rejects invalid timestamp types cleanly", () => {
    const badValues = ["1786650000000", 1.5, null, {}, Number.NaN, Number.POSITIVE_INFINITY];
    for (const value of badValues) {
      expect(() => parseTaskInventoryGeneration(generationFixture({ observed_at: value })))
        .toThrow(TaskInventoryValidationError);
      expect(() => parseTaskInventoryGeneration(generationFixture({
        tasks: [taskFixture({
          bundle: { ...(taskFixture().bundle as object), deployed_at: value },
        })],
      }))).toThrow(TaskInventoryValidationError);
    }
  });

  it("handles a large invalid task array as a clean 400-class validation failure", () => {
    const tasks = Array.from({ length: 2_500 }, (_, index) => taskFixture({
      task_id: `task-${index}`,
      display_name: `Task ${index}`,
    }));
    tasks[tasks.length - 1].constructor = "unknown-field";
    try {
      parseTaskInventoryGeneration(generationFixture({ tasks }));
      throw new Error("expected a validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(TaskInventoryValidationError);
      expect((error as Error).message).toMatch(
        /tasks\[2499\] has unknown field\(s\): constructor/,
      );
    }
  });

  it("rejects an empty capability token instead of silently dropping it", () => {
    expect(() => parseTaskInventoryGeneration(generationFixture({
      executor: { name: "agent-schedule", version: "1", capabilities: ["cron", "  "] },
    }))).toThrow(/executor\.capabilities\[1\] must be a non-empty string/);
  });

  it("accepts an empty task set and a future observation explicitly", () => {
    const parsed = parseTaskInventoryGeneration(generationFixture({
      observed_at: NOW + HOUR,
      tasks: [],
    }));
    expect(parsed.tasks).toEqual([]);
    expect(deriveExecutorFreshness(parsed.observed_at, NOW)).toBe("unknown");
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

  it("breaks equal observation and receipt timestamps by newest rowid", () => {
    const receipts = Array.from({ length: 51 }, (_, index) =>
      store(parseTaskInventoryGeneration(generationFixture({
        executor: { name: "agent-schedule", version: `${index}`, capabilities: ["cron"] },
      })), NOW));

    const retainedIds = db.prepare(
      `SELECT id
         FROM task_inventory_generations
        WHERE executor_name = ?
        ORDER BY rowid ASC`,
    ).all("agent-schedule") as Array<{ id: string }>;
    expect(retainedIds.map((row) => row.id)).toEqual(
      receipts.slice(1).map((receipt) => receipt.generation_id),
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

  it("keeps a renamed executor as a distinct identity", () => {
    store(parseTaskInventoryGeneration(generationFixture()), NOW);
    store(parseTaskInventoryGeneration(generationFixture({
      executor: { name: "agent-schedule-v2", version: "2", capabilities: [] },
      observed_at: NOW + HOUR,
    })), NOW + HOUR);
    const view = getTaskInventoryView(db, { now: NOW + HOUR });
    expect(view.executors.map((entry) => entry.name)).toEqual([
      "agent-schedule",
      "agent-schedule-v2",
    ]);
  });

  it("projects a few thousand receipts within a UI-poll budget", () => {
    const insert = db.prepare(
      `INSERT INTO task_inventory_generations (
         id, digest, schema_id, executor_name, executor_version, capabilities_json,
         observed_at, task_count, payload_json, posted_by_user_id, created_at
       ) VALUES (?, ?, ?, ?, ?, '[]', ?, 0, ?, ?, ?)`,
    );
    db.transaction(() => {
      for (let index = 0; index < 4_000; index += 1) {
        const executor = `executor-${index % 20}`;
        const observedAt = NOW + index;
        const payload = parseTaskInventoryGeneration(generationFixture({
          executor: { name: executor, version: "1", capabilities: [] },
          observed_at: observedAt,
          tasks: [],
        }));
        insert.run(
          `generation-${index}`,
          `digest-${index}`,
          TASK_INVENTORY_SCHEMA,
          executor,
          "1",
          observedAt,
          JSON.stringify(payload),
          publisherId,
          observedAt,
        );
      }
    })();

    const started = performance.now();
    const view = getTaskInventoryView(db, { now: NOW + 4_000 });
    const elapsedMs = performance.now() - started;
    expect(view.executors).toHaveLength(20);
    expect(view.tasks).toEqual([]);
    expect(elapsedMs).toBeLessThan(1_000);
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
