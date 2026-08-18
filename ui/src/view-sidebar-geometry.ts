import type { Route } from './routing';

export type ViewSidebarGeometry = {
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
};

/**
 * One geometry source for the shared shell and every route-owned ViewSidebar.
 * Storage keys and defaults preserve each route's existing persisted state.
 */
export const VIEW_SIDEBAR_GEOMETRY = {
  auth: { storageKey: 'sidebar-width:auth', defaultWidth: 320, minWidth: 190 },
  artifacts: { storageKey: 'sidebar-width:artifacts', defaultWidth: 320, minWidth: 240 },
  briefing: { storageKey: 'sidebar-width:briefing', defaultWidth: 360, minWidth: 230 },
  console: { storageKey: 'sidebar-width:conversations', defaultWidth: 320, minWidth: 190 },
  graph: { storageKey: 'mandible_graph_sidebar_width:v1', defaultWidth: 320, minWidth: 260 },
  inbox: { storageKey: 'sidebar-width:inbox', defaultWidth: 400, minWidth: 190 },
  issues: { storageKey: 'sidebar-width:issues', defaultWidth: 420, minWidth: 280 },
  spaces: { storageKey: 'sidebar-width:spaces', defaultWidth: 300, minWidth: 220 },
  tasks: { storageKey: 'sidebar-width:tasks', defaultWidth: 340, minWidth: 240 },
  timeline: { storageKey: 'mandible_timeline_sidebar_width:v1', defaultWidth: 320, minWidth: 260 },
} as const satisfies Partial<Record<Route['tab'], ViewSidebarGeometry>>;

export type ViewSidebarRoute = keyof typeof VIEW_SIDEBAR_GEOMETRY;

export function viewSidebarGeometryForRoute(tab: Route['tab']): ViewSidebarGeometry | null {
  return tab in VIEW_SIDEBAR_GEOMETRY
    ? VIEW_SIDEBAR_GEOMETRY[tab as ViewSidebarRoute]
    : null;
}

export function readInitialViewSidebarWidth(
  geometry: ViewSidebarGeometry,
  viewportWidth = typeof window === 'undefined' ? Number.POSITIVE_INFINITY : window.innerWidth,
): number | null {
  if (viewportWidth <= 700) return null;
  if (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function') {
    const stored = localStorage.getItem(geometry.storageKey);
    if (stored) {
      const parsed = parseInt(stored, 10);
      if (!Number.isNaN(parsed) && parsed >= geometry.minWidth) return parsed;
    }
  }
  return geometry.defaultWidth;
}
