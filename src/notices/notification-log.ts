import type { z } from "zod";
import type { Db } from "../db.js";
import type { NoticeProvider, NotificationRecord, NotificationSubjectKind, NOTIFICATION_LIST_QUERY } from "./contract.js";

/** The entity a notification's subject opens in the app. */
export type NotificationTarget =
  | { kind: "auth_request"; id: string }
  | { kind: "conversation"; id: string }
  | { kind: "reminder"; id: string };

export type NotificationListItem = NotificationRecord & { target: NotificationTarget | null };

export interface NotificationListResponse {
  notifications: NotificationListItem[];
  /** `before` for the next older page; null when this page is the last. */
  next_before: number | null;
}

const DEFAULT_PAGE = 100;

interface NotificationRow {
  id: string;
  subject_kind: NotificationSubjectKind;
  subject_id: string;
  recipient_kind: "session" | "user";
  recipient_provider: NoticeProvider | null;
  recipient_id: string;
  responsible_agent_ref: string | null;
  raised_at: number;
  delivered_at: number | null;
  text: string | null;
  target_auth_request: string | null;
  target_conversation: string | null;
}

const SELECT = `SELECT n.*,
    CASE n.subject_kind WHEN 'auth_request' THEN n.subject_id WHEN 'convergence_failure' THEN alert.auth_request_id END AS target_auth_request,
    CASE n.subject_kind WHEN 'credential_leak' THEN json_extract(leak.data_json, '$.conversation_id') END AS target_conversation
  FROM notifications n
  LEFT JOIN auth_hook_alerts alert ON n.subject_kind = 'convergence_failure' AND alert.id = n.subject_id
  LEFT JOIN webhook_events leak ON n.subject_kind = 'credential_leak' AND leak.id = n.subject_id`;

function target(row: NotificationRow): NotificationTarget | null {
  if (row.target_auth_request) return { kind: "auth_request", id: row.target_auth_request };
  if (row.target_conversation) return { kind: "conversation", id: row.target_conversation };
  if (row.subject_kind === "reminder") return { kind: "reminder", id: row.subject_id };
  return null;
}

function item(row: NotificationRow): NotificationListItem {
  return {
    id: row.id,
    subject: { kind: row.subject_kind, id: row.subject_id },
    recipient: row.recipient_kind === "user"
      ? { kind: "user", user_id: row.recipient_id }
      : {
          kind: "session",
          provider: row.recipient_provider as NoticeProvider,
          session_id: row.recipient_id,
          responsible_agent_ref: row.responsible_agent_ref as string,
        },
    raised_at: row.raised_at,
    delivered_at: row.delivered_at,
    text: row.text,
    target: target(row),
  };
}

/** The log, newest first, one page at a time. */
export function listNotifications(db: Db, query: z.infer<typeof NOTIFICATION_LIST_QUERY>): NotificationListResponse {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (query.recipient_kind) {
    clauses.push("n.recipient_kind = ?");
    params.push(query.recipient_kind);
  }
  if (query.undelivered) clauses.push(query.undelivered === "true" ? "n.delivered_at IS NULL" : "n.delivered_at IS NOT NULL");
  if (query.before !== undefined) {
    clauses.push("n.raised_at < ?");
    params.push(query.before);
  }
  const limit = query.limit ?? DEFAULT_PAGE;
  const rows = db.prepare(
    `${SELECT}${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY n.raised_at DESC, n.id DESC LIMIT ?`,
  ).all(...params, limit + 1) as NotificationRow[];
  const page = rows.slice(0, limit);
  return {
    notifications: page.map(item),
    next_before: rows.length > limit ? page[page.length - 1].raised_at : null,
  };
}

export type ReadMarkResult =
  | { ok: true; notification: NotificationListItem; changed: boolean }
  | { ok: false; error: "not_found" | "not_user_notification" };

/** The user's read mark. Reading again keeps the first mark. */
export function markUserNotificationRead(db: Db, id: string, now: number = Date.now()): ReadMarkResult {
  const recipient = db.prepare("SELECT recipient_kind FROM notifications WHERE id = ?").get(id) as
    { recipient_kind: string } | undefined;
  if (!recipient) return { ok: false, error: "not_found" };
  if (recipient.recipient_kind !== "user") return { ok: false, error: "not_user_notification" };
  const changed = db.prepare(
    "UPDATE notifications SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL",
  ).run(now, id).changes > 0;
  const row = db.prepare(`${SELECT} WHERE n.id = ?`).get(id) as NotificationRow;
  return { ok: true, notification: item(row), changed };
}

export interface ReadAllResult {
  ids: string[];
  read_at: number;
}

/** Marks every unread notification for the user read at one time. */
export function markUserNotificationsRead(db: Db, userId: string, now: number = Date.now()): ReadAllResult {
  const ids = (db.prepare(
    "UPDATE notifications SET delivered_at = ? WHERE recipient_kind = 'user' AND recipient_id = ? AND delivered_at IS NULL RETURNING id",
  ).all(now, userId) as Array<{ id: string }>).map((row) => row.id);
  return { ids, read_at: now };
}
