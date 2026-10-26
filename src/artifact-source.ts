import { requestOriginJson } from "./request-origin.js";
import { artifactAccessProjectIds } from './permissions/resources.js';
import crypto from 'node:crypto';
import path from 'node:path';
import type { Db } from './db.js';
import { resolveProjectRef } from './ledger/project-registry.js';

export type ArtifactSource =
  | { kind: 'repo'; project_id: string; path: string }
  | { kind: 'local'; path: string }
  | { kind: 'managed'; key: string };
export type ArtifactLifecycleErrorCode = 'invalid_source' | 'unknown_artifact' | 'ambiguous_source'
  | 'source_mismatch' | 'reconciliation_required' | 'stale_plan' | 'invalid_input' | 'storage_error';
export type ArtifactLifecycleResult<T> = { ok: true; value: T }
  | { ok: false; error: { code: ArtifactLifecycleErrorCode; message: string } };
export function artifactFailure<T>(code: ArtifactLifecycleErrorCode, message: string): ArtifactLifecycleResult<T> {
  return { ok: false, error: { code, message } };
}
export interface ArtifactSourceState {
  artifact_id: string;
  source: ArtifactSource | null;
  revision: number;
  reconciliation_reason: string | null;
}
export function sourceKey(source: ArtifactSource): string {
  switch (source.kind) {
    case 'repo': return JSON.stringify({ kind: source.kind, project_id: source.project_id, path: source.path });
    case 'local': return JSON.stringify({ kind: source.kind, path: source.path });
    case 'managed': return JSON.stringify({ kind: source.kind, key: source.key });
  }
}
export function validateArtifactSource(db: Db, source: ArtifactSource): ArtifactLifecycleResult<ArtifactSource> {
  if (source.kind === 'repo') {
    const repo = resolveProjectRef(db, source.project_id);
    if (!repo.ok || repo.project.id !== source.project_id || !source.path || path.posix.isAbsolute(source.path)
      || source.path.includes('\\') || source.path.split('/').some(p => p === '..' || p === '.' || !p)) {
      return artifactFailure('invalid_source', 'Repository source requires a canonical project ID and normalized relative path');
    }
  } else if (source.kind === 'local') {
    if (!path.isAbsolute(source.path) || path.normalize(source.path) !== source.path) {
      return artifactFailure('invalid_source', 'Local source requires an absolute normalized path');
    }
  } else if (source.kind !== 'managed' || !source.key?.trim()) {
    return artifactFailure('invalid_source', 'Managed source requires a producer key');
  }
  return { ok: true, value: JSON.parse(sourceKey(source)) as ArtifactSource };
}
export function getArtifactCurrentSource(db: Db, artifactId: string): ArtifactSourceState | null {
  const row = db.prepare('SELECT * FROM artifact_source WHERE artifact_id=?').get(artifactId) as {
    artifact_id: string; source_json: string | null; revision: number; reconciliation_reason: string | null;
  } | undefined;
  return row ? { artifact_id: row.artifact_id, source: row.source_json ? JSON.parse(row.source_json) : null,
    revision: row.revision, reconciliation_reason: row.reconciliation_reason } : null;
}
/** Version count per custody mode; the source never decides where saved bytes live. */
export function artifactVersionCustody(db: Db, artifactId: string): Record<string, number> {
  const rows = db.prepare('SELECT custody_mode, COUNT(*) AS n FROM artifact_version WHERE artifact_id=? GROUP BY custody_mode ORDER BY custody_mode')
    .all(artifactId) as { custody_mode: string; n: number }[];
  return Object.fromEntries(rows.map(row => [row.custody_mode, row.n]));
}
export function lookupArtifactCurrentSource(db: Db, source: ArtifactSource): ArtifactLifecycleResult<ArtifactSourceState | null> {
  const valid = validateArtifactSource(db, source);
  if (!valid.ok) return valid;
  const rows = db.prepare('SELECT artifact_id FROM artifact_source WHERE source_json=?').all(sourceKey(source)) as {artifact_id:string}[];
  if (rows.length > 1) return artifactFailure('ambiguous_source', 'Multiple artifacts claim this current source; reconcile explicitly');
  const state = rows[0] ? getArtifactCurrentSource(db, rows[0].artifact_id) : null;
  if (state?.reconciliation_reason) return artifactFailure('reconciliation_required', state.reconciliation_reason);
  // Unresolved historical evidence must not turn a former source into a new identity by accident.
  if (!state && source.kind !== 'managed') {
    const ambiguous = source.kind === 'repo'
      ? db.prepare(`SELECT 1 FROM artifact_version v JOIN artifact_source s ON s.artifact_id=v.artifact_id
          WHERE s.reconciliation_reason IS NOT NULL AND v.source_project_id=? AND v.repo_path=? LIMIT 1`).get(source.project_id, source.path)
      : db.prepare(`SELECT 1 FROM artifact_version v JOIN artifact_source s ON s.artifact_id=v.artifact_id
          WHERE s.reconciliation_reason IS NOT NULL AND v.observed_path=? LIMIT 1`).get(source.path);
    if (ambiguous) return artifactFailure('reconciliation_required', 'Historical source requires explicit reconciliation');
  }
  return { ok: true, value: state };
}
export function artifactRequiredProjects(db: Db, artifactId: string | null, ...sources: (ArtifactSource | null)[]): string[] {
  return [...new Set([...(artifactId ? artifactAccessProjectIds(db, artifactId) : []),
    ...sources.map(s => s?.kind === 'repo' ? s.project_id : null)].filter((id): id is string => Boolean(id)))].sort();
}
export interface ArtifactSourceMoveInput { artifact_id: string; expected_revision: number; source: ArtifactSource; actor: string; reconcile?: boolean }
export interface ArtifactSourceMovePlan extends ArtifactSourceMoveInput {
  previous_source: ArtifactSource | null;
  required_project_ids: string[];
}
const movePlans = new WeakMap<ArtifactSourceMovePlan, { db: Db; frozen: string }>();
export function planArtifactSourceMove(db: Db, input: ArtifactSourceMoveInput): ArtifactLifecycleResult<ArtifactSourceMovePlan> {
  const valid = validateArtifactSource(db, input.source);
  if (!valid.ok) return valid;
  const state = getArtifactCurrentSource(db, input.artifact_id);
  if (!state) return artifactFailure('unknown_artifact', 'Canonical artifact not found');
  if (state.reconciliation_reason && input.reconcile !== true) return artifactFailure('reconciliation_required', state.reconciliation_reason);
  if (state.revision !== input.expected_revision) return artifactFailure('stale_plan', 'Current source revision changed');
  if (!input.actor.trim()) return artifactFailure('invalid_input', 'Source moves require an authenticated actor');
  const target = db.prepare('SELECT artifact_id FROM artifact_source WHERE source_json=? AND artifact_id != ?').all(sourceKey(valid.value),input.artifact_id);
  if (target.length) return artifactFailure('source_mismatch', 'Destination source already belongs to another artifact');
  const plan = { ...input, source: valid.value, previous_source: state.source,
    required_project_ids: artifactRequiredProjects(db, input.artifact_id, state.source, valid.value) };
  if (state.reconciliation_reason) {
    const historical = db.prepare('SELECT DISTINCT source_project_id FROM artifact_version WHERE artifact_id=? AND source_project_id IS NOT NULL').all(input.artifact_id) as {source_project_id:string}[];
    plan.required_project_ids = [...new Set([...plan.required_project_ids,...historical.map(row=>row.source_project_id)])].sort();
  }
  movePlans.set(plan, {db, frozen: JSON.stringify(plan)});
  return { ok: true, value: plan };
}
export function commitArtifactSourceMove(db: Db, plan: ArtifactSourceMovePlan, now = Date.now()): ArtifactLifecycleResult<ArtifactSourceState> {
  const issued = movePlans.get(plan);
  if (!issued || issued.db !== db || issued.frozen !== JSON.stringify(plan)) return artifactFailure('stale_plan', 'Source move plan is not an unchanged issued plan');
  try {
    return db.transaction((): ArtifactLifecycleResult<ArtifactSourceState> => {
      const current = planArtifactSourceMove(db, plan);
      if (!current.ok) return current;
      if (JSON.stringify(current.value) !== issued.frozen) return artifactFailure('stale_plan', 'Source move authorization facts changed');
      const state = getArtifactCurrentSource(db, plan.artifact_id)!;
      if (!state.reconciliation_reason && state.source && sourceKey(state.source) === sourceKey(plan.source)) return { ok: true, value: state };
      db.prepare('UPDATE artifact_source SET source_json=?, revision=revision+1, reconciliation_reason=NULL, updated_at=? WHERE artifact_id=?')
        .run(sourceKey(plan.source), now, plan.artifact_id);
      db.prepare(`INSERT INTO artifact_source_move (id,artifact_id,previous_source_json,source_json,previous_revision,revision,actor,created_at,request_origin_json) VALUES (?,?,?,?,?,?,?,?,?)`).run(crypto.randomUUID(), plan.artifact_id,
        plan.previous_source ? sourceKey(plan.previous_source) : null, sourceKey(plan.source), plan.expected_revision,
        plan.expected_revision + 1, plan.actor, now, requestOriginJson());
      return { ok: true, value: getArtifactCurrentSource(db, plan.artifact_id)! };
    }).immediate();
  } catch (error) { return artifactFailure('storage_error', String(error)); }
}

export function artifactSourceLineage(db: Db, source: ArtifactSource): string[] {
  const key = sourceKey(source);
  const rows = db.prepare(`SELECT artifact_id FROM artifact_source WHERE source_json=?
    UNION SELECT artifact_id FROM artifact_source_move WHERE previous_source_json=? OR source_json=?
    UNION SELECT artifact_id FROM artifact_version WHERE source_project_id=? AND repo_path=?`)
    .all(key, key, key, source.kind === 'repo' ? source.project_id : null, source.kind === 'repo' ? source.path : null) as { artifact_id: string }[];
  return rows.map(row => row.artifact_id);
}
