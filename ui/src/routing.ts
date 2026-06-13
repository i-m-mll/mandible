export type Route = {
  tab: 'auth' | 'artifacts' | 'chat-history' | 'work' | 'review' | 'issues' | 'settings' | 'inbox' | 'console' | 'logs' | 'graph' | 'timeline' | 'presets';
  params: Record<string, string>;
};

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
