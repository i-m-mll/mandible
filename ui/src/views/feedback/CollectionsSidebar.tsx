import type { Dispatch, StateUpdater } from 'preact/hooks';
import { useMemo, useState } from 'preact/hooks';

import { ViewSidebar } from '../../components/ViewSidebar';
import { SidebarSearchFilterHeader } from '../../components/shared/SidebarSearchFilterHeader';
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
  hidden?: boolean;
  selectedCollectionId: string | null;
  viewState: BriefingCollectionViewState;
  setViewState: Dispatch<StateUpdater<BriefingCollectionViewState>>;
  onSelect(collection: FeedbackCollection): void;
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
}: CollectionsSidebarProps): JSX.Element {
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [draggedPinnedId, setDraggedPinnedId] = useState<string | null>(null);
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
  const visiblePinned = useMemo(
    () => ordered.filter((collection) => pinned.has(collection.id)),
    [ordered, pinned],
  );
  const ordinary = useMemo(
    () => ordered.filter((collection) => !pinned.has(collection.id)),
    [ordered, pinned],
  );
  const kinds = useMemo(
    () => [...new Set(collections.map((collection) => collection.kind))].sort(),
    [collections],
  );
  const activeFilterCount = Number(viewState.collectionKindFilter !== 'all')
    + Number(viewState.collectionStateFilter !== 'all');
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
          selectionLabel={`Select collection ${collection.label}`}
          selectionDescription={`Briefing state: ${collection.state}`}
          selected={selectedCollectionId === collection.id}
          ariaCurrent={navigation['aria-current']}
          onKeyDown={navigation.onKeyDown}
          onSelect={() => onSelect(collection)}
          badges={(
            <SidebarItemBadge
              className="feedback-collection-row__count"
              ariaLabel={`${collection.itemCount} item${collection.itemCount === 1 ? '' : 's'}`}
              title={`${collection.itemCount} item${collection.itemCount === 1 ? '' : 's'}`}
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
      ariaLabel="Feedback collections"
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
        <section className="feedback-collections-sidebar__pinned" aria-labelledby="briefing-pinned-heading">
          <button
            id="briefing-pinned-heading"
            type="button"
            className="feedback-collections-sidebar__section-heading"
            aria-expanded={!viewState.pinnedSectionCollapsed}
            aria-controls="briefing-pinned-list"
            onClick={() => setViewState((current) => ({
              ...current,
              pinnedSectionCollapsed: !current.pinnedSectionCollapsed,
            }))}
          >
            <strong>Pinned</strong>
            <em aria-label={`${visiblePinned.length} pinned briefing${visiblePinned.length === 1 ? '' : 's'}`}>
              {visiblePinned.length}
            </em>
          </button>
          {!viewState.pinnedSectionCollapsed ? (
            <ul id="briefing-pinned-list" className="feedback-collections-sidebar__list">
              {visiblePinned.map((collection, index) => renderCollection(collection, index))}
            </ul>
          ) : null}
        </section>
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
            {ordinary.map((collection) => renderCollection(collection, null))}
          </ul>
        )}
      </div>
    </ViewSidebar>
  );
}

export default CollectionsSidebar;
