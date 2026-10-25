import { hashKey, type Query, type QueryClient, type QueryKey } from '@tanstack/preact-query';
import { createCoalescedRefresh, RefreshDeadlineError } from '../lib/coalesced-refresh';
import { conversationKeys, normalizeSidebarFilters, type ConversationSidebarFilters } from './conversationKeys';

const replayPending = new WeakSet<Query>();

function replayAfterFetch(client: QueryClient, query: Query): void {
  if (replayPending.has(query)) return;
  replayPending.add(query);
  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (event.query !== query) return;
    const settled = event.type === 'updated' && (event.action.type === 'success' || event.action.type === 'error');
    if (!settled && event.type !== 'removed') return;
    unsubscribe();
    replayPending.delete(query);
    if (settled) query.invalidate();
  });
}

/**
 * Marks the sidebar lists under `queryKey` stale without fetching them; a running
 * `startSidebarRefresh` refetches them. A list that is fetching is marked stale again once
 * that fetch settles, because the settled response may predate the change.
 */
export function markSidebarListsStale(
  client: QueryClient,
  queryKey: QueryKey = conversationKeys.sidebars(),
  exact = false,
): void {
  for (const query of client.getQueryCache().findAll({ queryKey, exact })) {
    if (query.state.fetchStatus === 'fetching') replayAfterFetch(client, query);
    query.invalidate();
  }
}

/**
 * Refetches the stale sidebar lists for `filters` through one coalesced refresh
 * (`createCoalescedRefresh`): at most one refresh in flight, starts at least
 * `LIVE_REFRESH_MIN_INTERVAL_MS` apart. Lists marked stale before it started are refreshed
 * as soon as it starts. A refresh past the run deadline is cancelled and its lists fail with
 * the `RefreshDeadlineError`, which the sidebar reports like any failed refresh.
 */
export function startSidebarRefresh(
  client: QueryClient,
  filters: ConversationSidebarFilters,
): () => void {
  const cache = client.getQueryCache();
  const scope = hashKey([normalizeSidebarFilters(filters)]);
  const inScope = (query: Query): boolean => {
    const key = query.queryKey;
    return key[0] === 'chat' && key[1] === 'sidebar' && hashKey([key[3]]) === scope;
  };
  const due = (query: Query): boolean => (
    inScope(query) && query.state.isInvalidated && query.state.fetchStatus !== 'fetching'
  );
  const refresh = createCoalescedRefresh((signal) => {
    const targets = cache.findAll({ queryKey: conversationKeys.sidebars() }).filter(due);
    signal.addEventListener('abort', () => {
      const error = signal.reason;
      if (!(error instanceof RefreshDeadlineError)) return;
      for (const query of targets) {
        if (query.state.fetchStatus !== 'fetching') continue;
        void query.cancel({ revert: true }).then(() => query.setState({
          status: 'error',
          error,
          errorUpdatedAt: Date.now(),
          errorUpdateCount: query.state.errorUpdateCount + 1,
          fetchStatus: 'idle',
          // Not stale: the next change marks it stale again; a failed refresh is not retried.
          isInvalidated: false,
        }));
      }
    }, { once: true });
    return client.refetchQueries(
      { queryKey: conversationKeys.sidebars(), type: 'all', predicate: (query) => targets.includes(query) },
      { cancelRefetch: false },
    );
  });
  const unsubscribe = cache.subscribe((event) => {
    if (event.type === 'updated' && event.action.type === 'invalidate' && inScope(event.query)) refresh.request();
  });
  if (cache.findAll({ queryKey: conversationKeys.sidebars() }).some(due)) refresh.request();

  return () => {
    unsubscribe();
    refresh.stop();
  };
}
