import { createHash } from "node:crypto";
import type {
  ManagedReminder,
  ManagedReminderCreateRequest,
  ManagedReminderCreateResult,
  ManagedReminderLifecycle,
  ManagedReminderOccurrence,
  ManagedReminderPayload,
} from "./contracts.js";
import { MANAGED_REMINDER_SCHEMA } from "./contracts.js";
import type { Db } from "./db.js";
import {
  evaluateManagedReminder,
  type ReminderDatabaseCapability,
  type ReminderEvaluationEvidence,
} from "./managed-reminder-evaluator.js";
import {
  canonicalReminderPayloadJson,
  ManagedReminderValidationError,
  parseStoredReminderPayload,
} from "./managed-reminder-parser.js";
import { resolveProjectRef } from "./ledger/project-registry.js";
import { LedgerStore } from "./ledger/store.js";
import { SYSTEM_USER_ID } from "./users/store.js";
import { ulid } from "./users/ids.js";
import { resolveId } from "./entity-refs.js";

export class ManagedReminderError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code = "reminder_error") {
    super(message);
    this.name = "ManagedReminderError";
  }
}

type ReminderJoinedRow = {
  id: string;
  project_id: string;
  project_key: string;
  kind: "mandible-reminder";
  lifecycle: ManagedReminderLifecycle;
  created_by_user_id: string;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  cancelled_at: number | null;
  revision_id: string;
  revision_no: 1;
  schema_id: typeof MANAGED_REMINDER_SCHEMA;
  payload_digest: string;
  payload_json: string;
  revision_created_by_user_id: string;
  revision_created_at: number;
};

type OccurrenceRow = {
  id: string;
  task_id: string;
  revision_id: string;
  occurrence_key: string;
  kind: "inbox_occurrence";
  payload_json: string;
  triggering_evidence_json: string;
  created_by_user_id: string;
  fired_by_user_id: string;
  created_at: number;
  acknowledged_by: string | null;
  acknowledged_at: number | null;
};

export function resolveManagedReminderProject(db: Db, ref: string): { id: string; project_key: string } {
  const resolved = resolveProjectRef(db, ref);
  if ((!resolved.ok && resolved.reason === "ambiguous")) {
    throw new ManagedReminderError(`project reference '${ref}' is ambiguous`, 409, "ambiguous_project");
  }
  if (!resolved.ok) {
    throw new ManagedReminderError(`project not found: ${ref}`, 404, "project_not_found");
  }
  return { id: resolved.project.id, project_key: resolved.project.project_key };
}

function canonicalPayload(
  db: Db,
  request: ManagedReminderCreateRequest,
  projectId: string,
): ManagedReminderPayload {
  let predicate: ManagedReminderPayload["predicate"];
  if (request.predicate.kind === "at") {
    predicate = { kind: "at", at: request.predicate.at };
  } else if (request.predicate.kind === "issue_closed") {
    const resolved = new LedgerStore(db).resolveIssueRef(request.predicate.issue, { project_id: projectId });
    if (!resolved.ok) {
      throw new ManagedReminderError(
        resolved.error === "ambiguous" ? "issue reference is ambiguous" : "issue not found",
        resolved.error === "ambiguous" ? 409 : 404,
        resolved.error === "ambiguous" ? "ambiguous_issue" : "issue_not_found",
      );
    }
    predicate = { kind: "issue_closed", issue_id: resolved.id };
  } else {
    const predicateProject = resolveManagedReminderProject(db, request.predicate.project);
    if (predicateProject.id !== projectId) {
      throw new ManagedReminderValidationError(
        "predicate.project must resolve to the reminder's top-level project",
      );
    }
    predicate = {
      kind: "auth_merge_count_gte",
      project_id: predicateProject.id,
      ...(request.predicate.base_branch !== undefined
        ? { base_branch: request.predicate.base_branch }
        : {}),
      ...(request.predicate.canonical_message !== undefined
        ? { canonical_message: request.predicate.canonical_message }
        : {}),
      threshold: request.predicate.threshold,
    };
  }
  return {
    schema: MANAGED_REMINDER_SCHEMA,
    message: request.message,
    predicate,
    effect: { kind: "inbox_occurrence" },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digestRequest(projectId: string, payloadJson: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ project_id: projectId, payload: JSON.parse(payloadJson) }))
    .digest("hex");
}

