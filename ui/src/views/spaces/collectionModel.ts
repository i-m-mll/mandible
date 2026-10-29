// Collection renderer model assembly + tree projection (umbrella de56ffa, C8).
//
// Pure, side-effect-free helpers that turn a Space fact packet
// (space + items/occurrences/edges) into the in-memory model a collection
// renderer draws. Kept separate from the `.tsx` so the tree/list logic - the
// part with the interesting invariants - is unit-testable without a DOM.
//
// review2 C7 [Warning]: ordering/tree state lives on OCCURRENCES, never on
// items. A `space_item` with NO collection occurrence is therefore not "lost":
// it surfaces in the flat Items section. The section is derived membership, not a
// stored flag.

import type { SpaceItem, SpaceOccurrence, SpaceEdge, Space } from '../../api';
import type {
  ResolvedSpaceOccurrence,
  SpaceViewModel,
} from './types';

/** A node in the rendered collection tree: a resolved occurrence + its ordered children. */
export type CollectionTreeNode = {
  occurrence: ResolvedSpaceOccurrence;
  children: CollectionTreeNode[];
  /** Tree depth (0 = root) for indentation/aria-level. */
  depth: number;
};

/** What a collection renderer actually draws: the placed tree + flat item membership. */
export type CollectionProjection = {
  /** Roots of the collection occurrence tree (occurrences with renderer='collection'). */
  roots: CollectionTreeNode[];
  /** Items with no collection occurrence — surfaced, never dropped (review2 C7). */
  unplaced: SpaceItem[];
  /**
   * Occurrences whose backing item could not be resolved (item_id set but the
   * item is absent from the packet). Surfaced via the unresolved-ref UI rather
   * than silently dropped.
   */
  danglingOccurrences: ResolvedSpaceOccurrence[];
};

/**
 * Assemble the renderer's in-memory model from a raw fact packet. The
 * occurrence→item join and the effective-renderer resolution happen here so the
 * renderers consume a uniform {@link SpaceViewModel}.
 */
export function buildSpaceViewModel(packet: {
  space: Space;
  items: SpaceItem[];
  occurrences: SpaceOccurrence[];
  edges: SpaceEdge[];
}): SpaceViewModel {
  const itemsById: Record<string, SpaceItem> = {};
  for (const item of packet.items) itemsById[item.id] = item;

  const occurrences: ResolvedSpaceOccurrence[] = packet.occurrences.map((occurrence) => ({
    occurrence,
    item: occurrence.item_id ? itemsById[occurrence.item_id] ?? null : null,
    // Occurrence override → space default. Document spaces never carry
    // collection occurrences, so the space default is a safe fallback here.
    renderer:
      occurrence.renderer ??
      (packet.space.default_renderer === 'document'
        ? 'collection'
        : packet.space.default_renderer),
  }));

  return {
    space: packet.space,
    itemsById,
    occurrences,
    edges: packet.edges,
  };
}

/**
 * Stable ordering comparator for sibling collection occurrences:
 * `sort_key` (lexicographic, nulls last) → `section_id` → `created_at` → `id`.
 * Deterministic so SSE reconciliation never reorders identical data.
 */
export function compareCollectionOccurrences(
  a: ResolvedSpaceOccurrence,
  b: ResolvedSpaceOccurrence,
): number {
  const ak = a.occurrence.sort_key;
  const bk = b.occurrence.sort_key;
  if (ak !== bk) {
    if (ak === null) return 1;
    if (bk === null) return -1;
    if (ak < bk) return -1;
    if (ak > bk) return 1;
  }
  const asec = a.occurrence.section_id ?? '';
  const bsec = b.occurrence.section_id ?? '';
  if (asec !== bsec) return asec < bsec ? -1 : 1;
  if (a.occurrence.created_at !== b.occurrence.created_at) {
    return a.occurrence.created_at - b.occurrence.created_at;
  }
  return a.occurrence.id < b.occurrence.id ? -1 : a.occurrence.id > b.occurrence.id ? 1 : 0;
}

/**
 * Project a view-model into the collection tree + unplaced shelf.
 *
 * Only `renderer='collection'` occurrences participate in the tree; an
 * occurrence whose `parent_id` points outside the collection set (or forms a
 * cycle) is promoted to a root rather than dropped, so nothing is lost.
 */
export function projectCollection(model: SpaceViewModel): CollectionProjection {
  const collectionOccurrences = model.occurrences.filter(
    (o) => o.renderer === 'collection',
  );
  const byId = new Map<string, ResolvedSpaceOccurrence>();
  for (const o of collectionOccurrences) byId.set(o.occurrence.id, o);

  // Items that ARE placed by some collection occurrence (so the shelf can
  // exclude them). Placement is occurrence-derived, never item-stored.
  const placedItemIds = new Set<string>();
  for (const o of collectionOccurrences) {
    if (o.occurrence.item_id) placedItemIds.add(o.occurrence.item_id);
  }

  // Group children by resolved parent. An occurrence whose parent is missing
  // from the collection set, or that would form a cycle, becomes a root.
  const childrenByParent = new Map<string | null, ResolvedSpaceOccurrence[]>();
  const isReachableParent = (occ: ResolvedSpaceOccurrence): boolean => {
    let cursor: ResolvedSpaceOccurrence | undefined = occ;
    const seen = new Set<string>();
    while (cursor) {
      if (seen.has(cursor.occurrence.id)) return false; // cycle
      seen.add(cursor.occurrence.id);
      const parentId = cursor.occurrence.parent_id;
      if (!parentId) return true;
      cursor = byId.get(parentId);
    }
    return false; // parent_id pointed outside the collection set
  };

  for (const o of collectionOccurrences) {
    const parentId = o.occurrence.parent_id;
    const effectiveParent = parentId && byId.has(parentId) && isReachableParent(o) ? parentId : null;
    const bucket = childrenByParent.get(effectiveParent) ?? [];
    bucket.push(o);
    childrenByParent.set(effectiveParent, bucket);
  }

  const build = (parentId: string | null, depth: number): CollectionTreeNode[] => {
    const kids = (childrenByParent.get(parentId) ?? []).slice().sort(compareCollectionOccurrences);
    return kids.map((occurrence) => ({
      occurrence,
      depth,
      children: build(occurrence.occurrence.id, depth + 1),
    }));
  };

  const danglingOccurrences = collectionOccurrences.filter(
    (o) => o.occurrence.item_id !== null && o.item === null,
  );

  const unplaced = Object.values(model.itemsById)
    .filter((item) => !placedItemIds.has(item.id))
    .sort((a, b) => {
      if (a.created_at !== b.created_at) return a.created_at - b.created_at;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  return { roots: build(null, 0), unplaced, danglingOccurrences };
}

/** A human-friendly display label for an item (title → ref_uri → ref_type:ref_id). */
export function itemDisplayLabel(item: SpaceItem): string {
  if (item.title && item.title.trim()) return item.title.trim();
  if (item.ref_uri && item.ref_uri.trim()) return item.ref_uri.trim();
  return `${item.ref_type}:${item.ref_id}`;
}

/** The canonical resource-ref string for an item, for the C6 unresolved-ref UI. */
export { spaceItemRef as itemRefString } from './itemRef';
