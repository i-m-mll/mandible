export const ARTIFACT_ROUTE_SELECTORS = ['series', 'version', 'ref', 'artifact'] as const;
export const BRIEFING_ROUTE_SELECTORS = ['group', 'briefing', 'round'] as const;

/** Replace a route's selector family while retaining unrelated query context. */
export function patchRouteQuery(
  current: URLSearchParams,
  updates: Record<string, string | null | undefined>,
  ownedParams: readonly string[] = [],
): URLSearchParams {
  const params = new URLSearchParams(current);
  for (const key of ownedParams) params.delete(key);
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    if (value === null || value === '') params.delete(key);
    else params.set(key, value);
  }
  return params;
}