function occurrenceFromRow(row: OccurrenceRow | undefined): ManagedReminderOccurrence | null {
  if (!row) return null;
  const payload = JSON.parse(row.payload_json) as { message: string };
  return {
    id: row.id,
    task_id: row.task_id,
    revision_id: row.revision_id,
    occurrence_key: row.occurrence_key,
    kind: row.kind,
    message: payload.message,
    triggering_evidence: JSON.parse(row.triggering_evidence_json) as Record<string, unknown>,
    created_by_user_id: row.created_by_user_id,
    fired_by_user_id: row.fired_by_user_id,
    created_at: row.created_at,
    acknowledged_by: row.acknowledged_by,
    acknowledged_at: row.acknowledged_at,
  };
}

/** Read seam for the Inbox projection lane; occurrence rows are the delivery. */
export function listManagedReminderOccurrences(
  db: Db,
  filter: { projectId?: string; acknowledged?: boolean } = {},
): ManagedReminderOccurrence[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.projectId) {
    clauses.push("task.project_id = ?");
    params.push(filter.projectId);
  }
  if (filter.acknowledged === true) clauses.push("occurrence.acknowledged_at IS NOT NULL");
  if (filter.acknowledged === false) clauses.push("occurrence.acknowledged_at IS NULL");
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(
    `SELECT occurrence.*
       FROM managed_task_occurrences occurrence
       JOIN managed_tasks task ON task.id = occurrence.task_id
      ${where}
      ORDER BY occurrence.created_at DESC, occurrence.id DESC`,
  ).all(...params) as OccurrenceRow[];
  return rows.map((row) => occurrenceFromRow(row) as ManagedReminderOccurrence);
}

/** Inbox acknowledgement mutates only delivery state; the occurrence remains durable. */
export function acknowledgeManagedReminderOccurrence(
  db: Db,
  ref: string,
  acknowledgedBy: string,
  now: number = Date.now(),
): ManagedReminderOccurrence {
  const exact = db.prepare("SELECT id FROM managed_task_occurrences WHERE id = ?").get(ref) as
    { id: string } | undefined;
  const matches = exact ? [exact] : db.prepare(
    "SELECT id FROM managed_task_occurrences WHERE id LIKE ? ESCAPE '\\' ORDER BY id LIMIT 2",
  ).all(`${ref.replace(/([%_\\])/g, "\\$1")}%`) as Array<{ id: string }>;
  if (matches.length === 0) {
    throw new ManagedReminderError(`reminder occurrence not found: ${ref}`, 404, "not_found");
  }
  if (matches.length > 1) {
    throw new ManagedReminderError(`reminder occurrence reference is ambiguous: ${ref}`, 409, "ambiguous");
  }
  const id = matches[0].id;
  const result = db.prepare(
    `UPDATE managed_task_occurrences
        SET acknowledged_by = ?, acknowledged_at = ?
      WHERE id = ? AND acknowledged_at IS NULL`,
  ).run(acknowledgedBy, now, id);
  if (result.changes !== 1) {
    throw new ManagedReminderError(`reminder occurrence already acknowledged: ${ref}`, 404, "not_found");
  }
  return occurrenceFromRow(
    db.prepare("SELECT * FROM managed_task_occurrences WHERE id = ?").get(id) as OccurrenceRow,
  ) as ManagedReminderOccurrence;
}

function reminderFromRow(db: Db, row: ReminderJoinedRow): ManagedReminder {
  const occurrence = db.prepare(
    `SELECT * FROM managed_task_occurrences
      WHERE task_id = ? AND revision_id = ?
      ORDER BY created_at, id LIMIT 1`,
  ).get(row.id, row.revision_id) as OccurrenceRow | undefined;
  return {
    id: row.id,
    project_id: row.project_id,
    project_key: row.project_key,
    kind: row.kind,
    lifecycle: row.lifecycle,
    created_by_user_id: row.created_by_user_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
    cancelled_at: row.cancelled_at,
    revision: {
      id: row.revision_id,
      revision_no: row.revision_no,
      schema: row.schema_id,
      payload_digest: row.payload_digest,
      payload: parseStoredReminderPayload(row.payload_json),
      created_by_user_id: row.revision_created_by_user_id,
      created_at: row.revision_created_at,
    },
    occurrence: occurrenceFromRow(occurrence),
  };
}

