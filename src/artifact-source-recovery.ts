import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './db.js';
import {
  commitArtifactSourceMove, planArtifactSourceMove, sourceKey, validateArtifactSource,
  type ArtifactSource, type ArtifactSourceMoveHistoryShape,
} from './artifact-source.js';

export interface ArtifactSourceRecoveryDecision {
  artifact_id: string;
  previous_source: ArtifactSource | null;
  source: ArtifactSource;
  revision: number;
  basis: 'registered' | 'verified-git' | 'managed-identity' | 'collision-managed';
}

/** Runs only after version custody recovery; history never chooses a collision winner. */
export function reconcileRecoveredArtifactSources(
  db: Db,
  options: { collisions?: 'fail' | 'managed'; receipt_path?: string; history_shape?: ArtifactSourceMoveHistoryShape } = {},
): ArtifactSourceRecoveryDecision[] {
  return db.transaction(() => {
    const rows = db.prepare(`SELECT artifact_id,source_json,revision,reconciliation_reason
      FROM artifact_source WHERE reconciliation_reason IS NOT NULL ORDER BY artifact_id`).all() as {
        artifact_id: string; source_json: string | null; revision: number; reconciliation_reason: string;
      }[];
    const decisions: ArtifactSourceRecoveryDecision[] = rows.map(row => {
      if (row.reconciliation_reason !== 'historical_source_ambiguous') {
        throw new Error(`Source needs explicit reconciliation: ${row.artifact_id}: ${row.reconciliation_reason}`);
      }
      const previous = row.source_json ? JSON.parse(row.source_json) as ArtifactSource : null;
      if (previous) {
        const valid = validateArtifactSource(db, previous);
        if (!valid.ok) throw new Error(`Registered source is invalid: ${row.artifact_id}`);
        return { artifact_id: row.artifact_id, previous_source: previous, source: valid.value,
          revision: row.revision, basis: 'registered' };
      }
      const versions = db.prepare(`SELECT custody_mode,source_project_id,repo_path
        FROM artifact_version WHERE artifact_id=?`).all(row.artifact_id) as {
          custody_mode: string; source_project_id: string | null; repo_path: string | null;
        }[];
      if (!versions.length || versions.some(v => !['git','link','managed'].includes(v.custody_mode))) {
        throw new Error(`Source reconciliation requires recovered custody: ${row.artifact_id}`);
      }
      const locations = new Map<string, ArtifactSource>();
      for (const version of versions) {
        if (version.custody_mode === 'managed') continue;
        if (!version.source_project_id || !version.repo_path) throw new Error(`Incomplete Git source: ${row.artifact_id}`);
        const source: ArtifactSource = { kind: 'repo', project_id: version.source_project_id, path: version.repo_path };
        locations.set(sourceKey(source), source);
      }
      if (locations.size > 1) throw new Error(`Multiple historical Git locations require an explicit source decision: ${row.artifact_id}`);
      const source = locations.values().next().value ?? { kind: 'managed', key: row.artifact_id } as ArtifactSource;
      return { artifact_id: row.artifact_id, previous_source: null, source, revision: row.revision,
        basis: locations.size ? 'verified-git' : 'managed-identity' };
    });
    // Check the complete proposal before applying any source update.
    const originalKeys = new Map(decisions.map(decision => [decision.artifact_id, sourceKey(decision.source)]));
    for (const decision of decisions) {
      const key = originalKeys.get(decision.artifact_id)!;
      const existing = db.prepare('SELECT artifact_id FROM artifact_source WHERE source_json=? AND artifact_id<>?')
        .all(key, decision.artifact_id) as {artifact_id:string}[];
      const competing = decisions.filter(other => other.artifact_id !== decision.artifact_id
        && originalKeys.get(other.artifact_id) === key);
      const preservesSoleRegisteredSource = decision.basis === 'registered' && !existing.length
        && competing.every(other => other.basis !== 'registered');
      if (!preservesSoleRegisteredSource && (existing.length || competing.length)) {
        if (options.collisions !== 'managed') throw new Error(`Current source collision: ${decision.artifact_id}`);
        decision.source = { kind: 'managed', key: decision.artifact_id };
        decision.basis = 'collision-managed';
      }
    }
    if (decisions.length && options.receipt_path) {
      const bytes = JSON.stringify({ schema: 'mandible-artifact-source-recovery@1', decisions }, null, 2);
      fs.mkdirSync(path.dirname(options.receipt_path), { recursive: true });
      try { fs.writeFileSync(options.receipt_path, bytes, { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if (!fs.existsSync(options.receipt_path) || fs.readFileSync(options.receipt_path, 'utf8') !== bytes) throw error;
      }
    }
    for (const decision of decisions) {
      const plan = planArtifactSourceMove(db, { artifact_id: decision.artifact_id,
        expected_revision: decision.revision, source: decision.source, reconcile: true,
        actor: `migration:artifact-custody-v185:${decision.basis}` });
      if (!plan.ok) throw new Error(plan.error.message);
      const result = commitArtifactSourceMove(db, plan.value, Date.now(), options.history_shape);
      if (!result.ok) throw new Error(result.error.message);
    }
    return decisions;
  }).immediate();
}
