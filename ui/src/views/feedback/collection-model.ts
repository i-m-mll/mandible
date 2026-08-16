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
  const pinned = new Set(pinnedCollectionIds);
  return [...collections].sort((left, right) => {
    const pinOrder = Number(pinned.has(right.id)) - Number(pinned.has(left.id));
    return pinOrder !== 0 ? pinOrder : compareCollections(left, right);
  });
}
