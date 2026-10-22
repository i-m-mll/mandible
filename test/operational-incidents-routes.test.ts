import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setSetting } from "../src/client-auth/settings-kv.js";
import { migrate, setDb, type Db } from "../src/db.js";
import { resolveInstanceInfo } from "../src/instance-policy.js";
import { registerAgentDispatchRoutes } from "../src/routes/agent-dispatch.js";
import { registerOperationalIncidentRoutes } from "../src/routes/operational-incidents.js";
import { Router, type ClientAuthGate, type ResolvedClientIdentity } from "../src/server.js";
import { PRODUCTION_EFFECTS } from "../src/security/effect-policy.js";
import { TASK_INVENTORY_EXECUTORS_KEY } from "../src/task-inventory.js";
import { createUser, OPERATOR_SETTING_KEY } from "../src/users/store.js";

const FIRST = "2026-08-15T11:54:03.122Z";

class SlugGate implements ClientAuthGate {
  constructor(private readonly lookup: () => Db) {}

  authenticate(
    credential: string | null | undefined,
    source: ResolvedClientIdentity["source"] = "in_process",
  ): ResolvedClientIdentity | null {
    if (!credential) return null;
    const ephemeral = credential.startsWith("session:");
    const slug = ephemeral ? credential.slice("session:".length) : credential;
    const row = this.lookup().prepare(
      "SELECT id, slug FROM users WHERE slug = ? AND status = 'active'",
    ).get(slug) as { id: string; slug: string } | undefined;
    return row ? {
      user_id: row.id,
      slug: row.slug,
      method: ephemeral ? "ephemeral" : "api_token",
      credential_id: null,
      source,
      effect_ceiling: PRODUCTION_EFFECTS,
    } : null;
  }

  mode(): "compat" { return "compat"; }
  recordUnattributedWrite(): void {}
}

function payload(task = "daily-digest", eventId = "01K2QN2M4Y3D1VH5E8A5K5EWK3") {
  return {
    schema: "operational-incidents@1",
    executor: { name: "agent-schedule", version: "1.0.0" },
    generation: {
      inventory_schema: "executor-inventory@2",
      inventory_digest: "a".repeat(64),
      observed_at: FIRST,
    },
    provenance: { basis: "scheduler_computed", verification: "unverified_by_mandible" },
    events: [{
      event_id: eventId,
      event_seq: 1,
      episode: { task, condition: "failed_permanent", first_seen: FIRST },
      observation: "active",
      observed_at: FIRST,
      facts: {
        run_id: "184",
        run_status: "failed_permanent",
        exit_class: "validation",
        finished_at: "2026-08-15T11:54:03.120Z",
      },
      recovery: null,
    }],
  };
}

