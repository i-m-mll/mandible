import type { Db } from "./db.js";
import { assignmentProvider, assignmentTargetForSession, resolveAssignmentTarget } from "./work-unit-assignment.js";

export const WORK_UNIT_ASSIGNMENT_SCHEMA_SQL: readonly string[] = [
  `ALTER TABLE work_units ADD COLUMN assignment_target_json TEXT CHECK(assignment_target_json IS NULL OR
    (COALESCE(json_valid(assignment_target_json) AND json_type(assignment_target_json, '$.session_id') = 'text'
      AND length(trim(json_extract(assignment_target_json, '$.session_id'))) > 0
      AND CASE json_extract(assignment_target_json, '$.kind')
        WHEN 'alias' THEN json_type(assignment_target_json, '$.provider') IS NULL
        WHEN 'native' THEN COALESCE(json_extract(assignment_target_json, '$.provider') IN ('codex','claude_code','gemini'), 0)
        ELSE 0 END, 0)))`,
  `CREATE INDEX idx_work_units_pending_assignment ON work_units(id) WHERE assignment_target_json IS NOT NULL AND worker_provider IS NULL`,
  `CREATE INDEX idx_work_units_assignment_target ON work_units(
    json_extract(assignment_target_json, '$.kind'), json_extract(assignment_target_json, '$.provider'),
    json_extract(assignment_target_json, '$.session_id'), state) WHERE assignment_target_json IS NOT NULL`,
];

/** Observe retained evidence today; no historical claimant or actor reconstruction. */
export function seedLegacyAssignmentTargets(db: Db): void {
  const rows = db.prepare(`SELECT id, assigned_session_id, worker_provider, worker_provider_session_id FROM work_units
    WHERE assigned_session_id IS NOT NULL OR (worker_provider IS NOT NULL AND worker_provider_session_id IS NOT NULL)`).all() as Array<{
      id: string; assigned_session_id: string | null; worker_provider: string | null; worker_provider_session_id: string | null;
    }>;
  const now = Date.now();
  for (const row of rows) {
    const assigned = row.assigned_session_id?.trim() ? assignmentTargetForSession(db, row.assigned_session_id.trim()) : null;
    const provider = assignmentProvider(row.worker_provider);
    const bound = provider && row.worker_provider_session_id ? { kind: "native" as const, provider, session_id: row.worker_provider_session_id } : null;
    if (assigned && bound) {
      const resolved = resolveAssignmentTarget(db, assigned);
      if (!resolved || resolved.provider !== bound.provider || resolved.session_id !== bound.session_id) continue;
    }
    const target = assigned ?? bound;
    if (!target) continue;
    db.prepare("UPDATE work_units SET assignment_target_json = ? WHERE id = ?").run(JSON.stringify(target), row.id);
    db.prepare(`INSERT INTO ledger_events (id,entity_type,entity_id,event_type,actor_id,actor_type,source,payload_json,occurred_at,observed_at)
      VALUES (lower(hex(randomblob(32))),'work_unit',?,'work_unit.assignment.observed','schema-migration-v221','system','system',?,?,?)`)
      .run(row.id, JSON.stringify({ provenance: "legacy_retained_assignment_observation", assignment_target: target,
        changed_fields: ["assignment_target_json"], retained_assigned_session_id: row.assigned_session_id,
        retained_worker_provider: row.worker_provider, retained_worker_provider_session_id: row.worker_provider_session_id }), now, now);
  }
}
