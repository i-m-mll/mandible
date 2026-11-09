import { keepPreviousData, type UseQueryOptions } from '@tanstack/preact-query';
import { useMemo } from 'preact/hooks';
import type { EntityKind } from '../../../src/app-routes';
import type { ResolverMatch, ResolverResult } from '../../../src/contracts';
import { resolveEntityRoute } from '../api';
import { useViewActive } from '../app-shell';
import { entityRouteKey } from '../query/entityRoute';
import { useProjectionQuery } from '../query/useProjectionQuery';

/** What an entity path's ref names, as its view consumes it. */
export type EntityRouteResolution =
  | { status: 'none' }
  | { status: 'resolving' }
  | { status: 'resolved'; ref: string; entity: Record<string, unknown>; detail?: Record<string, unknown> | null }
  | { status: 'not_found'; ref: string }
  | { status: 'ambiguous'; ref: string; matches: ResolverMatch[]; total: number }
  | { status: 'failed'; ref: string; error: string; retry: () => void };

// The previous ref's result stays in place while the next one resolves, so a
// view keeps its entity open through an in-app navigation instead of blanking.
function entityRouteOptions(kind: EntityKind, ref: string): UseQueryOptions<ResolverResult> {
  return {
    queryKey: entityRouteKey(kind, ref),
    staleTime: Number.POSITIVE_INFINITY,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => resolveEntityRoute(kind, ref, signal),
  };
}

/**
 * Resolve an entity path's ref once per navigation through
 * `GET /api/refs/resolve`. A resolved result names the ref it resolved, which
 * is the previous ref until the current one settles.
 */
export function useEntityRoute(kind: EntityKind, ref: string | null | undefined): EntityRouteResolution {
  const target = ref ?? '';
  const options = useMemo(() => entityRouteOptions(kind, target), [kind, target]);
  const query = useProjectionQuery(options, useViewActive() && target !== '');
  if (!target) return { status: 'none' };
  const result = query.data;
  if (result && (result.status === 'resolved' || !query.isPlaceholderData)) {
    switch (result.status) {
      case 'resolved':
        return { status: 'resolved', ref: result.ref, entity: result.entity, detail: result.detail };
      case 'not_found':
        return { status: 'not_found', ref: target };
      case 'ambiguous':
        return { status: 'ambiguous', ref: target, matches: result.matches, total: result.total };
    }
  }
  if (query.isError) {
    return { status: 'failed', ref: target, error: query.error.message, retry: () => { void query.refetch(); } };
  }
  return { status: 'resolving' };
}
