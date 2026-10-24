import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setSetting } from "../src/client-auth/settings-kv.js";
import { setDb, type Db } from "../src/db.js";
import { resolveInstanceInfo } from "../src/instance-policy.js";
import { registerOperationalIncidentRoutes } from "../src/routes/operational-incidents.js";
import { PRODUCTION_EFFECTS } from "../src/security/effect-policy.js";
import { Router, type ClientAuthGate, type ResolvedClientIdentity } from "../src/server.js";
import { TASK_INVENTORY_EXECUTORS_KEY } from "../src/task-inventory.js";
import {
  acknowledgeOperationalIncident,
  closeOperationalIncident,
  getOperationalIncident,
  ingestOperationalIncidentEnvelope,
  raiseDaemonIncident,
  resolveDaemonIncident,
  listOperationalIncidents,
  OperationalIncidentError,
  parseOperationalIncidentEnvelope,
} from "../src/operational-incidents.js";
import { createUser, OPERATOR_SETTING_KEY } from "../src/users/store.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

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
    db = migratedMemoryDb();
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

  it("daemon_incident_resolution_touches_only_the_incident_it_raised", () => {
    const task = "runtime-handoff-reconcile/request";
    const first = raiseDaemonIncident(db, { task, exitClass: "runner", observedAt: 1_000 }).incident_id;
    closeOperationalIncident(db, first, humanId, "Handled by hand.", getOperationalIncident(db, first).updated_at, 2_000);
    const second = raiseDaemonIncident(db, { task, exitClass: "runner", observedAt: 3_000 }).incident_id;

    expect(resolveDaemonIncident(db, { incidentId: first, task, observedAt: 4_000 })).toBeNull();
    expect(getOperationalIncident(db, second).resolved).toBe(false);
    expect(resolveDaemonIncident(db, { incidentId: second, task: "auth-idle-convergence", observedAt: 4_000 })).toBeNull();
    expect(resolveDaemonIncident(db, { incidentId: second, task, observedAt: 4_000 })).toEqual({ incident_id: second });
    expect(getOperationalIncident(db, second)).toMatchObject({ resolved: true, resolution_kind: "successful_run" });
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

});

describe("operational incident routes", () => {
  class SlugGate implements ClientAuthGate {
    authenticate(credential: string | null | undefined): ResolvedClientIdentity | null {
      if (!credential) return null;
      const ephemeral = credential.startsWith("session:");
      const slug = ephemeral ? credential.slice("session:".length) : credential;
      const row = db.prepare("SELECT id, slug FROM users WHERE slug = ? AND status = 'active'")
        .get(slug) as { id: string; slug: string } | undefined;
      return row ? {
        user_id: row.id,
        slug: row.slug,
        method: ephemeral ? "ephemeral" : "api_token",
        credential_id: null,
        source: "in_process",
        effect_ceiling: PRODUCTION_EFFECTS,
      } : null;
    }
    mode(): "compat" { return "compat"; }
    recordUnattributedWrite(): void {}
  }

  let db: Db;
  let router: Router;
  let publisherId: string;
  let operatorId: string;

  beforeEach(() => {
    db = migratedMemoryDb();
    setDb(db);
    operatorId = createUser(db, { slug: "operator", kind: "human", display_name: "Operator" }).id;
    setSetting(db, OPERATOR_SETTING_KEY, operatorId);
    createUser(db, { slug: "reviewer", kind: "human", display_name: "Reviewer" });
    publisherId = createUser(db, { slug: "agent-schedule", kind: "agent", display_name: "Agent Schedule" }).id;
    createUser(db, { slug: "unmapped-agent", kind: "agent", display_name: "Unmapped" });
    router = new Router({
      clientAuth: new SlugGate(),
      instance: resolveInstanceInfo({ env: { MANDIBLE_OPERATIONAL_MUTATIONS: "allow" } as NodeJS.ProcessEnv }),
    });
    registerOperationalIncidentRoutes(router, db);
  });

  afterEach(() => db.close());

  function postIngest(credential?: string, body: unknown = payload()) {
    return router.invoke({
      method: "POST",
      url: "/api/operational-incidents/ingest",
      body,
      ...(credential ? { credential } : {}),
    });
  }

  async function createIncident(): Promise<string> {
    const response = await postIngest("agent-schedule");
    return (response.body as { accepted: Array<{ incident_id: string }> }).accepted[0].incident_id;
  }

  it("incident_ingest_requires_mapped_durable_executor", async () => {
    expect((await postIngest()).status).toBe(401);
    expect((await postIngest("session:agent-schedule")).body).toMatchObject({ code: "executor_credential_required" });
    expect((await postIngest("operator")).body).toMatchObject({ code: "executor_agent_required" });
    expect((await postIngest("unmapped-agent")).body).toMatchObject({ code: "executor_identity_forbidden" });
    setSetting(db, TASK_INVENTORY_EXECUTORS_KEY, JSON.stringify({ "agent-schedule": ["fleet"] }));
    expect(await postIngest("agent-schedule")).toMatchObject({ status: 403, body: { code: "executor_identity_forbidden" } });
    expect(db.prepare("SELECT COUNT(*) AS n FROM operational_incidents").get()).toEqual({ n: 0 });
  });

  it("incident_ingest_records_authenticated_actor_not_payload_actor", async () => {
    expect((await postIngest("agent-schedule", { ...payload(), posted_by_user_id: operatorId })).status).toBe(400);
    await postIngest("agent-schedule");
    expect(db.prepare("SELECT posted_by_user_id FROM operational_incidents").get())
      .toEqual({ posted_by_user_id: publisherId });
  });

  it("incident_acknowledge_requires_active_human", async () => {
    const incidentId = await createIncident();
    const agent = await router.invoke({
      method: "POST",
      url: `/api/operational-incidents/${incidentId}/acknowledge`,
      credential: "agent-schedule",
      body: { expected_attention: "unacknowledged" },
    });
    expect(agent).toMatchObject({ status: 403, body: { code: "human_incident_actor_required" } });
  });

  it("incident_close_requires_operator", async () => {
    const incidentId = await createIncident();
    const { updated_at } = db.prepare("SELECT updated_at FROM operational_incidents WHERE id = ?")
      .get(incidentId) as { updated_at: number };
    const close = (credential: string) => router.invoke({
      method: "POST",
      url: `/api/operational-incidents/${incidentId}/close`,
      credential,
      body: { reason: "Task retired.", expected_updated_at: updated_at },
    });
    expect((await close("reviewer")).body).toMatchObject({ code: "operator_required" });
    expect(await close("operator")).toMatchObject({
      status: 200,
      body: { incident: { id: incidentId, resolution_kind: "operator_closure" } },
    });
  });
});
