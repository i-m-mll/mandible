import { compactLongIdSegments } from './resource-refs';
import { BRIEFING_ROUTE_SELECTORS, patchRouteQuery } from '../../src/route-query';

export { ARTIFACT_ROUTE_SELECTORS, BRIEFING_ROUTE_SELECTORS } from '../../src/route-query';

export type Route = {
  tab: 'auth' | 'artifacts' | 'chat-history' | 'work' | 'issues' | 'settings' | 'inbox' | 'console' | 'logs' | 'graph' | 'timeline' | 'spaces' | 'overview' | 'briefing' | 'tasks';
  params: Record<string, string>;
};

export const VIEW_SIDEBAR_QUERY_PARAM = 'sidebar';
export const VIEW_SIDEBAR_HIDDEN_VALUE = 'hidden';
export const ARTIFACT_SERIES_QUERY_PARAM = 'series';
export const ARTIFACT_VERSION_QUERY_PARAM = 'version';

// Issue f59b5bd — short-form IDs in generated URLs. Deterministically emitted
// in-app links carry compact refs instead of full internal identities;
// consumers resolve prefixes with honest zero/one/many handling. UUIDs keep
// the established 8-char form, while typed long-hex refs reuse the common
// 7-char resource-ref display contract.
export const SHORT_ROUTE_ID_LENGTH = 8;
const FULL_UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const TYPED_LONG_HEX_REF_RE = /^[a-z][a-z0-9-]*:[0-9a-f]{12,64}$/i;
const FULL_PROJECT_ID_RE = /^prj_[a-z0-9_]{12,}$/i;

export function shortRouteId(id: string): string {
  if (FULL_UUID_RE.test(id)) return id.slice(0, SHORT_ROUTE_ID_LENGTH);
  if (FULL_PROJECT_ID_RE.test(id)) return id.slice(0, SHORT_ROUTE_ID_LENGTH);
  return TYPED_LONG_HEX_REF_RE.test(id) ? compactLongIdSegments(id) : id;
}

export type SpacesRouteTarget = {
  projectId?: string | null;
  projectKey?: string | null;
  spaceId?: string | null;
  preserveSpaceId?: boolean;
  renderer?: string | null;
};

/** Build a generated Spaces route while preserving all unrelated view state. */
export function spacesRouteFromHash(hashValue: string, target: SpacesRouteTarget): string {
  const queryPart = (hashValue || '#/spaces').replace(/^#/, '').split('?')[1] ?? '';
  const params = new URLSearchParams(queryPart);
  const setOrDelete = (key: string, value: string | null | undefined) => {
    if (value === undefined) return;
    if (value === null || value === '') params.delete(key);
    else params.set(key, value);
  };
  const projectRef = target.projectKey?.trim() || (
    target.projectId === undefined || target.projectId === null
      ? target.projectId
      : shortRouteId(target.projectId)
  );
  setOrDelete('project', projectRef);
  setOrDelete('space', target.spaceId && !target.preserveSpaceId ? shortRouteId(target.spaceId) : target.spaceId);
  setOrDelete('renderer', target.renderer);
  const query = params.toString();
  return `#/spaces${query ? `?${query}` : ''}`;
}

export function routeHashWithParams(
  hashValue: string,
  tab: Route['tab'],
  updates: Record<string, string | null | undefined>,
  ownedParams: readonly string[] = [],
): string {
  const query = hashValue.split('?')[1] ?? '';
  const params = patchRouteQuery(new URLSearchParams(query), updates, ownedParams);
  return `#/${tab}${params.size ? `?${params.toString()}` : ''}`;
}

/** Keep the mounted router synchronized with a selection written without a history entry. */
export function replaceRouteHash(hash: string): void {
  if (window.location.hash === hash) return;
  window.history.replaceState(window.history.state, '', hash);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function briefingRoute(briefingId: string, roundId?: string | null, hashValue = ''): string {
  return `/${routeHashWithParams(hashValue, 'briefing', {
    briefing: shortRouteId(briefingId), round: roundId ? shortRouteId(roundId) : null,
  }, BRIEFING_ROUTE_SELECTORS)}`;
}

export function briefingGroupRoute(groupKey: string, hashValue = ''): string {
  return `/${routeHashWithParams(hashValue, 'briefing', { group: groupKey }, BRIEFING_ROUTE_SELECTORS)}`;
}

export function parseArtifactVersionParam(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function normalizeArtifactRouteParams(params: Record<string, string>): Record<string, string> {
  const normalized = { ...params };
  const series = params.series?.trim();
  const ref = params.ref?.trim();
  const artifact = params.artifact?.trim();
  delete normalized.series;
  delete normalized.ref;
  delete normalized.artifact;
  delete normalized.version;

  if (series) {
    normalized.series = series;
    const version = parseArtifactVersionParam(params.version);
    if (version !== null) normalized.version = String(version);
  } else if (ref) {
    normalized.ref = ref;
  } else if (artifact) {
    normalized.artifact = artifact;
  }
  return normalized;
}

export function isViewSidebarHidden(route: Route): boolean {
  return route.params[VIEW_SIDEBAR_QUERY_PARAM] === VIEW_SIDEBAR_HIDDEN_VALUE;
}

function hashWithSidebarParam(hashValue: string, value: string | null): string {
  const hash = hashValue || '#/spaces';
  const [pathPart, queryPart] = hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(queryPart ?? '');
  if (value === null) {
    params.delete(VIEW_SIDEBAR_QUERY_PARAM);
  } else {
    params.set(VIEW_SIDEBAR_QUERY_PARAM, value);
  }
  const query = params.toString();
  return `#${pathPart || '/spaces'}${query ? `?${query}` : ''}`;
}

export function hashWithViewSidebarHidden(hashValue: string): string {
  return hashWithSidebarParam(hashValue, VIEW_SIDEBAR_HIDDEN_VALUE);
}

export function hashWithViewSidebarVisible(hashValue: string): string {
  return hashWithSidebarParam(hashValue, null);
}

export function parseRouteFromHash(hashValue: string): Route {
  const hash = hashValue || '#/spaces';
  const [pathPart, queryPart] = hash.replace('#', '').split('?');
  const path = pathPart.replace(/^\//, '') || 'spaces';
  const params: Record<string, string> = {};
  if (queryPart) {
    const search = new URLSearchParams(queryPart);
    search.forEach((value, key) => {
      params[key] = value;
    });
  }
  // Support legacy history and monitor routes as aliases for the unified Chat workspace.
  const normalizedPath = (
    path === 'conversations' ||
    path === 'chats' ||
    path === 'chat-history' ||
    path === 'sessions'
  ) ? 'console' : path;
  const retiredReviewPath = normalizedPath === 'review' ? 'work' : normalizedPath;
  const retiredPresetsPath = retiredReviewPath === 'presets' ? 'artifacts' : retiredReviewPath;
  if (retiredReviewPath === 'presets' && !params.role) {
    params.role = 'instructions';
  }
  const tab = ['auth', 'artifacts', 'chat-history', 'work', 'issues', 'settings', 'inbox', 'console', 'logs', 'graph', 'timeline', 'spaces', 'overview', 'briefing', 'tasks'].includes(retiredPresetsPath)
    ? (retiredPresetsPath as Route['tab'])
    : 'spaces';
  return { tab, params: tab === 'artifacts' ? normalizeArtifactRouteParams(params) : params };
}
