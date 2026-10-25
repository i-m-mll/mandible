import { inlineLedgerReader } from "../src/ledger-reads/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MANAGED_REMINDER_SCHEMA } from "../src/contracts.js";
import { setDb, type Db } from "../src/db.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { parseManagedReminderCreateRequest } from "../src/managed-reminder-parser.js";
import { startManagedReminderScheduler, stopManagedReminderScheduler } from "../src/managed-reminder-scheduler.js";
import {
  cancelManagedReminder,
  createManagedReminder,
  getManagedReminder,
  listManagedReminderOccurrences,
  reconcileManagedReminders,
} from "../src/managed-reminders.js";
import { addGrant, setProjectRestricted } from "../src/permissions/store.js";
import { countGlobalInboxBadge, registerInboxRoutes } from "../src/routes/inbox.js";
import { registerManagedReminderRoutes } from "../src/routes/reminders.js";
import { PRODUCTION_EFFECTS } from "../src/security/effect-policy.js";
import { Router, type ClientAuthGate, type ResolvedClientIdentity } from "../src/server.js";
import { resolveInstanceInfo } from "../src/instance-policy.js";
import { createUser, SYSTEM_USER_ID } from "../src/users/store.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

const NOW = Date.parse("2026-08-14T12:00:00.000Z");
let db: Db;
let projectId: string;
let userId: string;

function request(
  predicate: Record<string, unknown>,
  idempotencyKey = "reminder-key",
  message = "Review the threshold",
) {
  return parseManagedReminderCreateRequest({
    schema: MANAGED_REMINDER_SCHEMA,
    idempotency_key: idempotencyKey,
    project: "reminder-project",
    message,
    predicate,
  });
}

beforeEach(() => {
  db = migratedMemoryDb();
  userId = createUser(db, { slug: "reminder-agent", kind: "agent", display_name: "Reminder Agent" }, NOW).id;
  projectId = resolveProjectForCheckout(db, {
    root: "/tmp/managed-reminder-project",
    name: "reminder-project",
    remoteUrl: "https://example.test/reminder-project.git",
    defaultBranch: "develop",
  }, NOW).project.id;
});

afterEach(() => db.close());

describe("mandible-reminder@1 parser", () => {

  it("admits exactly the three v1 predicates and rejects unknown fields", () => {
    expect(request({ kind: "at", at: "2026-08-14T12:00:00Z" }).predicate.kind).toBe("at");
    expect(request({ kind: "issue_closed", issue: "abc" }).predicate.kind).toBe("issue_closed");
    expect(request({
      kind: "auth_merge_count_gte",
      project: "reminder-project",
      threshold: 2,
    }).predicate.kind).toBe("auth_merge_count_gte");
    expect(() => request({ kind: "cron", expression: "* * * * *" })).toThrow(/must be one of/);
    expect(() => request({ kind: "at", at: "2026-08-14T12:00:00Z", url: "https://example.test" }))
      .toThrow(/unknown field\(s\): url/);
    expect(() => request({
      kind: "auth_merge_count_gte",
      project: "reminder-project",
      threshold: 0,
    })).toThrow(/positive integer/);
  });
});

