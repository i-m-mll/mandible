import type { Db } from "../db.js";
import type { ResolvedClientIdentity } from "../server.js";
import { resolveArtifactProjects } from "../permissions/resources.js";
import { requireProjectAccess } from "../permissions/store.js";
import { listArtifactSeries, projectArtifactPublicValue } from "../provider-artifacts.js";

/**
 * The entries of a list the caller may read: an entry is kept when its
 * artifact has no project, or one project the caller can read. An entry
 * without an artifact is kept.
 */
export function readableArtifactEntries<T>(db: Db, identity: ResolvedClientIdentity | null, entries: T[], artifactId: (entry: T) => string | null): T[] {
  const projects = resolveArtifactProjects(db, entries.flatMap((entry) => artifactId(entry) ?? []));
  const readable = new Map<string, boolean>();
  return entries.filter((entry) => {
    const id = artifactId(entry);
    if (id === null) return true;
    const project = projects.get(id)!;
    if (!project.ok) return project.reason === "unassociated";
    let allowed = readable.get(project.project_id);
    if (allowed === undefined) {
      try {
        requireProjectAccess(db, { client_identity: identity }, project.project_id, "read");
        allowed = true;
      } catch {
        allowed = false;
      }
      readable.set(project.project_id, allowed);
    }
    return allowed;
  });
}

export function artifactSeries(db: Db, { identity, options }: {
  identity: ResolvedClientIdentity | null;
  options: NonNullable<Parameters<typeof listArtifactSeries>[1]>;
}) {
  const series = listArtifactSeries(db, options);
  const readable = readableArtifactEntries(db, identity, series, entry => entry.latest_artifact?.id ?? null);
  return projectArtifactPublicValue(db, { series: readable });
}
