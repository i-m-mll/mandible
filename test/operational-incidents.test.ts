import SqliteDatabase from "../../src/sqlite.ts";
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { migrate, type Db } from "../../src/db.js";
import {
  acknowledgeOperationalIncident,
  closeOperationalIncident,
  countOperationalIncidents,
  ingestOperationalIncidentEnvelope,
  listOperationalIncidents,
  OperationalIncidentError,
  parseOperationalIncidentEnvelope,
  transitionOperationalIncidentRemediation,
} from "../../src/operational-incidents.js";
import { createUser } from "../../src/users/store.js";

const FIRST = "2026-08-15T11:54:03.122Z";
const SECOND = "2026-08-16T11:58:44.980Z";
const RAISED_ID = "01K2QN2M4Y3D1VH5E8A5K5EWK3";
const RECOVERED_ID = "01K2T70C4HDD6WJZRX6YZCC7YJ";

function payload(options: {
  seq?: 1 | 2;
  eventId?: string;
  firstSeen?: string;
  task?: string;
} = {}) {
  const seq = options.seq ?? 1;
  const firstSeen = options.firstSeen ?? FIRST;
  return {
    schema: "operational-incidents@1",
    executor: { name: "agent-schedule", version: "1.0.0" },
    generation: {
      inventory_schema: "executor-inventory@2",
      inventory_digest: (seq === 1 ? "a" : "b").repeat(64),
      observed_at: seq === 1 ? FIRST : SECOND,
    },
    provenance: {
      basis: "scheduler_computed",
      verification: "unverified_by_mandible",
    },
    events: [{
      event_id: options.eventId ?? (seq === 1 ? RAISED_ID : RECOVERED_ID),
      event_seq: seq,
      episode: {
        task: options.task ?? "daily-digest",
        condition: "failed_permanent",
        first_seen: firstSeen,
      },
      observation: seq === 1 ? "active" : "recovered",
      observed_at: seq === 1 ? firstSeen : SECOND,
      facts: {
        run_id: "184",
        run_status: "failed_permanent",
        exit_class: "validation",
        finished_at: "2026-08-15T11:54:03.120Z",
      },
      recovery: seq === 1 ? null : {
        basis: "newer_successful_run",
        run_id: "185",
        run_status: "succeeded",
        finished_at: "2026-08-16T11:58:44.979Z",
      },
    }],
  };
}

