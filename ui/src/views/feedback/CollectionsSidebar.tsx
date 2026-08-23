import type { Dispatch, StateUpdater } from 'preact/hooks';
import { useMemo, useState } from 'preact/hooks';

import { ViewSidebar } from '../../components/ViewSidebar';
import { VIEW_SIDEBAR_GEOMETRY } from '../../view-sidebar-geometry';
import { SidebarSearchFilterHeader } from '../../components/shared/SidebarSearchFilterHeader';
import { SidebarBriefingBundleIcon, SidebarGroupNode } from '../../components/shared/SidebarGroupNode';
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
import type { BriefingBundle, BriefingBundleLayoutEntry, BriefingGroup } from '../../api';

type BriefingSidebarOccurrence = {
  key: string;
  collection: FeedbackCollection;
};

export type CollectionsSidebarProps = {
  collections: readonly FeedbackCollection[];
  bundles?: readonly BriefingBundle[];
  groups?: readonly BriefingGroup[];
  loadError?: string | null;
  hidden?: boolean;
  selectedCollectionId: string | null;
  selectedGroupId?: string | null;
  viewState: BriefingCollectionViewState;
  setViewState: Dispatch<StateUpdater<BriefingCollectionViewState>>;
  onSelect(collection: FeedbackCollection): void;
  onSelectGroup?(group: BriefingGroup): void;
};

