export type FeedbackCollectionKind = 'recurring_feed' | 'bounded_ask';

export type FeedbackCollectionState =
  | 'open'
  | 'submitted'
  | 'expired'
  | 'cancelled'
  | 'closed';

export type RecurringCollectionHealth = 'current' | 'stale' | 'unknown';

export type FeedbackCollection = {
  id: string;
  kind: FeedbackCollectionKind;
  state: FeedbackCollectionState;
  source?: string;
  label: string;
  pendingCount?: number;
  recurring?: {
    health: RecurringCollectionHealth;
    publicationRecorded: boolean;
    lastPublicationItemCount: number | null;
    lastTaskIdentity: string | null;
  };
};

export type FeedbackCollectionFilters = {
  kind: 'all' | FeedbackCollectionKind;
  source: string;
  state: 'all' | FeedbackCollectionState;
};

export function feedbackCollectionIdentity(
  kind: FeedbackCollectionKind,
  source: string,
): string {
  return `${kind}:${encodeURIComponent(source)}`;
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
  const source = (left.source ?? left.label).localeCompare(right.source ?? right.label);
  if (source !== 0) return source;
  const kind = left.kind.localeCompare(right.kind);
  return kind !== 0 ? kind : left.id.localeCompare(right.id);
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

