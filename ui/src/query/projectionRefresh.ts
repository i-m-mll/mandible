import type { Query, QueryClient, QueryKey } from '@tanstack/preact-query';
import { createCoalescedRefresh } from '../lib/coalesced-refresh';
import { isProjectionKey } from './projectionKeys';

const owners = new WeakMap<QueryClient, { invalidate: (key?: QueryKey) => void }>();

/** Query owns payloads and reads; one scheduler bounds live projection reconciliation. */
export function invalidateProjectionQueries(client: QueryClient, key?: QueryKey): void {
  let owner = owners.get(client);
  if (!owner) {
    const cache = client.getQueryCache();
    const trailing = new WeakSet<Query>();
    const refresh = createCoalescedRefresh(() => {
      const targets = cache.getAll().filter((query) => isProjectionKey(query.queryKey)
        && query.isActive() && query.state.isInvalidated && query.state.fetchStatus !== 'fetching');
      return client.refetchQueries({ predicate: (query) => targets.includes(query) }, { cancelRefetch: false });
    }, { deadlineMs: null });
    const unsubscribe = cache.subscribe((event) => {
      const query = event.query;
      if (!isProjectionKey(query.queryKey)) return;
      if (event.type === 'updated' && (event.action.type === 'success' || event.action.type === 'error') && trailing.delete(query)) {
        query.invalidate();
        refresh.request();
      }
      if (event.type === 'removed' && !cache.getAll().some((entry) => isProjectionKey(entry.queryKey))) {
        refresh.stop();
        unsubscribe();
        owners.delete(client);
      }
    });
    owner = {
      invalidate(queryKey) {
        const targets = cache.findAll(queryKey ? { queryKey } : {}).filter((query) => isProjectionKey(query.queryKey));
        for (const query of targets) {
          if (query.state.fetchStatus === 'fetching') trailing.add(query);
          query.invalidate();
        }
        if (targets.length) refresh.request();
      },
    };
    owners.set(client, owner);
  }
  owner.invalidate(key);
}