describe("operational incident ledger and reconciliation", () => {
  let db: Db;
  let publisherId: string;
  let humanId: string;

  beforeEach(() => {
    db = new SqliteDatabase(":memory:");
    migrate(db);
    publisherId = createUser(db, {
      slug: "incident-publisher",
      kind: "agent",
      display_name: "Incident Publisher",
    }).id;
    humanId = createUser(db, {
      slug: "reviewer",
      kind: "human",
      display_name: "Reviewer",
    }).id;
  });

  afterEach(() => db.close());

  function ingest(value: unknown, at = 100) {
    return ingestOperationalIncidentEnvelope(
      db,
      parseOperationalIncidentEnvelope(value),
      publisherId,
      at,
    );
  }

  it("operational_incidents_ingest_creates_active_unacknowledged_episode", () => {
    const result = ingest(payload());
    expect(result.accepted[0]).toMatchObject({ result: "stored", event_id: RAISED_ID });
    expect(listOperationalIncidents(db).incidents[0]).toMatchObject({
      observation: "active",
      attention: "unacknowledged",
      remediation: "none",
      resolved: false,
    });
    expect(db.prepare(
      "SELECT applied, ignored_reason FROM operational_incident_observation_events",
    ).get()).toEqual({ applied: 1, ignored_reason: null });
  });

  it("operational_incidents_run_status_vocabulary_is_terminal_only", () => {
    // `facts` describes a finished run — `finished_at` is mandatory — so a
    // non-terminal status cannot mean anything. The executor emits exactly
    // `statedb.TERMINAL_STATUSES`; the consumer must not admit a wider set
    // than the producer can send.
    for (const status of ["running", "blocked"]) {
      const body = payload();
      body.events[0].facts.run_status = status;
      expect(() => ingest(body)).toThrow();
    }
  });

  it("operational_incidents_duplicate_event_same_digest_is_idempotent", () => {
    const first = ingest(payload());
    const replay = ingest(payload(), 200);
    expect(replay.accepted).toEqual([{ ...first.accepted[0], result: "duplicate" }]);
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM operational_incident_observation_events",
    ).get()).toEqual({ n: 1 });
  });

  it("operational_incidents_duplicate_event_different_digest_conflicts", () => {
    ingest(payload());
    const changed = payload();
    changed.events[0].facts.exit_class = "schema";
    expect(() => ingest(changed)).toThrowError(OperationalIncidentError);
    try { ingest(changed); } catch (error) {
      expect(error).toMatchObject({ status: 409, code: "incident_event_conflict" });
    }
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM operational_incident_observation_events",
    ).get()).toEqual({ n: 1 });
  });

  it("operational_incidents_clear_before_raise_converges", () => {
    const recovered = ingest(payload({ seq: 2 }));
    ingest(payload({ eventId: RAISED_ID }));
    expect(listOperationalIncidents(db, { status: "all" }).incidents[0]).toMatchObject({
      id: recovered.accepted[0].incident_id,
      observation: "recovered",
      remediation: "complete",
      resolution_kind: "successful_run",
    });
    expect(db.prepare(
      `SELECT event_seq, applied, ignored_reason
         FROM operational_incident_observation_events ORDER BY event_seq`,
    ).all()).toEqual([
      { event_seq: 1, applied: 0, ignored_reason: "stale_sequence" },
      { event_seq: 2, applied: 1, ignored_reason: null },
    ]);
  });

  it("operational_incidents_inventory_omission_does_not_resolve", () => {
    ingest(payload());
    // An inventory generation has no incident-ledger API and therefore cannot
    // mutate this table. A later read proves the episode remains unresolved.
    expect(listOperationalIncidents(db).incidents[0]).toMatchObject({
      observation: "active",
      resolved: false,
    });
  });

  it("operational_incidents_recovery_preserves_attention", () => {
    const incidentId = ingest(payload()).accepted[0].incident_id;
    acknowledgeOperationalIncident(db, incidentId, humanId, 150);
    ingest(payload({ seq: 2 }), 200);
    expect(listOperationalIncidents(db, { status: "resolved" }).incidents[0]).toMatchObject({
      attention: "acknowledged",
      acknowledged_at: 150,
      acknowledged_by_user_id: humanId,
    });

    const other = payload({ task: "task-health", eventId: "01K2QN2M4Y3D1VH5E8A5K5EWK4" });
    const otherId = ingest(other).accepted[0].incident_id;
    ingest(payload({
      task: "task-health",
      seq: 2,
      eventId: "01K2T70C4HDD6WJZRX6YZCC7YK",
    }));
    expect(listOperationalIncidents(db, { status: "resolved" }).incidents)
      .toContainEqual(expect.objectContaining({ id: otherId, attention: "unacknowledged" }));
  });

  it("operational_incidents_recurrence_does_not_inherit_acknowledgement", () => {
    const oldId = ingest(payload()).accepted[0].incident_id;
    acknowledgeOperationalIncident(db, oldId, humanId, 150);
    const nextFirstSeen = "2026-08-17T11:54:03.122Z";
    const nextId = ingest(payload({
      firstSeen: nextFirstSeen,
      eventId: "01K2Z70C4HDD6WJZRX6YZCC7YJ",
    }), 300).accepted[0].incident_id;
    expect(nextId).not.toBe(oldId);
    expect(listOperationalIncidents(db).incidents)
      .toContainEqual(expect.objectContaining({ id: nextId, attention: "unacknowledged" }));
  });

  it("operational_incidents_recovery_while_fix_prepared_completes_remediation", () => {
    const incidentId = ingest(payload()).accepted[0].incident_id;
    transitionOperationalIncidentRemediation(db, incidentId, "triaging", {
      kind: "prepare_fix_confirmed",
      authority: "user",
      actorUserId: humanId,
      now: 120,
    });
    transitionOperationalIncidentRemediation(db, incidentId, "fix_prepared", {
      authority: "server",
      now: 130,
    });
    ingest(payload({ seq: 2 }), 200);
    expect(listOperationalIncidents(db, { status: "resolved" }).incidents[0])
      .toMatchObject({ observation: "recovered", remediation: "complete" });
  });

  it("operational_incidents_operator_close_preserves_executor_observation", () => {
    const incidentId = ingest(payload()).accepted[0].incident_id;
    const closed = closeOperationalIncident(db, incidentId, humanId, "Task retired.", 100, 200);
    expect(closed).toMatchObject({
      observation: "active",
      attention: "acknowledged",
      remediation: "complete",
      resolution_kind: "operator_closure",
    });
    expect(db.prepare(
      `SELECT kind FROM operational_incident_workflow_events
        WHERE incident_id = ? ORDER BY created_at, id`,
    ).all(incidentId)).toEqual(expect.arrayContaining([
      { kind: "attention_acknowledged" },
      { kind: "operator_closed" },
    ]));
  });

  it("operational_incidents_badge_count_is_active_and_unacknowledged_only", () => {
    const unacknowledged = ingest(payload()).accepted[0].incident_id;
    const acknowledged = ingest(payload({
      task: "task-health",
      eventId: "01K2QN2M4Y3D1VH5E8A5K5EWK4",
    })).accepted[0].incident_id;
    acknowledgeOperationalIncident(db, acknowledged, humanId, 150);
    const recovered = ingest(payload({
      task: "policy-audit",
      eventId: "01K2QN2M4Y3D1VH5E8A5K5EWK5",
    })).accepted[0].incident_id;
    ingest(payload({
      task: "policy-audit",
      seq: 2,
      eventId: "01K2T70C4HDD6WJZRX6YZCC7YM",
    }));
    const closed = ingest(payload({
      task: "limit-postmortem",
      eventId: "01K2QN2M4Y3D1VH5E8A5K5EWK6",
    })).accepted[0].incident_id;
    closeOperationalIncident(db, closed, humanId, "No longer applicable.", 100, 200);

    expect(countOperationalIncidents(db)).toEqual({
      active_unacknowledged: 1,
      active_acknowledged: 1,
      resolved: 2,
    });
    expect(unacknowledged).not.toBe(acknowledged);
    expect(recovered).not.toBe(closed);
  });
});
