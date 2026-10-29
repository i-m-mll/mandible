import { keepPreviousData, queryOptions, type UseQueryOptions } from '@tanstack/preact-query';
import {
  getLedgerIssueDetailByIssueId, getLedgerIssueDetailByRef,
  getArtifact, getArtifactContent, getArtifactKnowledgeBackrefs, getArtifactVersions,
  getArtifactSeriesList, resolveArtifact, type ArtifactQueryParams,
  isApiErrorStatus,
} from '../api';
import { readPersistedDetail, writePersistedDetail, removePersistedDetail, ROUTE_DATA_FRESH_MS } from '../detail-cache';
import { detailKeys } from './detailKeys';

function snapshotOptions<T>(queryKey: readonly unknown[], load: (signal: AbortSignal) => Promise<T>, accept: (data: T) => boolean = () => true) {
  const namespace = `${queryKey[0]}-query-snapshot`;
  const key = JSON.stringify(queryKey);
  const restartSnapshot = () => {
    const data = readPersistedDetail<T>(namespace, key);
    return data && accept(data) ? data : undefined;
  };
  return { ...queryOptions<T>({
    queryKey,
    staleTime: ROUTE_DATA_FRESH_MS,
    placeholderData: restartSnapshot as UseQueryOptions<T>['placeholderData'],
    queryFn: async ({ signal }) => {
      const data = await load(signal).catch((error: unknown) => {
        if (isApiErrorStatus(error, 404) || isApiErrorStatus(error, 409)) removePersistedDetail(namespace, key);
        throw error;
      });
      signal.throwIfAborted();
      if (!accept(data)) throw new Error('Detail response does not match the selected identity');
      writePersistedDetail(namespace, key, data);
      return data;
    },
  }), restartSnapshot };
}

export function detailQueryData<T>(query: { data: T | undefined; isError: boolean }, options: { restartSnapshot: () => T | undefined }): T | undefined {
  return query.data ?? (query.isError ? options.restartSnapshot() : undefined);
}

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
