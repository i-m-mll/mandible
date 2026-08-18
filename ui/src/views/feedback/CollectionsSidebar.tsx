import type { Dispatch, StateUpdater } from 'preact/hooks';
import { useMemo, useState } from 'preact/hooks';

import { ViewSidebar } from '../../components/ViewSidebar';
import { SidebarSearchFilterHeader } from '../../components/shared/SidebarSearchFilterHeader';
import { SidebarGroupNode } from '../../components/shared/SidebarGroupNode';
import {
  SidebarItemBadge,
  SidebarItemPinAction,
  SidebarItemRow,
} from '../../components/shared/SidebarItemRow';
import { useSidebarListNavigation } from '../../hooks/useSidebarListNavigation';
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
  const ordered = useMemo(() => orderFeedbackCollections(
    filterFeedbackCollections(collections, viewState.collectionSourceFilter),
    viewState.pinnedCollectionIds,
  ), [
    collections,
    viewState.collectionSourceFilter,
    viewState.pinnedCollectionIds,
  ]);
  const pinned = useMemo(
    () => new Set(viewState.pinnedCollectionIds),
    [viewState.pinnedCollectionIds],
  );
  const visiblePinned = useMemo(
    () => ordered.filter((collection) => pinned.has(collection.id)),
    [ordered, pinned],
  );
  const ordinary = useMemo(
    () => ordered.filter((collection) => !pinned.has(collection.id)),
    [ordered, pinned],
  );
  const navigable = viewState.pinnedSectionCollapsed
    ? ordinary
    : [...visiblePinned, ...ordinary];
  const navigableIds = new Set(navigable.map((collection) => collection.id));
  const listNavigation = useSidebarListNavigation({
    items: navigable,
    getKey: (collection) => collection.id,
    selectedKey: selectedCollectionId && navigableIds.has(selectedCollectionId)
      ? selectedCollectionId
      : null,
    onSelect,
  });
  const navigationIndex = new Map(navigable.map((collection, index) => [collection.id, index]));

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

  const renderCollection = (collection: FeedbackCollection, pinnedIndex: number | null) => {
    const navigation = listNavigation.getItemNavigationProps(
      collection,
      navigationIndex.get(collection.id) ?? 0,
    );
    const isPinned = pinnedIndex !== null;
    return (
      <li
        key={collection.id}
        className={`feedback-collection-row${draggedPinnedId === collection.id ? ' feedback-collection-row--dragging' : ''}`}
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
              {isPinned ? (
                <span className="feedback-collection-row__move-actions">
                  <button
                    type="button"
                    className="sidebar-item-row__action"
                    aria-label={`Move ${collection.label} up`}
                    title={`Move ${collection.label} up`}
                    disabled={pinnedIndex === 0}
                    onClick={(event) => {
                      event.stopPropagation();
                      movePinned(collection.id, pinnedIndex - 1);
                    }}
                  >
                    <span aria-hidden="true">↑</span>
                  </button>
                  <button
                    type="button"
                    className="sidebar-item-row__action"
                    aria-label={`Move ${collection.label} down`}
                    title={`Move ${collection.label} down`}
                    disabled={pinnedIndex === visiblePinned.length - 1}
                    onClick={(event) => {
                      event.stopPropagation();
                      movePinned(collection.id, pinnedIndex + 1);
                    }}
                  >
                    <span aria-hidden="true">↓</span>
                  </button>
                </span>
              ) : null}
              <SidebarItemPinAction
                label={collection.label}
                pressed={isPinned}
                onPress={() => togglePin(collection.id)}
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
      storageKey="sidebar-width:briefing"
      defaultWidth={360}
      minWidth={230}
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
        />
      )}
      bodyClassName="feedback-collections-sidebar__body"
    >
      <div data-testid="feedback-collections-sidebar">
        <SidebarGroupNode
          id="briefing-pinned"
          className="feedback-collections-sidebar__pinned"
          label="Pinned"
          count={visiblePinned.length}
          countLabel={`${visiblePinned.length} pinned briefing${visiblePinned.length === 1 ? '' : 's'}`}
          expanded={!viewState.pinnedSectionCollapsed}
          onToggle={() => setViewState((current) => ({
            ...current,
            pinnedSectionCollapsed: !current.pinnedSectionCollapsed,
          }))}
          bodyAs="ul"
          bodyClassName="feedback-collections-sidebar__list"
        >
          {visiblePinned.map((collection, index) => renderCollection(collection, index))}
        </SidebarGroupNode>
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
            {ordinary.map((collection) => renderCollection(collection, null))}
          </ul>
        )}
      </div>
    </ViewSidebar>
  );
}

export default CollectionsSidebar;