const REMINDER_SELECT = `
  SELECT task.*, project.project_key,
         revision.id AS revision_id, revision.revision_no, revision.schema_id,
         revision.payload_digest, revision.payload_json,
         revision.created_by_user_id AS revision_created_by_user_id,
         revision.created_at AS revision_created_at
    FROM managed_tasks task
    JOIN ledger_projects project ON project.id = task.project_id
    JOIN managed_task_revisions revision ON revision.id = task.active_revision_id`;

function resolveReminderId(db: Db, ref: string): string {
  const resolved = resolveId(db, "reminder", ref);
  if (resolved.ok) return resolved.id;
  if (resolved.error === "ambiguous") throw new ManagedReminderError(`reminder reference is ambiguous: ${ref}`, 409, "ambiguous");
  throw new ManagedReminderError(`reminder not found: ${ref}`, 404, "not_found");
}

export function getManagedReminder(db: Db, ref: string): ManagedReminder {
  const id = resolveReminderId(db, ref);
  const row = db.prepare(`${REMINDER_SELECT} WHERE task.id = ?`).get(id) as ReminderJoinedRow;
  return reminderFromRow(db, row);
}

export function listManagedReminders(
  db: Db,
  filter: { projectId?: string; lifecycle?: ManagedReminderLifecycle } = {},
): ManagedReminder[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.projectId) {
    clauses.push("task.project_id = ?");
    params.push(filter.projectId);
  }
  if (filter.lifecycle) {
    clauses.push("task.lifecycle = ?");
    params.push(filter.lifecycle);
  }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`${REMINDER_SELECT}${where} ORDER BY task.created_at DESC, task.id DESC`)
    .all(...params) as ReminderJoinedRow[];
  return rows.map((row) => reminderFromRow(db, row));
}