describe("operational incident API routes", () => {
  let db: Db;
  let router: Router;
  let publisherId: string;
  let operatorId: string;
  let reviewerId: string;

  beforeEach(() => {
    db = new SqliteDatabase(":memory:");
    migrate(db);
    setDb(db);
    operatorId = createUser(db, {
      slug: "operator",
      kind: "human",
      display_name: "Operator",
    }).id;
    setSetting(db, OPERATOR_SETTING_KEY, operatorId);
    reviewerId = createUser(db, {
      slug: "reviewer",
      kind: "human",
      display_name: "Reviewer",
    }).id;
    publisherId = createUser(db, {
      slug: "agent-schedule",
      kind: "agent",
      display_name: "Agent Schedule",
    }).id;
    createUser(db, { slug: "unmapped-agent", kind: "agent", display_name: "Unmapped" });
    router = new Router({
      clientAuth: new SlugGate(() => db),
      instance: resolveInstanceInfo({
        env: { MANDIBLE_OPERATIONAL_MUTATIONS: "allow" } as NodeJS.ProcessEnv,
      }),
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

  async function createIncident(task = "daily-digest", eventId?: string): Promise<string> {
    const response = await postIngest("agent-schedule", payload(task, eventId));
    return (response.body as { accepted: Array<{ incident_id: string }> }).accepted[0].incident_id;
  }

  it("incident_ingest_requires_mapped_durable_executor", async () => {
    expect((await postIngest()).status).toBe(401);
    expect((await postIngest("session:agent-schedule")).body).toMatchObject({
      code: "executor_credential_required",
    });
    expect((await postIngest("operator")).body).toMatchObject({ code: "executor_agent_required" });
    expect((await postIngest("unmapped-agent")).body).toMatchObject({
      code: "executor_identity_forbidden",
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM operational_incidents").get()).toEqual({ n: 0 });
  });

  it("incident_ingest_records_authenticated_actor_not_payload_actor", async () => {
    const spoofed = { ...payload(), posted_by_user_id: operatorId };
    expect((await postIngest("agent-schedule", spoofed)).status).toBe(400);
    await postIngest("agent-schedule");
    expect(db.prepare("SELECT posted_by_user_id FROM operational_incidents").get())
      .toEqual({ posted_by_user_id: publisherId });
  });

  it("incident_list_orders_active_unacknowledged_before_acknowledged", async () => {
    const acknowledgedId = await createIncident();
    await router.invoke({
      method: "POST",
      url: `/api/operational-incidents/${acknowledgedId}/acknowledge`,
      credential: "reviewer",
      body: { expected_attention: "unacknowledged" },
    });
    const activeId = await createIncident(
      "task-health",
      "01K2QN2M4Y3D1VH5E8A5K5EWK4",
    );
    const response = await router.invoke({ method: "GET", url: "/api/operational-incidents" });
    expect((response.body as { incidents: Array<{ id: string }> }).incidents.map(({ id }) => id))
      .toEqual([activeId, acknowledgedId]);
  });

  it("incident_acknowledge_requires_active_human", async () => {
    const incidentId = await createIncident();
    const agent = await router.invoke({
      method: "POST",
      url: `/api/operational-incidents/${incidentId}/acknowledge`,
      credential: "agent-schedule",
      body: { expected_attention: "unacknowledged" },
    });
    expect(agent.status).toBe(403);
    expect(agent.body).toMatchObject({ code: "human_incident_actor_required" });
  });

  it("incident_acknowledge_is_episode_durable_and_idempotent", async () => {
    const incidentId = await createIncident();
    const request = {
      method: "POST",
      url: `/api/operational-incidents/${incidentId}/acknowledge`,
      credential: "reviewer",
      body: { expected_attention: "unacknowledged" },
    } as const;
    const first = await router.invoke(request);
    const second = await router.invoke(request);
    expect(second.body).toEqual(first.body);
    expect((first.body as { acknowledged_by_user_id: string }).acknowledged_by_user_id)
      .toBe(reviewerId);
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM operational_incident_workflow_events",
    ).get()).toEqual({ n: 1 });
    const listed = await router.invoke({ method: "GET", url: "/api/operational-incidents" });
    expect(listed.body).toMatchObject({
      incidents: [expect.objectContaining({ id: incidentId, attention: "acknowledged" })],
    });
  });

  it("incident_close_requires_operator", async () => {
    const incidentId = await createIncident();
    const updatedAt = (db.prepare(
      "SELECT updated_at FROM operational_incidents WHERE id = ?",
    ).get(incidentId) as { updated_at: number }).updated_at;
    const denied = await router.invoke({
      method: "POST",
      url: `/api/operational-incidents/${incidentId}/close`,
      credential: "reviewer",
      body: { reason: "Task retired.", expected_updated_at: updatedAt },
    });
    expect(denied.body).toMatchObject({ code: "operator_required" });
    const closed = await router.invoke({
      method: "POST",
      url: `/api/operational-incidents/${incidentId}/close`,
      credential: "operator",
      body: { reason: "Task retired.", expected_updated_at: updatedAt },
    });
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({
      incident: { id: incidentId, resolution_kind: "operator_closure" },
    });
  });

  it("incident_mutations_are_file_rpc_denied", () => {
    registerAgentDispatchRoutes(router, db);
    expect(router.resolveFileRpcPolicy("POST", "/api/operational-incidents/ingest")).toBe(true);
    expect(router.resolveFileRpcPolicy("GET", "/api/operational-incidents")).toBe(true);
    expect(router.resolveFileRpcPolicy(
      "POST", "/api/operational-incidents/incident/acknowledge",
    )).toBe(false);
    expect(router.resolveFileRpcPolicy("POST", "/api/operational-incidents/incident/close"))
      .toBe(false);
    expect(router.resolveFileRpcPolicy("POST", "/api/agent-dispatch/preview")).toBe(false);
    expect(router.resolveFileRpcPolicy("POST", "/api/agent-dispatch/dispatch")).toBe(false);
  });

  it("rejects a payload executor that differs from the authenticated mapping", async () => {
    setSetting(db, TASK_INVENTORY_EXECUTORS_KEY, JSON.stringify({ "agent-schedule": ["fleet"] }));
    const response = await postIngest("agent-schedule");
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: "executor_identity_forbidden" });
  });
});
