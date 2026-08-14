import type { Dispatch, StateUpdater } from 'preact/hooks';

import {
  filterFeedbackCollections,
  orderFeedbackCollections,
  type FeedbackCollection,
} from './collection-model';
import type { BriefingCollectionViewState } from './collection-view-state';

export type CollectionsSidebarProps = {
  collections: readonly FeedbackCollection[];
  selectedCollectionId: string | null;
  viewState: BriefingCollectionViewState;
  setViewState: Dispatch<StateUpdater<BriefingCollectionViewState>>;
  onSelect(collection: FeedbackCollection): void;
};

function kindLabel(kind: FeedbackCollection['kind']): string {
  return kind === 'recurring_feed' ? 'Recurring review' : 'Bounded ask';
}

function recurringFact(collection: FeedbackCollection): string | null {
  const recurring = collection.recurring;
  if (!recurring) return null;
  if (!recurring.publicationRecorded) return 'No publication recorded';
  if (recurring.lastPublicationItemCount === 0) return 'Latest publication: no findings';
  if (recurring.lastPublicationItemCount !== null) {
    return `Latest publication: ${recurring.lastPublicationItemCount} finding${recurring.lastPublicationItemCount === 1 ? '' : 's'}`;
  }
  return 'Publication recorded';
}

export function CollectionsSidebar({
  collections,
  selectedCollectionId,
  viewState,
  setViewState,
  onSelect,
}: CollectionsSidebarProps): JSX.Element {
  const filtered = filterFeedbackCollections(collections, {
    kind: viewState.collectionKindFilter,
    source: viewState.collectionSourceFilter,
    state: viewState.collectionStateFilter,
  });
  const ordered = orderFeedbackCollections(filtered, viewState.pinnedCollectionIds);
  const pinned = new Set(viewState.pinnedCollectionIds);

  const togglePin = (collectionId: string) => {
    setViewState((current) => {
      const exists = current.pinnedCollectionIds.includes(collectionId);
      return {
        ...current,
        pinnedCollectionIds: exists
          ? current.pinnedCollectionIds.filter((id) => id !== collectionId)
          : [...current.pinnedCollectionIds, collectionId],
      };
    });
  };

  return (
    <aside className="feedback-collections-sidebar" aria-label="Feedback collections" data-testid="feedback-collections-sidebar">
      <div className="feedback-collections-sidebar__filters" aria-label="Collection filters">
        <label>
          <span>Kind</span>
          <select
            aria-label="Collection kind"
            value={viewState.collectionKindFilter}
            onInput={(event) => setViewState((current) => ({
              ...current,
              collectionKindFilter: (event.currentTarget as HTMLSelectElement).value as BriefingCollectionViewState['collectionKindFilter'],
            }))}
          >
            <option value="all">All kinds</option>
            <option value="recurring_feed">Recurring review</option>
            <option value="bounded_ask">Bounded ask</option>
          </select>
        </label>
        <label>
          <span>Source</span>
          <input
            type="search"
            aria-label="Collection source"
            value={viewState.collectionSourceFilter}
            placeholder="Filter sources"
            onInput={(event) => setViewState((current) => ({
              ...current,
              collectionSourceFilter: (event.currentTarget as HTMLInputElement).value,
            }))}
          />
        </label>
        <label>
          <span>State</span>
          <select
            aria-label="Collection state"
            value={viewState.collectionStateFilter}
            onInput={(event) => setViewState((current) => ({
              ...current,
              collectionStateFilter: (event.currentTarget as HTMLSelectElement).value as BriefingCollectionViewState['collectionStateFilter'],
            }))}
          >
            <option value="all">All states</option>
            <option value="open">Open</option>
            <option value="submitted">Submitted</option>
            <option value="expired">Expired</option>
            <option value="cancelled">Cancelled</option>
            <option value="closed">Closed</option>
          </select>
        </label>
      </div>

      {ordered.length === 0 ? (
        <p className="feedback-collections-sidebar__empty" role="status">No collections match these filters.</p>
      ) : (
        <ul className="feedback-collections-sidebar__list">
          {ordered.map((collection) => {
            const isPinned = pinned.has(collection.id);
            const fact = recurringFact(collection);
            return (
              <li key={collection.id} className="feedback-collection-row">
                <button
                  type="button"
                  className={`feedback-collection-row__select${selectedCollectionId === collection.id ? ' feedback-collection-row__select--active' : ''}`}
                  aria-label={`Select collection ${collection.label}`}
                  aria-current={selectedCollectionId === collection.id ? 'page' : undefined}
                  onClick={() => onSelect(collection)}
                >
                  <span className="feedback-collection-row__label">{collection.label}</span>
                  <span className="feedback-collection-row__facts">
                    <span>{kindLabel(collection.kind)}</span>
                    {collection.source ? <span>Source: {collection.source}</span> : null}
                    <span>State: {collection.state}</span>
                    {collection.recurring ? <span>Health: {collection.recurring.health}</span> : null}
                    {collection.pendingCount !== undefined ? <span>{collection.pendingCount} pending</span> : null}
                    {fact ? <span>{fact}</span> : null}
                  </span>
                </button>
                <button
                  type="button"
                  className="feedback-collection-row__pin"
                  aria-label={`${isPinned ? 'Unpin' : 'Pin'} ${collection.label}`}
                  aria-pressed={isPinned}
                  onClick={() => togglePin(collection.id)}
                >
                  {isPinned ? 'Pinned' : 'Pin'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

export default CollectionsSidebar;
