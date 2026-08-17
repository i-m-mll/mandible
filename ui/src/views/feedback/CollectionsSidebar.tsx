import type { Dispatch, StateUpdater } from 'preact/hooks';
import { useMemo, useState } from 'preact/hooks';

import { ViewSidebar } from '../../components/ViewSidebar';
import { SidebarSearchFilterHeader } from '../../components/shared/SidebarSearchFilterHeader';
import {
  SidebarItemBadge,
  SidebarItemOverflowMenu,
  SidebarItemPinAction,
  SidebarItemRow,
  type SidebarItemOverflowAction,
} from '../../components/shared/SidebarItemRow';
import { useSidebarListNavigation } from '../../hooks/useSidebarListNavigation';
import {
  filterFeedbackCollections,
  orderFeedbackCollections,
  type FeedbackCollection,
} from './collection-model';
import type { BriefingCollectionViewState } from './collection-view-state';

export type CollectionsSidebarProps = {
  collections: readonly FeedbackCollection[];
  hidden?: boolean;
  selectedCollectionId: string | null;
  viewState: BriefingCollectionViewState;
  setViewState: Dispatch<StateUpdater<BriefingCollectionViewState>>;
  onSelect(collection: FeedbackCollection): void;
  onSetExpiry?(collection: FeedbackCollection): Promise<void>;
};

