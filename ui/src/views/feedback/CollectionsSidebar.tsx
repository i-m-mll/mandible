import type { Dispatch, StateUpdater } from 'preact/hooks';
import { useMemo, useState } from 'preact/hooks';

import { ViewSidebar } from '../../components/ViewSidebar';
import { VIEW_SIDEBAR_GEOMETRY } from '../../view-sidebar-geometry';
import { SidebarSearchFilterHeader } from '../../components/shared/SidebarSearchFilterHeader';
import {
  SidebarItemBadge,
  SidebarItemOverflowMenu,
  SidebarItemPinAction,
  SidebarItemRow,
  type SidebarItemOverflowAction,
} from '../../components/shared/SidebarItemRow';
import { useSidebarListNavigation } from '../../hooks/useSidebarListNavigation';
import { briefingRoute } from '../../routing';
import {
  filterFeedbackCollections,
  moveVisiblePinnedCollection,
  orderFeedbackCollections,
  type FeedbackCollection,
} from './collection-model';
import type { BriefingCollectionViewState } from './collection-view-state';

export type CollectionsSidebarProps = {
  collections: readonly FeedbackCollection[];
  loadError?: string | null;
  hidden?: boolean;
  selectedCollectionId: string | null;
  viewState: BriefingCollectionViewState;
  setViewState: Dispatch<StateUpdater<BriefingCollectionViewState>>;
  onSelect(collection: FeedbackCollection): void;
};

