import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MANAGED_REMINDER_SCHEMA } from "../src/contracts.js";
import { migrate, type Db } from "../src/db.js";
import { parseManagedReminderCreateRequest } from "../src/managed-reminder-parser.js";
import { startManagedReminderScheduler, stopManagedReminderScheduler } from "../src/managed-reminder-scheduler.js";
import { createManagedReminder, getManagedReminder } from "../src/managed-reminders.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { createUser } from "../src/users/store.js";

const NOW = Date.parse("2026-08-14T12:00:00Z");
let db: Db;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  db = new SqliteDatabase(":memory:");
  migrate(db);
});

afterEach(() => {
  stopManagedReminderScheduler();
  db.close();
  vi.useRealTimers();
});

describe("managed reminder scheduler", () => {
  it("reconciles at startup and on the minute cadence", async () => {
    const user = createUser(db, { slug: "scheduler-agent", kind: "agent", display_name: "Scheduler Agent" }, NOW);
    const project = resolveProjectForCheckout(db, {
      root: "/tmp/reminder-scheduler",
      name: "scheduler-project",
      remoteUrl: "https://example.test/scheduler.git",
      defaultBranch: "develop",
    }, NOW).project;
    const request = parseManagedReminderCreateRequest({
      schema: MANAGED_REMINDER_SCHEMA,
      idempotency_key: "scheduler-key",
      project: "scheduler-project",
      message: "Minute boundary",
      predicate: { kind: "at", at: "2026-08-14T12:01:00Z" },
    });
    const created = createManagedReminder(
      db,
      request,
      { userId: user.id, evidenceMethod: "api_token" },
      { now: NOW, projectId: project.id },
    );
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
    startManagedReminderScheduler(
      db,
      (_level, event, fields) => logs.push({ event, fields }),
      { startupDelayMs: 0, intervalMs: 60_000 },
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(getManagedReminder(db, created.reminder.id).lifecycle).toBe("armed");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getManagedReminder(db, created.reminder.id).lifecycle).toBe("completed");
    expect(logs).toContainEqual(expect.objectContaining({ event: "managed_reminder_reconcile" }));
  });
});
