import { randomUUID } from "node:crypto";
import { DOMAIN_EVENTS } from "../contracts.js";
import type { Db } from "../db.js";
import { broadcast } from "../sse.js";
import { getOperatorId } from "../users/store.js";
import type { NotificationSubjectKind } from "./contract.js";

/** The facts that raise a notification for the user rather than for a session. */
export type UserNotificationSubject = {
  kind: Exclude<NotificationSubjectKind, "auth_request">;
  id: string;
};

/**
 * Raise the user's notification for a fact, once per subject. The recipient is
 * the configured operator; before one exists nothing is raised, and the
 * start-up pass raises it later from the still-open fact.
 */
export function raiseUserNotification(
  db: Db,
  subject: UserNotificationSubject,
  text: string,
  raisedAt: number = Date.now(),
): boolean {
  const userId = getOperatorId(db);
  if (!userId) return false;
  const id = randomUUID();
  const inserted = db.prepare(
    `INSERT INTO notifications (id, subject_kind, subject_id, recipient_kind, recipient_id, raised_at, text)
     SELECT ?, ?, ?, 'user', ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications
         WHERE subject_kind = ? AND subject_id = ? AND recipient_kind = 'user'
      )`,
  ).run(id, subject.kind, subject.id, userId, raisedAt, text, subject.kind, subject.id);
  if (inserted.changes === 0) return false;
  db.afterCommit(() => broadcast(DOMAIN_EVENTS.NOTIFICATION_CHANGED, { id }));
  return true;
}

/**
 * Raise a notification for every user-facing fact that is still open and has
 * none: a pending credential-leak alert, an unacknowledged convergence alert,
 * an unacknowledged fired reminder. Idempotent; run at start-up.
 */
export function raiseOpenUserNotifications(db: Db): number {
  const open = [
    ...(db.prepare(
      `SELECT 'credential_leak' AS kind, id, COALESCE(title, event_type) AS text, created_at AS raised_at
         FROM webhook_events WHERE event_type = 'credential_leak' AND status = 'pending'`,
    ).all() as OpenFact[]),
    ...(db.prepare(
      `SELECT 'convergence_failure' AS kind, id, detail AS text, created_at AS raised_at
         FROM auth_hook_alerts WHERE acknowledged_at IS NULL`,
    ).all() as OpenFact[]),
    ...(db.prepare(
      `SELECT 'reminder' AS kind, task_id AS id, json_extract(payload_json, '$.message') AS text, created_at AS raised_at
         FROM managed_task_occurrences WHERE acknowledged_at IS NULL`,
    ).all() as OpenFact[]),
  ];
  let raised = 0;
  db.transaction(() => {
    for (const fact of open) {
      if (raiseUserNotification(db, { kind: fact.kind, id: fact.id }, fact.text, fact.raised_at)) raised += 1;
    }
  })();
  return raised;
}

type OpenFact = { kind: UserNotificationSubject["kind"]; id: string; text: string; raised_at: number };

/** Unread notifications for the user: the rail badge. */
export function countUnreadUserNotifications(db: Db): number {
  return Number((db.prepare(
    "SELECT COUNT(*) AS count FROM notifications WHERE recipient_kind = 'user' AND delivered_at IS NULL",
  ).get() as { count: number }).count);
}