export function CollectionsSidebar({
  collections,
  loadError = null,
  hidden = false,
  selectedCollectionId,
  viewState,
  setViewState,
  onSelect,
}: CollectionsSidebarProps): JSX.Element {
  const [draggedPinnedId, setDraggedPinnedId] = useState<string | null>(null);
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const pinned = useMemo(
    () => new Set(viewState.pinnedCollectionIds),
    [viewState.pinnedCollectionIds],
  );
  const ordered = useMemo(() => orderFeedbackCollections(
    filterFeedbackCollections(collections, viewState.collectionSourceFilter)
      .filter((collection) => !viewState.pinnedOnly || pinned.has(collection.id)),
    viewState.pinnedCollectionIds,
    viewState.collectionSort,
  ), [
    collections,
    viewState.collectionSourceFilter,
    viewState.pinnedOnly,
    viewState.collectionSort,
    viewState.pinnedCollectionIds,
    pinned,
  ]);
  const visiblePinned = useMemo(
    () => ordered.filter((collection) => pinned.has(collection.id)),
    [ordered, pinned],
  );
  const visiblePinnedIndexes = new Map(
    visiblePinned.map((collection, index) => [collection.id, index]),
  );
  const navigableIds = new Set(ordered.map((collection) => collection.id));
  const listNavigation = useSidebarListNavigation({
    items: ordered,
    getKey: (collection) => collection.id,
    selectedKey: selectedCollectionId && navigableIds.has(selectedCollectionId)
      ? selectedCollectionId
      : null,
    onSelect,
  });
  const navigationIndex = new Map(ordered.map((collection, index) => [collection.id, index]));
  const activeFilterCount = Number(viewState.pinnedOnly) + Number(viewState.collectionSort !== 'activity');

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

  const movePinned = (collectionId: string, targetIndex: number) => {
    const visibleIds = visiblePinned.map((collection) => collection.id);
    setViewState((current) => {
      const next = moveVisiblePinnedCollection(
        current.pinnedCollectionIds,
        visibleIds,
        collectionId,
        targetIndex,
      );
      return next.every((id, index) => id === current.pinnedCollectionIds[index])
        ? current
        : { ...current, pinnedCollectionIds: next };
    });
  };

  const copyBriefingLink = (briefingId: string) => {
    const target = new URL(briefingRoute(briefingId), window.location.origin).href;
    navigator.clipboard?.writeText(target).catch(() => {});
  };

  const renderCollection = (collection: FeedbackCollection, pinnedIndex: number | null) => {
    const navigation = listNavigation.getItemNavigationProps(
      collection,
      navigationIndex.get(collection.id) ?? 0,
    );
    const isPinned = pinnedIndex !== null;
    const overflowActions: SidebarItemOverflowAction[] = [{
      id: 'copy-link',
      label: 'Copy link',
      ariaLabel: `Copy link to ${collection.label}`,
      onSelect: () => copyBriefingLink(collection.collectionId),
    }];
    if (isPinned) {
      overflowActions.push(
        {
          id: 'move-up',
          label: 'Move up',
          ariaLabel: `Move ${collection.label} up`,
          disabled: pinnedIndex === 0,
          onSelect: () => movePinned(collection.id, pinnedIndex - 1),
        },
        {
          id: 'move-down',
          label: 'Move down',
          ariaLabel: `Move ${collection.label} down`,
          disabled: pinnedIndex === visiblePinned.length - 1,
          onSelect: () => movePinned(collection.id, pinnedIndex + 1),
        },
      );
    }
    return (
      <li
        key={collection.id}
        className={`feedback-collection-row${isPinned ? ' feedback-collection-row--pinned' : ''}${draggedPinnedId === collection.id ? ' feedback-collection-row--dragging' : ''}`}
        draggable={isPinned}
        onDragStart={isPinned ? (event) => {
          setDraggedPinnedId(collection.id);
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', collection.id);
        } : undefined}
        onDragOver={isPinned ? (event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
        } : undefined}
        onDrop={isPinned ? (event) => {
          event.preventDefault();
          const movedId = draggedPinnedId || event.dataTransfer.getData('text/plain');
          if (movedId) movePinned(movedId, pinnedIndex);
          setDraggedPinnedId(null);
        } : undefined}
        onDragEnd={isPinned ? () => setDraggedPinnedId(null) : undefined}
      >
        <SidebarItemRow
          tabIndex={navigation.tabIndex}
          selectRef={navigation.ref}
          label={collection.label}
          selectionLabel={`Select briefing ${collection.label}`}
          selectionDescription={`${collection.itemCount} round${collection.itemCount === 1 ? '' : 's'}`}
          selected={selectedCollectionId === collection.id}
          trailingReveal={isPinned ? 'persistent-pin' : 'interaction'}
          ariaCurrent={navigation['aria-current']}
          onKeyDown={navigation.onKeyDown}
          onSelect={() => onSelect(collection)}
          badges={(
            <SidebarItemBadge
              className="feedback-collection-row__count"
              ariaLabel={`${collection.itemCount} round${collection.itemCount === 1 ? '' : 's'}`}
              title={`${collection.itemCount} round${collection.itemCount === 1 ? '' : 's'}`}
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
                label={`Briefing actions for ${collection.label}`}
                actions={overflowActions}
              />
            </>
          )}
        />
      </li>
    );
  };

  return (
    <ViewSidebar
      hidden={hidden}
      {...VIEW_SIDEBAR_GEOMETRY.briefing}
      ariaLabel="Briefings"
      className="feedback-collections-sidebar"
      header={(
        <SidebarSearchFilterHeader
          value={viewState.collectionSourceFilter}
          onValueChange={(value) => setViewState((current) => ({
            ...current,
            collectionSourceFilter: value,
          }))}
          placeholder="Search briefings"
          searchAriaLabel="Search briefings"
          clearAriaLabel="Clear briefing search"
          captureFindShortcut
          filterTrigger={{
            ariaLabel: 'Briefing filters',
            title: 'Briefing filters',
            open: filterPanelOpen,
            active: activeFilterCount > 0,
            count: activeFilterCount,
            onToggle: () => setFilterPanelOpen((open) => !open),
          }}
          summarySlot={activeFilterCount > 0 ? (
            <>
              {viewState.pinnedOnly ? <span>Pinned only</span> : null}
              {viewState.collectionSort === 'name' ? <span>By name</span> : null}
              {viewState.collectionSort === 'round-count' ? <span>By round count</span> : null}
            </>
          ) : undefined}
          panel={filterPanelOpen ? {
            id: 'briefing-filter-panel',
            variant: 'popover',
            ariaLabel: 'Briefing filter controls',
            onDismiss: () => setFilterPanelOpen(false),
            children: (
              <>
                <div className="sidebar-search-filter__section">
                  <label className="sidebar-search-filter__option">
                    <input
                      type="checkbox"
                      checked={viewState.pinnedOnly}
                      onInput={(event) => setViewState((current) => ({
                        ...current,
                        pinnedOnly: event.currentTarget.checked,
                      }))}
                    />
                    <span>Pinned only</span>
                  </label>
                </div>
                <div className="sidebar-search-filter__section">
                  <label className="sidebar-search-filter__label" for="briefing-sort">Sort</label>
                  <select
                    id="briefing-sort"
                    aria-label="Sort briefings"
                    value={viewState.collectionSort}
                    onInput={(event) => setViewState((current) => ({
                      ...current,
                      collectionSort: event.currentTarget.value as BriefingCollectionViewState['collectionSort'],
                    }))}
                  >
                    <option value="activity">Recent activity</option>
                    <option value="name">Name</option>
                    <option value="round-count">Round count</option>
                  </select>
                </div>
              </>
            ),
          } : undefined}
        />
      )}
      bodyClassName="feedback-collections-sidebar__body"
    >
      <div data-testid="feedback-collections-sidebar">
        {loadError ? (
          <div className="feedback-collections-sidebar__list">
            <p className="feedback-collections-sidebar__empty" role="alert">
              {loadError}
            </p>
          </div>
        ) : ordered.length === 0 ? (
          <div className="feedback-collections-sidebar__list">
            <p className="feedback-collections-sidebar__empty" role="status">
              {collections.length === 0
                ? 'No Briefings have been reported yet.'
                : 'No Briefings match this search.'}
            </p>
          </div>
        ) : (
          <ul className="feedback-collections-sidebar__list">
            {ordered.map((collection) => {
              const pinnedIndex = visiblePinnedIndexes.get(collection.id);
              return renderCollection(collection, pinnedIndex ?? null);
            })}
          </ul>
        )}
      </div>
    </ViewSidebar>
  );
}

export default CollectionsSidebar;
