import { hashKey, keepPreviousData, queryOptions, type QueryKey } from '@tanstack/preact-query';
import {
  getLedgerIssueDetailByIssueId, getLedgerIssueDetailByRef,
  getLedgerIssueInitialDetailByIssueId, getLedgerIssueInitialDetailByRef, type LedgerIssueDetailProjection,
  getArtifact, getArtifactContent, getArtifactKnowledgeBackrefs, getArtifactVersions,
  getArtifactSeriesList, resolveArtifact, type ArtifactQueryParams,
  isApiErrorStatus,
} from '../api';
import { ROUTE_DATA_FRESH_MS } from './policy';
import { removeRestartSnapshot, snapshotOptions, writeRestartSnapshot } from './snapshots';
export { detailQueryData } from './snapshots';
import { detailKeys } from './detailKeys';
import { queryClient } from './client';

export function issueDetailOptions(id: string | null, repo?: string) {
  const key = detailKeys.issue(id, repo);
  return snapshotOptions(key, (signal) => (key[2]
    ? getLedgerIssueDetailByRef(key[2], key[1]!, { signal })
    : getLedgerIssueDetailByIssueId(key[1]!, { signal })).catch((error: unknown) => {
      if (isApiErrorStatus(error, 404) || isApiErrorStatus(error, 409)) removeRestartSnapshot([...key, 'initial']);
      throw error;
    }));
}

export function issueInitialDetailOptions(id: string | null, repo?: string) {
  const key = detailKeys.issue(id, repo);
  return snapshotOptions([...key, 'initial'], (signal) => key[2]
    ? getLedgerIssueInitialDetailByRef(key[2], key[1]!, { signal })
    : getLedgerIssueInitialDetailByIssueId(key[1]!, { signal }));
}

export async function publishIssueDetail(key: QueryKey, detail: LedgerIssueDetailProjection): Promise<void> {
  const canonical = detailKeys.issue(detail.id);
  const requestedHash = hashKey(key);
  const canonicalHash = hashKey(canonical);
  const targets = queryClient.getQueryCache().findAll({ queryKey: detailKeys.issues }).filter((query) =>
    query.queryHash === requestedHash || query.queryHash === canonicalHash
      || (query.state.data as LedgerIssueDetailProjection | undefined)?.id === detail.id);
  await Promise.all(targets.map((query) => queryClient.cancelQueries({ queryKey: query.queryKey, exact: true })));
  for (const query of targets) {
    queryClient.setQueryData(query.queryKey, detail);
    writeRestartSnapshot(query.queryKey, detail);
  }
  queryClient.setQueryData(key, detail);
  writeRestartSnapshot(key, detail);
  queryClient.setQueryData(canonical, detail);
  writeRestartSnapshot(canonical, detail);
}

export async function refreshIssueDetail(options: ReturnType<typeof issueDetailOptions>): Promise<LedgerIssueDetailProjection> {
  await queryClient.cancelQueries({ queryKey: options.queryKey, exact: true });
  await queryClient.invalidateQueries({ queryKey: options.queryKey, exact: true, refetchType: 'none' });
  return queryClient.fetchQuery(options);
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
