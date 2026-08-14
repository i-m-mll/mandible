// Operator-authored disable commands and executor receipts — issue 548bd73.
//
// Requests are immutable. Lifecycle is a projection over append-only events;
// there is intentionally no state or expiry column to mutate. The route layer
// owns authority checks, while this module owns exact wire validation,
// canonical digests, idempotency, and legal state transitions.

import { createHash, randomUUID } from "node:crypto";

import {
  TASK_COMMAND_EVENT_SCHEMA,
  TASK_COMMAND_SCHEMA,
  type TaskCommand,
  type TaskCommandCreateRequest,
  type TaskCommandEvent,
  type TaskCommandExecutorEventRequest,
  type TaskCommandMutationResult,
  type TaskCommandRejectionReason,
  type TaskCommandState,
} from "./contracts.js";
import { getDb, type Db } from "./db.js";

const REJECTION_REASONS: readonly TaskCommandRejectionReason[] = [
  "unknown_task",
  "unsupported_verb",
  "invalid_payload",
  "stale_target",
  "policy_refused",
  "unknown",
];

export class TaskCommandError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code = "invalid_task_command",
  ) {
    super(message);
    this.name = "TaskCommandError";
  }
}

type RequestRow = {
  id: string;
  schema_id: string;
  request_key: string;
  request_digest: string;
  executor_name: string;
  task_id: string;
  verb: "disable";
  payload_json: string;
  requested_by_user_id: string;
  requested_by_slug: string | null;
  requested_at: number;
};

type EventRow = {
  id: string;
  command_id: string;
  event_digest: string;
  event_type: TaskCommandState;
  payload_json: string;
  no_op: number | null;
  rejection_reason: TaskCommandRejectionReason | null;
  actor_user_id: string;
  actor_slug: string | null;
  created_at: number;
};

