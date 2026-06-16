export type Route = {
  tab: 'auth' | 'artifacts' | 'chat-history' | 'work' | 'review' | 'issues' | 'settings' | 'inbox' | 'console' | 'logs' | 'graph' | 'timeline' | 'presets';
  params: Record<string, string>;
};

export const VIEW_SIDEBAR_QUERY_PARAM = 'sidebar';
export const VIEW_SIDEBAR_HIDDEN_VALUE = 'hidden';

export function isViewSidebarHidden(route: Route): boolean {
  return route.params[VIEW_SIDEBAR_QUERY_PARAM] === VIEW_SIDEBAR_HIDDEN_VALUE;
}

function hashWithSidebarParam(hashValue: string, value: string | null): string {
  const hash = hashValue || '#/graph';
  const [pathPart, queryPart] = hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(queryPart ?? '');
  if (value === null) {
    params.delete(VIEW_SIDEBAR_QUERY_PARAM);
  } else {
    params.set(VIEW_SIDEBAR_QUERY_PARAM, value);
  }
  const query = params.toString();
  return `#${pathPart || '/graph'}${query ? `?${query}` : ''}`;
}

export function hashWithViewSidebarHidden(hashValue: string): string {
  return hashWithSidebarParam(hashValue, VIEW_SIDEBAR_HIDDEN_VALUE);
}

export function hashWithViewSidebarVisible(hashValue: string): string {
  return hashWithSidebarParam(hashValue, null);
}

export function parseRouteFromHash(hashValue: string): Route {
  const hash = hashValue || '#/graph';
  const [pathPart, queryPart] = hash.replace('#', '').split('?');
  const path = pathPart.replace(/^\//, '') || 'graph';
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
  const tab = ['auth', 'artifacts', 'chat-history', 'work', 'review', 'issues', 'settings', 'inbox', 'console', 'logs', 'graph', 'timeline', 'presets'].includes(normalizedPath)
    ? (normalizedPath as Route['tab'])
    : 'graph';
  return { tab, params };
}
