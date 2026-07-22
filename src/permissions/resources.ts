import type { Db } from "../db.js";
import { resolveProjectRef } from "../ledger/project-registry.js";
import { LedgerStore } from "../ledger/store.js";

export type ResourceProjectResolution =
  | { ok: true; project_id: string }
  | { ok: false; reason: "not_found" | "ambiguous" | "unassociated" };

/** Resolve an issue ref first, then derive its canonical project identity. */
export function resolveIssueProject(
  db: Db,
  issueRef: string,
): ResourceProjectResolution {
  const resolved = new LedgerStore(db).resolveIssueRef(issueRef);
  if (!resolved.ok) {
    return { ok: false, reason: resolved.error === "ambiguous" ? "ambiguous" : "not_found" };
  }
  const row = db.prepare("SELECT project_id FROM ledger_issues WHERE id = ?")
    .get(resolved.id) as { project_id: string } | undefined;
  return row ? { ok: true, project_id: row.project_id } : { ok: false, reason: "not_found" };
}

/**
 * Resolve an artifact or version to its canonical project association. Multiple
 * distinct associations are deliberately ambiguous rather than choosing one.
 */
export function resolveArtifactProject(
  db: Db,
  artifactOrVersionId: string,
): ResourceProjectResolution {
  const rows = db.prepare(
    `SELECT DISTINCT project_id FROM (
       SELECT source_project_id AS project_id FROM artifact
        WHERE id = ? AND source_project_id IS NOT NULL
       UNION
       SELECT source_project_id AS project_id FROM artifact_version
        WHERE id = ? AND source_project_id IS NOT NULL
       UNION
       SELECT source_project_id AS project_id FROM artifact_version
        WHERE artifact_id = ? AND source_project_id IS NOT NULL
       UNION
      SELECT project_id FROM project_artifact_associations
        WHERE target_id = ? AND status = 'active'
       UNION
       SELECT a.source_project_id AS project_id
         FROM artifact_version v
         JOIN artifact a ON a.id = v.artifact_id
        WHERE v.id = ? AND a.source_project_id IS NOT NULL
       UNION
       SELECT pa.project_id
         FROM project_artifact_associations pa
         JOIN artifact_version v ON v.id = pa.target_id
        WHERE pa.target_type = 'artifact_version'
          AND v.artifact_id = ?
          AND pa.status = 'active'
     ) ORDER BY project_id`,
  ).all(
    artifactOrVersionId,
    artifactOrVersionId,
    artifactOrVersionId,
    artifactOrVersionId,
    artifactOrVersionId,
    artifactOrVersionId,
  ) as
    Array<{ project_id: string }>;
  if (rows.length === 0) return { ok: false, reason: "unassociated" };
  if (rows.length > 1) return { ok: false, reason: "ambiguous" };
  return { ok: true, project_id: rows[0].project_id };
}

/** Resolve work-scanner ids, checkout roots, or canonical refs to one project. */
export function resolveWorkProject(db: Db, repoRef: string): ResourceProjectResolution {
  const rows = db.prepare(
    `SELECT DISTINCT project_id FROM ledger_project_checkouts
      WHERE work_repo_id = ? OR root = ? OR id = ?
      ORDER BY project_id`,
  ).all(repoRef, repoRef, repoRef) as Array<{ project_id: string }>;
  if (rows.length > 1) return { ok: false, reason: "ambiguous" };
  if (rows.length === 1) return { ok: true, project_id: rows[0].project_id };
  const direct = resolveProjectRef(db, repoRef);
  if (direct.ambiguous) return { ok: false, reason: "ambiguous" };
  if (direct.ok && direct.project) return { ok: true, project_id: direct.project.id };
  return { ok: false, reason: "not_found" };
}