function objectAt(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskCommandError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const extras = Object.keys(record).filter((key) => !allowed.includes(key)).sort();
  if (extras.length > 0) {
    throw new TaskCommandError(`${field} has unknown field(s): ${extras.join(", ")}`);
  }
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TaskCommandError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function digestString(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new TaskCommandError(`${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

export function parseTaskCommandCreateRequest(body: unknown): TaskCommandCreateRequest {
  const record = objectAt(body, "request body");
  rejectUnknownKeys(
    record,
    ["schema", "request_key", "executor", "task_id", "verb", "payload"],
    "request body",
  );
  if (record.schema !== TASK_COMMAND_SCHEMA) {
    throw new TaskCommandError(
      `unsupported schema '${String(record.schema)}'; expected '${TASK_COMMAND_SCHEMA}'`,
    );
  }
  if (record.verb !== "disable") {
    throw new TaskCommandError("verb must be 'disable'");
  }
  const payload = objectAt(record.payload, "payload");
  rejectUnknownKeys(payload, [], "payload");
  return {
    schema: TASK_COMMAND_SCHEMA,
    request_key: nonEmptyString(record.request_key, "request_key"),
    executor: nonEmptyString(record.executor, "executor"),
    task_id: nonEmptyString(record.task_id, "task_id"),
    verb: "disable",
    payload: {},
  };
}

/** Digest the immutable command body; request_key is its idempotency key, not content. */
export function taskCommandRequestDigest(request: TaskCommandCreateRequest): string {
  return sha256({
    schema: request.schema,
    executor: request.executor,
    task_id: request.task_id,
    verb: request.verb,
    payload: request.payload,
  });
}

export function taskCommandEventDigest(
  commandId: string,
  event: { event: "accepted" } | { event: "applied"; no_op: boolean }
    | { event: "rejected"; reason: TaskCommandRejectionReason },
): string {
  return sha256({ command_id: commandId, ...event });
}

export function parseTaskCommandExecutorEvent(
  commandId: string,
  body: unknown,
): TaskCommandExecutorEventRequest {
  const record = objectAt(body, "request body");
  const event = nonEmptyString(record.event, "event");
  const allowed = event === "applied"
    ? ["schema", "event", "event_digest", "no_op"]
    : event === "rejected"
      ? ["schema", "event", "event_digest", "reason"]
      : ["schema", "event", "event_digest"];
  rejectUnknownKeys(record, allowed, "request body");
  if (record.schema !== TASK_COMMAND_EVENT_SCHEMA) {
    throw new TaskCommandError(
      `unsupported schema '${String(record.schema)}'; expected '${TASK_COMMAND_EVENT_SCHEMA}'`,
    );
  }
  if (!(["accepted", "applied", "rejected"] as const).includes(
    event as "accepted" | "applied" | "rejected",
  )) {
    throw new TaskCommandError("event must be one of: accepted, applied, rejected");
  }
  const suppliedDigest = digestString(record.event_digest, "event_digest");
  let canonical: { event: "accepted" } | { event: "applied"; no_op: boolean }
    | { event: "rejected"; reason: TaskCommandRejectionReason };
  if (event === "accepted") {
    canonical = { event: "accepted" };
  } else if (event === "applied") {
    if (typeof record.no_op !== "boolean") {
      throw new TaskCommandError("no_op must be a boolean for an applied event");
    }
    canonical = { event: "applied", no_op: record.no_op };
  } else {
    if (typeof record.reason !== "string" || !REJECTION_REASONS.includes(
      record.reason as TaskCommandRejectionReason,
    )) {
      throw new TaskCommandError(`reason must be one of: ${REJECTION_REASONS.join(", ")}`);
    }
    canonical = { event: "rejected", reason: record.reason as TaskCommandRejectionReason };
  }
  const expected = taskCommandEventDigest(commandId, canonical);
  if (suppliedDigest !== expected) {
    throw new TaskCommandError(
      "event_digest does not match the canonical command event",
      409,
      "event_digest_conflict",
    );
  }
  return { schema: TASK_COMMAND_EVENT_SCHEMA, event_digest: suppliedDigest, ...canonical };
}

function requestRow(db: Db, commandId: string): RequestRow | undefined {
  return db.prepare(
    `SELECT r.*, u.slug AS requested_by_slug
       FROM task_command_requests AS r
       LEFT JOIN users AS u ON u.id = r.requested_by_user_id
      WHERE r.id = ?`,
  ).get(commandId) as RequestRow | undefined;
}

function eventRows(db: Db, commandId: string): EventRow[] {
  return db.prepare(
    `SELECT e.*, u.slug AS actor_slug
       FROM task_command_events AS e
       LEFT JOIN users AS u ON u.id = e.actor_user_id
      WHERE e.command_id = ?
      ORDER BY e.created_at ASC, e.rowid ASC`,
  ).all(commandId) as EventRow[];
}

function projectedEventPayload(event: EventRow): Record<string, unknown> {
  if (event.event_type === "applied") return { no_op: event.no_op === 1 };
  if (event.event_type === "rejected") return { reason: event.rejection_reason ?? "unknown" };
  return {};
}

function projectCommand(row: RequestRow, events: EventRow[]): TaskCommand {
  const projectedEvents: TaskCommandEvent[] = events.map((event) => ({
    id: event.id,
    event: event.event_type,
    event_digest: event.event_digest,
    payload: projectedEventPayload(event),
    actor_user_id: event.actor_user_id,
    actor_slug: event.actor_slug,
    created_at: event.created_at,
  }));
  const terminal = projectedEvents.find((event) =>
    event.event === "applied" || event.event === "rejected" || event.event === "cancelled");
  const accepted = projectedEvents.find((event) => event.event === "accepted");
  const state: TaskCommandState = terminal?.event ?? accepted?.event ?? "requested";
  return {
    id: row.id,
    schema: TASK_COMMAND_SCHEMA,
    request_key: row.request_key,
    request_digest: row.request_digest,
    executor: row.executor_name,
    task_id: row.task_id,
    verb: row.verb,
    payload: {},
    requested_by_user_id: row.requested_by_user_id,
    requested_by_slug: row.requested_by_slug,
    requested_at: row.requested_at,
    state,
    no_op: state === "applied" ? terminal?.payload.no_op === true : null,
    rejection_reason: state === "rejected"
      ? terminal?.payload.reason as TaskCommandRejectionReason ?? "unknown"
      : null,
    events: projectedEvents,
  };
}

export function getTaskCommand(
  db: Db,
  commandId: string,
): TaskCommand {
  const row = requestRow(db, commandId);
  if (!row) {
    throw new TaskCommandError("Task command not found.", 404, "task_command_not_found");
  }
  return projectCommand(row, eventRows(db, commandId));
}

export function listTaskCommands(
  db: Db = getDb(),
  filters: { executor?: string; taskId?: string; pendingOnly?: boolean; limit?: number } = {},
): TaskCommand[] {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (filters.executor) {
    clauses.push("r.executor_name = ?");
    values.push(filters.executor);
  }
  if (filters.taskId) {
    clauses.push("r.task_id = ?");
    values.push(filters.taskId);
  }
  if (filters.pendingOnly) {
    clauses.push(`NOT EXISTS (
      SELECT 1 FROM task_command_events AS terminal
       WHERE terminal.command_id = r.id
         AND terminal.event_type IN ('applied','rejected','cancelled')
    )`);
  }
  const limit = Math.max(1, Math.min(filters.limit ?? 100, 500));
  const rows = db.prepare(
    `SELECT r.*, u.slug AS requested_by_slug
       FROM task_command_requests AS r
       LEFT JOIN users AS u ON u.id = r.requested_by_user_id
      ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY r.requested_at DESC, r.rowid DESC
      LIMIT ?`,
  ).all(...values, limit) as RequestRow[];
  return rows.map((row) => projectCommand(row, eventRows(db, row.id)));
}

export function createTaskCommand(
  db: Db,
  request: TaskCommandCreateRequest,
  requestedByUserId: string,
  now = Date.now(),
): TaskCommandMutationResult {
  const digest = taskCommandRequestDigest(request);
  return db.transaction(() => {
    const existing = db.prepare(
      `SELECT id, request_digest FROM task_command_requests
        WHERE requested_by_user_id = ? AND request_key = ?`,
    ).get(requestedByUserId, request.request_key) as
      | { id: string; request_digest: string }
      | undefined;
    if (existing) {
      if (existing.request_digest !== digest) {
        throw new TaskCommandError(
          "request_key was already used for a different command body",
          409,
          "request_key_conflict",
        );
      }
      return { command: getTaskCommand(db, existing.id), stored: false };
    }
    const id = randomUUID();
    db.prepare(
      `INSERT INTO task_command_requests (
         id, schema_id, request_key, request_digest, executor_name, task_id,
         verb, payload_json, requested_by_user_id, requested_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      request.schema,
      request.request_key,
      digest,
      request.executor,
      request.task_id,
      request.verb,
      JSON.stringify(request.payload),
      requestedByUserId,
      now,
    );
    return { command: getTaskCommand(db, id), stored: true };
  })();
}