function appendAuditEvent(
  db: Db,
  input: {
    taskId: string;
    revisionId: string;
    projectId: string;
    eventType: "created" | "completed" | "cancelled";
    actorUserId: string;
    evidenceMethod: "api_token" | "ephemeral" | "local_default" | "session_claim" | "system_internal";
    payload?: Record<string, unknown>;
    now: number;
  },
): void {
  db.prepare(
    `INSERT INTO managed_task_events (
       id, task_id, revision_id, project_id, event_type, actor_user_id,
       evidence_method, payload_json, occurred_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `remevt_${ulid(input.now)}`,
    input.taskId,
    input.revisionId,
    input.projectId,
    input.eventType,
    input.actorUserId,
    input.evidenceMethod,
    JSON.stringify(input.payload ?? {}),
    input.now,
  );
}

function capabilityFor(
  db: Db,
  reminder: { taskId: string; revisionId: string; projectId: string; createdByUserId: string },
): ReminderDatabaseCapability {
  return {
    evaluatePredicate(payload, now): ReminderEvaluationEvidence | null {
      const predicate = payload.predicate;
      if (predicate.kind === "at") {
        const scheduledAt = Date.parse(predicate.at);
        return now >= scheduledAt
          ? { occurrence_key: `at:${predicate.at}`, evidence: { kind: "at", at: predicate.at, evaluated_at: now } }
          : null;
      }
      if (predicate.kind === "issue_closed") {
        const issue = db.prepare(
          "SELECT status, closed_at FROM ledger_issues WHERE id = ? AND project_id = ?",
        ).get(predicate.issue_id, reminder.projectId) as { status: string; closed_at: number | null } | undefined;
        return issue?.status === "closed"
          ? {
              occurrence_key: `issue_closed:${predicate.issue_id}`,
              evidence: { kind: "issue_closed", issue_id: predicate.issue_id, closed_at: issue.closed_at },
            }
          : null;
      }
      const clauses = ["project_id = ?"];
      const params: unknown[] = [predicate.project_id];
      if (predicate.base_branch !== undefined) {
        clauses.push("base_branch = ?");
        params.push(predicate.base_branch);
      }
      if (predicate.canonical_message !== undefined) {
        clauses.push("canonical_message = ?");
        params.push(predicate.canonical_message ? 1 : 0);
      }
      const count = db.prepare(
        `SELECT COUNT(*) AS count, MAX(completed_at) AS latest_completed_at
           FROM auth_request_merge_succeeded_facts WHERE ${clauses.join(" AND ")}`,
      ).get(...params) as { count: number; latest_completed_at: number | null };
      return count.count >= predicate.threshold
        ? {
            occurrence_key: `auth_merge_count_gte:${predicate.threshold}`,
            evidence: {
              kind: "auth_merge_count_gte",
              project_id: predicate.project_id,
              ...(predicate.base_branch !== undefined ? { base_branch: predicate.base_branch } : {}),
              ...(predicate.canonical_message !== undefined
                ? { canonical_message: predicate.canonical_message }
                : {}),
              threshold: predicate.threshold,
              observed_count: count.count,
              latest_completed_at: count.latest_completed_at,
            },
          }
        : null;
    },
    appendInboxOccurrence(evaluation, now): boolean {
      const state = db.prepare("SELECT lifecycle FROM managed_tasks WHERE id = ?")
        .get(reminder.taskId) as { lifecycle: ManagedReminderLifecycle } | undefined;
      if (state?.lifecycle !== "armed") return false;
      const revision = db.prepare("SELECT payload_json FROM managed_task_revisions WHERE id = ?")
        .get(reminder.revisionId) as { payload_json: string };
      const payload = parseStoredReminderPayload(revision.payload_json);
      const occurrenceId = `remocc_${ulid(now)}`;
      const inserted = db.prepare(
        `INSERT OR IGNORE INTO managed_task_occurrences (
           id, task_id, revision_id, occurrence_key, kind, payload_json,
           triggering_evidence_json, created_by_user_id, fired_by_user_id, created_at
         ) VALUES (?, ?, ?, ?, 'inbox_occurrence', ?, ?, ?, ?, ?)`,
      ).run(
        occurrenceId,
        reminder.taskId,
        reminder.revisionId,
        evaluation.occurrence_key,
        JSON.stringify({ message: payload.message }),
        JSON.stringify(evaluation.evidence),
        reminder.createdByUserId,
        SYSTEM_USER_ID,
        now,
      );
      if (inserted.changes === 0) return false;
      const updated = db.prepare(
        `UPDATE managed_tasks
            SET lifecycle = 'completed', completed_at = ?, updated_at = ?
          WHERE id = ? AND lifecycle = 'armed'`,
      ).run(now, now, reminder.taskId);
      if (updated.changes !== 1) throw new Error("reminder lifecycle changed during firing transaction");
      appendAuditEvent(db, {
        taskId: reminder.taskId,
        revisionId: reminder.revisionId,
        projectId: reminder.projectId,
        eventType: "completed",
        actorUserId: SYSTEM_USER_ID,
        evidenceMethod: "system_internal",
        payload: { occurrence_id: occurrenceId, occurrence_key: evaluation.occurrence_key },
        now,
      });
      return true;
    },
  };
}

export function createManagedReminder(
  db: Db,
  request: ManagedReminderCreateRequest,
  actor: { userId: string; evidenceMethod: "api_token" | "ephemeral" | "local_default" | "session_claim" },
  options: { now?: number; projectId?: string } = {},
): ManagedReminderCreateResult {
  const now = options.now ?? Date.now();
  const project = options.projectId
    ? { id: options.projectId }
    : resolveManagedReminderProject(db, request.project);
  const payload = canonicalPayload(db, request, project.id);
  const payloadJson = canonicalReminderPayloadJson(payload);
  const payloadDigest = sha256(payloadJson);
  const requestDigest = digestRequest(project.id, payloadJson);

  return db.transaction(() => {
    const replay = db.prepare(
      `SELECT request_digest, result_json FROM managed_task_create_requests
        WHERE created_by_user_id = ? AND idempotency_key = ?`,
    ).get(actor.userId, request.idempotency_key) as
      { request_digest: string; result_json: string } | undefined;
    if (replay) {
      if (replay.request_digest !== requestDigest) {
        throw new ManagedReminderError(
          "idempotency key was already used with a different canonical payload",
          409,
          "idempotency_conflict",
        );
      }
      const original = JSON.parse(replay.result_json) as ManagedReminderCreateResult;
      const occurrence = original.reminder.occurrence;
      return {
        ...original,
        reminder: {
          ...original.reminder,
          occurrence: occurrence ? {
            ...occurrence,
            acknowledged_by: occurrence.acknowledged_by ?? null,
            acknowledged_at: occurrence.acknowledged_at ?? null,
          } : null,
        },
        stored: false,
      };
    }

    const taskId = `rem_${ulid(now)}`;
    const revisionId = `remrev_${ulid(now)}`;
    db.prepare(
      `INSERT INTO managed_tasks (
         id, project_id, kind, lifecycle, active_revision_id, created_by_user_id,
         created_at, updated_at
       ) VALUES (?, ?, 'mandible-reminder', 'armed', ?, ?, ?, ?)`,
    ).run(taskId, project.id, revisionId, actor.userId, now, now);
    db.prepare(
      `INSERT INTO managed_task_revisions (
         id, task_id, revision_no, schema_id, payload_json, payload_digest,
         created_by_user_id, created_at
       ) VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
    ).run(revisionId, taskId, MANAGED_REMINDER_SCHEMA, payloadJson, payloadDigest, actor.userId, now);
    appendAuditEvent(db, {
      taskId,
      revisionId,
      projectId: project.id,
      eventType: "created",
      actorUserId: actor.userId,
      evidenceMethod: actor.evidenceMethod,
      payload: { idempotency_key: request.idempotency_key, payload_digest: payloadDigest },
      now,
    });
    const firedImmediately = evaluateManagedReminder(
      capabilityFor(db, {
        taskId,
        revisionId,
        projectId: project.id,
        createdByUserId: actor.userId,
      }),
      payload,
      now,
    );
    const result: ManagedReminderCreateResult = {
      reminder: getManagedReminder(db, taskId),
      stored: true,
      fired_immediately: firedImmediately,
    };
    db.prepare(
      `INSERT INTO managed_task_create_requests (
         id, created_by_user_id, idempotency_key, request_digest, task_id,
         result_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `remreq_${ulid(now)}`,
      actor.userId,
      request.idempotency_key,
      requestDigest,
      taskId,
      JSON.stringify(result),
      now,
    );
    return result;
  }).immediate();
}

export function cancelManagedReminder(
  db: Db,
  ref: string,
  actor: { userId: string; evidenceMethod: "api_token" | "ephemeral" | "local_default" | "session_claim" },
  now: number = Date.now(),
): ManagedReminder {
  return db.transaction(() => {
    const taskId = resolveReminderId(db, ref);
    const task = db.prepare(
      "SELECT project_id, active_revision_id, lifecycle FROM managed_tasks WHERE id = ?",
    ).get(taskId) as { project_id: string; active_revision_id: string; lifecycle: ManagedReminderLifecycle };
    if (task.lifecycle !== "armed") {
      throw new ManagedReminderError(
        `only an armed reminder can be cancelled; current lifecycle is ${task.lifecycle}`,
        409,
        "invalid_lifecycle",
      );
    }
    db.prepare(
      `UPDATE managed_tasks SET lifecycle = 'cancelled', cancelled_at = ?, updated_at = ?
        WHERE id = ? AND lifecycle = 'armed'`,
    ).run(now, now, taskId);
    appendAuditEvent(db, {
      taskId,
      revisionId: task.active_revision_id,
      projectId: task.project_id,
      eventType: "cancelled",
      actorUserId: actor.userId,
      evidenceMethod: actor.evidenceMethod,
      now,
    });
    return getManagedReminder(db, taskId);
  }).immediate();
}

export function reconcileManagedReminders(db: Db, now: number = Date.now()): {
  evaluated: number;
  fired: number;
  task_ids: string[];
} {
  const armed = db.prepare(
    `SELECT id, project_id, active_revision_id, created_by_user_id
       FROM managed_tasks WHERE lifecycle = 'armed' ORDER BY created_at, id`,
  ).all() as Array<{
    id: string;
    project_id: string;
    active_revision_id: string;
    created_by_user_id: string;
  }>;
  const fired: string[] = [];
  for (const task of armed) {
    const didFire = db.transaction(() => {
      const current = db.prepare("SELECT lifecycle FROM managed_tasks WHERE id = ?")
        .get(task.id) as { lifecycle: ManagedReminderLifecycle } | undefined;
      if (current?.lifecycle !== "armed") return false;
      const revision = db.prepare("SELECT payload_json FROM managed_task_revisions WHERE id = ?")
        .get(task.active_revision_id) as { payload_json: string };
      return evaluateManagedReminder(
        capabilityFor(db, {
          taskId: task.id,
          revisionId: task.active_revision_id,
          projectId: task.project_id,
          createdByUserId: task.created_by_user_id,
        }),
        parseStoredReminderPayload(revision.payload_json),
        now,
      );
    }).immediate();
    if (didFire) fired.push(task.id);
  }
  return { evaluated: armed.length, fired: fired.length, task_ids: fired };
}
