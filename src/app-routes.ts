/**
 * The web app's route table: every app path, its parse and its build. The
 * daemon and the client share this module; nothing else parses or builds an
 * app path. Query parameters are view state and are not part of a route.
 */

export const ENTITY_KINDS = ["issue", "auth", "artifact", "briefing"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export const VIEW_TABS = [
  "issues", "auth", "artifacts", "briefing",
  "spaces", "console", "work", "settings", "inbox", "logs", "graph", "timeline", "overview", "tasks",
] as const;
export type ViewTab = (typeof VIEW_TABS)[number];

/** The tab an entity path opens, with that entity selected. */
export const ENTITY_TAB: Readonly<Record<EntityKind, ViewTab>> = {
  issue: "issues",
  auth: "auth",
  artifact: "artifacts",
  briefing: "briefing",
};

export type AppRoute =
  | { kind: "startup" }
  | { kind: "view"; tab: ViewTab }
  | { kind: "entity"; entity: EntityKind; ref: string };

export type ParsedAppPath = AppRoute | { kind: "not_found"; path: string };

const isEntityKind = (value: string): value is EntityKind => (ENTITY_KINDS as readonly string[]).includes(value);
const isViewTab = (value: string): value is ViewTab => (VIEW_TABS as readonly string[]).includes(value);

/** Parse a URL pathname (still percent-encoded) into its route. */
export function parseAppPath(pathname: string): ParsedAppPath {
  if (pathname === "/") return { kind: "startup" };
  const notFound = { kind: "not_found", path: pathname } as const;
  const match = /^\/([^/]+)(?:\/(.+))?$/.exec(pathname);
  if (!match) return notFound;
  const [, head, rest] = match;
  if (rest === undefined) return isViewTab(head) ? { kind: "view", tab: head } : notFound;
  if (!isEntityKind(head)) return notFound;
  let ref: string;
  try {
    ref = decodeURIComponent(rest);
  } catch {
    return notFound;
  }
  return ref.trim() ? { kind: "entity", entity: head, ref } : notFound;
}

/** Build the path of a route. A ref keeps `/`, `:` and `@` literal. */
export function appPath(route: AppRoute): string {
  switch (route.kind) {
    case "startup":
      return "/";
    case "view":
      return `/${route.tab}`;
    case "entity":
      return `/${route.entity}/${encodeRef(route.ref)}`;
  }
}

/** Build a path with view-state query parameters; empty values are dropped. */
export function appHref(
  route: AppRoute,
  query: URLSearchParams | Record<string, string | null | undefined> = {},
): string {
  const params = new URLSearchParams();
  const entries = query instanceof URLSearchParams ? [...query.entries()] : Object.entries(query);
  for (const [key, value] of entries) {
    if (value !== null && value !== undefined && value !== "") params.append(key, value);
  }
  const search = params.toString();
  return `${appPath(route)}${search ? `?${search}` : ""}`;
}

function encodeRef(ref: string): string {
  return encodeURIComponent(ref).replace(/%(2F|3A|40)/gi, (escape) => decodeURIComponent(escape));
}

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
    if (value === null || value === "") params.delete(key);
    else params.set(key, value);
  }
  return params;
}