function eventPayload(event: TaskCommandExecutorEventRequest): Record<string, unknown> {
  if (event.event === "applied") return { no_op: event.no_op };
  if (event.event === "rejected") return { reason: event.reason };
  return {};
}

export function appendTaskCommandExecutorEvent(
  db: Db,
  commandId: string,
  event: TaskCommandExecutorEventRequest,
  actorUserId: string,
  now = Date.now(),
): TaskCommandMutationResult {
  return db.transaction(() => {
    getTaskCommand(db, commandId);
    const existing = db.prepare(
      "SELECT id FROM task_command_events WHERE command_id = ? AND event_digest = ?",
    ).get(commandId, event.event_digest) as { id: string } | undefined;
    if (existing) return { command: getTaskCommand(db, commandId), stored: false };

    const before = getTaskCommand(db, commandId);
    if (before.state === "applied" || before.state === "rejected" || before.state === "cancelled") {
      throw new TaskCommandError(
        `command already has terminal state '${before.state}'`,
        409,
        "terminal_event_conflict",
      );
    }
    if (event.event === "accepted" && before.state !== "requested") {
      throw new TaskCommandError(
        "command was already accepted with a different event",
        409,
        "accepted_event_conflict",
      );
    }
    if (event.event !== "accepted" && before.state !== "accepted") {
      throw new TaskCommandError(
        "a terminal executor event requires an accepted command",
        409,
        "command_not_accepted",
      );
    }
    db.prepare(
      `INSERT INTO task_command_events (
         id, command_id, event_digest, event_type, payload_json, no_op,
         rejection_reason, actor_user_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      commandId,
      event.event_digest,
      event.event,
      JSON.stringify(eventPayload(event)),
      event.event === "applied" ? (event.no_op ? 1 : 0) : null,
      event.event === "rejected" ? event.reason : null,
      actorUserId,
      now,
    );
    return { command: getTaskCommand(db, commandId), stored: true };
  })();
}

export function cancelTaskCommand(
  db: Db,
  commandId: string,
  actorUserId: string,
  now = Date.now(),
): TaskCommandMutationResult {
  return db.transaction(() => {
    const before = getTaskCommand(db, commandId);
    if (before.state === "cancelled") return { command: before, stored: false };
    if (before.state !== "requested") {
      throw new TaskCommandError(
        "a disable request can only be cancelled before executor acceptance",
        409,
        "cancel_after_accept_refused",
      );
    }
    const eventDigest = sha256({ command_id: commandId, event: "cancelled" });
    db.prepare(
      `INSERT INTO task_command_events (
         id, command_id, event_digest, event_type, payload_json, no_op,
         rejection_reason, actor_user_id, created_at
       ) VALUES (?, ?, ?, 'cancelled', '{}', NULL, NULL, ?, ?)`,
    ).run(randomUUID(), commandId, eventDigest, actorUserId, now);
    return { command: getTaskCommand(db, commandId), stored: true };
  })();
}
