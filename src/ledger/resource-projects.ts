import type { Db } from "../db.js";

export type ArtifactProjectResolution =
  | { ok: true; project_id: string }
  | { ok: false; reason: "ambiguous" | "unassociated" };

export function resolveArtifactProject(db: Db, artifactOrVersionId: string): ArtifactProjectResolution {
  const projects = db.prepare(`WITH logical AS (
    SELECT id, source_project_id FROM artifact WHERE id = @id
    UNION
    SELECT a.id, a.source_project_id FROM artifact_version v
      JOIN artifact a ON a.id = v.artifact_id WHERE v.id = @id
  ) SELECT source_project_id AS project_id FROM logical WHERE source_project_id IS NOT NULL
    UNION
    SELECT association.project_id FROM logical
      JOIN project_artifact_associations association
        ON association.target_type = 'artifact' AND association.target_id = logical.id
      WHERE association.association_kind = 'canonical' AND association.status = 'active'
    ORDER BY project_id`).all({ id: artifactOrVersionId }) as Array<{ project_id: string }>;
  if (projects.length === 0) return { ok: false, reason: "unassociated" };
  if (projects.length > 1) return { ok: false, reason: "ambiguous" };
  return { ok: true, project_id: projects[0].project_id };
}
