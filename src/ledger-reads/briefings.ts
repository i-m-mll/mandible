import type { Db } from "../db.js";
import type { ResolvedClientIdentity } from "../server.js";
import { listBriefings } from "../feedback/briefings.js";
import { resolveArtifactProject } from "../permissions/resources.js";
import { evaluateProjectAccess } from "../permissions/store.js";

export function briefingsList(db: Db, { viewer, identity }: {
  viewer: { userId: string; operator: boolean; projectScoped: boolean };
  identity: ResolvedClientIdentity | null;
}) {
  const briefings = listBriefings(db, viewer) as Array<{ logical_artifact_id: string | null }>;
  return { briefings: viewer.projectScoped ? briefings.filter(briefing => {
    if (!briefing.logical_artifact_id) return false;
    const scope = resolveArtifactProject(db, briefing.logical_artifact_id);
    return scope.ok && evaluateProjectAccess(db, { identity, project_id: scope.project_id, required_role: "read" }).allowed;
  }) : briefings };
}
