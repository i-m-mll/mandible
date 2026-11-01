import type { Db } from "../db.js";

export type ArtifactProjectResolution =
  | { ok: true; project_id: string }
  | { ok: false; reason: "ambiguous" | "unassociated" };

export function artifactProjectIds(db: Db, artifactOrVersionId: string): string[] {
  const rows = db.prepare(`WITH ids(tid) AS (SELECT @id),
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
  ) ORDER BY tid, project_id`).all({ id: artifactOrVersionId }) as Array<{ tid: string; project_id: string }>;
  return rows.map(row => row.project_id);
}

function projectResolution(projects: readonly string[]): ArtifactProjectResolution {
  if (projects.length === 0) return { ok: false, reason: "unassociated" };
  if (projects.length > 1) return { ok: false, reason: "ambiguous" };
  return { ok: true, project_id: projects[0] };
}

export function resolveArtifactProject(db: Db, artifactOrVersionId: string): ArtifactProjectResolution {
  return projectResolution(artifactProjectIds(db, artifactOrVersionId));
}
