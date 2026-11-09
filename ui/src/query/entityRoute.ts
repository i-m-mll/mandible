import type { EntityKind } from '../../../src/app-routes';
import type { ResolverResult } from '../../../src/contracts';
import { queryClient } from './client';

export const entityRouteKey = (kind: EntityKind, ref: string): readonly unknown[] => ['entity-route', kind, ref];

/**
 * Record the identity a view already holds for an entity path it navigates
 * to, so the route opens it without another resolver read.
 */
export function rememberEntityRoute(kind: EntityKind, ref: string, entity: Record<string, unknown>): void {
  queryClient.setQueryData<ResolverResult>(entityRouteKey(kind, ref), { ref, kind, status: 'resolved', entity });
}
