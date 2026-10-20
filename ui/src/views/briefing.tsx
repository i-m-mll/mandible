import { useQuery } from '@tanstack/preact-query';
import { queryClient } from '../query/client';
import { browserResourceKeys } from '../query/browserResources';
import { useEffect, useMemo } from 'preact/hooks';

import {
  getBriefing,
  getBriefingSidebarSnapshot,
  ApiError,
  type BriefingBundle,
  type BriefingGroup,
  type BriefingSidebarSnapshot,
  type InstanceInfo,
  type InvalidBriefingRow,
} from '../api';

import { useAppShell, useRegisterInitialRouteLoad } from '../app-shell';
import { briefingGroupRoute, briefingRoute } from '../routing';
import { readPersistedViewState } from '../hooks/usePersistedViewState';
import { BriefingDocumentRenderer } from './feedback/BriefingDocumentRenderer';
import { BriefingGroupDetail } from './feedback/BriefingGroupDetail';
import { CollectionShell } from './feedback/CollectionShell';
import { DetailPaneNotice } from '../components/shared/DetailPaneNotice';
import { resolveFeedbackCollection, type FeedbackCollection } from './feedback/collection-model';
import {
  BRIEFING_VIEW_STATE_KEY,
  DEFAULT_BRIEFING_COLLECTION_VIEW_STATE,
  normalizeBriefingCollectionViewState,
  useBriefingCollectionViewState,
  type BriefingCollectionViewState,
} from './feedback/collection-view-state';
import {
  briefingGroupOwnsUpdate,
  indexBriefingGroupBundleOwners,
  resolveBriefingGroupProjection,
} from './feedback/briefing-group-projection';

export type BriefingViewProps = {
  instance: InstanceInfo | null;
  initialBriefingId?: string | null;
  initialRoundId?: string | null;
  initialGroupId?: string | null;
  sidebarHidden?: boolean;
  keepSubmittedAnnotations?: boolean;
};

function replaceBriefingRoute(briefingId: string, roundId?: string | null): void {
  window.history.replaceState(null, '', briefingRoute(briefingId, roundId));
}

function resolveBriefingRouteGroup(groups: readonly BriefingGroup[], groupId?: string | null): BriefingGroup | null {
  if (!groupId) return null;
  const exact = groups.find((group) => group.id === groupId);
  const prefixMatches = exact ? [] : groups.filter((group) => group.id.startsWith(groupId));
  return exact ?? (prefixMatches.length === 1 ? prefixMatches[0] : null);
}

function defaultBriefingGroup(
  groups: readonly BriefingGroup[],
  lifecycle: BriefingCollectionViewState['collectionLifecycle'],
): BriefingGroup | null {
  return groups.find((group) => lifecycle === 'all'
    || (lifecycle === 'archived' ? group.archivedAt != null : group.archivedAt == null)) ?? null;
}

function resolveBriefingSelection(
  sidebar: BriefingSidebarSnapshot,
  viewState: BriefingCollectionViewState,
  params: Record<string, string | null | undefined>,
): { briefing: FeedbackCollection | null; group: BriefingGroup | null; roundId: string | null } {
  const routeGroup = resolveBriefingRouteGroup(sidebar.groups, params.group);
  if (routeGroup) return { briefing: null, group: routeGroup, roundId: null };

  const routeBriefing = params.briefing
    ? resolveFeedbackCollection(sidebar.briefings, params.briefing)
    : null;
  if (routeBriefing) {
    return {
      briefing: routeBriefing,
      group: null,
      roundId: params.round || viewState.selectedRoundIds[routeBriefing.id] || null,
    };
  }

  const savedGroup = sidebar.groups.find((group) => group.id === viewState.selectedGroupId) ?? null;
  if (savedGroup) return { briefing: null, group: savedGroup, roundId: null };
  const savedBriefing = sidebar.briefings.find((entry) => entry.id === viewState.selectedCollectionId) ?? null;
  if (savedBriefing) {
    return {
      briefing: savedBriefing,
      group: null,
      roundId: viewState.selectedRoundIds[savedBriefing.id] ?? null,
    };
  }

  if (params.group || params.briefing) return { briefing: null, group: null, roundId: null };
  const fallbackGroup = defaultBriefingGroup(sidebar.groups, viewState.collectionLifecycle);
  if (fallbackGroup) return { briefing: null, group: fallbackGroup, roundId: null };
  const fallbackBriefing = sidebar.briefings[0] ?? null;
  return {
    briefing: fallbackBriefing,
    group: null,
    roundId: fallbackBriefing ? viewState.selectedRoundIds[fallbackBriefing.id] ?? null : null,
  };
}

