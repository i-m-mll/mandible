import { hashKey, type Query, type QueryClient, type QueryKey } from '@tanstack/preact-query';
import { conversationKeys, normalizeSidebarFilters, type ConversationSidebarFilters } from './conversationKeys';

export const SIDEBAR_REFRESH_MIN_INTERVAL_MS = 1_000;

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
 * Refetches the stale sidebar lists for `filters`, starting at most one refresh per
 * `SIDEBAR_REFRESH_MIN_INTERVAL_MS` and never overlapping a fetch already in flight.
 * Lists marked stale before it started are refreshed as soon as it starts.
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
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let lastStartedAt = Number.NEGATIVE_INFINITY;
  let stopped = false;

  const schedule = (): void => {
    if (stopped || running || timer !== null) return;
    if (!cache.findAll({ queryKey: conversationKeys.sidebars() }).some(due)) return;
    timer = setTimeout(run, Math.max(0, lastStartedAt + SIDEBAR_REFRESH_MIN_INTERVAL_MS - Date.now()));
  };

  const run = async (): Promise<void> => {
    timer = null;
    running = true;
    lastStartedAt = Date.now();
    await client.refetchQueries(
      { queryKey: conversationKeys.sidebars(), type: 'all', predicate: due },
      { cancelRefetch: false },
    );
    running = false;
    schedule();
  };

  const unsubscribe = cache.subscribe((event) => {
    if (event.type === 'updated' && event.action.type === 'invalidate' && inScope(event.query)) schedule();
  });
  schedule();

  return () => {
    stopped = true;
    unsubscribe();
    if (timer !== null) clearTimeout(timer);
  };
}
