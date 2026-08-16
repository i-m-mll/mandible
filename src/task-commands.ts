// Immutable operator task commands and append-only executor testimony.
// task-command@1 remains byte-compatible for disable during the v2 rollout.

import { createHash, randomUUID } from "node:crypto";

import {
  TASK_COMMAND_EVENT_SCHEMA,
  TASK_COMMAND_EVENT_SCHEMA_V1,
  TASK_COMMAND_SCHEMA,
  TASK_COMMAND_SCHEMA_V1,
  type EmptyPayload,
  type ExecutionHashPayload,
  type TaskCommand,
  type TaskCommandCreateRequest,
  type TaskCommandEvent,
  type TaskCommandExecutorEventRequest,
  type TaskCommandEventType,
  type TaskCommandFailureClass,
  type TaskCommandMutationResult,
  type TaskCommandPolicyGate,
  type TaskCommandProgressSequence,
  type TaskCommandProgressStep,
  type TaskCommandRejectionReason,
  type TaskCommandSchema,
  type TaskCommandState,
  type TaskCommandVerb,
} from "./contracts.js";
import { getDb, type Db } from "./db.js";

const SHA256_RE = /^[0-9a-f]{64}$/;
const REJECTION_REASONS: readonly TaskCommandRejectionReason[] = [
  "unknown_task",
  "unsupported_verb",
  "invalid_payload",
  "stale_target",
  "busy",
  "missing_receipt",
  "stale_receipt",
  "policy_refused",
  "dry_run_failed",
  "unknown",
];
const V1_REJECTION_REASONS: readonly TaskCommandRejectionReason[] = [
  "unknown_task",
  "unsupported_verb",
  "invalid_payload",
  "stale_target",
  "policy_refused",
  "unknown",
];
const FAILURE_CLASSES: readonly TaskCommandFailureClass[] = [
  "budget", "collector", "config", "containment", "limit", "output-source",
  "runner", "schema", "stale", "supervisor", "timeout", "unavailable", "validation",
];
// Closed on this side too. An unrecognized value is refused rather than stored:
// "a member a future executor added" is indistinguishable at this boundary from
// "a string that should never have been sent", and storing the latter is exactly
// the path leak the closed enumeration exists to prevent.
const POLICY_GATES: readonly TaskCommandPolicyGate[] = [
  "kill_switch", "no_bundle", "unprotected", "tampered", "misbound", "unreadable_config",
];
const PROGRESS_PAIRS = Object.freeze([
  [1, "preflight_passed"],
  [2, "collector_started"],
  [3, "snapshot_validated"],
  [4, "runner_started"],
  [5, "runner_completed"],
  [6, "output_validated"],
] as const);

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
  schema_id: TaskCommandSchema;
  request_key: string;
  request_digest: string;
  executor_name: string;
  task_id: string;
  verb: TaskCommandVerb;
  payload_json: string;
  requested_by_user_id: string;
  requested_by_slug: string | null;
  requested_at: number;
};

