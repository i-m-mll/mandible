import fs from "node:fs";

import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  TASK_COMMAND_EVENT_SCHEMA,
  TASK_COMMAND_SCHEMA,
  type TaskActivationHealthFacts,
  type TaskInventoryGeneration,
} from "../src/contracts.js";
import { migrate, type Db } from "../src/db.js";
import {
  ingestOperationalIncidentEnvelope,
  parseOperationalIncidentEnvelope,
} from "../src/operational-incidents.js";
import {
  appendTaskCommandExecutorEvent,
  createTaskCommand,
  parseTaskCommandExecutorEvent,
  taskCommandEventDigest,
} from "../src/task-commands.js";
import {
  countActiveTaskActivationConditions,
  getTaskInventoryView,
  parseTaskInventoryGeneration,
  recordTaskInventoryGeneration,
} from "../src/task-inventory.js";
import { createUser } from "../src/users/store.js";

type ProducerFixtures = {
  producer: { commit: string; fixture_kind: string };
  inventory: Record<string, unknown>;
  incidents: Record<string, unknown>;
};

const FIXTURES = JSON.parse(fs.readFileSync(
  "test/fixtures/dotfiles-cba4353-activation-health.json",
  "utf8",
)) as ProducerFixtures;

describe("dotfiles cba4353 activation-health contract", () => {
  let db: Db;
  let executorId: string;
  let operatorId: string;

  beforeEach(() => {
    db = new SqliteDatabase(":memory:");
    migrate(db);
    executorId = createUser(db, {
      slug: "agent-schedule",
      kind: "agent",
      display_name: "Agent Schedule",
    }).id;
    operatorId = createUser(db, {
      slug: "operator",
      kind: "human",
      display_name: "Operator",
    }).id;
  });

  afterEach(() => db.close());

  function store(body: Record<string, unknown>, now: number): TaskInventoryGeneration {
    const generation = parseTaskInventoryGeneration(body);
    recordTaskInventoryGeneration(db, generation, { postedByUserId: executorId, now });
    return generation;
  }

  function generationWithActivation(
    base: Record<string, unknown>,
    activation: TaskActivationHealthFacts,
    observedAt: number,
  ): Record<string, unknown> {
    const tasks = base.tasks as Array<Record<string, unknown>>;
    return {
      ...base,
      observed_at: observedAt,
      tasks: [{ ...tasks[0], activation }],
    };
  }

  function applyEnable(executionHash: string, now: number): string {
    const request = {
      schema: TASK_COMMAND_SCHEMA,
      request_key: `enable-${executionHash}`,
      executor: "agent-schedule",
      task_id: "task-health",
      verb: "enable" as const,
      payload: { execution_hash: executionHash },
    };
    const command = createTaskCommand(db, request, operatorId, now).command;
    for (const [offset, event] of [
      { event: "accepted" as const },
      { event: "applied" as const, execution_hash: executionHash, no_op: false },
    ].entries()) {
      const body = {
        schema: TASK_COMMAND_EVENT_SCHEMA,
        ...event,
        event_digest: taskCommandEventDigest(command.id, event),
      };
      appendTaskCommandExecutorEvent(
        db,
        command.id,
        parseTaskCommandExecutorEvent(command, body),
        executorId,
        now + offset + 1,
      );
    }
    return command.id;
  }

  it("pins the generated fixtures to the signed producer commit and accepts both v3/v2 envelopes", () => {
    expect(FIXTURES.producer).toMatchObject({
      commit: "cba4353d5845830fb760e219626ced8d0af3bdb0",
      fixture_kind: "generated_from_producer_contract",
    });
    expect(parseTaskInventoryGeneration(FIXTURES.inventory).schema)
      .toBe("executor-inventory@3");
    const incident = parseOperationalIncidentEnvelope(FIXTURES.incidents);
    expect(incident).toMatchObject({
      schema: "operational-incidents@2",
      generation: { inventory_schema: "executor-inventory@3" },
    });
    expect(ingestOperationalIncidentEnvelope(db, incident, executorId).accepted[0].result)
      .toBe("stored");
  });

  it("deduplicates the important condition and resolves only after dry-run readiness plus enable", () => {
    const invalidated = store(FIXTURES.inventory, 100);
    const first = getTaskInventoryView(db, { now: invalidated.observed_at }).tasks[0];
    expect(first.source_kind).toBe("executor");
    if (first.source_kind !== "executor") throw new Error("expected executor task");
    expect(first.activation_condition).toMatchObject({
      attention: "important",
      next_action: "dry_run",
      required_execution_hash: "5".repeat(64),
    });
    expect(countActiveTaskActivationConditions(db)).toBe(1);

    // A later snapshot of the same transition advances recovery without
    // creating a second task/hash notification.
    const firstActivation = invalidated.tasks[0].activation as TaskActivationHealthFacts;
    store(generationWithActivation(
      FIXTURES.inventory,
      { ...firstActivation, required_action: "enable" },
      invalidated.observed_at + 1,
    ), 101);
    expect(getTaskInventoryView(db, { now: invalidated.observed_at + 1 }).tasks[0])
      .toMatchObject({ activation_condition: { next_action: "enable" } });
    expect((db.prepare("SELECT count(*) AS n FROM task_activation_conditions").get() as { n: number }).n)
      .toBe(1);

    const enableId = applyEnable("5".repeat(64), 200);
    // The receipt alone is not recovery; the executor must also report that
    // the task is activated under the current condition.
    expect(getTaskInventoryView(db, { now: invalidated.observed_at + 1 }).tasks[0])
      .toMatchObject({ activation_condition: { state: "active" } });

    const activated = {
      ...firstActivation,
      locally_activated: true,
      state: "activated" as const,
      reason: "operator_enabled" as const,
      changed_at: invalidated.observed_at + 2,
      previous_execution_hash: "5".repeat(64),
      required_execution_hash: "none" as const,
      deployment_commit: "none" as const,
      deployment_content_hash: "none" as const,
      deployed_at: "unknown" as const,
      required_action: "none" as const,
      attention: "none" as const,
    };
    store(generationWithActivation(
      FIXTURES.inventory,
      activated,
      invalidated.observed_at + 2,
    ), 300);

    const recovered = getTaskInventoryView(db, { now: invalidated.observed_at + 2 }).tasks[0];
    expect(recovered).toMatchObject({
      activation_condition: null,
      activation_history: [
        { state: "activated" },
        { state: "deployment_invalidated", facts: { required_action: "enable" } },
        { state: "deployment_invalidated", facts: { required_action: "dry_run" } },
      ],
    });
    expect(db.prepare(
      "SELECT kind, command_id FROM task_activation_condition_events ORDER BY created_at, rowid",
    ).all()).toEqual([
      { kind: "raised", command_id: null },
      { kind: "dry_run_ready", command_id: null },
      { kind: "resolved", command_id: enableId },
    ]);
    expect(countActiveTaskActivationConditions(db)).toBe(0);

    // Complete inventory ordering still governs current state. A delayed old
    // snapshot remains admissible history but cannot resurrect its alert.
    store(generationWithActivation(
      FIXTURES.inventory,
      firstActivation,
      invalidated.observed_at - 1,
    ), 400);
    expect(countActiveTaskActivationConditions(db)).toBe(0);
    expect(getTaskInventoryView(db, { now: invalidated.observed_at + 2 }).tasks[0])
      .toMatchObject({ activation_condition: null, task: { activation: { state: "activated" } } });
  });

  it("fails closed on unknown and malformed v3 records", () => {
    expect(() => parseTaskInventoryGeneration({
      ...FIXTURES.inventory,
      schema: "executor-inventory@4",
    })).toThrow(/unsupported schema/);
    const tasks = FIXTURES.inventory.tasks as Array<Record<string, unknown>>;
    expect(() => parseTaskInventoryGeneration({
      ...FIXTURES.inventory,
      tasks: [{
        ...tasks[0],
        activation: { ...(tasks[0].activation as object), required_execution_hash: "not-a-hash" },
      }],
    })).toThrow(/required_execution_hash/);
    expect(() => parseOperationalIncidentEnvelope({
      ...FIXTURES.incidents,
      schema: "operational-incidents@3",
    })).toThrow(/schema must be/);
  });
});
