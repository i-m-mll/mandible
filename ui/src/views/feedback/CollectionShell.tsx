import type { ComponentChildren } from 'preact';
import type { Dispatch, StateUpdater } from 'preact/hooks';

import { CollectionsSidebar } from './CollectionsSidebar';
import type { FeedbackCollection } from './collection-model';
import type { BriefingCollectionViewState } from './collection-view-state';

export type CollectionShellProps = {
  collections: readonly FeedbackCollection[];
  sidebarHidden?: boolean;
  viewState: BriefingCollectionViewState;
  setViewState: Dispatch<StateUpdater<BriefingCollectionViewState>>;
  onSetExpiry?(collection: FeedbackCollection): Promise<void>;
  children: ComponentChildren;
};

export function CollectionShell({
  collections,
  sidebarHidden = false,
  viewState,
  setViewState,
  onSetExpiry,
  children,
}: CollectionShellProps): JSX.Element {
  const selectedCollectionId = viewState.selectedCollectionId;
  const selectCollection = (collection: FeedbackCollection) => {
    setViewState((current) => ({
      ...current,
      selectedCollectionId: collection.id,
      source: collection.source ?? current.source,
    }));
  };

  return (
    <div className="feedback-collection-shell" data-testid="feedback-collection-shell">
      <CollectionsSidebar
        collections={collections}
        hidden={sidebarHidden}
        selectedCollectionId={selectedCollectionId}
        viewState={viewState}
        setViewState={setViewState}
        onSelect={selectCollection}
        onSetExpiry={onSetExpiry}
      />
      <section className="feedback-collection-shell__content" aria-label="Selected feedback collection">
        <div className="feedback-collection-shell__content-inner">
          {children}
        </div>
      </section>
    </div>
  );
}

export default CollectionShell;
