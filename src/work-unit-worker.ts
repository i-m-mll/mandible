import type { Db } from "./db.js";
import { tableExists } from "./db-introspection.js";
import { PROVIDER_TO_CONVERSATION_SOURCE } from "./provider-identities.js";
import type { ConversationSource } from "./parsers/types.js";
import { resolveSessionAlias } from "./session-liveness.js";
import { getRetainedChildByProvider } from "./conversations/retention-policy.js";

type UnitRow = Record<string, unknown>;

function sourceOf(provider: unknown): ConversationSource | null {
  if (provider === "claude_code") return provider;
  return typeof provider === "string" ? PROVIDER_TO_CONVERSATION_SOURCE[provider] ?? null : null;
}

/** Bind assignment identity independently of the request's creator attribution. */
export function reconcileWorkerAssignment(db: Db, before: UnitRow | undefined, after: UnitRow | undefined): void {
  if (!after || !tableExists(db, "conversations")) return;
  if (before?.assigned_session_id && !after.assigned_session_id
    && before.custody_generation === after.custody_generation) return;
  const assigned = typeof after.assigned_session_id === "string" ? after.assigned_session_id : null;
  const alias = assigned ? resolveSessionAlias(db, assigned, { readCodexTaskLiveness: () => ({ status: "unavailable" }) }) : null;
  const provider = sourceOf(assigned ? alias?.provider : after.provider);
  const nativeId = assigned ? alias?.provider_session_id : after.provider_session_id;
  const child = provider && typeof nativeId === "string" ? getRetainedChildByProvider(db, provider, nativeId) : null;
  const assignmentChanged = before && (before.assigned_session_id !== after.assigned_session_id
    || before.custody_generation !== after.custody_generation);
  if (child?.role === "worker") {
    db.prepare("UPDATE work_units SET worker_provider = ?, worker_provider_session_id = ?, assigned_session_id = COALESCE(assigned_session_id, ?) WHERE id = ?")
      .run(child.provider, child.sessionId, child.sessionId, after.id);
  } else if (assignmentChanged || !before) {
    db.prepare("UPDATE work_units SET worker_provider = NULL, worker_provider_session_id = NULL WHERE id = ?")
      .run(after.id);
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
  const unresolvedUnitIds = (db.prepare(`SELECT id FROM work_units WHERE state IN ('open','committed')
    AND ((worker_provider = ? AND worker_provider_session_id = ?) OR assigned_session_id IN (
      SELECT ? UNION SELECT id FROM sessions WHERE app = ? AND conversation_id = ?
      UNION SELECT id FROM console_sessions WHERE command = ? AND provider_session_id = ?
      UNION SELECT mandible_session_id FROM console_sessions WHERE command = ? AND provider_session_id = ?
    )) ORDER BY id`).all(worker.provider, worker.provider_session_id, worker.provider_session_id,
      provider, worker.provider_session_id, provider, worker.provider_session_id, provider, worker.provider_session_id) as Array<{ id: string }>).map(row => row.id);
  return { resolvedUnitIds, unresolvedUnitIds, complete: resolvedUnitIds.length > 0 && unresolvedUnitIds.length === 0 };
}

/** Visibility changes preserve the current assignment, independently of process liveness. */
export function hasArchivedResponsibility(db: Db, unit: UnitRow): boolean {
  if (unit.state !== "open" && unit.state !== "committed") return false;
  if (!tableExists(db, "conversations")) return false;
  const assigned = typeof unit.assigned_session_id === "string" ? unit.assigned_session_id : null;
  const holder = assigned ? resolveSessionAlias(db, assigned, { readCodexTaskLiveness: () => ({ status: "unavailable" }) }) : null;
  const provider = sourceOf(assigned ? holder?.provider : unit.worker_provider ?? unit.provider);
  const nativeId = assigned ? holder?.provider_session_id : unit.worker_provider_session_id ?? unit.provider_session_id;
  if (!provider || typeof nativeId !== "string") return false;
  return Boolean(db.prepare(`SELECT 1 FROM ledger_events archive
    JOIN conversations c ON c.id = archive.entity_id
    WHERE archive.entity_type = 'conversation_metadata' AND c.source = ? AND c.session_id = ?
      AND json_extract(archive.payload_json, '$.archived') = 1
      AND archive.occurred_at >= ?
      AND archive.rowid > COALESCE((SELECT MAX(assignment.rowid) FROM ledger_events assignment,
        json_each(assignment.payload_json, '$.changed_fields') field
        WHERE assignment.entity_type = 'work_unit' AND assignment.entity_id = ?
          AND field.value IN ('assigned_session_id', 'worker_provider', 'worker_provider_session_id', 'custody_generation')),
        0) LIMIT 1`).get(provider, nativeId, unit.created_at ?? 0, unit.id));
}
