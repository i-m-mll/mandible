import type { ComponentChildren } from 'preact';
import type { Dispatch, StateUpdater } from 'preact/hooks';

import { CollectionsSidebar } from './CollectionsSidebar';
import type { FeedbackCollection } from './collection-model';
import type { BriefingCollectionViewState } from './collection-view-state';
import type { BriefingBundle, BriefingGroup } from '../../api';

export type CollectionShellProps = {
  collections: readonly FeedbackCollection[];
  bundles?: readonly BriefingBundle[];
  groups?: readonly BriefingGroup[];
  notice?: ComponentChildren;
  sidebarHidden?: boolean;
  viewState: BriefingCollectionViewState;
  setViewState: Dispatch<StateUpdater<BriefingCollectionViewState>>;
  onSelect?(collection: FeedbackCollection): void;
  onSelectGroup?(group: BriefingGroup): void;
  confirmedLoaded?: boolean;
  children: ComponentChildren;
};

export function CollectionShell({
  collections,
  bundles = [],
  groups = [],
  notice,
  sidebarHidden = false,
  viewState,
  setViewState,
  onSelect,
  onSelectGroup,
  confirmedLoaded = false,
  children,
}: CollectionShellProps): JSX.Element {
  const selectedCollectionId = viewState.selectedCollectionId;
  const selectCollection = (collection: FeedbackCollection) => {
    setViewState((current) => ({
      ...current,
      selectedCollectionId: collection.id,
      selectedGroupId: null,
    }));
    onSelect?.(collection);
  };

  return (
    <div className="feedback-collection-shell" data-testid="feedback-collection-shell">
      <CollectionsSidebar
        collections={collections}
        bundles={bundles}
        groups={groups}
        confirmedLoaded={confirmedLoaded}
        hidden={sidebarHidden}
        selectedCollectionId={selectedCollectionId}
        selectedGroupId={viewState.selectedGroupId}
        viewState={viewState}
        setViewState={setViewState}
        onSelect={selectCollection}
        onSelectGroup={onSelectGroup}
      />
      <section className="feedback-collection-shell__content" aria-label="Selected Briefing">
        {notice}
        <div className="feedback-collection-shell__content-inner">
          {children}
        </div>
      </section>
    </div>
  );
}

export default CollectionShell;
