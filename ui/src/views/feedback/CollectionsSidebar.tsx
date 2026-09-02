import type { Dispatch, StateUpdater } from 'preact/hooks';
import { useMemo, useState } from 'preact/hooks';

import { ViewSidebar } from '../../components/ViewSidebar';
import { VIEW_SIDEBAR_GEOMETRY } from '../../view-sidebar-geometry';
import { SidebarSearchFilterHeader } from '../../components/shared/SidebarSearchFilterHeader';
import { SidebarBriefingBundleIcon, SidebarGroupNode } from '../../components/shared/SidebarGroupNode';
import {
  SidebarItemBadge,
  SidebarItemOverflowMenu,
  SidebarItemRow,
  type SidebarItemOverflowAction,
} from '../../components/shared/SidebarItemRow';
import { useSidebarListNavigation } from '../../hooks/useSidebarListNavigation';
import { briefingRoute } from '../../routing';
import {
  filterFeedbackCollections,
  orderFeedbackCollections,
  type FeedbackCollection,
} from './collection-model';
import type { BriefingCollectionViewState } from './collection-view-state';
import type { BriefingBundle, BriefingBundleLayoutEntry, BriefingGroup } from '../../api';
import { indexBriefingGroupBundleOwners, resolveBriefingGroupProjection } from './briefing-group-projection';

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
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const filtered = useMemo(
    () => filterFeedbackCollections(collections, viewState.collectionSourceFilter),
    [collections, viewState.collectionSourceFilter],
  );
  const ordered = useMemo(() => orderFeedbackCollections(
    filtered,
    viewState.collectionSort,
  ), [
    filtered,
    viewState.collectionSort,
  ]);
  const filteredIds = useMemo(() => new Set(filtered.map((collection) => collection.id)), [filtered]);
  const containedBriefingIds = useMemo(() => new Set([
    ...bundles,
    ...groups.flatMap((group) => [
      ...(group.current ? [group.current] : []),
      ...group.updates,
      ...(group.history ?? []).flatMap((entry) => [
        ...(entry.priorBase ? [entry.priorBase] : []),
        entry.proposal,
        ...(entry.resultingBase ? [entry.resultingBase] : []),
      ]),
    ]),
  ].flatMap((bundle) => bundle.members.map((member) => member.briefing.id))), [bundles, groups]);
  const groupedBundleIds = useMemo(() => new Set(
    groups.flatMap((group) => [
      ...(group.current ? [group.current.id] : []),
      ...group.updates.map((update) => update.id),
      ...(group.history ?? []).flatMap((entry) => [
        ...(entry.priorBase ? [entry.priorBase.id] : []),
        entry.proposal.id,
        ...(entry.resultingBase ? [entry.resultingBase.id] : []),
      ]),
    ]),
  ), [groups]);
  const groupBundleOwners = useMemo(() => indexBriefingGroupBundleOwners(groups), [groups]);
  const lifecycleGroups = useMemo(() => groups.filter((group) => viewState.collectionLifecycle === 'all'
    || (viewState.collectionLifecycle === 'archived' ? group.archivedAt != null : group.archivedAt == null)),
  [groups, viewState.collectionLifecycle]);
  const visibleBundles = useMemo(() => viewState.collectionLifecycle === 'archived' ? [] : bundles.filter((bundle) => !groupedBundleIds.has(bundle.id)).map((bundle) => ({
    ...bundle,
    members: bundle.members.filter((member) => filteredIds.has(member.briefing.id)),
  })).filter((bundle) => bundle.members.length > 0), [
    bundles,
    filteredIds,
    groupedBundleIds,
    viewState.collectionSourceFilter,
    viewState.collectionLifecycle,
  ]);
  const visibleGroups = useMemo(() => lifecycleGroups.map((group) => {
    const projection = resolveBriefingGroupProjection(
      group,
      viewState.selectedGroupUpdateIds[group.id],
      groupBundleOwners,
    );
    const { layoutSource } = projection;
    const groupMatches = group.name.toLocaleLowerCase().includes(viewState.collectionSourceFilter.trim().toLocaleLowerCase());
    const layout = (layoutSource?.layout ?? []).map((entry): BriefingBundleLayoutEntry | null => {
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
    return { group, projection, layout };
  }).filter((entry) => entry.layout.length > 0 || !viewState.collectionSourceFilter.trim()), [
    lifecycleGroups,
    filteredIds,
    viewState.collectionSourceFilter,
    viewState.selectedGroupUpdateIds,
    groupBundleOwners,
  ]);
  const unbundled = useMemo(() => viewState.collectionLifecycle === 'archived' ? []
    : ordered.filter((collection) => !containedBriefingIds.has(collection.id)),
  [ordered, containedBriefingIds, viewState.collectionLifecycle]);
  const collapsedBundles = useMemo(() => new Set(viewState.collapsedBundleIds), [viewState.collapsedBundleIds]);
  const collapsedGroups = useMemo(() => new Set(viewState.collapsedGroupIds), [viewState.collapsedGroupIds]);
  const collapsedSubgroups = useMemo(() => new Set(viewState.collapsedGroupSubgroupKeys), [viewState.collapsedGroupSubgroupKeys]);
  const bundleExpanded = (bundleId: string) => Boolean(viewState.collectionSourceFilter.trim()) || !collapsedBundles.has(bundleId);
  const groupExpanded = (groupId: string) => Boolean(viewState.collectionSourceFilter.trim()) || !collapsedGroups.has(groupId);
  const navigationRows = useMemo(() => [
    ...visibleGroups.flatMap(({ group, projection, layout }) => groupExpanded(group.id)
      ? layout.flatMap((entry, index) => entry.kind === 'briefing'
        ? [{ key: `group:${projection.ownerGroupId}:${projection.layoutSource?.id ?? 'empty'}:${index}:${entry.briefing.id}`, collection: entry.briefing }]
        : collapsedSubgroups.has(`${projection.ownerGroupId}:${projection.layoutSource?.id ?? 'empty'}:${index}`) && !viewState.collectionSourceFilter.trim()
          ? []
          : entry.briefings.map((briefing) => ({ key: `group:${projection.ownerGroupId}:${projection.layoutSource?.id ?? 'empty'}:${index}:${briefing.id}`, collection: briefing })))
      : []),
    ...visibleBundles.flatMap((bundle) => bundleExpanded(bundle.id)
      ? bundle.members.map((member) => ({ key: `bundle:${bundle.id}:${member.briefing.id}`, collection: member.briefing }))
      : []),
    ...unbundled.map((collection) => ({ key: `briefing:${collection.id}`, collection })),
  ], [visibleGroups, visibleBundles, unbundled, collapsedBundles, collapsedGroups, collapsedSubgroups, viewState.collectionSourceFilter]);
  const selectedNavigationKey = navigationRows.find((row) => row.collection.id === selectedCollectionId)?.key ?? null;
  const listNavigation = useSidebarListNavigation({
    items: navigationRows,
    getKey: (row) => row.key,
    selectedKey: selectedNavigationKey,
    onSelect: (row) => onSelect(row.collection),
  });
  const navigationIndex = new Map(navigationRows.map((row, index) => [row.key, index]));
  const activeFilterCount = Number(viewState.collectionSort !== 'activity')
    + Number(viewState.collectionLifecycle !== 'active');

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

  const renderCollection = (occurrence: BriefingSidebarOccurrence) => {
    const collection = occurrence.collection;
    const navigation = listNavigation.getItemNavigationProps(
      occurrence,
      navigationIndex.get(occurrence.key) ?? 0,
    );
    const overflowActions: SidebarItemOverflowAction[] = [{
      id: 'copy-link',
      label: 'Copy link',
      ariaLabel: `Copy link to ${collection.label}`,
      onSelect: () => copyBriefingLink(collection.collectionId),
    }];
    return (
      <li
        key={occurrence.key}
        className="feedback-collection-row"
      >
        <SidebarItemRow
          tabIndex={navigation.tabIndex}
          selectRef={navigation.ref}
          label={collection.label}
          selectionLabel={`Select briefing ${collection.label}`}
          selectionDescription={collection.unansweredDirectiveCount > 0
            ? `${collection.unansweredDirectiveCount} unanswered directive${collection.unansweredDirectiveCount === 1 ? '' : 's'}`
            : 'No unanswered directives'}
          selected={selectedCollectionId === collection.id}
          trailingReveal="interaction"
          ariaCurrent={navigation['aria-current']}
          onKeyDown={navigation.onKeyDown}
          onSelect={() => onSelect(collection)}
          badges={collection.unansweredDirectiveCount > 0 ? (
            <SidebarItemBadge
              className="feedback-collection-row__count"
              ariaLabel={`${collection.unansweredDirectiveCount} unanswered directive${collection.unansweredDirectiveCount === 1 ? '' : 's'}`}
              title={`${collection.unansweredDirectiveCount} unanswered directive${collection.unansweredDirectiveCount === 1 ? '' : 's'}`}
            >
              {collection.unansweredDirectiveCount}
            </SidebarItemBadge>
          ) : undefined}
          actions={(
            <SidebarItemOverflowMenu
              label={`Briefing actions for ${collection.label}`}
              actions={overflowActions}
            />
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
              {viewState.collectionSort === 'name' ? <span>By name</span> : null}
              {viewState.collectionSort === 'unanswered-count' ? <span>Needs response</span> : null}
              {viewState.collectionLifecycle === 'all' ? <span>All</span> : null}
              {viewState.collectionLifecycle === 'archived' ? <span>Archived</span> : null}
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
                  <label className="sidebar-search-filter__label" for="briefing-lifecycle">Collection</label>
                  <select
                    id="briefing-lifecycle"
                    aria-label="Briefing collection lifecycle"
                    value={viewState.collectionLifecycle}
                    onInput={(event) => setViewState((current) => ({
                      ...current,
                      collectionLifecycle: event.currentTarget.value as BriefingCollectionViewState['collectionLifecycle'],
                    }))}
                  >
                    <option value="active">Active</option>
                    <option value="all">All</option>
                    <option value="archived">Archived</option>
                  </select>
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
                    <option value="unanswered-count">Needs response</option>
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
            {visibleGroups.map(({ group, projection, layout }) => {
              const expanded = groupExpanded(group.id);
              const count = layout.reduce((total, entry) => total + (entry.kind === 'briefing' ? 1 : entry.briefings.length), 0);
              return (
                <SidebarGroupNode
                  key={group.id}
                  id={`briefing-group-${group.id}`}
                  presentation="nested"
                  className="feedback-collections-sidebar__group"
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
                  headingDescription={`${count} Briefing${count === 1 ? '' : 's'} in ${projection.selectedUpdate ? 'selected proposed update' : 'current layout'}`}
                >
                  {layout.map((entry, index) => {
                    if (entry.kind === 'briefing') {
                      return (
                        <ul
                          className="feedback-collections-sidebar__list"
                          key={`briefing:${projection.ownerGroupId}:${projection.layoutSource?.id ?? 'empty'}:${index}:${entry.briefing.id}`}
                        >
                          {renderCollection(
                            { key: `group:${projection.ownerGroupId}:${projection.layoutSource?.id ?? 'empty'}:${index}:${entry.briefing.id}`, collection: entry.briefing },
                          )}
                        </ul>
                      );
                    }
                    const subgroupKey = `${projection.ownerGroupId}:${projection.layoutSource?.id ?? 'empty'}:${index}`;
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
                          { key: `group:${projection.ownerGroupId}:${projection.layoutSource?.id ?? 'empty'}:${index}:${briefing.id}`, collection: briefing },
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
                  ))}
                </SidebarGroupNode>
              );
            })}
            {unbundled.length > 0 ? (
              <ul className="feedback-collections-sidebar__list">
                {unbundled.map((collection) => renderCollection(
                  { key: `briefing:${collection.id}`, collection },
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
