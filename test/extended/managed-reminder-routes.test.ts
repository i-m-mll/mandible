import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MANAGED_REMINDER_SCHEMA } from "../../src/contracts.js";
import { migrate, type Db } from "../../src/db.js";
import { FileRpcTransport } from "../../src/file-rpc-transport.js";
import { resolveInstanceInfo } from "../../src/instance-policy.js";
import { resolveProjectForCheckout } from "../../src/ledger/projects.js";
import { addGrant, setProjectRestricted } from "../../src/permissions/store.js";
import { registerManagedReminderRoutes } from "../../src/routes/reminders.js";
import { Router, type ClientAuthGate, type ResolvedClientIdentity } from "../../src/server.js";
import { PRODUCTION_EFFECTS } from "../../src/security/effect-policy.js";
import { addBinding, createUser } from "../../src/users/store.js";

const NOW = Date.parse("2026-08-14T12:00:00Z");
let db: Db;
let router: Router;

class SlugGate implements ClientAuthGate {
  authenticate(
    credential: string | null | undefined,
    source: ResolvedClientIdentity["source"] = "in_process",
  ): ResolvedClientIdentity | null {
    if (!credential) return null;
    const socket = credential.startsWith("socket:");
    const slug = socket ? credential.slice("socket:".length) : credential;
    const row = db.prepare("SELECT id, slug FROM users WHERE slug = ? AND status = 'active'")
      .get(slug) as { id: string; slug: string } | undefined;
    return row
      ? {
          user_id: row.id,
          slug: row.slug,
          method: socket ? "local_socket" : "api_token",
          credential_id: null,
          source: socket ? "local_socket" : source,
          effect_ceiling: PRODUCTION_EFFECTS,
        }
      : null;
  }
  mode(): "compat" { return "compat"; }
  recordUnattributedWrite(): void {}
}

function body(key: string) {
  return {
    schema: MANAGED_REMINDER_SCHEMA,
    idempotency_key: key,
    project: "route-project",
    message: "Durable route reminder",
    predicate: { kind: "at", at: "2099-08-15T12:00:00Z" },
  };
}

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  createUser(db, { slug: "route-agent", kind: "agent", display_name: "Route Agent" }, NOW);
  createUser(db, { slug: "retired-agent", kind: "agent", display_name: "Retired", status: "retired" }, NOW);
  resolveProjectForCheckout(db, {
    root: "/tmp/managed-reminder-route-project",
    name: "route-project",
    remoteUrl: "https://example.test/route-project.git",
    defaultBranch: "develop",
  }, NOW);
  setProjectRestricted(db, "route-project", true);
  router = new Router({
    clientAuth: new SlugGate(),
    instance: resolveInstanceInfo({
      env: { MANDIBLE_OPERATIONAL_MUTATIONS: "allow" } as NodeJS.ProcessEnv,
    }),
  });
  registerManagedReminderRoutes(router, db);
});

afterEach(() => db.close());

describe("managed reminder route admission", () => {
  it("records a socket agent claim without relabeling it as ephemeral", async () => {
    addBinding(db, "route-agent", { binding_type: "provider_session_env", value: "CODEX_THREAD_ID" });
    addGrant(db, { subject_type: "user", subject: "route-agent", resource_type: "project",
      resource: "route-project", permission: "write" }, NOW);
    const ambient_identity = { provider: "codex", provider_session_id: "reminder-agent-session" };
    const created = await router.invoke({ method: "POST", url: "/api/reminders",
      body: body("socket-agent"), credential: "socket:route-agent", ambient_identity });
    expect(created.status).toBe(201);
    const id = (created.body as { reminder: { id: string } }).reminder.id;
    expect(db.prepare("SELECT evidence_method FROM managed_task_events WHERE task_id = ?").get(id))
      .toEqual({ evidence_method: "session_claim" });
    const cancelled = await router.invoke({ method: "POST", url: `/api/reminders/${id}/cancel`,
      body: {}, credential: "socket:route-agent", ambient_identity });
    expect(cancelled.status).toBe(200);
    expect(db.prepare("SELECT evidence_method FROM managed_task_events WHERE task_id = ? AND event_type = 'cancelled'")
      .get(id)).toEqual({ evidence_method: "session_claim" });
  });

  it("requires an attributable active human/agent and project write access", async () => {
    const anonymous = await router.invoke({ method: "POST", url: "/api/reminders", body: body("anon") });
    expect(anonymous).toMatchObject({ status: 401, body: { code: "authentication_required" } });

    const denied = await router.invoke({
      method: "POST",
      url: "/api/reminders",
      body: body("denied"),
      credential: "route-agent",
    });
    expect(denied).toMatchObject({ status: 403, body: { code: "project_permission_required" } });

    addGrant(db, {
      subject_type: "user",
      subject: "route-agent",
      resource_type: "project",
      resource: "route-project",
      permission: "write",
    }, NOW);
    const accepted = await router.invoke({
      method: "POST",
      url: "/api/reminders",
      body: body("accepted"),
      credential: "route-agent",
    });
    expect(accepted).toMatchObject({ status: 201, body: { stored: true, fired_immediately: false } });
  });

  it("enforces the same identity and project-write boundary over file-RPC", async () => {
    addGrant(db, {
      subject_type: "user",
      subject: "route-agent",
      resource_type: "project",
      resource: "route-project",
      permission: "write",
    }, NOW);
    const spool = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-reminder-rpc-"));
    try {
      const transport = new FileRpcTransport({ router, dir: spool });
      for (const entry of [
        { id: "anonymous", capability_token: undefined, key: "rpc-anon" },
        { id: "authorized", capability_token: "route-agent", key: "rpc-ok" },
      ]) {
        fs.writeFileSync(
          path.join(spool, `${entry.id}.request.json`),
          JSON.stringify({
            id: entry.id,
            method: "POST",
            path: "/api/reminders",
            body: body(entry.key),
            ...(entry.capability_token ? { capability_token: entry.capability_token } : {}),
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
        body: { error: "authentication_required", operation: "delivery.background" },
      });
      expect(response("authorized")).toMatchObject({ status: 201, body: { stored: true } });
    } finally {
      fs.rmSync(spool, { recursive: true, force: true });
    }
  });

  it("supports create, show, list, idempotent replay, and cancel", async () => {
    addGrant(db, {
      subject_type: "user",
      subject: "route-agent",
      resource_type: "project",
      resource: "route-project",
      permission: "write",
    }, NOW);
    const create = await router.invoke({
      method: "POST",
      url: "/api/reminders",
      body: body("crud"),
      credential: "route-agent",
    });
    const created = create.body as { reminder: { id: string } };
    expect((await router.invoke({ method: "GET", url: `/api/reminders/${created.reminder.id}` })).status)
      .toBe(200);
    const list = await router.invoke({ method: "GET", url: "/api/reminders?project=route-project&lifecycle=armed" });
    expect(list).toMatchObject({ status: 200, body: { reminders: [{ id: created.reminder.id }] } });
    const replay = await router.invoke({
      method: "POST",
      url: "/api/reminders",
      body: body("crud"),
      credential: "route-agent",
    });
    expect(replay).toMatchObject({ status: 200, body: { stored: false } });
    const cancelled = await router.invoke({
      method: "POST",
      url: `/api/reminders/${created.reminder.id}/cancel`,
      credential: "route-agent",
    });
    expect(cancelled).toMatchObject({ status: 200, body: { reminder: { lifecycle: "cancelled" } } });
  });
});