describe("managed reminder service", () => {
  it("fires an already-satisfied predicate inside creation with immutable provenance", () => {
    const result = createManagedReminder(
      db,
      request({ kind: "at", at: "2026-08-14T07:00:00-04:00" }),
      { userId, evidenceMethod: "api_token" },
      { now: NOW, projectId },
    );
    expect(result).toMatchObject({ stored: true, fired_immediately: true });
    expect(result.reminder.lifecycle).toBe("completed");
    expect(result.reminder.revision.payload.predicate).toEqual({
      kind: "at",
      at: "2026-08-14T11:00:00.000Z",
    });
    expect(result.reminder.occurrence).toMatchObject({
      kind: "inbox_occurrence",
      created_by_user_id: userId,
      fired_by_user_id: SYSTEM_USER_ID,
    });
    expect(listManagedReminderOccurrences(db, { projectId })).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM managed_task_revisions").get())
      .toEqual({ count: 1 });
    expect(db.prepare(
      "SELECT event_type, actor_user_id, evidence_method FROM managed_task_events ORDER BY occurred_at, rowid",
    ).all()).toEqual([
      { event_type: "created", actor_user_id: userId, evidence_method: "api_token" },
      { event_type: "completed", actor_user_id: SYSTEM_USER_ID, evidence_method: "system_internal" },
    ]);
    expect(() => db.prepare("UPDATE managed_task_revisions SET payload_json = '{}' ").run())
      .toThrow(/immutable/);
    expect(() => db.prepare(
      `INSERT INTO managed_task_occurrences (
         id, task_id, revision_id, occurrence_key, kind, payload_json,
         triggering_evidence_json, created_by_user_id, fired_by_user_id, created_at
       ) VALUES ('bad', ?, ?, 'bad', 'webhook', '{}', '{}', ?, ?, ?)`,
    ).run(result.reminder.id, result.reminder.revision.id, userId, SYSTEM_USER_ID, NOW))
      .toThrow();
  });

  it("replays the same idempotency key and conflicts on different canonical bytes", () => {
    const first = createManagedReminder(
      db,
      request({ kind: "at", at: "2026-08-15T12:00:00Z" }),
      { userId, evidenceMethod: "api_token" },
      { now: NOW, projectId },
    );
    const replay = createManagedReminder(
      db,
      request({ kind: "at", at: "2026-08-15T08:00:00-04:00" }),
      { userId, evidenceMethod: "api_token" },
      { now: NOW + 1, projectId },
    );
    expect(replay.stored).toBe(false);
    expect(replay.reminder.id).toBe(first.reminder.id);
    expect(db.prepare("SELECT COUNT(*) AS count FROM managed_tasks").get()).toEqual({ count: 1 });
    expect(() => createManagedReminder(
      db,
      request({ kind: "at", at: "2026-08-16T12:00:00Z" }),
      { userId, evidenceMethod: "api_token" },
      { now: NOW + 2, projectId },
    )).toThrow(/different canonical payload/);
  });

  it("reconciles issue_closed and auth_merge_count_gte as level predicates", () => {
    db.prepare(
      `INSERT INTO ledger_issues (
         id, short_id, project_id, title, body, status, kind, priority,
         author_actor_type, author_display, source, created_at, updated_at, worker_status
       ) VALUES (?, ?, ?, 'Close me', '', 'open', 'feature', 'normal',
                 'mandible_user', 'Agent', 'mandible', ?, ?, 'none')`,
    ).run("issue-canonical", "closeme", projectId, NOW, NOW);
    const issueReminder = createManagedReminder(
      db,
      request({ kind: "issue_closed", issue: "closeme" }, "issue-key"),
      { userId, evidenceMethod: "api_token" },
      { now: NOW, projectId },
    );
    expect(issueReminder.reminder.lifecycle).toBe("armed");
    db.prepare("UPDATE ledger_issues SET status = 'closed', resolution = 'delivered', closed_at = ? WHERE id = ?")
      .run(NOW + 10, "issue-canonical");
    expect(reconcileManagedReminders(db, NOW + 20)).toMatchObject({ fired: 1 });

    db.prepare(
      `INSERT INTO auth_request_merge_succeeded_facts (
         auth_request_id, project_id, base_branch, completed_at, canonical_message, recorded_at
       ) VALUES
         ('merge-1', ?, 'develop', ?, 1, ?),
         ('merge-2', ?, 'main', ?, 1, ?),
         ('merge-3', ?, 'develop', ?, 0, ?)`,
    ).run(projectId, NOW, NOW, projectId, NOW, NOW, projectId, NOW, NOW);
    const authReminder = createManagedReminder(
      db,
      request({
        kind: "auth_merge_count_gte",
        project: "reminder-project",
        base_branch: "develop",
        canonical_message: true,
        threshold: 2,
      }, "auth-key"),
      { userId, evidenceMethod: "api_token" },
      { now: NOW + 30, projectId },
    );
    expect(authReminder.reminder.lifecycle).toBe("armed");
    db.prepare(
      `INSERT INTO auth_request_merge_succeeded_facts
       VALUES ('merge-4', ?, 'develop', ?, 1, ?)`,
    ).run(projectId, NOW + 40, NOW + 40);
    expect(reconcileManagedReminders(db, NOW + 50)).toMatchObject({ fired: 1 });
  });

  it("makes cancel versus fire deterministic by transaction order", () => {
    const cancelled = createManagedReminder(
      db,
      request({ kind: "at", at: "2026-08-15T12:00:00Z" }, "cancel-first"),
      { userId, evidenceMethod: "api_token" },
      { now: NOW, projectId },
    );
    expect(cancelManagedReminder(
      db,
      cancelled.reminder.id,
      { userId, evidenceMethod: "api_token" },
      NOW + 1,
    ).lifecycle).toBe("cancelled");
    expect(reconcileManagedReminders(db, Date.parse("2026-08-16T00:00:00Z")).fired).toBe(0);

    const firesFirst = createManagedReminder(
      db,
      request({ kind: "at", at: "2026-08-15T12:00:00Z" }, "fire-first"),
      { userId, evidenceMethod: "api_token" },
      { now: NOW, projectId },
    );
    expect(reconcileManagedReminders(db, Date.parse("2026-08-16T00:00:00Z")).fired).toBe(1);
    expect(() => cancelManagedReminder(
      db,
      firesFirst.reminder.id,
      { userId, evidenceMethod: "api_token" },
      NOW + 2,
    )).toThrow(/current lifecycle is completed/);
  });
});

