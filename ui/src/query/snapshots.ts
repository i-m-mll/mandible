import { queryOptions, type UseQueryOptions } from "@tanstack/preact-query";
import { isApiErrorStatus } from "../api";
import { readPersistedDetail, writePersistedDetail, removePersistedDetail, ROUTE_DATA_FRESH_MS } from "../detail-cache";

export function snapshotOptions<T>(queryKey: readonly unknown[], load: (signal: AbortSignal) => Promise<T>, accept: (data: T) => boolean = () => true) {
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

