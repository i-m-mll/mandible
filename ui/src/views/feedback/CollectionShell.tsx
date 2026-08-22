import type { ComponentChildren } from 'preact';
import type { Dispatch, StateUpdater } from 'preact/hooks';

import { CollectionsSidebar } from './CollectionsSidebar';
import type { FeedbackCollection } from './collection-model';
import type { BriefingCollectionViewState } from './collection-view-state';
import type { BriefingBundle } from '../../api';

export type CollectionShellProps = {
  collections: readonly FeedbackCollection[];
  bundles?: readonly BriefingBundle[];
  loadError?: string | null;
  sidebarHidden?: boolean;
  viewState: BriefingCollectionViewState;
  setViewState: Dispatch<StateUpdater<BriefingCollectionViewState>>;
  onSelect?(collection: FeedbackCollection): void;
  children: ComponentChildren;
};

export function CollectionShell({
  collections,
  bundles = [],
  loadError = null,
  sidebarHidden = false,
  viewState,
  setViewState,
  onSelect,
  children,
}: CollectionShellProps): JSX.Element {
  const selectedCollectionId = viewState.selectedCollectionId;
  const selectCollection = (collection: FeedbackCollection) => {
    setViewState((current) => ({
      ...current,
      selectedCollectionId: collection.id,
    }));
    onSelect?.(collection);
  };

  return (
    <div className="feedback-collection-shell" data-testid="feedback-collection-shell">
      <CollectionsSidebar
        collections={collections}
        bundles={bundles}
        loadError={loadError}
        hidden={sidebarHidden}
        selectedCollectionId={selectedCollectionId}
        viewState={viewState}
        setViewState={setViewState}
        onSelect={selectCollection}
      />
      <section className="feedback-collection-shell__content" aria-label="Selected Briefing">
        <div className="feedback-collection-shell__content-inner">
          {children}
        </div>
      </section>
    </div>
  );
}

export default CollectionShell;
