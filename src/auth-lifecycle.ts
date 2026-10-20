import { authPublicationSnapshot } from "./auth-publication.js";
import { createHash, randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import type {
  AuthLifecycleActor,
  AuthRequestLifecycleEvent,
  AuthRequestLifecycleEventType,
  AuthRequestStatus,
} from "./types.js";

function parseJsonColumn(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function authRequestSnapshot(db: Db, requestId: string): string {
  const row = db.prepare("SELECT * FROM auth_requests WHERE id = ?").get(requestId) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new Error(`Auth request '${requestId}' is missing.`);
  // Columns added after receipts existed appear only when set, so receipts
  // recorded before them keep verifying.
  const omittedWhenNull = ["space_publication_id", "protected_root_dirty_action_json"];
  const request = Object.fromEntries(Object.entries(row).filter(([key, value]) => !omittedWhenNull.includes(key) || value !== null).map(([key, value]) => [
    key,
    ["issue_ids", "issues", "issue_references", "issue_closures", "merge_finalizer_state", "change_report_json", "protected_root_dirty_action_json"].includes(key)
      ? parseJsonColumn(value)
      : value ?? null,
  ]));
  const actions = db.prepare(
    "SELECT * FROM auth_request_actions WHERE auth_request_id = ? ORDER BY ordinal, id",
  ).all(requestId).map((action) => {
    const record = action as Record<string, unknown>;
    return { ...record, payload: parseJsonColumn(record.payload) };
  });
  const publication = authPublicationSnapshot(db, requestId);
  return JSON.stringify({ request, actions, ...(publication ? { publication } : {}) });
}

export function authSnapshotDigest(snapshot: string): string {
  return createHash("sha256").update(snapshot).digest("hex");
}

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
    occurredAt: number;
  },
): AuthRequestLifecycleEvent {
  const snapshot = authRequestSnapshot(db, input.requestId);
  const revision = Number((db.prepare(
    "SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM auth_request_lifecycle_events WHERE auth_request_id = ?",
  ).get(input.requestId) as { revision: number }).revision);
  const event: AuthRequestLifecycleEvent = {
    id: randomUUID(),
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
  db.prepare(`INSERT INTO auth_request_lifecycle_events (
    id, auth_request_id, revision, event_type, prior_status, next_status,
    snapshot_json, snapshot_sha256, prior_snapshot_json, prior_snapshot_sha256,
    actor_user_id, evidence_method, evidence_id, credential_id, reason,
    related_request_id, custody_work_unit_id, custody_generation, authority_path, occurred_at
  ) VALUES (
    @id, @auth_request_id, @revision, @event_type, @prior_status, @next_status,
    @snapshot_json, @snapshot_sha256, @prior_snapshot_json, @prior_snapshot_sha256,
    @actor_user_id, @evidence_method, @evidence_id, @credential_id, @reason,
    @related_request_id, @custody_work_unit_id, @custody_generation, @authority_path, @occurred_at
  )`).run(event);
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
  ).all(requestId) as AuthRequestLifecycleEvent[];
}
