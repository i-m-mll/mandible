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
  loadError?: string | null;
  notice?: ComponentChildren;
  sidebarHidden?: boolean;
  viewState: BriefingCollectionViewState;
  setViewState: Dispatch<StateUpdater<BriefingCollectionViewState>>;
  onSelect?(collection: FeedbackCollection): void;
  onSelectGroup?(group: BriefingGroup): void;
  onSelectIncidents?(): void;
  confirmedLoaded?: boolean;
  children: ComponentChildren;
};

export function CollectionShell({
  collections,
  bundles = [],
  groups = [],
  loadError = null,
  notice,
  sidebarHidden = false,
  viewState,
  setViewState,
  onSelect,
  onSelectGroup,
  onSelectIncidents,
  confirmedLoaded = false,
  children,
}: CollectionShellProps): JSX.Element {
  const selectedCollectionId = viewState.selectedSurface === 'briefing' ? viewState.selectedCollectionId : null;
  const selectCollection = (collection: FeedbackCollection) => {
    setViewState((current) => ({
      ...current,
      selectedSurface: 'briefing',
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
        loadError={loadError}
        confirmedLoaded={confirmedLoaded}
        hidden={sidebarHidden}
        selectedCollectionId={selectedCollectionId}
        selectedGroupId={viewState.selectedSurface === 'briefing' ? viewState.selectedGroupId : null}
        viewState={viewState}
        setViewState={setViewState}
        onSelect={selectCollection}
        onSelectGroup={onSelectGroup}
        onSelectIncidents={onSelectIncidents}
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