function kindLabel(kind: FeedbackCollection['kind']): string {
  const words = kind.replaceAll('_', ' ');
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

export function CollectionsSidebar({
  collections,
  hidden = false,
  selectedCollectionId,
  viewState,
  setViewState,
  onSelect,
  onSetExpiry,
}: CollectionsSidebarProps): JSX.Element {
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [expiryBusyId, setExpiryBusyId] = useState<string | null>(null);
  const ordered = useMemo(() => orderFeedbackCollections(
    filterFeedbackCollections(collections, {
      kind: viewState.collectionKindFilter,
      source: viewState.collectionSourceFilter,
      state: viewState.collectionStateFilter,
    }),
    viewState.pinnedCollectionIds,
  ), [
    collections,
    viewState.collectionKindFilter,
    viewState.collectionSourceFilter,
    viewState.collectionStateFilter,
    viewState.pinnedCollectionIds,
  ]);
  const pinned = useMemo(
    () => new Set(viewState.pinnedCollectionIds),
    [viewState.pinnedCollectionIds],
  );
  const kinds = useMemo(
    () => [...new Set(collections.map((collection) => collection.kind))].sort(),
    [collections],
  );
  const activeFilterCount = Number(viewState.collectionKindFilter !== 'all')
    + Number(viewState.collectionStateFilter !== 'all');
  const listNavigation = useSidebarListNavigation({
    items: ordered,
    getKey: (collection) => collection.id,
    selectedKey: selectedCollectionId,
    onSelect,
  });

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

  const toggleExpiry = async (collection: FeedbackCollection) => {
    if (!onSetExpiry || expiryBusyId) return;
    setExpiryBusyId(collection.id);
    try {
      await onSetExpiry(collection);
    } finally {
      setExpiryBusyId(null);
    }
  };

  return (
    <ViewSidebar
      hidden={hidden}
      storageKey="sidebar-width:briefing"
      defaultWidth={290}
      minWidth={230}
      ariaLabel="Feedback collections"
      className="feedback-collections-sidebar"
      header={(
        <SidebarSearchFilterHeader
          value={viewState.collectionSourceFilter}
          onValueChange={(value) => setViewState((current) => ({
            ...current,
            collectionSourceFilter: value,
          }))}
          placeholder="Search collections"
          searchAriaLabel="Search collections"
          clearAriaLabel="Clear collection search"
          captureFindShortcut
          onBlurWithin={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setFilterMenuOpen(false);
            }
          }}
          filterTrigger={{
            ariaLabel: 'Collection filters',
            title: 'Collection filters',
            open: filterMenuOpen,
            active: activeFilterCount > 0,
            count: activeFilterCount,
            onToggle: () => setFilterMenuOpen((open) => !open),
          }}
          panel={filterMenuOpen ? {
            id: 'collection-filter-panel',
            variant: 'popover',
            ariaLabel: 'Collection filter controls',
            onDismiss: () => setFilterMenuOpen(false),
            children: (
              <>
                <div className="sidebar-search-filter__section sidebar-search-filter__section--header">
                  <span>Filters</span>
                  <button
                    type="button"
                    className="sidebar-search-filter__clear-action"
                    onClick={() => setViewState((current) => ({
                      ...current,
                      collectionKindFilter: 'all',
                      collectionStateFilter: 'all',
                    }))}
                  >
                    Clear
                  </button>
                </div>
                <div className="sidebar-search-filter__section">
                  <span className="sidebar-search-filter__label">Kind</span>
                  <div className="sidebar-search-filter__options sidebar-search-filter__options--segmented">
                    {(['all', ...kinds] as const).map((kind) => (
                      <button
                        key={kind}
                        type="button"
                        className={`sidebar-search-filter__option${viewState.collectionKindFilter === kind ? ' sidebar-search-filter__option--active' : ''}`}
                        aria-pressed={viewState.collectionKindFilter === kind}
                        onClick={() => setViewState((current) => ({ ...current, collectionKindFilter: kind }))}
                      >
                        {kind === 'all' ? 'All' : kindLabel(kind)}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="sidebar-search-filter__section">
                  <span className="sidebar-search-filter__label">State</span>
                  <div className="sidebar-search-filter__options">
                    {(['all', 'open', 'expired'] as const).map((state) => (
                      <button
                        key={state}
                        type="button"
                        className={`sidebar-search-filter__option${viewState.collectionStateFilter === state ? ' sidebar-search-filter__option--active' : ''}`}
                        aria-pressed={viewState.collectionStateFilter === state}
                        onClick={() => setViewState((current) => ({ ...current, collectionStateFilter: state }))}
                      >
                        {state === 'all' ? 'All' : `${state.charAt(0).toUpperCase()}${state.slice(1)}`}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            ),
          } : undefined}
        />
      )}
      bodyClassName="feedback-collections-sidebar__body"
    >
      <div data-testid="feedback-collections-sidebar">
        {ordered.length === 0 ? (
          <div className="feedback-collections-sidebar__list">
            <p className="feedback-collections-sidebar__empty" role="status">
              {collections.length === 0
                ? 'No briefing collections have been reported yet.'
                : 'No collections match these filters.'}
            </p>
          </div>
        ) : (
          <ul className="feedback-collections-sidebar__list">
            {ordered.map((collection, index) => {
              const isPinned = pinned.has(collection.id);
              const navigation = listNavigation.getItemNavigationProps(collection, index);
              const expiryLabel = collection.state === 'expired' ? 'Un-expire' : 'Expire';
              const overflowActions: SidebarItemOverflowAction[] = (
                onSetExpiry && collection.expiryReversible
              ) ? [{
                  id: 'expiry',
                  label: expiryBusyId === collection.id ? 'Saving…' : expiryLabel,
                  ariaLabel: `${expiryLabel} ${collection.label}`,
                  disabled: expiryBusyId !== null,
                  onSelect: () => void toggleExpiry(collection),
                }] : [];
              return (
                <li key={collection.id} className="feedback-collection-row">
                  <SidebarItemRow
                    tabIndex={navigation.tabIndex}
                    selectRef={navigation.ref}
                    label={collection.label}
                    selectionLabel={`Select collection ${collection.label}`}
                    selected={selectedCollectionId === collection.id}
                    ariaCurrent={navigation['aria-current']}
                    onKeyDown={navigation.onKeyDown}
                    onSelect={() => onSelect(collection)}
                    leading={(
                      <span
                        className={`feedback-collection-row__state feedback-collection-row__state--${collection.state}`}
                        aria-label={`State: ${collection.state}`}
                        title={collection.state}
                      />
                    )}
                    badges={(
                      <SidebarItemBadge
                        ariaLabel={`${collection.itemCount} item${collection.itemCount === 1 ? '' : 's'}`}
                        title={`${collection.itemCount} item${collection.itemCount === 1 ? '' : 's'}`}
                      >
                        {collection.itemCount}
                      </SidebarItemBadge>
                    )}
                    actions={(
                      <>
                        <SidebarItemPinAction
                          label={collection.label}
                          pressed={isPinned}
                          onPress={() => togglePin(collection.id)}
                        />
                        <SidebarItemOverflowMenu
                          label={`More actions for ${collection.label}`}
                          actions={overflowActions}
                        />
                      </>
                    )}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </ViewSidebar>
  );
}

export default CollectionsSidebar;
