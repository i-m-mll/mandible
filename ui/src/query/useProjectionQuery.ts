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
    const release = active ? register(queryClient.fetchQuery(options).then(() => undefined, () => undefined)) : () => undefined;
    return () => {
      release();
      live.active = false;
      const current = queryClient.getQueryCache().find({ queryKey: options.queryKey, exact: true });
      if (current && !current.isActive()) void queryClient.cancelQueries({ queryKey: options.queryKey, exact: true });
    };
  }, [live, active]);
  return query;
}