function briefingDisplayContext(
  selected: FeedbackCollection | null,
  groups: readonly BriefingGroup[],
  viewState: BriefingCollectionViewState,
): { groupId: string; proposalBundleId: string | null } | undefined {
  if (!selected) return undefined;
  const groupBundleOwners = indexBriefingGroupBundleOwners(groups);
  for (const group of groups) {
    const projection = resolveBriefingGroupProjection(
      group,
      viewState.selectedGroupUpdateIds[group.id],
      groupBundleOwners,
    );
    if (projection.layoutSource?.members.some((member) => member.briefing.id === selected.id)) {
      return { groupId: group.id, proposalBundleId: projection.selectedUpdate?.id ?? null };
    }
  }
  return undefined;
}

/** Report rows the Briefing service returned that cannot be shown, without hiding the valid ones. */
export function InvalidBriefingsNotice({ rows }: { rows: readonly InvalidBriefingRow[] }): JSX.Element | null {
  if (rows.length === 0) return null;
  const title = rows.length === 1 ? '1 Briefing could not be shown' : `${rows.length} Briefings could not be shown`;
  return (
    <DetailPaneNotice source="briefing:invalid-rows" severity="warning" density="compact" title={title} testId="briefing-invalid-rows">
      <ul className="briefing-invalid-rows">
        {rows.map((row) => (
          <li key={`${row.id ?? ''}:${row.title ?? ''}:${row.reason}`}>
            {row.title ?? 'Untitled Briefing'}
            {row.id ? <> (<code>{row.id}</code>)</> : null}
            {`: ${row.reason}.`}
          </li>
        ))}
      </ul>
    </DetailPaneNotice>
  );
}

