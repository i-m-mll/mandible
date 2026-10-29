import type { Db } from "./db.js";
import { tableExists } from "./db-introspection.js";
import { parseAssignmentTarget, resolveAssignmentTarget } from "./work-unit-assignment.js";
import type { ConversationSource } from "./parsers/types.js";
import { getRetainedChildByProvider } from "./conversations/retention-policy.js";

type UnitRow = Record<string, unknown>;

/** Binding follows the current durable target; process cleanup never recreates active assignment. */
export function reconcileWorkerAssignment(db: Db, before: UnitRow | undefined, after: UnitRow | undefined): void {
  if (!after) return;
  const changed = before?.assignment_target_json !== after.assignment_target_json
    || before?.custody_generation !== after.custody_generation;
  if (changed) db.prepare("UPDATE work_units SET worker_provider = NULL, worker_provider_session_id = NULL WHERE id = ?").run(after.id);
  if (!tableExists(db, "conversations")) return;
  const identity = resolveAssignmentTarget(db, parseAssignmentTarget(after.assignment_target_json));
  const child = identity ? getRetainedChildByProvider(db, identity.provider, identity.session_id) : null;
  if (child?.role === "worker") {
    db.prepare("UPDATE work_units SET worker_provider = ?, worker_provider_session_id = ? WHERE id = ?")
      .run(child.provider, child.sessionId, after.id);
  } else if (after.worker_provider || after.worker_provider_session_id) {
    db.prepare("UPDATE work_units SET worker_provider = NULL, worker_provider_session_id = NULL WHERE id = ?").run(after.id);
  }
}

export function getWorkerAssignments(db: Db, worker: { provider: ConversationSource; provider_session_id: string }): {
  resolvedUnitIds: string[]; unresolvedUnitIds: string[]; complete: boolean;
} {
  const rows = db.prepare(`SELECT id, state FROM work_units
    WHERE worker_provider = ? AND worker_provider_session_id = ? AND state != 'abandoned' ORDER BY id`)
    .all(worker.provider, worker.provider_session_id) as Array<{ id: string; state: string }>;
  const resolvedUnitIds = rows.filter(row => row.state === "resolved").map(row => row.id);
  const provider = worker.provider === "claude_code" ? "claude" : worker.provider;
  const candidates = db.prepare(`SELECT id, assignment_target_json, worker_provider, worker_provider_session_id FROM work_units
    WHERE state IN ('open','committed') AND (
      (worker_provider = ? AND worker_provider_session_id = ?) OR
      (json_extract(assignment_target_json, '$.kind') = 'native'
        AND json_extract(assignment_target_json, '$.provider') = ? AND json_extract(assignment_target_json, '$.session_id') = ?) OR
      (json_extract(assignment_target_json, '$.kind') = 'alias' AND json_extract(assignment_target_json, '$.session_id') IN (
        SELECT ? UNION SELECT id FROM sessions WHERE app = ? AND conversation_id = ?
        UNION SELECT id FROM console_sessions WHERE command = ? AND provider_session_id = ?
        UNION SELECT mandible_session_id FROM console_sessions WHERE command = ? AND provider_session_id = ?))) ORDER BY id`)
    .all(worker.provider, worker.provider_session_id, worker.provider, worker.provider_session_id, worker.provider_session_id,
      provider, worker.provider_session_id, provider, worker.provider_session_id, provider, worker.provider_session_id) as UnitRow[];
  const unresolvedUnitIds = candidates.filter(row => {
    const identity = resolveAssignmentTarget(db, parseAssignmentTarget(row.assignment_target_json));
    return (identity?.provider === worker.provider && identity.session_id === worker.provider_session_id)
      || (row.worker_provider === worker.provider && row.worker_provider_session_id === worker.provider_session_id);
  }).map(row => String(row.id));
  return { resolvedUnitIds, unresolvedUnitIds, complete: resolvedUnitIds.length > 0 && unresolvedUnitIds.length === 0 };
}

/** Visibility changes preserve the current assignment, independently of process liveness. */
export function hasArchivedResponsibility(db: Db, unit: UnitRow): boolean {
  if (unit.state !== "open" && unit.state !== "committed") return false;
  if (!tableExists(db, "conversations")) return false;
  const identity = resolveAssignmentTarget(db, parseAssignmentTarget(unit.assignment_target_json ?? unit.assignment_target));
  const provider = identity?.provider ?? unit.worker_provider;
  const nativeId = identity?.session_id ?? unit.worker_provider_session_id;
  if (!provider || typeof nativeId !== "string") return false;
  return Boolean(db.prepare(`SELECT 1 FROM ledger_events archive
    JOIN conversations c ON c.id = archive.entity_id
    WHERE archive.entity_type = 'conversation_metadata' AND c.source = ? AND c.session_id = ?
      AND json_extract(archive.payload_json, '$.archived') = 1
      AND archive.occurred_at >= ?
      AND archive.rowid > COALESCE((SELECT MAX(assignment.rowid) FROM ledger_events assignment,
        json_each(assignment.payload_json, '$.changed_fields') field
        WHERE assignment.entity_type = 'work_unit' AND assignment.entity_id = ?
          AND field.value IN ('assignment_target_json', 'custody_generation')),
        0) LIMIT 1`).get(provider, nativeId, unit.created_at ?? 0, unit.id));
}
