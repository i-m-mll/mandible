import type { ArtifactResolveResult } from '../../src/contracts.js';

const histories = new WeakMap<object, { series: any; version: any }>();
export function registerArtifactFixtureHistory(artifact: object, series: any, version: any): void {
  histories.set(artifact, { series, version });
}

/** Author HTTP fixtures with canonical identity records alongside historical read fields. */
export function makeArtifactResolution(input: any): ArtifactResolveResult {
  if (input.status !== 'resolved') return { ...input, kind: input.status, target_id: null,
    requested_kind: 'unknown', logical_artifact: null, artifact_version: null, artifact_blob: null };
  const material = input.artifact;
  const blob = { ...material, id: `artifact-blob:${material.content_hash}`, storage_uri: material.uri,
    metadata: material.metadata ?? {}, ...input.artifact_blob };
  const saved = input.target_type === 'artifact_blob' ? undefined : histories.get(material);
  const historicalSeries = input.series ?? saved?.series;
  const historicalVersion = input.version ?? input.artifact_version ?? saved?.version;
  const logicalId = input.target_type === 'artifact_blob' ? null : input.logical_artifact?.id ?? historicalSeries?.id?.replace(/^artifact-series:/, 'artifact:');
  const logical = logicalId ? { id: logicalId, identity_key: historicalSeries?.series_key ?? logicalId,
    source_kind: historicalSeries?.source_kind ?? 'managed', source_project_id: null, source_repo_id: null,
    source_path: null, logical_name: historicalSeries?.logical_name ?? null, title: historicalSeries?.title ?? null,
    latest_version_id: historicalVersion?.id ?? null, version_count: historicalSeries?.version_count ?? 1,
    metadata: historicalSeries?.metadata ?? {}, created_at: material.created_at, updated_at: material.created_at,
    ...input.logical_artifact } : null;
  const version = historicalVersion && logical ? { ...historicalVersion, artifact_id: logical.id,
    blob_id: blob.id, source_project_id: null, source_repo_id: null, parent_version_id: null,
    metadata: historicalVersion.metadata ?? {} } : null;
  const targetType = input.target_type ?? (logical ? (input.scheme === 'artifact-series' ? 'artifact' : 'artifact_version') : 'artifact_blob');
  return { ...input, kind: targetType === 'artifact' ? 'logical' : targetType === 'artifact_version' ? 'pinned-version' : 'blob',
    target_type: targetType, target_id: targetType === 'artifact' ? logical.id : targetType === 'artifact_version' ? version.id : blob.id,
    logical_artifact: logical, artifact_version: version, artifact_blob: blob };
}
