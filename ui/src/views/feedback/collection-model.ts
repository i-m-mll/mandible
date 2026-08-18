export type FeedbackCollectionKind = string;
export type FeedbackInteractionMode = 'immediate_per_item' | 'explicit_submit';
export type FeedbackCollectionState = 'open' | 'expired';

/** The single sidebar row model returned by the collection-general listing. */
export type FeedbackCollection = {
  id: string;
  collectionId: string;
  kind: FeedbackCollectionKind;
  interactionMode: FeedbackInteractionMode;
  state: FeedbackCollectionState;
  source: string | null;
  label: string;
  itemCount: number;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  expiryReversible: boolean;
};

export type FeedbackCollectionFilters = {
  kind: 'all' | FeedbackCollectionKind;
  source: string;
  state: 'all' | FeedbackCollectionState;
};

export function feedbackCollectionIdentity(collectionId: string): string {
  return `feedback_collection:${encodeURIComponent(collectionId)}`;
}

/** Compatibility alias for view-state written before durable collection ids. */
export function legacyFeedbackCollectionIdentity(collection: FeedbackCollection): string {
  return `${collection.kind}:${encodeURIComponent(collection.source ?? collection.collectionId)}`;
}

export function filterFeedbackCollections(
  collections: readonly FeedbackCollection[],
  filters: Readonly<FeedbackCollectionFilters>,
): FeedbackCollection[] {
  const sourceNeedle = filters.source.trim().toLocaleLowerCase();
  return collections.filter((collection) => {
    if (filters.kind !== 'all' && collection.kind !== filters.kind) return false;
    if (filters.state !== 'all' && collection.state !== filters.state) return false;
    if (!sourceNeedle) return true;
    return (collection.source ?? '').toLocaleLowerCase().includes(sourceNeedle)
      || collection.label.toLocaleLowerCase().includes(sourceNeedle);
  });
}

function compareCollections(left: FeedbackCollection, right: FeedbackCollection): number {
  const updated = right.updatedAt - left.updatedAt;
  return updated !== 0 ? updated : left.id.localeCompare(right.id);
}

export function orderFeedbackCollections(
  collections: readonly FeedbackCollection[],
  pinnedCollectionIds: readonly string[],
): FeedbackCollection[] {
  const pinnedOrder = new Map<string, number>();
  for (const id of pinnedCollectionIds) {
    if (!pinnedOrder.has(id)) pinnedOrder.set(id, pinnedOrder.size);
  }
  return [...collections].sort((left, right) => {
    const leftPin = pinnedOrder.get(left.id);
    const rightPin = pinnedOrder.get(right.id);
    if (leftPin !== undefined && rightPin !== undefined) return leftPin - rightPin;
    if (leftPin !== undefined) return -1;
    if (rightPin !== undefined) return 1;
    return compareCollections(left, right);
  });
}

/**
 * Reorder only the visible pins while leaving filtered-out and unavailable ids
 * in their existing storage slots. This keeps refreshes and filters from
 * erasing or gratuitously moving browser-owned intent.
 */
export function moveVisiblePinnedCollection(
  pinnedCollectionIds: readonly string[],
  visiblePinnedIds: readonly string[],
  collectionId: string,
  targetIndex: number,
): string[] {
  const visible = new Set(visiblePinnedIds);
  const slots = pinnedCollectionIds
    .map((id, index) => visible.has(id) ? index : -1)
    .filter((index) => index >= 0);
  const orderedVisible = slots.map((index) => pinnedCollectionIds[index]);
  const currentIndex = orderedVisible.indexOf(collectionId);
  if (currentIndex < 0 || targetIndex < 0 || targetIndex >= orderedVisible.length) {
    return [...pinnedCollectionIds];
  }
  const nextVisible = [...orderedVisible];
  const [moved] = nextVisible.splice(currentIndex, 1);
  nextVisible.splice(targetIndex, 0, moved);
  if (nextVisible.every((id, index) => id === orderedVisible[index])) {
    return [...pinnedCollectionIds];
  }
  const next = [...pinnedCollectionIds];
  slots.forEach((slot, index) => { next[slot] = nextVisible[index]; });
  return next;
}
