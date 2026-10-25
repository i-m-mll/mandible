import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "../src/db.js";
import type { EventLoopLagSnapshot } from "../src/daemon-event-loop.js";
import { EVENT_LOOP_STALL_TASK, EventLoopStallIncident } from "../src/event-loop-stall-incident.js";
import {
  closeOperationalIncident,
  getOperationalIncident,
  listOperationalIncidents,
  raiseDaemonIncident,
} from "../src/operational-incidents.js";
import { EVENT_LOOP_STALL_BUDGET_MS } from "../src/runtime-health-contract.js";
import { createUser } from "../src/users/store.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

const WINDOW_MS = 30_000;
const STALL = { maxMs: EVENT_LOOP_STALL_BUDGET_MS + 900, p95Ms: 12, warning: false };
const LAG = { maxMs: 140, p95Ms: 120, warning: true };
const CLEAN = { maxMs: 8, p95Ms: 2, warning: false };

describe("event-loop stall incident", () => {
  let db: Db;
  let errors: unknown[];
  let sequence: number;

  beforeEach(() => {
    db = migratedMemoryDb();
    errors = [];
    sequence = 0;
  });

  afterEach(() => db.close());

  function monitor() {
    return new EventLoopStallIncident(db, (level, message, details) => {
      if (level === "error") errors.push({ message, details });
    });
  }

  function window(shape: { maxMs: number; p95Ms: number; warning: boolean }): EventLoopLagSnapshot {
    sequence += 1;
    const intervalEndedAt = 1_000_000 + sequence * WINDOW_MS;
    return {
      sequence,
      intervalStartedAt: intervalEndedAt - WINDOW_MS,
      intervalEndedAt,
      p50Ms: 1,
      highWaterMs: shape.maxMs,
      backgroundBackoffMs: 0,
      ...shape,
    };
  }

  function stallIncidents() {
    return listOperationalIncidents(db, { status: "all", task: EVENT_LOOP_STALL_TASK }).incidents;
  }

  it("raises one incident for a stall episode and resolves it after two clean windows", () => {
    const stalls = monitor();
    stalls.observe(window(CLEAN));
    expect(stallIncidents()).toHaveLength(0);

    stalls.observe(window(STALL));
    stalls.observe(window(LAG));
    stalls.observe(window(CLEAN));
    stalls.observe(window(STALL));
    const [incident] = stallIncidents();
    expect(stallIncidents()).toHaveLength(1);
    expect(incident).toMatchObject({ resolved: false, executor: "mandible-daemon" });
    expect((incident!.latest_telemetry.event as { facts: { measurements: Record<string, number> } }).facts.measurements).toEqual({
      max_ms: STALL.maxMs,
      p95_ms: STALL.p95Ms,
      budget_ms: EVENT_LOOP_STALL_BUDGET_MS,
      interval_started_at: 1_000_000 + WINDOW_MS,
      interval_ended_at: 1_000_000 + 2 * WINDOW_MS,
    });

    stalls.observe(window(CLEAN));
    expect(getOperationalIncident(db, incident!.id).resolved).toBe(false);
    stalls.observe(window(CLEAN));
    expect(getOperationalIncident(db, incident!.id)).toMatchObject({ resolved: true, resolution_kind: "successful_run" });

    stalls.observe(window(STALL));
    expect(stallIncidents().filter((item) => !item.resolved)).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it("resolves an incident a previous process left open once this one sees two clean windows", () => {
    monitor().observe(window(STALL));
    const [left] = stallIncidents();

    const restarted = monitor();
    restarted.observe(window(CLEAN));
    restarted.observe(window(CLEAN));
    expect(getOperationalIncident(db, left!.id)).toMatchObject({ resolved: true, resolution_kind: "successful_run" });
  });

  it("retries a failed resolution on the next clean window", () => {
    const stalls = monitor();
    stalls.observe(window(STALL));
    const [incident] = stallIncidents();
    db.exec(`CREATE TEMP TRIGGER fail_stall_resolution BEFORE UPDATE ON operational_incidents
      WHEN NEW.resolved_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'SQLITE_BUSY injected'); END`);
    stalls.observe(window(CLEAN));
    stalls.observe(window(CLEAN));
    expect(errors).toHaveLength(1);
    expect(getOperationalIncident(db, incident!.id).resolved).toBe(false);

    db.exec("DROP TRIGGER fail_stall_resolution");
    stalls.observe(window(CLEAN));
    expect(getOperationalIncident(db, incident!.id)).toMatchObject({ resolved: true, resolution_kind: "successful_run" });
    expect(errors).toHaveLength(1);
  });

  it("leaves alone an incident an operator closed and the one that replaced it", () => {
    const operator = createUser(db, { slug: "operator", kind: "human", display_name: "Operator" }).id;
    const stalls = monitor();
    stalls.observe(window(STALL));
    const [held] = stallIncidents();
    closeOperationalIncident(db, held!.id, operator, "Investigated.", getOperationalIncident(db, held!.id).updated_at, 2_000_000);
    const replacement = raiseDaemonIncident(db, { task: EVENT_LOOP_STALL_TASK, exitClass: "budget", observedAt: 2_000_001 }).incident_id;

    stalls.observe(window(CLEAN));
    stalls.observe(window(CLEAN));
    expect(getOperationalIncident(db, held!.id)).toMatchObject({ resolved: true, resolution_kind: "operator_closure" });
    expect(getOperationalIncident(db, replacement).resolved).toBe(false);
    expect(errors).toEqual([]);
  });
});
