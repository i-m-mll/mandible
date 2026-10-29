import { hashKey, queryOptions, type UseQueryOptions } from "@tanstack/preact-query";
import { isApiErrorStatus } from "../api";
import { readPersistedDetail, writePersistedDetail, removePersistedDetail, ROUTE_DATA_FRESH_MS } from "../detail-cache";
import { isProjectionKey } from './projectionKeys';
import { LIVE_REFRESH_DEADLINE_MS, RefreshDeadlineError } from '../lib/coalesced-refresh';

async function readProjection<T>(load: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const abandon = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abandon, { once: true });
  const failed = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
  });
  const deadline = setTimeout(() => controller.abort(new RefreshDeadlineError(LIVE_REFRESH_DEADLINE_MS)), LIVE_REFRESH_DEADLINE_MS);
  try {
    return await Promise.race([load(controller.signal), failed]);
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener('abort', abandon);
  }
}

export function snapshotOptions<T>(queryKey: readonly unknown[], load: (signal: AbortSignal) => Promise<T>, accept: (data: T) => boolean = () => true) {
  const namespace = `${queryKey[0]}-query-snapshot`;
  const key = hashKey(queryKey);
  const restartSnapshot = () => {
    const data = readPersistedDetail<T>(namespace, key);
    return data && accept(data) ? data : undefined;
  };
  return { ...queryOptions<T>({
    queryKey,
    staleTime: ROUTE_DATA_FRESH_MS,
    placeholderData: restartSnapshot as UseQueryOptions<T>['placeholderData'],
    queryFn: async ({ signal }) => {
      const data = await (isProjectionKey(queryKey) ? readProjection(load, signal) : load(signal)).catch((error: unknown) => {
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

export function removeRestartSnapshot(queryKey: readonly unknown[]): void {
  removePersistedDetail(`${queryKey[0]}-query-snapshot`, hashKey(queryKey));
}

export function writeRestartSnapshot(queryKey: readonly unknown[], data: unknown): void {
  writePersistedDetail(`${queryKey[0]}-query-snapshot`, hashKey(queryKey), data);
}

export function detailQueryData<T>(query: { data: T | undefined; isError: boolean }, options: { restartSnapshot: () => T | undefined }): T | undefined {
  return query.data ?? (query.isError ? options.restartSnapshot() : undefined);
}
