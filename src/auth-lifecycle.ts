import { currentRequestOrigin, requestOriginForRequest } from "./request-origin.js";
import { authRequestSnapshot, authSnapshotDigest, AUTH_SNAPSHOT_SHAPE_V212 } from "./auth-request-snapshot.js";
import { describeAuthExecutionFailure, type AuthExecutionAttempt } from "./contracts.js";
import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import type {
  AuthLifecycleActor,
  AuthRequestLifecycleEvent,
  AuthRequestLifecycleEventType,
  AuthRequestStatus,
} from "./types.js";

const AUTH_LIFECYCLE_HISTORY_COLUMNS_V212 = [
  "id", "auth_request_id", "revision", "event_type", "prior_status", "next_status",
  "snapshot_json", "snapshot_sha256", "prior_snapshot_json", "prior_snapshot_sha256",
  "actor_user_id", "evidence_method", "evidence_id", "credential_id", "reason", "related_request_id",
  "custody_work_unit_id", "custody_generation", "authority_path", "occurred_at",
] as const;

export function appendAuthLifecycleEvent(
  db: Db,
  input: {
    requestId: string;
    eventType: AuthRequestLifecycleEventType;
    priorStatus: AuthRequestStatus | null;
    nextStatus: AuthRequestStatus;
    actor?: AuthLifecycleActor | null;
    reason?: string | null;
    relatedRequestId?: string | null;
    priorSnapshot?: string | null;
    historyShape?: "v212" | "current";
    occurredAt: number;
  },
): AuthRequestLifecycleEvent {
  const snapshot = authRequestSnapshot(db, input.requestId, input.historyShape === "v212" ? AUTH_SNAPSHOT_SHAPE_V212 : undefined);
  const revision = Number((db.prepare(
    "SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM auth_request_lifecycle_events WHERE auth_request_id = ?",
  ).get(input.requestId) as { revision: number }).revision);
  const origin = input.actor?.authority_path === "system"
    ? authRequestInitiatingOrigin(db, input.requestId) : currentRequestOrigin();
  const event: AuthRequestLifecycleEvent = {
    id: randomUUID(),
    request_origin_json: origin ? JSON.stringify(origin) : null,
    request_origin: origin,
    auth_request_id: input.requestId,
    revision,
    event_type: input.eventType,
    prior_status: input.priorStatus,
    next_status: input.nextStatus,
    snapshot_json: snapshot,
    snapshot_sha256: authSnapshotDigest(snapshot),
    prior_snapshot_json: input.priorSnapshot ?? null,
    prior_snapshot_sha256: input.priorSnapshot ? authSnapshotDigest(input.priorSnapshot) : null,
    actor_user_id: input.actor?.user_id ?? null,
    evidence_method: input.actor?.evidence_method ?? null,
    evidence_id: input.actor?.evidence_id ?? null,
    credential_id: input.actor?.credential_id ?? null,
    reason: input.reason?.trim() || null,
    related_request_id: input.relatedRequestId ?? null,
    custody_work_unit_id: rowCustody(db, input.requestId)?.work_unit_id ?? null,
    custody_generation: rowCustody(db, input.requestId)?.custody_generation ?? null,
    authority_path: input.actor?.authority_path ?? (input.actor ? "custodian" : "system"),
    occurred_at: input.occurredAt,
  };
  const columns = input.historyShape === "v212" ? AUTH_LIFECYCLE_HISTORY_COLUMNS_V212
    : ["request_origin_json" as const, ...AUTH_LIFECYCLE_HISTORY_COLUMNS_V212];
  db.prepare(`INSERT INTO auth_request_lifecycle_events (${columns.join(",")})
    VALUES (${columns.map(column => `@${column}`).join(",")})`)
    .run(Object.fromEntries(columns.map(column => [column, event[column]])));
  return event;
}

function rowCustody(db: Db, requestId: string): { work_unit_id: string; custody_generation: number } | null {
  return (db.prepare(`SELECT ar.custody_work_unit_id AS work_unit_id, wu.custody_generation
    FROM auth_requests ar LEFT JOIN work_units wu ON wu.id = ar.custody_work_unit_id
    WHERE ar.id = ? AND ar.custody_work_unit_id IS NOT NULL`).get(requestId) as
      { work_unit_id: string; custody_generation: number } | undefined) ?? null;
}

export function listAuthLifecycleEvents(db: Db, requestId: string): AuthRequestLifecycleEvent[] {
  return db.prepare(
    "SELECT * FROM auth_request_lifecycle_events WHERE auth_request_id = ? ORDER BY revision",
  ).all(requestId).map((row: AuthRequestLifecycleEvent) => ({ ...row, request_origin_json: row.request_origin_json ?? null,
    request_origin: row.request_origin_json ? JSON.parse(row.request_origin_json) : null })) as AuthRequestLifecycleEvent[];
}

/**
 * Issue cc8fe29 — every execution a request has had, read from its lifecycle.
 * A retry reuses the request row, so the row alone shows only the latest
 * execution. Events recorded before the `failed` state existed carry
 * `completed` with the non-zero exit in their snapshot; the snapshot decides.
 */
export function listAuthExecutionAttempts(db: Db, requestId: string): AuthExecutionAttempt[] {
  const rows = db.prepare(`SELECT revision, occurred_at, event_type, reason,
      json_extract(snapshot_json, '$.request.exit_code') AS exit_code,
      json_extract(snapshot_json, '$.request.error') AS error,
      CASE WHEN json_extract(snapshot_json, '$.request.error') IS NULL
        THEN json_extract(snapshot_json, '$.request.output') END AS output
    FROM auth_request_lifecycle_events
    WHERE auth_request_id = ? AND event_type IN ('completed', 'failed')
    ORDER BY revision`).all(requestId) as Array<{
      revision: number; occurred_at: number; event_type: string; reason: string | null;
      exit_code: number | null; error: string | null; output: string | null;
    }>;
  return rows.map((row) => {
    const failed = row.event_type === "failed" || row.exit_code !== 0;
    return {
      revision: row.revision,
      occurred_at: row.occurred_at,
      result: failed ? "failed" : "succeeded",
      exit_code: row.exit_code,
      failure_reason: failed ? describeAuthExecutionFailure(row.error ?? row.output ?? row.reason, row.exit_code) : null,
    };
  });
}

/** The initiating session is serialized with submission, never inferred from the daemon. */
export function authRequestInitiatingOrigin(db: Db, requestId: string) {
  const row = db.prepare("SELECT request_origin_json FROM auth_request_lifecycle_events WHERE auth_request_id = ? AND event_type = 'submitted' ORDER BY revision LIMIT 1")
    .get(requestId) as { request_origin_json: string | null } | undefined;
  return requestOriginForRequest({ ambient_identity: row?.request_origin_json ? JSON.parse(row.request_origin_json) : null });
}
