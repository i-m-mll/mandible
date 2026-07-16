// Collection-view browser-local view state (umbrella de56ffa, C8).
//
// Per the project Dataful-UX rule, this is the BROWSER-LOCAL side of the state
// split: active selection, item filter, and collapsed sub-trees. It is NOT
// ledger/canonical state and is never promoted to a contract request without an
// explicit user action. It is persisted in browser storage + reflected in the URL
// hash, mirroring the Timeline pattern (ui/src/views/timeline.tsx), so it
// survives tab switches, refreshes, and SSE reconciliation.

import type { SpaceSelection } from './types';

export type CollectionViewState = {
  /** Free-text item filter applied across the tree + shelf. */
  itemFilter: string;
  /** Currently selected occurrence/item ids (UI selection, not persisted to the ledger). */
  selection: SpaceSelection;
  /** Collapsed occurrence ids, keyed for stable per-occurrence persistence. */
  collapsed: Record<string, boolean>;
};

export const EMPTY_COLLECTION_VIEW_STATE: CollectionViewState = {
  itemFilter: '',
  selection: { kind: null, ids: [] },
  collapsed: {},
};

const STORAGE_PREFIX = 'mandible.spaces.collection';

/** Per-space storage key so each Space keeps its own view state. */
export function collectionStorageKey(projectId: string, spaceId: string): string {
  return `${STORAGE_PREFIX}:${projectId || '_'}:${spaceId}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Coerce arbitrary stored JSON into a safe, fully-populated view-state. */
export function normalizeCollectionViewState(raw: unknown): CollectionViewState {
  if (!isPlainRecord(raw)) return { ...EMPTY_COLLECTION_VIEW_STATE };
  const itemFilter = typeof raw.itemFilter === 'string' ? raw.itemFilter : '';

  let selection: SpaceSelection = { kind: null, ids: [] };
  if (isPlainRecord(raw.selection)) {
    const kind = raw.selection.kind;
    const ids = Array.isArray(raw.selection.ids)
      ? raw.selection.ids.filter((id): id is string => typeof id === 'string')
      : [];
    selection = {
      kind:
        kind === 'occurrence' || kind === 'edge' || kind === 'item' ? kind : ids.length ? 'item' : null,
      ids,
    };
  }

  const collapsed: Record<string, boolean> = {};
  if (isPlainRecord(raw.collapsed)) {
    for (const [key, value] of Object.entries(raw.collapsed)) {
      if (typeof value === 'boolean') collapsed[key] = value;
    }
  }

  return { itemFilter, selection, collapsed };
}

/**
 * Reconcile prior view-state against the current set of live occurrence/item
 * ids. SSE refetches are reconciliation inputs, NOT resets: we keep selection
 * and collapse flags for entities that still exist and silently drop only those
 * that vanished. Selection is never cleared just because data refreshed.
 */
export function reconcileCollectionViewState(
  prior: CollectionViewState,
  liveIds: ReadonlySet<string>,
): CollectionViewState {
  const ids = prior.selection.ids.filter((id) => liveIds.has(id));
  const collapsed: Record<string, boolean> = {};
  for (const [id, value] of Object.entries(prior.collapsed)) {
    if (liveIds.has(id)) collapsed[id] = value;
  }
  return {
    itemFilter: prior.itemFilter,
    selection:
      ids.length === prior.selection.ids.length && ids.length > 0
        ? prior.selection
        : { kind: ids.length ? prior.selection.kind : null, ids },
    collapsed,
  };
}
