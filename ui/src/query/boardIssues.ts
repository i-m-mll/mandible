import { hashKey, queryOptions, useQueries, type QueryClient } from '@tanstack/preact-query';
import { useLayoutEffect, useMemo, useRef } from 'preact/hooks';
import PQueue from 'p-queue';
import { useRegisterInitialRouteLoad, useViewActive } from '../app-shell';
import { resolveResourceRef } from '../resource-refs';
import type { SpaceViewModel } from '../views/spaces/types';
import { spaceItemRef } from '../views/spaces/itemRef';
import { issueFactsFromEntity, type IssueFactsByItemId } from '../views/spaces/boardModel';
import { queryClient } from './client';
import { ROUTE_DATA_FRESH_MS } from './policy';
import { readWithDeadline } from './readWithDeadline';

const queues = new WeakMap<QueryClient, PQueue>();
export const boardIssueKey = (ref: string, project: string | null) => {
  const normalized = ref.trim();
  return ['board-issue', normalized, /^issue:[a-f0-9]{64}$/i.test(normalized) ? null : project] as const;
};

export function boardIssueOptions(ref: string, project: string | null, client = queryClient, load = resolveResourceRef) {
  const queryKey = boardIssueKey(ref, project);
  let queue = queues.get(client);
  if (!queue) {
    queue = new PQueue({ concurrency: 4 });
    queues.set(client, queue);
  }
  return queryOptions({
    queryKey,
    staleTime: queryKey[2] === null && /^issue:[a-f0-9]{64}$/i.test(queryKey[1]) ? ROUTE_DATA_FRESH_MS : 0,
    retry: false,
    queryFn: ({ signal }) => queue.add(() => readWithDeadline(
      (readSignal) => load(queryKey[1], { project: queryKey[2] ?? undefined, signal: readSignal }), signal,
    ), { signal }),
  });
}

export function useBoardIssueFacts(model: SpaceViewModel | null) {
  const active = useViewActive();
  const register = useRegisterInitialRouteLoad();
  const items = useMemo(() => {
    if (!model) return [];
    const placed = new Set(model.occurrences.filter((entry) => entry.renderer === 'board').map((entry) => entry.item?.id));
    return Object.values(model.itemsById).filter((item) => item.ref_type === 'issue' && placed.has(item.id));
  }, [model]);
  const identities = items.map((item) => boardIssueKey(spaceItemRef(item), model!.space.project_id));
  const keys = [...new Map(identities.map((key) => [hashKey(key), key])).entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, key]) => key);
  const signature = JSON.stringify(keys);
  const group = useMemo(() => ({ active, keys: new Set<string>() }), []);
  const previousActive = group.active;
  group.active = active;
  group.keys = new Set(keys.map((key) => hashKey(key)));
  const verification = useRef(new Map<string, number>());
  if (!active || !previousActive) verification.current.clear();
  for (const hash of verification.current.keys()) if (!group.keys.has(hash)) verification.current.delete(hash);
  for (const key of keys) {
    const hash = hashKey(key);
    if (!verification.current.has(hash)) verification.current.set(hash, queryClient.getQueryState(key)?.dataUpdateCount ?? 0);
  }
  const entries = useMemo(() => keys.map((key) => ({
    options: boardIssueOptions(key[1], key[2]),
    enabled: () => group.active && group.keys.has(hashKey(key)),
  })), [signature]);
  const results = useQueries({ queries: entries.map(({ options, enabled }) => ({ ...options, enabled })) }, queryClient);
  const observed = useRef(new Set<string>());
  useLayoutEffect(() => () => { group.active = false; }, []);
  useLayoutEffect(() => {
    const added = entries.filter(({ options }) => !observed.current.has(hashKey(options.queryKey))
      || queryClient.getQueryState(options.queryKey)?.fetchStatus === 'fetching');
    observed.current = active ? new Set(entries.map(({ options }) => hashKey(options.queryKey))) : new Set();
    const release = active ? register(Promise.allSettled(added.map(({ options }) => queryClient.fetchQuery(options)))) : () => undefined;
    return () => {
      release();
      for (const { options } of entries) {
        const query = queryClient.getQueryCache().find({ queryKey: options.queryKey, exact: true });
        if (query && !query.isActive()) void queryClient.cancelQueries({ queryKey: options.queryKey, exact: true });
      }
    };
  }, [entries, active]);
  const verified = entries.map(({ options }, index) => {
    const { dataUpdatedAt, isFetching, isSuccess } = results[index];
    const successfulReads = queryClient.getQueryState(options.queryKey)?.dataUpdateCount ?? 0;
    return /^issue:[a-f0-9]{64}$/i.test(options.queryKey[1])
      || (successfulReads > verification.current.get(hashKey(options.queryKey))!
        && (dataUpdatedAt > 0 || (!isFetching && isSuccess)));
  });
  const facts = useMemo(() => {
    const byKey = new Map(entries.map((entry, index) => [hashKey(entry.options.queryKey), verified[index] ? results[index].data : undefined]));
    const byItem: IssueFactsByItemId = {};
    items.forEach((item, index) => {
      const result = byKey.get(hashKey(identities[index]));
      if (result?.resolved && result.kind === 'issue') byItem[item.id] = issueFactsFromEntity(item.id, result.entity);
    });
    return byItem;
  }, [model, verified.join(','), ...results.map((result) => result.data)]);
  return { facts, failed: results.filter((result) => result.isError), pending: results.some((result) => result.isPending) };
}

