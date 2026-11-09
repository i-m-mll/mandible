import { appHistory } from './app-history';
import { getAgentPageBinding, withAgentSession } from './agent-page-binding';
import { compactLongIdSegments } from './resource-refs';
import {
  appHref,
  ENTITY_TAB,
  parseAppPath,
  patchRouteQuery,
  type AppRoute,
  type EntityKind,
  type ParsedAppPath,
  type ViewTab,
} from '../../src/app-routes';

export type { AppRoute, EntityKind, ParsedAppPath, ViewTab };

export type EntityTarget = { kind: EntityKind; ref: string };

/**
 * The app's location as the shell reads it. `tab` is the rail tab the path
 * opens (null for the startup path and for a path outside the route table),
 * `entity` the entity an entity path names, and `params` the query, which is
 * view state carried through every navigation.
 */
export type Route = {
  path: ParsedAppPath;
  tab: ViewTab | null;
  entity: EntityTarget | null;
  params: Record<string, string>;
};

export const VIEW_SIDEBAR_QUERY_PARAM = 'sidebar';
export const VIEW_SIDEBAR_HIDDEN_VALUE = 'hidden';

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

/** Read a URL (or the current location) into the shell's route. */
export function routeFromUrl(url: Pick<URL, 'pathname' | 'search'>): Route {
  const path = parseAppPath(url.pathname);
  const params = Object.fromEntries(new URLSearchParams(url.search).entries());
  switch (path.kind) {
    case 'view':
      return { path, tab: path.tab, entity: null, params };
    case 'entity':
      return { path, tab: ENTITY_TAB[path.entity], entity: { kind: path.entity, ref: path.ref }, params };
    default:
      return { path, tab: null, entity: null, params };
  }
}

export function currentRoute(): Route {
  return routeFromUrl(window.location);
}

/**
 * Build the href of `route` from the current query: `updates` set or delete
 * individual parameters, and `ownedParams` are cleared first, so a view can
 * replace its own selector family while every other parameter carries through.
 */
export function routeWithParams(
  route: AppRoute,
  updates: Record<string, string | null | undefined> = {},
  ownedParams: readonly string[] = [],
  search: string = typeof window === 'undefined' ? '' : window.location.search,
): string {
  return appHref(route, patchRouteQuery(new URLSearchParams(search), updates, ownedParams));
}

/** Push an in-app navigation, keeping this tab's agent session binding. */
export function navigateTo(href: string, state: unknown = null): void {
  const target = withAgentSession(href, getAgentPageBinding());
  if (new URL(target, window.location.href).href !== window.location.href) appHistory().push(target, state);
}

/** Replace the current entry, keeping this tab's agent session binding. */
export function replaceRoute(href: string, state: unknown = window.history.state, notify = true): void {
  appHistory().replace(withAgentSession(href, getAgentPageBinding()), state, notify);
}

export function isViewSidebarHidden(route: Route): boolean {
  return route.params[VIEW_SIDEBAR_QUERY_PARAM] === VIEW_SIDEBAR_HIDDEN_VALUE;
}

/** The current location with the view sidebar shown or hidden. */
export function hrefWithViewSidebar(hidden: boolean): string {
  const params = new URLSearchParams(window.location.search);
  if (hidden) params.set(VIEW_SIDEBAR_QUERY_PARAM, VIEW_SIDEBAR_HIDDEN_VALUE);
  else params.delete(VIEW_SIDEBAR_QUERY_PARAM);
  const search = params.toString();
  return `${window.location.pathname}${search ? `?${search}` : ''}`;
}

export type SpacesRouteTarget = {
  projectId?: string | null;
  projectKey?: string | null;
  spaceId?: string | null;
  preserveSpaceId?: boolean;
  renderer?: string | null;
};

/** Build a generated Spaces route while preserving all unrelated view state. */
export function spacesRoute(target: SpacesRouteTarget, search: string = window.location.search): string {
  const projectRef = target.projectKey?.trim() || (
    target.projectId === undefined || target.projectId === null
      ? target.projectId
      : shortRouteId(target.projectId)
  );
  return routeWithParams({ kind: 'view', tab: 'spaces' }, {
    project: projectRef,
    space: target.spaceId && !target.preserveSpaceId ? shortRouteId(target.spaceId) : target.spaceId,
    renderer: target.renderer,
  }, [], search);
}
