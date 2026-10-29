import { keepPreviousData, queryOptions } from '@tanstack/preact-query';
import {
  getLedgerIssueDetailByIssueId, getLedgerIssueDetailByRef,
  getArtifact, getArtifactContent, getArtifactKnowledgeBackrefs, getArtifactVersions,
  getArtifactSeriesList, resolveArtifact, type ArtifactQueryParams,
} from '../api';
import { ROUTE_DATA_FRESH_MS } from '../detail-cache';
import { snapshotOptions } from './snapshots';
export { detailQueryData } from './snapshots';
import { detailKeys } from './detailKeys';

export function issueDetailOptions(id: string | null, repo?: string) {
  const key = detailKeys.issue(id, repo);
  return snapshotOptions(key, (signal) => key[2]
    ? getLedgerIssueDetailByRef(key[2], key[1]!, { signal })
    : getLedgerIssueDetailByIssueId(key[1]!, { signal }));
}

export const artifactResolutionOptions = (ref: string | null) =>
  snapshotOptions(detailKeys.resolution(ref), (signal) => resolveArtifact(ref!, { signal }));
export const artifactVersionsOptions = (ref: string | null) =>
  snapshotOptions(detailKeys.versions(ref), async (signal) => {
    const history = await getArtifactVersions(ref!, { signal });
    return { ...history, versions: [...history.versions].sort((a, b) => b.version_no - a.version_no) };
  });
export const artifactRecordOptions = (id: string | null) =>
  snapshotOptions(detailKeys.record(id), (signal) => getArtifact(id!, { signal }), (data) => data.id === id);
export const artifactContentOptions = (id: string | null) =>
  snapshotOptions(detailKeys.content(id), (signal) => getArtifactContent(id!, { signal }), (data) => data.artifact_id === id);
export const artifactBackrefsOptions = (id: string | null) =>
  snapshotOptions(detailKeys.backrefs(id), (signal) => getArtifactKnowledgeBackrefs(id!, { signal }));
export const artifactListOptions = (params: ArtifactQueryParams) => queryOptions({
  queryKey: detailKeys.list(params),
  queryFn: ({ signal }) => getArtifactSeriesList(params, { signal }),
  staleTime: ROUTE_DATA_FRESH_MS,
  placeholderData: keepPreviousData,
});

export const queryErrorMessage = (error: Error | null) => error?.message ?? null;
