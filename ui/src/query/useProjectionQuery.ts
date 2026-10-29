import { hashKey, useQuery, type UseQueryOptions } from '@tanstack/preact-query';
import { useLayoutEffect, useMemo } from 'preact/hooks';
import { useRegisterInitialRouteLoad } from '../app-shell';
import { queryClient } from './client';

/** Observe a projection and release an abandoned read only when no enabled observer remains. */
export function useProjectionQuery<T>(options: UseQueryOptions<T>, active: boolean) {
  const hash = hashKey(options.queryKey);
  const live = useMemo(() => ({ active }), [hash]);
  live.active = active;
  const query = useQuery({ ...options, enabled: () => live.active }, queryClient);
  const register = useRegisterInitialRouteLoad();
  useLayoutEffect(() => {
    live.active = active;
    return () => {
      live.active = false;
      const current = queryClient.getQueryCache().find({ queryKey: options.queryKey, exact: true });
      if (current && !current.isActive()) void queryClient.cancelQueries({ queryKey: options.queryKey, exact: true });
    };
  }, [live, active]);
  useLayoutEffect(() => {
    if (!active) return undefined;
    const current = queryClient.getQueryCache().find({ queryKey: options.queryKey, exact: true });
    if (current?.promise && query.fetchStatus === 'fetching') return register(current.promise);
    if (!query.isPending) return register(Promise.resolve());
    return undefined;
  }, [active, hash, query.fetchStatus, query.isPending, register]);
  return query;
}
