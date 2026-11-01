import type { Db } from "../db.js";
import { listArtifactSeries, projectArtifactPublicValue } from "../provider-artifacts.js";

export function artifactSeries(db: Db, { options }: {
  options: NonNullable<Parameters<typeof listArtifactSeries>[1]>;
}) {
  const series = listArtifactSeries(db, options);
  return projectArtifactPublicValue(db, { series });
}
