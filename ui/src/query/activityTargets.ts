import { useQueries } from '@tanstack/preact-query';
import { useMemo } from 'preact/hooks';
import { activityTargetKey, type ActivityTarget, type ActivityTargetResolution } from '../../../src/presentation/activity-targets';
import { resolveActivityTargets } from '../api';
import { queryClient } from './client';

export const activityTargetQueries = ['chat', 'activity-target'] as const;
type Pending = { target: ActivityTarget; signal: AbortSignal; resolve: (value: ActivityTargetResolution) => void; reject: (error: unknown) => void };
let pending: Pending[] = [];

/** Individual cache identities share one bounded metadata request in each query turn. */
function resolveBatched(target: ActivityTarget, signal: AbortSignal): Promise<ActivityTargetResolution> {
  return new Promise((resolve, reject) => {
    pending.push({target, signal, resolve, reject});
    if (pending.length !== 1) return;
    queueMicrotask(() => {
      const requests = pending; pending = [];
      for (let offset = 0; offset < requests.length; offset += 64) {
        const batch = requests.slice(offset, offset + 64);
        const controller = new AbortController();
        const abort = () => { if (batch.every(request => request.signal.aborted)) controller.abort(); };
        for (const request of batch) request.signal.addEventListener('abort', abort, {once:true});
        abort();
        void resolveActivityTargets(batch.map(request => request.target), controller.signal).then(values => {
          const byKey = new Map(values.map(value => [value.key, value]));
          for (const request of batch) {
            const value = byKey.get(activityTargetKey(request.target));
            if (!value) request.reject(new Error('Activity target resolution omitted a requested identity.'));
            else request.resolve(value);
          }
        }, error => { for (const request of batch) request.reject(error); }).finally(() => {
          for (const request of batch) request.signal.removeEventListener('abort', abort);
        });
      }
    });
  });
}

export function activityTargetOptions(target: ActivityTarget) {
  const {labelHint: _hint, ...identity} = target;
  return {queryKey:[...activityTargetQueries, activityTargetKey(target)] as const,
    queryFn: ({signal}:{signal:AbortSignal}) => resolveBatched(identity, signal), staleTime: Infinity};
}

export function useActivityTargetResolutions(targets: readonly ActivityTarget[]): ReadonlyMap<string, ActivityTargetResolution> {
  const identities = useMemo(() => [...new Map(targets.filter(target => target.kind !== 'pending-thread').map(target => [activityTargetKey(target),target])).values()], [targets]);
  const queries = useQueries({queries: identities.map(activityTargetOptions)}, queryClient);
  const values = queries.flatMap(query => query.data ? [query.data] : []);
  const signature = JSON.stringify(values);
  return useMemo(() => new Map(values.map(value => [value.key,value])), [signature]);
}

/** Metadata reconciliation never invalidates source-row/body queries. */
export function invalidateActivityTargets(client: typeof queryClient, conversationId?: string): void {
  void client.invalidateQueries({queryKey:activityTargetQueries, predicate: query => {
    const value = query.state.data as ActivityTargetResolution | undefined;
    return !conversationId || !value || value.status !== 'resolved' || value.conversationId === conversationId;
  }});
}
