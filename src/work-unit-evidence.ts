import type { Db } from "./db.js";
import type { LineageEvidence } from "./conversation-lineage.js";
import { getRetainedChildByProvider } from "./conversations/retention-policy.js";
import { systemAction } from "./identity/resolver.js";
import { mutateLedgerRecord } from "./ledger/mutation-history.js";
import { parseAssignmentTarget, resolveAssignmentTarget } from "./work-unit-assignment.js";
import { reconcileWorkerAssignment } from "./work-unit-worker.js";

type UnitRow = Record<string, unknown>;

function reconcileEvidence(db: Db, id: string): void {
  db.transaction(() => {
    const row = db.prepare("SELECT * FROM work_units WHERE id=?").get(id) as UnitRow | undefined;
    if (!row) return;
    const target = parseAssignmentTarget(row.assignment_target_json);
    const identity = resolveAssignmentTarget(db, target);
    const evidence = identity ? getRetainedChildByProvider(db, identity.provider, identity.session_id) : null;
    const issue = row.ledger_issue_id ? db.prepare("SELECT project_id FROM ledger_issues WHERE id=?")
      .get(row.ledger_issue_id) as { project_id: string } | undefined : undefined;
    mutateLedgerRecord(db, {
      entity_type: "work_unit", entity_id: id, project_id: issue?.project_id, source: "work_unit",
      actor_type: "system", actor_id: "worker-assignment-reconciliation", attribution: systemAction(),
      payload: { assignment_target: target, custody_generation: row.custody_generation,
        evidence: { conversation_id: evidence?.conversationId ?? null, provider: identity?.provider ?? null,
          session_id: identity?.session_id ?? null, role: evidence?.role ?? null } },
      snapshot: () => db.prepare("SELECT * FROM work_units WHERE id=?").get(id) as UnitRow ?? null,
    }, () => reconcileWorkerAssignment(db, row, row));
  })();
}

/** Reconcile only targets that name identities affected by this ingestion. */
export function reconcileWorkerLineageEvidence(db: Db, identities: readonly LineageEvidence[]): void {
  const ids = new Set<string>();
  for (const identity of identities) {
    const provider = identity.source === "claude_code" ? "claude" : identity.source;
    const rows = db.prepare(`SELECT id FROM work_units WHERE assignment_target_json IS NOT NULL
      AND json_extract(assignment_target_json,'$.kind')='native'
      AND json_extract(assignment_target_json,'$.provider')=? AND json_extract(assignment_target_json,'$.session_id')=?
      UNION SELECT id FROM work_units WHERE assignment_target_json IS NOT NULL
      AND json_extract(assignment_target_json,'$.kind')='alias' AND json_extract(assignment_target_json,'$.provider') IS NULL
      AND json_extract(assignment_target_json,'$.session_id') IN (
        SELECT ? UNION SELECT id FROM sessions WHERE app=? AND conversation_id=?
        UNION SELECT id FROM console_sessions WHERE command=? AND provider_session_id=?
        UNION SELECT mandible_session_id FROM console_sessions WHERE command=? AND provider_session_id=?)`)
      .all(identity.source, identity.sessionId, identity.sessionId, provider, identity.sessionId,
        provider, identity.sessionId, provider, identity.sessionId) as { id: string }[];
    for (const row of rows) ids.add(row.id);
  }
  for (const id of ids) reconcileEvidence(db, id);
}

/** One indexed keyset batch; callers yield before continuing with the returned cursor. */
export function recoverPendingWorkerAssignments(db: Db, afterId = "", batchSize = 16): string | null {
  const rows = db.prepare(`SELECT id FROM work_units WHERE assignment_target_json IS NOT NULL
    AND worker_provider IS NULL AND id>? ORDER BY id LIMIT ?`).all(afterId, batchSize) as { id: string }[];
  for (const row of rows) reconcileEvidence(db, row.id);
  return rows.length === batchSize ? rows.at(-1)!.id : null;
}
