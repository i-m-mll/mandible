export type AppHistorySnapshot = { canBack: boolean; canForward: boolean; href: string; entryId: string; revision: number };
export type AppHistoryNavigation = AppHistorySnapshot & { back(): void; forward(): void };
type Entry = { id: string; href: string };
type Segment = { version: 1; id: string; index: number; entries: Entry[] };
type Marker = { segment: string; entry: string; position: number };
const STATE_KEY = '__mandibleAppHistory';
const STORAGE_KEY = 'mandible.app-history.v1';
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function createAppHistory(host: Window) {
  const listeners = new Set<() => void>();
  const sameDocument = (url: URL) => url.origin === host.location.origin && url.pathname === host.location.pathname && url.search === host.location.search;
  let segment: Segment;
  let revision = 0;
  let traversalPending = false;
  let snapshot: AppHistorySnapshot;
  const marker = () => object(object(host.history.state)[STATE_KEY]);
  const persist = () => {
    try { host.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(segment)); }
    catch { /* Unavailable tab storage starts a new safe boundary on reload. */ }
  };
  const markedState = (state: unknown, position: number, entry: Entry) => ({
    ...object(state), [STATE_KEY]: { segment: segment.id, entry: entry.id, position } satisfies Marker,
  });
  const establishBoundary = () => {
    const entry = { id: crypto.randomUUID(), href: host.location.href };
    segment = { version: 1, id: crypto.randomUUID(), index: 0, entries: [entry] };
    host.history.replaceState(markedState(host.history.state, 0, entry), '', entry.href);
    persist();
  };
  const restore = () => {
    try {
      const stored = object(JSON.parse(host.sessionStorage.getItem(STORAGE_KEY) ?? 'null'));
      const current = marker();
      if (stored.version === 1 && typeof stored.id === 'string' && Array.isArray(stored.entries)
        && stored.entries.length > 0 && stored.entries.every(value => typeof object(value).id === 'string' && typeof object(value).href === 'string' && sameDocument(new URL(object(value).href as string)))
        && Number.isInteger(current.position) && current.segment === stored.id) {
        const entries = stored.entries as Entry[];
        const position = current.position as number;
        if (entries[position]?.id === current.entry && entries[position]?.href === host.location.href) {
          segment = { version: 1, id: stored.id, index: position, entries };
          return;
        }
      }
    } catch { /* Missing or invalid custody cannot authorize traversal. */ }
    establishBoundary();
  };
  const updateSnapshot = (advance = true) => {
    snapshot = { canBack: segment.index > 0, canForward: segment.index < segment.entries.length - 1,
      href: host.location.href, entryId: segment.entries[segment.index]!.id, revision: advance ? ++revision : revision };
  };
  const publish = () => { updateSnapshot(); for (const listener of listeners) listener(); };
  const reconcile = () => {
    const current = marker();
    const position = current.position as number;
    if (current.segment === segment.id && Number.isInteger(position)
      && segment.entries[position]?.id === current.entry && segment.entries[position]?.href === host.location.href) {
      if (segment.index === position && snapshot.href === host.location.href && snapshot.entryId === current.entry) return;
      segment.index = position;
      persist();
    } else establishBoundary();
    traversalPending = false;
    publish();
  };
  const appUrl = (value: string): URL => {
    const url = new URL(value, host.location.href);
    if (!sameDocument(url)) {
      throw new Error('App history navigation must stay in the current app document.');
    }
    return url;
  };
  const push = (value: string, state: unknown = null) => {
    reconcile();
    const href = appUrl(value).href;
    const entry = { id: crypto.randomUUID(), href };
    const position = segment.index + 1;
    host.history.pushState(markedState(state, position, entry), '', href);
    segment.entries = [...segment.entries.slice(0, position), entry];
    segment.index = position;
    persist(); publish();
  };
  const replace = (value: string, state: unknown = host.history.state, notify = true) => {
    reconcile();
    const entry = { ...segment.entries[segment.index]!, href: appUrl(value).href };
    host.history.replaceState(markedState(state, segment.index, entry), '', entry.href);
    segment.entries[segment.index] = entry;
    persist();
    if (notify) publish(); else updateSnapshot(false);
  };
  const click = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
    if (!anchor || anchor.hasAttribute('download') || (anchor.target && anchor.target !== '_self')) return;
    const url = new URL(anchor.href, host.location.href);
    if (!sameDocument(url) || !url.hash.startsWith('#/')) return;
    event.preventDefault();
    if (url.href !== host.location.href) push(url.href);
  };
  restore(); updateSnapshot();
  host.addEventListener('popstate', reconcile);
  host.addEventListener('hashchange', reconcile);
  host.document.addEventListener('click', click);
  return {
    host,
    reconcile,
    snapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    push, replace,
    back() { reconcile(); if (!traversalPending && snapshot.canBack) { traversalPending = true; host.history.back(); } },
    forward() { reconcile(); if (!traversalPending && snapshot.canForward) { traversalPending = true; host.history.forward(); } },
    dispose() { host.removeEventListener('popstate', reconcile); host.removeEventListener('hashchange', reconcile); host.document.removeEventListener('click', click); listeners.clear(); },
  };
}

let owner: ReturnType<typeof createAppHistory> | undefined;
export function appHistory(): ReturnType<typeof createAppHistory> {
  if (owner?.host !== window) { owner?.dispose(); owner = createAppHistory(window); }
  owner.reconcile();
  return owner;
}
export function pushAppHistory(hash: string, state?: unknown): void { appHistory().push(hash, state); }
export function navigateAppHash(hash: string): void {
  if (new URL(hash, window.location.href).href !== window.location.href) pushAppHistory(hash);
}
export function replaceAppHistory(hash: string, state?: unknown, notify = true): void { appHistory().replace(hash, state, notify); }