describe("managed reminder routes", () => {
  class SlugGate implements ClientAuthGate {
    authenticate(credential: string | null | undefined): ResolvedClientIdentity | null {
      if (!credential) return null;
      const row = db.prepare("SELECT id, slug FROM users WHERE slug = ? AND status = 'active'")
        .get(credential) as { id: string; slug: string } | undefined;
      return row
        ? {
            user_id: row.id,
            slug: row.slug,
            method: "api_token",
            credential_id: null,
            source: "in_process",
            effect_ceiling: PRODUCTION_EFFECTS,
          }
        : null;
    }
    mode(): "compat" { return "compat"; }
    recordUnattributedWrite(): void {}
  }

  it("requires an attributable active user with project write access", async () => {
    setProjectRestricted(db, "reminder-project", true);
    const router = new Router({
      clientAuth: new SlugGate(),
      instance: resolveInstanceInfo({ env: { MANDIBLE_OPERATIONAL_MUTATIONS: "allow" } as NodeJS.ProcessEnv }),
    });
    registerManagedReminderRoutes(router, db);
    const create = (key: string, credential?: string) => router.invoke({
      method: "POST",
      url: "/api/reminders",
      body: {
        schema: MANAGED_REMINDER_SCHEMA,
        idempotency_key: key,
        project: "reminder-project",
        message: "Durable route reminder",
        predicate: { kind: "at", at: "2099-08-15T12:00:00Z" },
      },
      ...(credential ? { credential } : {}),
    });

    expect(await create("anon")).toMatchObject({ status: 401, body: { code: "authentication_required" } });
    expect(await create("denied", "reminder-agent"))
      .toMatchObject({ status: 403, body: { code: "project_permission_required" } });
    addGrant(db, { subject_type: "user", subject: "reminder-agent", resource_type: "project",
      resource: "reminder-project", permission: "write" }, NOW);
    expect(await create("accepted", "reminder-agent"))
      .toMatchObject({ status: 201, body: { stored: true, fired_immediately: false } });
  });

  it("acknowledges an Inbox occurrence without deleting it", async () => {
    setDb(db);
    const created = createManagedReminder(
      db,
      request({ kind: "at", at: "2026-08-14T11:00:00Z" }),
      { userId, evidenceMethod: "api_token" },
      { now: NOW, projectId },
    );
    const occurrenceId = created.reminder.occurrence!.id;
    const router = new Router();
    registerInboxRoutes(router, {} as never, undefined, undefined, inlineLedgerReader());
    expect(countGlobalInboxBadge(db)).toBe(1);

    const ack = await router.invoke({
      method: "POST",
      url: `/api/inbox/managed_reminder_occurrence/${occurrenceId}/ack`,
      body: {},
    });

    expect(ack.status).toBe(200);
    expect(countGlobalInboxBadge(db)).toBe(0);
    expect(listManagedReminderOccurrences(db)).toEqual([
      expect.objectContaining({ id: occurrenceId, acknowledged_by: "manual" }),
    ]);
  });
});

describe("managed reminder scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    stopManagedReminderScheduler();
    vi.useRealTimers();
  });

  it("reconciles at startup and on the minute cadence", async () => {
    const created = createManagedReminder(
      db,
      request({ kind: "at", at: "2026-08-14T12:01:00Z" }, "scheduler-key"),
      { userId, evidenceMethod: "api_token" },
      { now: NOW, projectId },
    );
    startManagedReminderScheduler(db, () => undefined, { startupDelayMs: 0, intervalMs: 60_000 });

    await vi.advanceTimersByTimeAsync(1);
    expect(getManagedReminder(db, created.reminder.id).lifecycle).toBe("armed");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getManagedReminder(db, created.reminder.id).lifecycle).toBe("completed");
  });
});
