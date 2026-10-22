import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate, setDb, type Db } from "../src/db.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { createManagedReminder, listManagedReminderOccurrences } from "../src/managed-reminders.js";
import { parseManagedReminderCreateRequest } from "../src/managed-reminder-parser.js";
import { countGlobalInboxBadge, registerInboxRoutes } from "../src/routes/inbox.js";
import { Router } from "../src/server.js";
import { createUser } from "../src/users/store.js";

const NOW = Date.parse("2026-08-14T12:00:00.000Z");

describe("managed reminder Inbox projection", () => {
  let db: Db;
  let router: Router;
  let occurrenceId: string;

  beforeEach(() => {
    db = new SqliteDatabase(":memory:");
    migrate(db);
    setDb(db);
    const userId = createUser(db, {
      slug: "projection-agent",
      kind: "agent",
      display_name: "Projection Agent",
    }, NOW).id;
    const projectId = resolveProjectForCheckout(db, {
      root: "/tmp/reminder-inbox-project",
      name: "reminder-inbox-project",
      remoteUrl: "https://example.test/reminder-inbox-project.git",
      defaultBranch: "develop",
    }, NOW).project.id;
    const created = createManagedReminder(
      db,
      parseManagedReminderCreateRequest({
        schema: "mandible-reminder@1",
        idempotency_key: "inbox-projection",
        project: "reminder-inbox-project",
        message: "Review the durable occurrence",
        predicate: { kind: "at", at: "2026-08-14T11:00:00Z" },
      }),
      { userId, evidenceMethod: "api_token" },
      { now: NOW, projectId },
    );
    occurrenceId = created.reminder.occurrence!.id;
    router = new Router();
    registerInboxRoutes(router, {} as never);
  });

  afterEach(() => db.close());

  it("projects the durable row into scoped and global reads and counts it in the badge", async () => {
    const scoped = await router.invoke({
      method: "GET",
      url: "/api/inbox?repo=reminder-inbox-project",
    });
    const global = await router.invoke({ method: "GET", url: "/api/inbox/global" });

    for (const response of [scoped, global]) {
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        total: 1,
        managed_reminder_occurrences: [{
          id: occurrenceId,
          message: "Review the durable occurrence",
          project_key: "reminder-inbox-project",
          predicate: { kind: "at", at: "2026-08-14T11:00:00.000Z" },
          triggering_evidence: { kind: "at", evaluated_at: NOW },
        }],
      });
    }
    expect(countGlobalInboxBadge(db)).toBe(1);
  });

  it("acknowledges delivery without deleting the occurrence", async () => {
    const ack = await router.invoke({
      method: "POST",
      url: `/api/inbox/managed_reminder_occurrence/${occurrenceId}/ack`,
      body: {},
    });
    expect(ack.status).toBe(200);
    expect(countGlobalInboxBadge(db)).toBe(0);
    expect((await router.invoke({ method: "GET", url: "/api/inbox/global" })).body)
      .toMatchObject({ total: 0, managed_reminder_occurrences: [] });
    expect(listManagedReminderOccurrences(db)).toHaveLength(1);
    expect(listManagedReminderOccurrences(db)[0]).toMatchObject({
      id: occurrenceId,
      acknowledged_by: "manual",
    });
  });
});
