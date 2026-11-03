import { exactAgentRef } from "./ambient-provider-identity.js";
import type { Db } from "./db.js";
import { assignmentProvider, resolveAssignmentTarget } from "./work-unit-assignment.js";

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
    const alias = row.assigned_session_id?.trim() ? { kind: "alias" as const, session_id: row.assigned_session_id.trim() } : null;
    const resolved = alias ? resolveAssignmentTarget(db, alias) : null;
    const assigned = resolved ? { kind: "native", provider: resolved.provider, session_id: resolved.session_id } : alias;
    const provider = assignmentProvider(row.worker_provider);
    const bound = provider && row.worker_provider_session_id ? { kind: "native", provider, session_id: row.worker_provider_session_id } : null;
    if (assigned && bound && (!resolved || resolved.provider !== bound.provider || resolved.session_id !== bound.session_id)) continue;
    const target = assigned ?? bound;
    if (!target) continue;
    db.prepare("UPDATE work_units SET assignment_target_json = ? WHERE id = ?").run(JSON.stringify(target), row.id);
    db.prepare(`INSERT INTO ledger_events (id,entity_type,entity_id,event_type,actor_id,actor_type,source,payload_json,occurred_at,observed_at)
      VALUES (lower(hex(randomblob(32))),'work_unit',?,'work_unit.assignment.observed','schema-migration-v223','system','system',?,?,?)`)
      .run(row.id, JSON.stringify({ provenance: "legacy_retained_assignment_observation", assignment_target: target,
        changed_fields: ["assignment_target_json"], retained_assigned_session_id: row.assigned_session_id,
        retained_worker_provider: row.worker_provider, retained_worker_provider_session_id: row.worker_provider_session_id }), now, now);
  }
}

export const EXACT_AGENT_WORK_UNIT_SCHEMA_SQL = [
  "ALTER TABLE work_units ADD COLUMN worker_agent_ref TEXT",
  "UPDATE work_units SET worker_agent_ref = mandible_exact_agent_ref('codex', worker_provider_session_id) WHERE worker_provider = 'codex' AND worker_provider_session_id IS NOT NULL",
  "DROP INDEX idx_work_units_pending_assignment",
  "DROP INDEX idx_work_units_assignment_target",
  "ALTER TABLE work_units RENAME COLUMN assignment_target_json TO legacy_assignment_target_json",
  `ALTER TABLE work_units ADD COLUMN assignment_target_json TEXT CHECK(assignment_target_json IS NULL OR
    (COALESCE(json_valid(assignment_target_json) AND CASE json_extract(assignment_target_json, '$.kind')
      WHEN 'native' THEN json_type(assignment_target_json, '$.agent_ref') = 'text' AND length(json_extract(assignment_target_json, '$.agent_ref')) > 0
      WHEN 'alias' THEN json_type(assignment_target_json, '$.session_id') = 'text' AND length(trim(json_extract(assignment_target_json, '$.session_id'))) > 0
      ELSE 0 END, 0)))`,
  `UPDATE work_units SET assignment_target_json = CASE
    WHEN json_extract(legacy_assignment_target_json, '$.kind') = 'native' AND json_extract(legacy_assignment_target_json, '$.provider') IN ('codex','gemini')
      THEN json_object('kind', 'native', 'agent_ref', mandible_exact_agent_ref(json_extract(legacy_assignment_target_json, '$.provider'), json_extract(legacy_assignment_target_json, '$.session_id')))
    WHEN json_extract(legacy_assignment_target_json, '$.provider') IN ('claude','claude_code') THEN NULL
    WHEN legacy_assignment_target_json IS NOT NULL THEN json_object('kind', 'alias', 'session_id', json_extract(legacy_assignment_target_json, '$.session_id')) END`,
  `ALTER TABLE work_units ADD COLUMN execution_identity_json TEXT CHECK(execution_identity_json IS NULL OR json_valid(execution_identity_json))`,
  `UPDATE work_units SET execution_identity_json = json_object('provider', CASE provider WHEN 'claude_code' THEN 'claude' ELSE provider END,
    'agent_id', CASE WHEN provider IN ('codex','gemini') THEN provider_session_id ELSE NULL END,
    'session_id', CASE WHEN provider IN ('claude','claude_code','gemini') THEN provider_session_id ELSE NULL END)
    WHERE provider IS NOT NULL AND provider_session_id IS NOT NULL`,
  "CREATE INDEX idx_work_units_pending_assignment ON work_units(id) WHERE assignment_target_json IS NOT NULL AND worker_provider IS NULL",
  "CREATE INDEX idx_work_units_assignment_target ON work_units(json_extract(assignment_target_json, '$.agent_ref'), state) WHERE assignment_target_json IS NOT NULL",
];

/** Historical Claude session evidence cannot establish root execution identity. */
export function recoverHistoricalExactAssignments(db: Db): void {
  const rows = db.prepare("SELECT id, legacy_assignment_target_json FROM work_units WHERE legacy_assignment_target_json IS NOT NULL")
    .all() as Array<{ id: string; legacy_assignment_target_json: string }>;
  for (const row of rows) {
    const legacy = JSON.parse(row.legacy_assignment_target_json) as { provider?: string; session_id: string };
    if (legacy.provider && legacy.provider !== "claude_code" && legacy.provider !== "claude") continue;
    const candidates = db.prepare("SELECT session_id, agent_id FROM conversations WHERE source = 'claude_code' AND (session_id = ? OR agent_id = ?)")
      .all(legacy.session_id, legacy.session_id) as Array<{ session_id: string; agent_id: string | null }>;
    if (!candidates.length && legacy.provider !== "claude_code") continue;
    const refs = new Set(candidates.filter(candidate => candidate.agent_id === legacy.session_id && candidate.agent_id !== candidate.session_id)
      .map(candidate => exactAgentRef({ provider: "claude", agent_id: candidate.agent_id, session_id: candidate.session_id })));
    const precise = refs.size === 1 && !candidates.some(candidate => candidate.session_id === legacy.session_id) ? [...refs][0] : null;
    db.prepare("UPDATE work_units SET assignment_target_json = ? WHERE id = ?")
      .run(precise ? JSON.stringify({ kind: "native", agent_ref: precise }) : null, row.id);
  }
}
