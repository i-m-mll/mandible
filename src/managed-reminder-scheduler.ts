import { MANAGED_REMINDER_EVENTS } from "./contracts.js";
import type { Db } from "./db.js";
import { reconcileManagedReminders } from "./managed-reminders.js";
import { broadcast } from "./sse.js";

let interval: ReturnType<typeof setInterval> | null = null;
let startup: ReturnType<typeof setTimeout> | null = null;

export function startManagedReminderScheduler(
  db: Db,
  log: (level: "info" | "warn", event: string, fields: Record<string, unknown>) => void,
  options: { intervalMs?: number; startupDelayMs?: number } = {},
): void {
  stopManagedReminderScheduler();
  const run = () => {
    try {
      const result = reconcileManagedReminders(db);
      if (result.fired > 0) {
        log("info", "managed_reminder_reconcile", { subsystem: "managed-reminders", ...result });
        for (const taskId of result.task_ids) {
          broadcast(MANAGED_REMINDER_EVENTS.changed, { task_id: taskId, lifecycle: "completed" });
          broadcast(MANAGED_REMINDER_EVENTS.occurred, { task_id: taskId });
        }
      }
    } catch (error) {
      log("warn", "managed_reminder_reconcile_failed", {
        subsystem: "managed-reminders",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  startup = setTimeout(run, options.startupDelayMs ?? 0);
  interval = setInterval(run, options.intervalMs ?? 60_000);
  startup.unref?.();
  interval.unref?.();
}

export function stopManagedReminderScheduler(): void {
  if (startup) {
    clearTimeout(startup);
    startup = null;
  }
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}
