import type { ComponentChildren } from 'preact';
import type { Dispatch, StateUpdater } from 'preact/hooks';

import { CollectionsSidebar } from './CollectionsSidebar';
import { feedbackCollectionIdentity, type FeedbackCollection } from './collection-model';
import type { BriefingCollectionViewState } from './collection-view-state';

export type CollectionShellProps = {
  collections: readonly FeedbackCollection[];
  sidebarHidden?: boolean;
  viewState: BriefingCollectionViewState;
  setViewState: Dispatch<StateUpdater<BriefingCollectionViewState>>;
  children: ComponentChildren;
};

export function CollectionShell({
  collections,
  sidebarHidden = false,
  viewState,
  setViewState,
  children,
}: CollectionShellProps): JSX.Element {
  const selectedCollectionId = viewState.selectedCollectionId
    ?? (viewState.source ? feedbackCollectionIdentity('recurring_feed', viewState.source) : null);
  const selectCollection = (collection: FeedbackCollection) => {
    setViewState((current) => ({
      ...current,
      selectedCollectionId: collection.id,
      source: collection.kind === 'recurring_feed' ? collection.source ?? null : current.source,
    }));
  };

  return (
    <div className={`feedback-collection-shell${sidebarHidden ? ' feedback-collection-shell--sidebar-hidden' : ''}`} data-testid="feedback-collection-shell">
      {!sidebarHidden ? (
        <CollectionsSidebar
          collections={collections}
          selectedCollectionId={selectedCollectionId}
          viewState={viewState}
          setViewState={setViewState}
          onSelect={selectCollection}
        />
      ) : null}
      <section className="feedback-collection-shell__content" aria-label="Selected feedback collection">
        {children}
      </section>
    </div>
  );
}

export default CollectionShell;