type EventRow = {
  id: string;
  command_id: string;
  schema_id: typeof TASK_COMMAND_EVENT_SCHEMA_V1 | typeof TASK_COMMAND_EVENT_SCHEMA;
  event_ordinal: number;
  event_digest: string;
  event_type: TaskCommandEventType;
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
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
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
  const base = {
    request_key: nonEmptyString(record.request_key, "request_key"),
    executor: nonEmptyString(record.executor, "executor"),
    task_id: nonEmptyString(record.task_id, "task_id"),
  };
  const payload = objectAt(record.payload, "payload");

  if (record.schema === TASK_COMMAND_SCHEMA_V1) {
    if (record.verb !== "disable") {
      throw new TaskCommandError("task-command@1 permits only verb 'disable'");
    }
    rejectUnknownKeys(payload, [], "payload");
    return { ...base, schema: TASK_COMMAND_SCHEMA_V1, verb: "disable", payload: {} };
  }
  if (record.schema !== TASK_COMMAND_SCHEMA) {
    throw new TaskCommandError(
      `unsupported schema '${String(record.schema)}'; expected '${TASK_COMMAND_SCHEMA_V1}' or '${TASK_COMMAND_SCHEMA}'`,
    );
  }
  if (record.verb === "disable") {
    rejectUnknownKeys(payload, [], "payload");
    return { ...base, schema: TASK_COMMAND_SCHEMA, verb: "disable", payload: {} };
  }
  if (record.verb !== "dry_run" && record.verb !== "enable") {
    throw new TaskCommandError("verb must be one of: disable, dry_run, enable");
  }
  rejectUnknownKeys(payload, ["execution_hash"], "payload");
  const executionHash = digestString(payload.execution_hash, "payload.execution_hash");
  return {
    ...base,
    schema: TASK_COMMAND_SCHEMA,
    verb: record.verb,
    payload: { execution_hash: executionHash },
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

type CanonicalExecutorEvent =
  | { event: "accepted" }
  | { event: "started"; execution_hash: string; run_id: string }
  | {
      event: "progress";
      sequence: TaskCommandProgressSequence;
      step: TaskCommandProgressStep;
    }
  | { event: "applied"; no_op: boolean }
  | { event: "applied"; execution_hash: string; no_op: boolean }
  | { event: "applied"; execution_hash: string; run_id: string }
  // The gate-less arm still covers `policy_refused`: a task-command-event@1
  // rejection never carries a gate, and neither does a v2 one from an executor
  // predating the field. Such an event digests as {command_id,event,reason},
  // exactly as it always did.
  | { event: "rejected"; reason: Exclude<TaskCommandRejectionReason, "dry_run_failed"> }
  // `policy_gate` follows `reason` in the canonical object.
  | { event: "rejected"; reason: "policy_refused"; policy_gate: TaskCommandPolicyGate }
  | { event: "rejected"; reason: "dry_run_failed"; failure_class: TaskCommandFailureClass };

export function taskCommandEventDigest(commandId: string, event: CanonicalExecutorEvent): string {
  return sha256({ command_id: commandId, ...event });
}

function expectedEventSchema(command: Pick<TaskCommand, "schema">):
  typeof TASK_COMMAND_EVENT_SCHEMA_V1 | typeof TASK_COMMAND_EVENT_SCHEMA {
  return command.schema === TASK_COMMAND_SCHEMA_V1
    ? TASK_COMMAND_EVENT_SCHEMA_V1
    : TASK_COMMAND_EVENT_SCHEMA;
}

export function parseTaskCommandExecutorEvent(
  command: Pick<TaskCommand, "id" | "schema" | "verb">,
  body: unknown,
): TaskCommandExecutorEventRequest {
  const record = objectAt(body, "request body");
  const event = nonEmptyString(record.event, "event");
  const expectedSchema = expectedEventSchema(command);
  if (record.schema !== expectedSchema) {
    throw new TaskCommandError(
      `event schema must be '${expectedSchema}' for command schema '${command.schema}'`,
    );
  }

  let canonical: CanonicalExecutorEvent;
  if (event === "accepted") {
    rejectUnknownKeys(record, ["schema", "event", "event_digest"], "request body");
    canonical = { event: "accepted" };
  } else if (event === "started") {
    if (command.schema !== TASK_COMMAND_SCHEMA || command.verb !== "dry_run") {
      throw new TaskCommandError("started is permitted only for a task-command@2 dry_run");
    }
    rejectUnknownKeys(
      record,
      ["schema", "event", "event_digest", "execution_hash", "run_id"],
      "request body",
    );
    canonical = {
      event: "started",
      execution_hash: digestString(record.execution_hash, "execution_hash"),
      run_id: nonEmptyString(record.run_id, "run_id"),
    };
  } else if (event === "progress") {
    if (command.schema !== TASK_COMMAND_SCHEMA || command.verb !== "dry_run") {
      throw new TaskCommandError("progress is permitted only for a task-command@2 dry_run");
    }
    rejectUnknownKeys(
      record,
      ["schema", "event", "event_digest", "sequence", "step"],
      "request body",
    );
    const pair = PROGRESS_PAIRS.find(([sequence]) => sequence === record.sequence);
    if (!pair || pair[1] !== record.step) {
      throw new TaskCommandError("progress sequence and step must be one of the six fixed pairs");
    }
    canonical = { event: "progress", sequence: pair[0], step: pair[1] };
  } else if (event === "applied") {
    if (command.verb === "disable") {
      rejectUnknownKeys(
        record,
        ["schema", "event", "event_digest", "no_op"],
        "request body",
      );
      if (typeof record.no_op !== "boolean") {
        throw new TaskCommandError("no_op must be a boolean for an applied disable event");
      }
      canonical = { event: "applied", no_op: record.no_op };
    } else if (command.verb === "enable") {
      rejectUnknownKeys(
        record,
        ["schema", "event", "event_digest", "execution_hash", "no_op"],
        "request body",
      );
      if (typeof record.no_op !== "boolean") {
        throw new TaskCommandError("no_op must be a boolean for an applied enable event");
      }
      canonical = {
        event: "applied",
        execution_hash: digestString(record.execution_hash, "execution_hash"),
        no_op: record.no_op,
      };
    } else {
      rejectUnknownKeys(
        record,
        ["schema", "event", "event_digest", "execution_hash", "run_id"],
        "request body",
      );
      canonical = {
        event: "applied",
        execution_hash: digestString(record.execution_hash, "execution_hash"),
        run_id: nonEmptyString(record.run_id, "run_id"),
      };
    }
  } else if (event === "rejected") {
    const allowedReasons = command.schema === TASK_COMMAND_SCHEMA_V1
      ? V1_REJECTION_REASONS
      : REJECTION_REASONS;
    if (typeof record.reason !== "string" || !allowedReasons.includes(
      record.reason as TaskCommandRejectionReason,
    )) {
      throw new TaskCommandError(`reason must be one of: ${allowedReasons.join(", ")}`);
    }
    if (record.reason === "dry_run_failed") {
      if (command.verb !== "dry_run") {
        throw new TaskCommandError("dry_run_failed is permitted only for a dry_run command");
      }
      rejectUnknownKeys(
        record,
        ["schema", "event", "event_digest", "reason", "failure_class"],
        "request body",
      );
      if (typeof record.failure_class !== "string" || !FAILURE_CLASSES.includes(
        record.failure_class as TaskCommandFailureClass,
      )) {
        throw new TaskCommandError(`failure_class must be one of: ${FAILURE_CLASSES.join(", ")}`);
      }
      canonical = {
        event: "rejected",
        reason: "dry_run_failed",
        failure_class: record.failure_class as TaskCommandFailureClass,
      };
    } else if (record.reason === "policy_refused"
      && command.schema === TASK_COMMAND_SCHEMA) {
      rejectUnknownKeys(
        record,
        ["schema", "event", "event_digest", "reason", "policy_gate"],
        "request body",
      );
      // Absent is legal: an executor predating this field is still supported,
      // and its event must digest as {command_id,event,reason} exactly as before.
      if (record.policy_gate === undefined) {
        canonical = { event: "rejected", reason: "policy_refused" };
      } else {
        if (typeof record.policy_gate !== "string" || !POLICY_GATES.includes(
          record.policy_gate as TaskCommandPolicyGate,
        )) {
          throw new TaskCommandError(`policy_gate must be one of: ${POLICY_GATES.join(", ")}`);
        }
        canonical = {
          event: "rejected",
          reason: "policy_refused",
          policy_gate: record.policy_gate as TaskCommandPolicyGate,
        };
      }
    } else {
      // Includes a task-command-event@1 policy_refused, which never carries a
      // gate: the v1 executor path produces that reason from no code at all.
      rejectUnknownKeys(
        record,
        ["schema", "event", "event_digest", "reason"],
        "request body",
      );
      canonical = {
        event: "rejected",
        reason: record.reason as Exclude<TaskCommandRejectionReason, "dry_run_failed">,
      };
    }
  } else {
    throw new TaskCommandError(
      "event must be one of: accepted, started, progress, applied, rejected",
    );
  }

  const suppliedDigest = digestString(record.event_digest, "event_digest");
  const expected = taskCommandEventDigest(command.id, canonical);
  if (suppliedDigest !== expected) {
    throw new TaskCommandError(
      "event_digest does not match the canonical command event",
      409,
      "event_digest_conflict",
    );
  }
  const parsed = { schema: expectedSchema, event_digest: suppliedDigest, ...canonical };
  return parsed as TaskCommandExecutorEventRequest;
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
      ORDER BY e.event_ordinal ASC`,
  ).all(commandId) as EventRow[];
}

function parseStoredObject(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>;
}

function projectCommand(row: RequestRow, events: EventRow[]): TaskCommand {
  const projectedEvents: TaskCommandEvent[] = events.map((event) => ({
    id: event.id,
    schema: event.schema_id,
    event: event.event_type,
    event_digest: event.event_digest,
    payload: parseStoredObject(event.payload_json),
    actor_user_id: event.actor_user_id,
    actor_slug: event.actor_slug,
    created_at: event.created_at,
  }));
  const terminal = projectedEvents.find((event) =>
    event.event === "applied" || event.event === "rejected" || event.event === "cancelled");
  const started = projectedEvents.find((event) => event.event === "started");
  const accepted = projectedEvents.find((event) => event.event === "accepted");
  const state: TaskCommandState = terminal
    ? terminal.event as "applied" | "rejected" | "cancelled"
    : started
      ? "started"
      : accepted
        ? "accepted"
        : "requested";
  const payload = parseStoredObject(row.payload_json) as EmptyPayload | ExecutionHashPayload;
  const appliedHasNoOp = state === "applied" && (row.verb === "disable" || row.verb === "enable");
  return {
    id: row.id,
    schema: row.schema_id,
    request_key: row.request_key,
    request_digest: row.request_digest,
    executor: row.executor_name,
    task_id: row.task_id,
    verb: row.verb,
    payload,
    requested_by_user_id: row.requested_by_user_id,
    requested_by_slug: row.requested_by_slug,
    requested_at: row.requested_at,
    state,
    no_op: appliedHasNoOp ? terminal?.payload.no_op === true : null,
    rejection_reason: state === "rejected"
      ? (terminal?.payload.reason as TaskCommandRejectionReason | undefined) ?? "unknown"
      : null,
    events: projectedEvents,
  };
}

export function getTaskCommand(db: Db, commandId: string): TaskCommand {
  const row = requestRow(db, commandId);
  if (!row) {
    throw new TaskCommandError("Task command not found.", 404, "task_command_not_found");
  }
  return projectCommand(row, eventRows(db, commandId));
}

export function listTaskCommands(
  db: Db = getDb(),
  filters: {
    executor?: string;
    taskId?: string;
    pendingOnly?: boolean;
    limit?: number | null;
  } = {},
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
  const limit = filters.limit === null
    ? null
    : Math.max(1, Math.min(filters.limit ?? 100, 500));
  const rows = db.prepare(
    `SELECT r.*, u.slug AS requested_by_slug
       FROM task_command_requests AS r
       LEFT JOIN users AS u ON u.id = r.requested_by_user_id
      ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY r.requested_at DESC, r.rowid DESC
      ${limit === null ? "" : "LIMIT ?"}`,
  ).all(...values, ...(limit === null ? [] : [limit])) as RequestRow[];
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
  if (event.event === "started") {
    return { execution_hash: event.execution_hash, run_id: event.run_id };
  }
  if (event.event === "progress") {
    return { sequence: event.sequence, step: event.step };
  }
  if (event.event === "applied") {
    if ("run_id" in event) {
      return { execution_hash: event.execution_hash, run_id: event.run_id };
    }
    if ("execution_hash" in event) {
      return { execution_hash: event.execution_hash, no_op: event.no_op };
    }
    return { no_op: event.no_op };
  }
  if (event.event === "rejected") {
    if (event.reason === "dry_run_failed" && "failure_class" in event) {
      return { reason: event.reason, failure_class: event.failure_class };
    }
    if (event.reason === "policy_refused" && "policy_gate" in event) {
      return { reason: event.reason, policy_gate: event.policy_gate };
    }
    return { reason: event.reason };
  }
  return {};
}

function eventOrdinal(event: TaskCommandExecutorEventRequest): number {
  if (event.event === "accepted") return 0;
  if (event.event === "started") return 1;
  if (event.event === "progress") return event.sequence + 1;
  return 8;
}

export function appendTaskCommandExecutorEvent(
  db: Db,
  commandId: string,
  event: TaskCommandExecutorEventRequest,
  actorUserId: string,
  now = Date.now(),
): TaskCommandMutationResult {
  return db.transaction(() => {
    const before = getTaskCommand(db, commandId);
    const existing = db.prepare(
      "SELECT id FROM task_command_events WHERE command_id = ? AND event_digest = ?",
    ).get(commandId, event.event_digest) as { id: string } | undefined;
    if (existing) return { command: before, stored: false };

    if (before.state === "cancelled" && event.event === "accepted") {
      throw new TaskCommandError(
        "command was cancelled before executor acceptance",
        409,
        "command_cancelled",
      );
    }
    if (before.state === "applied" || before.state === "rejected" || before.state === "cancelled") {
      throw new TaskCommandError(
        `command already has terminal state '${before.state}'`,
        409,
        "terminal_event_conflict",
      );
    }
    if (event.event === "accepted") {
      if (before.state !== "requested") {
        throw new TaskCommandError(
          "command was already accepted with a different event",
          409,
          "accepted_event_conflict",
        );
      }
    } else if (event.event === "started") {
      if (before.state !== "accepted" || before.verb !== "dry_run") {
        throw new TaskCommandError(
          "started requires an accepted dry_run command",
          409,
          "invalid_command_transition",
        );
      }
      if (event.execution_hash !== (before.payload as ExecutionHashPayload).execution_hash) {
        throw new TaskCommandError(
          "started execution_hash does not match the immutable command target",
          409,
          "event_command_mismatch",
        );
      }
    } else if (event.event === "progress") {
      if (before.state !== "started" || before.verb !== "dry_run") {
        throw new TaskCommandError(
          "progress requires a started dry_run command",
          409,
          "invalid_command_transition",
        );
      }
      const progressCount = before.events.filter((row) => row.event === "progress").length;
      if (event.sequence !== progressCount + 1) {
        throw new TaskCommandError(
          "progress must use the next exact sequence and step",
          409,
          "progress_sequence_conflict",
        );
      }
    } else if (event.event === "applied") {
      const valid = before.verb === "dry_run"
        ? before.state === "started"
        : before.state === "accepted";
      if (!valid) {
        throw new TaskCommandError(
          "applied event is not legal in the command's current state",
          409,
          before.state === "requested" ? "command_not_accepted" : "invalid_command_transition",
        );
      }
      if (before.verb !== "disable" && "execution_hash" in event
        && event.execution_hash !== (before.payload as ExecutionHashPayload).execution_hash) {
        throw new TaskCommandError(
          "applied execution_hash does not match the immutable command target",
          409,
          "event_command_mismatch",
        );
      }
      if (before.verb === "dry_run" && "run_id" in event) {
        const startedEvent = before.events.find((row) => row.event === "started");
        if (event.run_id !== startedEvent?.payload.run_id) {
          throw new TaskCommandError(
            "applied run_id does not match the started event",
            409,
            "event_command_mismatch",
          );
        }
      }
    } else if (before.state !== "accepted" && before.state !== "started") {
      throw new TaskCommandError(
        "rejected requires an accepted or started command",
        409,
        "command_not_accepted",
      );
    }

    const payload = eventPayload(event);
    db.prepare(
      `INSERT INTO task_command_events (
         id, command_id, schema_id, event_ordinal, event_digest, event_type,
         payload_json, no_op, rejection_reason, actor_user_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      commandId,
      event.schema,
      eventOrdinal(event),
      event.event_digest,
      event.event,
      JSON.stringify(payload),
      event.event === "applied" && "no_op" in event ? (event.no_op ? 1 : 0) : null,
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
        "a task command can only be cancelled before executor acceptance",
        409,
        "cancel_after_accept_refused",
      );
    }
    const canonical = { event: "cancelled" as const };
    const eventDigest = sha256({ command_id: commandId, ...canonical });
    db.prepare(
      `INSERT INTO task_command_events (
         id, command_id, schema_id, event_ordinal, event_digest, event_type,
         payload_json, no_op, rejection_reason, actor_user_id, created_at
       ) VALUES (?, ?, ?, 8, ?, 'cancelled', '{}', NULL, NULL, ?, ?)`,
    ).run(
      randomUUID(),
      commandId,
      expectedEventSchema(before),
      eventDigest,
      actorUserId,
      now,
    );
    return { command: getTaskCommand(db, commandId), stored: true };
  })();
}
