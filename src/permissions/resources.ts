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
  return artifactAccessProjectIdsByTarget(db, [artifactOrVersionId]).get(artifactOrVersionId) ?? [];
}

/**
 * `artifactAccessProjectIds` for many artifact, version, or blob ids in one
 * statement. Every target type a check constraint admits is named, so each
 * association lookup is an index search.
 */
export function artifactAccessProjectIdsByTarget(db: Db, ids: readonly string[]): Map<string, string[]> {
  const projects = new Map<string, string[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return projects;
  const rows = db.prepare(`WITH ids(tid) AS (SELECT DISTINCT value FROM json_each(@ids)),
  target AS (
    SELECT i.tid, a.id artifact_id, NULL version_id FROM ids i JOIN artifact a ON a.id = i.tid
    UNION SELECT i.tid, v.artifact_id, v.id FROM ids i JOIN artifact_version v ON v.id = i.tid
    UNION SELECT i.tid, v.artifact_id, v.id FROM ids i JOIN artifact_version v ON v.blob_id = i.tid
  ) SELECT DISTINCT tid, project_id FROM (
    SELECT i.tid, pa.project_id FROM ids i JOIN project_artifact_associations pa
      ON pa.target_type IN ('artifact', 'artifact_version') AND pa.target_id = i.tid
      WHERE pa.status = 'active'
    UNION
    SELECT t.tid, a.source_project_id FROM target t JOIN artifact a ON a.id = t.artifact_id
      WHERE a.source_project_id IS NOT NULL
    UNION
    SELECT t.tid, pa.project_id FROM target t JOIN project_artifact_associations pa
      ON pa.target_type = 'artifact' AND pa.target_id = t.artifact_id
      WHERE pa.status = 'active'
    UNION
    SELECT t.tid, pa.project_id FROM target t JOIN project_artifact_associations pa
      ON pa.target_type = 'artifact_version' AND pa.target_id = t.version_id
      WHERE pa.status = 'active'
    UNION
    SELECT t.tid, pa.project_id FROM target t JOIN artifact_version v ON v.artifact_id = t.artifact_id
      JOIN project_artifact_associations pa ON pa.target_type = 'artifact_version' AND pa.target_id = v.id
      WHERE t.version_id IS NULL AND pa.status = 'active'
  ) ORDER BY tid, project_id`).all({ ids: JSON.stringify(ids) }) as Array<{ tid: string; project_id: string }>;
  for (const row of rows) projects.get(row.tid)?.push(row.project_id);
  return projects;
}

function projectResolution(projects: readonly string[]): ResourceProjectResolution {
  if (projects.length === 0) return { ok: false, reason: "unassociated" };
  if (projects.length > 1) return { ok: false, reason: "ambiguous" };
  return { ok: true, project_id: projects[0] };
}

export function resolveArtifactProject(db: Db, artifactOrVersionId: string): ResourceProjectResolution {
  return projectResolution(artifactAccessProjectIds(db, artifactOrVersionId));
}

/** `resolveArtifactProject` for many ids in one statement. */
export function resolveArtifactProjects(db: Db, ids: readonly string[]): Map<string, ResourceProjectResolution> {
  return new Map([...artifactAccessProjectIdsByTarget(db, ids)].map(([id, projects]) => [id, projectResolution(projects)]));
}

export function resolveWorkProject(db: Db, repoRef: string): ResourceProjectResolution {
  const resolved = resolveProjectRef(db, repoRef);
  if (resolved.ok) return { ok: true, project_id: resolved.project.id };
  return { ok: false, reason: resolved.reason === "ambiguous" ? "ambiguous" : "not_found" };
}
