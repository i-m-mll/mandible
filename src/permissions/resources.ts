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

/** Project access constraints are ownership and explicit associations, never version provenance. */
export function artifactAccessProjectIds(db: Db, artifactOrVersionId: string): string[] {
  return (db.prepare(`WITH target AS (
    SELECT id artifact_id, NULL version_id FROM artifact WHERE id=@id
    UNION ALL SELECT artifact_id, id version_id FROM artifact_version WHERE id=@id OR blob_id=@id
  ) SELECT DISTINCT project_id FROM (
    SELECT project_id FROM project_artifact_associations WHERE target_id=@id AND status='active'
    UNION
    SELECT a.source_project_id project_id FROM artifact a JOIN target t ON a.id=t.artifact_id
      WHERE a.source_project_id IS NOT NULL
    UNION
    SELECT pa.project_id FROM project_artifact_associations pa JOIN target t
      ON (pa.target_type='artifact' AND pa.target_id=t.artifact_id)
      OR (pa.target_type='artifact_version' AND (pa.target_id=t.version_id OR
        (t.version_id IS NULL AND pa.target_id IN (SELECT id FROM artifact_version WHERE artifact_id=t.artifact_id))))
      WHERE pa.status='active'
  ) ORDER BY project_id`).all({id: artifactOrVersionId}) as {project_id:string}[]).map(row => row.project_id);
}

export function resolveArtifactProject(db: Db, artifactOrVersionId: string): ResourceProjectResolution {
  const projects = artifactAccessProjectIds(db, artifactOrVersionId);
  if (projects.length === 0) return { ok: false, reason: "unassociated" };
  if (projects.length > 1) return { ok: false, reason: "ambiguous" };
  return { ok: true, project_id: projects[0] };
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