export function BriefingView({ instance, initialBriefingId, initialRoundId, initialGroupId, sidebarHidden = false, keepSubmittedAnnotations = false }: BriefingViewProps): JSX.Element {
  const appShell = useAppShell();
  const registerInitialRouteLoad = useRegisterInitialRouteLoad();
  const [viewState, setViewState] = useBriefingCollectionViewState();
  const sidebarQuery = useQuery({
    queryKey: browserResourceKeys.briefingSidebar,
    queryFn: ({ signal }) => getBriefingSidebarSnapshot(signal),
    enabled: appShell.active,
    refetchOnWindowFocus: true,
  }, queryClient);
  const sidebar = sidebarQuery.data ?? { briefings: [], bundles: [], groups: [], invalidBriefings: [] };
  const setSidebar = (update: (current: BriefingSidebarSnapshot) => BriefingSidebarSnapshot) =>
    queryClient.setQueryData<BriefingSidebarSnapshot>(browserResourceKeys.briefingSidebar, (current) => current ? update(current) : current);
  const { briefings, bundles, groups, invalidBriefings } = sidebar;
  const error = sidebarQuery.error instanceof ApiError && sidebarQuery.error.code === 'local_access_unavailable' ? null : sidebarQuery.error?.message ?? null;
  const accessUnavailable = sidebarQuery.error instanceof ApiError && sidebarQuery.error.code === 'local_access_unavailable';
  const sidebarLoaded = sidebarQuery.data !== undefined;
  useEffect(() => {
    if (appShell.active) registerInitialRouteLoad(sidebarQuery.refetch());
  }, [appShell.active, registerInitialRouteLoad]);

  useEffect(() => {
    if (!initialBriefingId) return;
    const briefing = resolveFeedbackCollection(briefings, initialBriefingId);
    if (!briefing) return;
    const id = briefing.id;
    setViewState((current) => ({
      ...current,
      selectedCollectionId: id,
      selectedGroupId: null,
      selectedRoundIds: initialRoundId
        ? { ...current.selectedRoundIds, [id]: initialRoundId }
        : current.selectedRoundIds,
    }));
  }, [briefings, initialBriefingId, initialRoundId, setViewState]);

  useEffect(() => {
    if (!initialGroupId) return;
    const group = resolveBriefingRouteGroup(groups, initialGroupId);
    if (!group) return;
    setViewState((current) => ({ ...current, selectedGroupId: group.id, selectedCollectionId: null }));
  }, [groups, initialGroupId, setViewState]);

  const selected = useMemo(() => briefings.find((entry) => entry.id === viewState.selectedCollectionId) ?? null, [briefings, viewState.selectedCollectionId]);
  const selectedGroup = useMemo(() => groups.find((group) => group.id === viewState.selectedGroupId) ?? null, [groups, viewState.selectedGroupId]);
  useEffect(() => {
    const hasResolvedCollection = sidebarLoaded || groups.length > 0 || briefings.length > 0;
    if (!appShell.active || !hasResolvedCollection || initialBriefingId || initialGroupId || selected || selectedGroup) return;
    const fallbackGroup = defaultBriefingGroup(groups, viewState.collectionLifecycle);
    if (fallbackGroup) {
      setViewState((current) => ({
        ...current,
        selectedGroupId: fallbackGroup.id,
        selectedCollectionId: null,
      }));
      window.history.replaceState(null, '', briefingGroupRoute(fallbackGroup.key));
      return;
    }
    const fallbackBriefing = briefings[0];
    if (!fallbackBriefing) return;
    setViewState((current) => ({
      ...current,
      selectedCollectionId: fallbackBriefing.id,
      selectedGroupId: null,
    }));
    replaceBriefingRoute(fallbackBriefing.collectionId);
  }, [appShell.active, briefings, groups, initialBriefingId, initialGroupId, selected, selectedGroup, setViewState, sidebarLoaded, viewState.collectionLifecycle]);
  useEffect(() => {
    if (!appShell.active || initialBriefingId || initialGroupId) return;
    if (selectedGroup) window.history.replaceState(null, '', briefingGroupRoute(selectedGroup.key));
    else if (selected) replaceBriefingRoute(selected.collectionId, viewState.selectedRoundIds[selected.id] ?? null);
  }, [appShell.active, initialBriefingId, initialGroupId, selected, selectedGroup, viewState.selectedRoundIds]);
  const groupBundleOwners = useMemo(() => indexBriefingGroupBundleOwners(groups), [groups]);
  const selectedGroupUpdateId = selectedGroup
    ? resolveBriefingGroupProjection(
      selectedGroup,
      viewState.selectedGroupUpdateIds[selectedGroup.id],
      groupBundleOwners,
    ).selectedUpdate?.id ?? null
    : null;
  const explicitRoundId = selected ? viewState.selectedRoundIds[selected.id] ?? null : null;
  const selectedDisplayContext = useMemo(
    () => briefingDisplayContext(selected, groups, viewState),
    [groups, selected, viewState.selectedGroupUpdateIds],
  );

  const selectBriefing = (briefing: FeedbackCollection) => {
    setViewState((current) => ({ ...current, selectedCollectionId: briefing.id, selectedGroupId: null }));
    replaceBriefingRoute(briefing.collectionId, viewState.selectedRoundIds[briefing.id] ?? null);
  };

  const selectGroup = (group: BriefingGroup) => {
    setViewState((current) => ({ ...current, selectedGroupId: group.id, selectedCollectionId: null }));
    window.history.replaceState(null, '', briefingGroupRoute(group.key));
  };

  const selectGroupUpdate = (ownerGroupId: string, updateId: string | null) => {
    const ownerGroup = groups.find((group) => group.id === ownerGroupId);
    if (!ownerGroup) return;
    setViewState((current) => {
      const selectedGroupUpdateIds = { ...current.selectedGroupUpdateIds };
      if (updateId && briefingGroupOwnsUpdate(ownerGroup, updateId, groupBundleOwners)) {
        selectedGroupUpdateIds[ownerGroupId] = updateId;
      } else {
        delete selectedGroupUpdateIds[ownerGroupId];
      }
      return { ...current, selectedGroupUpdateIds };
    });
  };

  const selectRound = (roundId: string | null) => {
    if (!selected) return;
    setViewState((current) => {
      const selectedRoundIds = { ...current.selectedRoundIds };
      if (roundId) selectedRoundIds[selected.id] = roundId;
      else delete selectedRoundIds[selected.id];
      return { ...current, selectedRoundIds };
    });
    replaceBriefingRoute(selected.collectionId, roundId);
  };

  const updateSelectedTitle = (title: string) => {
    if (!selected) return;
    const updateCollection = (collection: FeedbackCollection): FeedbackCollection => collection.collectionId === selected.collectionId
      ? { ...collection, label: title }
      : collection;
    const updateBundle = (bundle: BriefingBundle): BriefingBundle => ({
      ...bundle,
      members: bundle.members.map((member) => ({ ...member, briefing: updateCollection(member.briefing) })),
      layout: bundle.layout.map((entry) => entry.kind === 'briefing'
        ? { ...entry, briefing: updateCollection(entry.briefing) }
        : { ...entry, briefings: entry.briefings.map(updateCollection) }),
    });
    setSidebar((current) => ({
      ...current,
      briefings: current.briefings.map(updateCollection),
      bundles: current.bundles.map(updateBundle),
      groups: current.groups.map((group) => ({
        ...group,
        current: group.current ? updateBundle(group.current) : null,
        updates: group.updates.map(updateBundle),
      })),
    }));
  };

  const updateDispositionedGroup = (nextGroup: BriefingGroup) => {
    setSidebar((current) => ({
      ...current,
      groups: current.groups.map((group) => group.id === nextGroup.id ? nextGroup : group),
    }));
    setViewState((current) => {
      const selectedGroupUpdateIds = { ...current.selectedGroupUpdateIds };
      delete selectedGroupUpdateIds[nextGroup.id];
      return { ...current, selectedGroupUpdateIds };
    });
  };

  return (
    <CollectionShell collections={briefings} bundles={bundles} groups={groups} loadError={error ?? (accessUnavailable ? 'Local access is resuming.' : null)} confirmedLoaded={sidebarLoaded} sidebarHidden={sidebarHidden} viewState={viewState} setViewState={setViewState} onSelect={selectBriefing} onSelectGroup={selectGroup} notice={<>
      {error ? (
        <DetailPaneNotice source="briefing:refresh" severity="error" density="compact" title="Briefings could not be refreshed">{error}</DetailPaneNotice>
      ) : null}
      <InvalidBriefingsNotice rows={invalidBriefings} />
    </>}>
      {selectedGroup ? (
        <BriefingGroupDetail
          key={selectedGroup.id}
          group={selectedGroup}
          selectedUpdateId={selectedGroupUpdateId}
          onSelectUpdate={(updateId) => selectGroupUpdate(selectedGroup.id, updateId)}
          onDisposition={updateDispositionedGroup}
        />
      ) : !selected ? sidebarLoaded && !error ? <p className="briefing-empty briefing-empty--selection">No Briefings in this view.</p> : null : (
        <BriefingDocumentRenderer
          key={`${selected.collectionId}:${explicitRoundId ?? 'latest'}`}
          briefingId={selected.collectionId}
          briefingTitle={selected.label}
          briefingDescription={selected.description}
          roundId={explicitRoundId}
          displayContext={selectedDisplayContext}
          instance={instance}
          keepSubmittedAnnotations={keepSubmittedAnnotations}
          onRoundChange={selectRound}
          onTitleChange={updateSelectedTitle}
        />
      )}
    </CollectionShell>
  );
}

/** Warm the Briefing sidebar and only its explicit, saved, or default selection. */
export async function warmInitialData(params: Record<string, string>): Promise<void> {
  const sidebar = await queryClient.fetchQuery({
    queryKey: browserResourceKeys.briefingSidebar,
    queryFn: ({ signal }) => getBriefingSidebarSnapshot(signal),
  });
  const viewState = readPersistedViewState(
    BRIEFING_VIEW_STATE_KEY,
    normalizeBriefingCollectionViewState,
    DEFAULT_BRIEFING_COLLECTION_VIEW_STATE,
  );
  const selection = resolveBriefingSelection(sidebar, viewState, params);
  if (!selection.briefing) return;

  const briefingId = selection.briefing.collectionId;
  const displayContext = briefingDisplayContext(selection.briefing, sidebar.groups, viewState);
  await queryClient.fetchQuery({
    queryKey: browserResourceKeys.briefingProjection(briefingId, selection.roundId, null, displayContext),
    queryFn: ({ signal }) => getBriefing(briefingId, selection.roundId, null, signal, displayContext),
  });
}

export default BriefingView;
