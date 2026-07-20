export type Route = {
  tab: 'auth' | 'artifacts' | 'chat-history' | 'work' | 'issues' | 'settings' | 'inbox' | 'console' | 'logs' | 'graph' | 'timeline' | 'spaces';
  params: Record<string, string>;
};

export const VIEW_SIDEBAR_QUERY_PARAM = 'sidebar';
export const VIEW_SIDEBAR_HIDDEN_VALUE = 'hidden';
export const ARTIFACT_SERIES_QUERY_PARAM = 'series';
export const ARTIFACT_VERSION_QUERY_PARAM = 'version';

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
  const tab = ['auth', 'artifacts', 'chat-history', 'work', 'issues', 'settings', 'inbox', 'console', 'logs', 'graph', 'timeline', 'spaces'].includes(retiredPresetsPath)
    ? (retiredPresetsPath as Route['tab'])
    : 'spaces';
  return { tab, params: tab === 'artifacts' ? normalizeArtifactRouteParams(params) : params };
}