export function CollectionsSidebar({
  collections,
  bundles = [],
  groups = [],
  loadError = null,
  hidden = false,
  selectedCollectionId,
  selectedGroupId = null,
  viewState,
  setViewState,
  onSelect,
  onSelectGroup,
}: CollectionsSidebarProps): JSX.Element {
  const [draggedPinnedId, setDraggedPinnedId] = useState<string | null>(null);
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const pinned = useMemo(
    () => new Set(viewState.pinnedCollectionIds),
    [viewState.pinnedCollectionIds],
  );
  const filtered = useMemo(() => (
    filterFeedbackCollections(collections, viewState.collectionSourceFilter)
      .filter((collection) => !viewState.pinnedOnly || pinned.has(collection.id))
  ), [collections, viewState.collectionSourceFilter, viewState.pinnedOnly, pinned]);
  const ordered = useMemo(() => orderFeedbackCollections(
    filtered,
    viewState.pinnedCollectionIds,
    viewState.collectionSort,
  ), [
    filtered,
    viewState.collectionSort,
    viewState.pinnedCollectionIds,
  ]);
  const filteredIds = useMemo(() => new Set(filtered.map((collection) => collection.id)), [filtered]);
  const bundledIds = useMemo(() => new Set(
    bundles.flatMap((bundle) => bundle.members.map((member) => member.briefing.id)),
  ), [bundles]);
  const groupedUpdateIds = useMemo(() => new Set(
    groups.flatMap((group) => group.updates.map((update) => update.id)),
  ), [groups]);
  const visibleBundles = useMemo(() => bundles.filter((bundle) => !groupedUpdateIds.has(bundle.id)).map((bundle) => ({
    ...bundle,
    members: bundle.members.filter((member) => filteredIds.has(member.briefing.id)),
  })).filter((bundle) => bundle.members.length > 0 || !viewState.collectionSourceFilter.trim()), [
    bundles,
    filteredIds,
    groupedUpdateIds,
    viewState.collectionSourceFilter,
  ]);
  const visibleGroups = useMemo(() => groups.map((group) => {
    const update = group.updates.find((candidate) => candidate.id === viewState.selectedGroupUpdateIds[group.id])
      ?? group.updates[0]
      ?? null;
    const groupMatches = group.name.toLocaleLowerCase().includes(viewState.collectionSourceFilter.trim().toLocaleLowerCase());
    const layout = (update?.layout ?? []).map((entry): BriefingBundleLayoutEntry | null => {
      if (entry.kind === 'briefing') {
        return groupMatches || filteredIds.has(entry.briefing.id) ? entry : null;
      }
      const briefings = groupMatches
        ? entry.briefings
        : entry.briefings.filter((briefing) => filteredIds.has(briefing.id));
      return briefings.length > 0 || !viewState.collectionSourceFilter.trim()
        ? { ...entry, briefings }
        : null;
    }).filter((entry): entry is BriefingBundleLayoutEntry => entry !== null);
    return { group, update, layout };
  }).filter((entry) => entry.layout.length > 0 || !viewState.collectionSourceFilter.trim()), [
    groups,
    filteredIds,
    viewState.collectionSourceFilter,
    viewState.selectedGroupUpdateIds,
  ]);
  const unbundled = useMemo(() => ordered.filter((collection) => !bundledIds.has(collection.id)), [ordered, bundledIds]);
  const collapsedBundles = useMemo(() => new Set(viewState.collapsedBundleIds), [viewState.collapsedBundleIds]);
  const collapsedGroups = useMemo(() => new Set(viewState.collapsedGroupIds), [viewState.collapsedGroupIds]);
  const collapsedSubgroups = useMemo(() => new Set(viewState.collapsedGroupSubgroupKeys), [viewState.collapsedGroupSubgroupKeys]);
  const bundleExpanded = (bundleId: string) => Boolean(viewState.collectionSourceFilter.trim()) || !collapsedBundles.has(bundleId);
  const groupExpanded = (groupId: string) => Boolean(viewState.collectionSourceFilter.trim()) || !collapsedGroups.has(groupId);
  const navigationRows = useMemo(() => [
    ...visibleGroups.flatMap(({ group, update, layout }) => groupExpanded(group.id)
      ? layout.flatMap((entry, index) => entry.kind === 'briefing'
        ? [{ key: `group:${group.id}:${update?.id ?? 'empty'}:${index}:${entry.briefing.id}`, collection: entry.briefing }]
        : collapsedSubgroups.has(`${group.id}:${update?.id ?? 'empty'}:${index}`) && !viewState.collectionSourceFilter.trim()
          ? []
          : entry.briefings.map((briefing) => ({ key: `group:${group.id}:${update?.id ?? 'empty'}:${index}:${briefing.id}`, collection: briefing })))
      : []),
    ...visibleBundles.flatMap((bundle) => bundleExpanded(bundle.id)
      ? bundle.members.map((member) => ({ key: `bundle:${bundle.id}:${member.briefing.id}`, collection: member.briefing }))
      : []),
    ...unbundled.map((collection) => ({ key: `briefing:${collection.id}`, collection })),
  ], [visibleGroups, visibleBundles, unbundled, collapsedBundles, collapsedGroups, collapsedSubgroups, viewState.collectionSourceFilter]);
  const visiblePinned = useMemo(
    () => ordered.filter((collection) => pinned.has(collection.id)),
    [ordered, pinned],
  );
  const visiblePinnedIndexes = new Map(
    visiblePinned.map((collection, index) => [collection.id, index]),
  );
  const selectedNavigationKey = navigationRows.find((row) => row.collection.id === selectedCollectionId)?.key ?? null;
  const listNavigation = useSidebarListNavigation({
    items: navigationRows,
    getKey: (row) => row.key,
    selectedKey: selectedNavigationKey,
    onSelect: (row) => onSelect(row.collection),
  });
  const navigationIndex = new Map(navigationRows.map((row, index) => [row.key, index]));
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

  const toggleBundle = (bundleId: string) => {
    setViewState((current) => ({
      ...current,
      collapsedBundleIds: current.collapsedBundleIds.includes(bundleId)
        ? current.collapsedBundleIds.filter((id) => id !== bundleId)
        : [...current.collapsedBundleIds, bundleId],
    }));
  };

  const toggleGroup = (groupId: string) => {
    setViewState((current) => ({
      ...current,
      collapsedGroupIds: current.collapsedGroupIds.includes(groupId)
        ? current.collapsedGroupIds.filter((id) => id !== groupId)
        : [...current.collapsedGroupIds, groupId],
    }));
  };

  const toggleSubgroup = (subgroupKey: string) => {
    setViewState((current) => ({
      ...current,
      collapsedGroupSubgroupKeys: current.collapsedGroupSubgroupKeys.includes(subgroupKey)
        ? current.collapsedGroupSubgroupKeys.filter((key) => key !== subgroupKey)
        : [...current.collapsedGroupSubgroupKeys, subgroupKey],
    }));
  };

  const copyBriefingLink = (briefingId: string) => {
    const target = new URL(briefingRoute(briefingId), window.location.origin).href;
    navigator.clipboard?.writeText(target).catch(() => {});
  };

  const renderCollection = (
    occurrence: BriefingSidebarOccurrence,
    pinnedIndex: number | null,
    reorderable = true,
  ) => {
    const collection = occurrence.collection;
    const navigation = listNavigation.getItemNavigationProps(
      occurrence,
      navigationIndex.get(occurrence.key) ?? 0,
    );
    const isPinned = pinnedIndex !== null;
    const overflowActions: SidebarItemOverflowAction[] = [{
      id: 'copy-link',
      label: 'Copy link',
      ariaLabel: `Copy link to ${collection.label}`,
      onSelect: () => copyBriefingLink(collection.collectionId),
    }];
    if (isPinned && reorderable) {
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
        key={occurrence.key}
        className={`feedback-collection-row${isPinned ? ' feedback-collection-row--pinned' : ''}${draggedPinnedId === collection.id ? ' feedback-collection-row--dragging' : ''}`}
        draggable={isPinned && reorderable}
        onDragStart={isPinned && reorderable ? (event) => {
          setDraggedPinnedId(collection.id);
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', collection.id);
        } : undefined}
        onDragOver={isPinned && reorderable ? (event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
        } : undefined}
        onDrop={isPinned && reorderable ? (event) => {
          event.preventDefault();
          const movedId = draggedPinnedId || event.dataTransfer.getData('text/plain');
          if (movedId) movePinned(movedId, pinnedIndex);
          setDraggedPinnedId(null);
        } : undefined}
        onDragEnd={isPinned && reorderable ? () => setDraggedPinnedId(null) : undefined}
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
        ) : visibleGroups.length === 0 && visibleBundles.length === 0 && unbundled.length === 0 ? (
          <div className="feedback-collections-sidebar__list">
            <p className="feedback-collections-sidebar__empty" role="status">
              {collections.length === 0
                ? 'No Briefings have been reported yet.'
                : 'No Briefings match this search.'}
            </p>
          </div>
        ) : (
          <>
            {visibleGroups.map(({ group, update, layout }) => {
              const expanded = groupExpanded(group.id);
              const count = layout.reduce((total, entry) => total + (entry.kind === 'briefing' ? 1 : entry.briefings.length), 0);
              return (
                <SidebarGroupNode
                  key={group.id}
                  id={`briefing-group-${group.id}`}
                  presentation="category"
                  bodyClassName="feedback-collections-sidebar__group-layout"
                  label={group.name}
                  count={undefined}
                  expanded={expanded}
                  onToggle={() => toggleGroup(group.id)}
                  selection={{
                    selected: selectedGroupId === group.id,
                    label: `Select Briefing group ${group.name}`,
                    onSelect: () => onSelectGroup?.(group),
                  }}
                  headingDescription={`${count} Briefing${count === 1 ? '' : 's'} in selected proposed update`}
                >
                  {layout.map((entry, index) => {
                    if (entry.kind === 'briefing') {
                      return (
                        <ul className="feedback-collections-sidebar__list" key={`briefing:${index}:${entry.briefing.id}`}>
                          {renderCollection(
                            { key: `group:${group.id}:${update?.id ?? 'empty'}:${index}:${entry.briefing.id}`, collection: entry.briefing },
                            visiblePinnedIndexes.get(entry.briefing.id) ?? null,
                            false,
                          )}
                        </ul>
                      );
                    }
                    const subgroupKey = `${group.id}:${update?.id ?? 'empty'}:${index}`;
                    const subgroupExpanded = Boolean(viewState.collectionSourceFilter.trim()) || !collapsedSubgroups.has(subgroupKey);
                    return (
                      <SidebarGroupNode
                        key={`subgroup:${subgroupKey}`}
                        id={`briefing-subgroup-${group.id}-${index}`}
                        presentation="folder"
                        bodyAs="ul"
                        bodyClassName="feedback-collections-sidebar__list"
                        label={entry.name}
                        count={entry.briefings.length}
                        countLabel={`${entry.briefings.length} Briefing${entry.briefings.length === 1 ? '' : 's'} in ${entry.name}`}
                        countVisibility="interaction"
                        expanded={subgroupExpanded}
                        onToggle={() => toggleSubgroup(subgroupKey)}
                        leadingIcon={<SidebarBriefingBundleIcon expanded={subgroupExpanded} />}
                      >
                        {entry.briefings.map((briefing) => renderCollection(
                          { key: `group:${group.id}:${update?.id ?? 'empty'}:${index}:${briefing.id}`, collection: briefing },
                          visiblePinnedIndexes.get(briefing.id) ?? null,
                          false,
                        ))}
                      </SidebarGroupNode>
                    );
                  })}
                </SidebarGroupNode>
              );
            })}
            {visibleBundles.map((bundle) => {
              const expanded = bundleExpanded(bundle.id);
              return (
                <SidebarGroupNode
                  key={bundle.id}
                  id={`briefing-bundle-${bundle.id}`}
                  presentation="folder"
                  bodyAs="ul"
                  bodyClassName="feedback-collections-sidebar__list"
                  label={bundle.name}
                  count={bundle.members.length}
                  countLabel={`${bundle.members.length} Briefing${bundle.members.length === 1 ? '' : 's'} in ${bundle.name}`}
                  countVisibility="interaction"
                  expanded={expanded}
                  onToggle={() => toggleBundle(bundle.id)}
                  leadingIcon={<SidebarBriefingBundleIcon expanded={expanded} />}
                >
                  {bundle.members.map((member) => renderCollection(
                    { key: `bundle:${bundle.id}:${member.briefing.id}`, collection: member.briefing },
                    visiblePinnedIndexes.get(member.briefing.id) ?? null,
                    false,
                  ))}
                </SidebarGroupNode>
              );
            })}
            {unbundled.length > 0 ? (
              <ul className="feedback-collections-sidebar__list">
                {unbundled.map((collection) => renderCollection(
                  { key: `briefing:${collection.id}`, collection },
                  visiblePinnedIndexes.get(collection.id) ?? null,
                ))}
              </ul>
            ) : null}
          </>
        )}
      </div>
    </ViewSidebar>
  );
}

export default CollectionsSidebar;
