import { useQuery } from '@tanstack/preact-query';
import { queryClient } from '../query/client';
import { ROUTE_DATA_FRESH_MS } from '../query/policy';
import { browserResourceKeys } from '../query/browserResources';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'preact/hooks';

import {
  canReadBriefingLayouts,
  getBriefing,
  getBriefingSidebarSnapshot,
  ApiError,
  type BriefingBundle,
  type BriefingGroup,
  type BriefingSidebarSnapshot,
  type InstanceInfo,
  type InvalidBriefingRow,
} from '../api';

import { useAppShell, useRouteLoad, useViewActive } from '../app-shell';
import { replaceRoute, routeWithParams, shortRouteId } from '../routing';
import { rememberEntityRoute } from '../query/entityRoute';
import { useEntityRoute } from '../hooks/useEntityRoute';
import { EntityRouteState, isUnopenedEntityRoute } from '../components/shared/EntityRouteState';
import { readPersistedViewState } from '../hooks/usePersistedViewState';
import { BriefingDocumentRenderer } from './feedback/BriefingDocumentRenderer';
import { BriefingGroupDetail } from './feedback/BriefingGroupDetail';
import { CollectionShell } from './feedback/CollectionShell';
import { DetailPaneNotice } from '../components/shared/DetailPaneNotice';
import { feedbackCollectionIdentity, type FeedbackCollection } from './feedback/collection-model';
import {
  BRIEFING_VIEW_STATE_KEY,
  DEFAULT_BRIEFING_COLLECTION_VIEW_STATE,
  normalizeBriefingCollectionViewState,
  useBriefingCollectionViewState,
  type BriefingCollectionViewState,
} from './feedback/collection-view-state';
import {
  briefingGroupOwnsPendingChange,
  indexBriefingGroupBundleOwners,
  resolveBriefingGroupProjection,
} from './feedback/briefing-group-projection';

export type BriefingViewProps = {
  instance: InstanceInfo | null;
  /** The ref of a `/briefing/<ref>` path. */
  entityRef?: string | null;
  initialRoundId?: string | null;
  initialGroupKey?: string | null;
  sidebarHidden?: boolean;
  keepSubmittedAnnotations?: boolean;
};

const BRIEFING_ROUTE_PARAMS = ['group', 'round'] as const;

function replaceBriefingRoute(briefingId: string, roundId?: string | null): void {
  const ref = shortRouteId(briefingId);
  rememberEntityRoute('briefing', ref, { id: briefingId });
  replaceRoute(routeWithParams({ kind: 'entity', entity: 'briefing', ref }, {
    round: roundId ? shortRouteId(roundId) : null,
  }, BRIEFING_ROUTE_PARAMS));
}

function replaceBriefingGroupRoute(groupKey: string): void {
  replaceRoute(routeWithParams({ kind: 'view', tab: 'briefing' }, { group: groupKey }, BRIEFING_ROUTE_PARAMS));
}

function briefingTargetQuery(ref: string, roundId: string | null, displayContext?: BriefingDisplayContext) {
  return {
    queryKey: browserResourceKeys.briefingProjection(ref, roundId, null, displayContext),
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const projection = await getBriefing(ref, roundId, null, signal, displayContext);
      if (projection.briefing_id !== ref) {
        queryClient.setQueryData(browserResourceKeys.briefingProjection(projection.briefing_id, roundId, null, displayContext), projection);
      }
      return projection;
    },
  };
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
): { status: 'resolved' | 'not-found' | 'ambiguous' | 'empty'; briefing: FeedbackCollection | null; group: BriefingGroup | null; roundId: string | null } {
  if (params.group) {
    const matches = sidebar.groups.filter((group) => group.key === params.group);
    return { status: matches.length > 1 ? 'ambiguous' : matches.length ? 'resolved' : 'not-found',
      briefing: null, group: matches.length === 1 ? matches[0] : null, roundId: null };
  }

  const savedGroup = sidebar.groups.find((group) => group.id === viewState.selectedGroupId) ?? null;
  if (savedGroup) return { status: 'resolved', briefing: null, group: savedGroup, roundId: null };
  const savedBriefing = sidebar.briefings.find((entry) => entry.id === viewState.selectedCollectionId) ?? null;
  if (savedBriefing) {
    return {
      status: 'resolved',
      briefing: savedBriefing,
      group: null,
      roundId: viewState.selectedRoundIds[savedBriefing.id] ?? null,
    };
  }

  const fallbackGroup = defaultBriefingGroup(sidebar.groups, viewState.collectionLifecycle);
  if (fallbackGroup) return { status: 'resolved', briefing: null, group: fallbackGroup, roundId: null };
  const fallbackBriefing = sidebar.briefings[0] ?? null;
  return {
    status: fallbackBriefing ? 'resolved' : 'empty',
    briefing: fallbackBriefing,
    group: null,
    roundId: fallbackBriefing ? viewState.selectedRoundIds[fallbackBriefing.id] ?? null : null,
  };
}

type BriefingDisplayContext = { groupId: string; proposalBundleId: string | null };

function briefingDisplayContext(
  briefingId: string | null,
  groups: readonly BriefingGroup[],
  viewState: BriefingCollectionViewState,
): BriefingDisplayContext | undefined {
  if (!briefingId) return undefined;
  const groupBundleOwners = indexBriefingGroupBundleOwners(groups);
  for (const group of groups) {
    const projection = resolveBriefingGroupProjection(
      group,
      viewState.selectedGroupUpdateIds[group.id],
      groupBundleOwners,
    );
    if (projection.layoutSource?.members.some((member) => member.briefing.collectionId === briefingId)) {
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

export function BriefingView({ instance, entityRef = null, initialRoundId, initialGroupKey, sidebarHidden = false, keepSubmittedAnnotations = false }: BriefingViewProps): JSX.Element {
  const appShell = useAppShell();
  const routeResolution = useEntityRoute('briefing', entityRef);
  const initialBriefingId = routeResolution.status === 'resolved' && routeResolution.ref === entityRef
    && typeof routeResolution.entity.id === 'string'
    ? routeResolution.entity.id : null;
  const viewActive = useViewActive();
  const [viewState, setViewState] = useBriefingCollectionViewState();
  const groupUnavailable = Boolean(initialGroupKey && !entityRef && !canReadBriefingLayouts(instance));
  const sidebarQuery = useQuery({
    queryKey: browserResourceKeys.briefingSidebar,
    queryFn: ({ signal }) => getBriefingSidebarSnapshot(signal, instance),
    enabled: viewActive,
    staleTime: ROUTE_DATA_FRESH_MS,
    refetchOnWindowFocus: true,
  }, queryClient);
  const sidebar = sidebarQuery.data ?? { briefings: [], bundles: [], groups: [], invalidBriefings: [] };
  const setSidebar = (update: (current: BriefingSidebarSnapshot) => BriefingSidebarSnapshot) =>
    queryClient.setQueryData<BriefingSidebarSnapshot>(browserResourceKeys.briefingSidebar, (current) => current ? update(current) : current);
  const { briefings, bundles, groups, invalidBriefings } = sidebar;
  const error = sidebarQuery.error instanceof ApiError && sidebarQuery.error.code === 'local_access_unavailable' ? null : sidebarQuery.error?.message ?? null;
  const sidebarLoaded = sidebarQuery.data !== undefined;
  const initialDisplayContext = useMemo(
    () => briefingDisplayContext(initialBriefingId, groups, viewState),
    [initialBriefingId, groups, viewState.selectedGroupUpdateIds],
  );
  const explicitBriefingQuery = useQuery({
    ...briefingTargetQuery(initialBriefingId ?? '', initialRoundId ?? null, initialDisplayContext),
    enabled: viewActive && Boolean(initialBriefingId),
    staleTime: ROUTE_DATA_FRESH_MS,
    refetchOnWindowFocus: true,
  }, queryClient);
  useRouteLoad((register) => {
    if (sidebarQuery.isStale) register(sidebarQuery.refetch({ cancelRefetch: false }));
  }, []);
  useRouteLoad((register) => {
    if (initialBriefingId && explicitBriefingQuery.isStale) register(explicitBriefingQuery.refetch({ cancelRefetch: false }));
  }, [initialBriefingId, initialRoundId, initialDisplayContext]);

  const hasExplicitTarget = Boolean(entityRef || initialGroupKey);
  const explicitError = explicitBriefingQuery.error;
  const projection = initialBriefingId ? explicitBriefingQuery.data : undefined;
  const explicitBriefing: FeedbackCollection | null = projection
    ? briefings.find((entry) => entry.collectionId === projection.briefing_id) ?? {
      id: feedbackCollectionIdentity(projection.briefing_id), collectionId: projection.briefing_id,
      label: projection.title, description: projection.description, publicationMode: projection.publication_mode,
      latestRoundId: projection.latest_round_id, unansweredDirectiveCount: 0, createdAt: 0, updatedAt: 0,
    } : null;
  const selection = initialBriefingId
    ? { briefing: explicitBriefing, group: null, roundId: initialRoundId ?? null, status: explicitBriefing ? 'resolved' : 'not-found' }
    : entityRef ? { briefing: null, group: null, roundId: null, status: 'empty' as const }
    : resolveBriefingSelection(sidebar, viewState, { group: initialGroupKey });
  const entityResolutionPending = routeResolution.status === 'resolving'
    || (routeResolution.status === 'resolved' && routeResolution.ref !== entityRef);
  const routeStatus = initialBriefingId
    ? explicitBriefing ? 'resolved' : explicitError ? 'error' : 'resolving'
    : entityRef ? entityResolutionPending ? 'resolving' : 'error'
    : hasExplicitTarget && selection.status !== 'resolved'
    ? sidebarQuery.error ? 'error' : !sidebarLoaded || sidebarQuery.isFetching ? 'resolving' : selection.status
    : selection.status;
  const lastResolvedSelection = useRef<typeof selection | null>(null);
  useLayoutEffect(() => {
    if (!appShell.active || routeStatus === 'resolving') return;
    lastResolvedSelection.current = routeStatus === 'resolved' ? selection : null;
  }, [appShell.active, routeStatus, selection]);
  const displayedSelection = routeStatus === 'resolving' ? lastResolvedSelection.current : selection;
  const selected = displayedSelection?.briefing ?? null;
  const selectedGroup = displayedSelection?.group ?? null;
  const explicitRoundId = displayedSelection?.roundId ?? null;
  const selectedCollectionId = selected?.id ?? null;
  const selectedGroupId = selectedGroup?.id ?? null;
  useEffect(() => {
    if (!appShell.active || routeStatus !== 'resolved') return;
    setViewState((current) => {
      const roundMatches = !selectedCollectionId || (current.selectedRoundIds[selectedCollectionId] ?? null) === explicitRoundId;
      if (current.selectedCollectionId === selectedCollectionId && current.selectedGroupId === selectedGroupId && roundMatches) return current;
      const selectedRoundIds = { ...current.selectedRoundIds };
      if (selectedCollectionId) {
        if (explicitRoundId) selectedRoundIds[selectedCollectionId] = explicitRoundId;
        else delete selectedRoundIds[selectedCollectionId];
      }
      return { ...current, selectedCollectionId, selectedGroupId, selectedRoundIds };
    });
    if (!hasExplicitTarget) {
      if (selectedGroup) replaceBriefingGroupRoute(selectedGroup.key);
      else if (selected) replaceBriefingRoute(selected.collectionId, explicitRoundId);
    }
  }, [appShell.active, routeStatus, selectedCollectionId, selectedGroupId, explicitRoundId, hasExplicitTarget, setViewState]);
  const groupBundleOwners = useMemo(() => indexBriefingGroupBundleOwners(groups), [groups]);
  const requestedGroupUpdateId = selectedGroup ? viewState.selectedGroupUpdateIds[selectedGroup.id] : null;
  const selectedGroupUpdateId = selectedGroup && requestedGroupUpdateId
    && briefingGroupOwnsPendingChange(selectedGroup, requestedGroupUpdateId, groupBundleOwners)
    ? requestedGroupUpdateId : null;
  const selectedDisplayContext = useMemo(
    () => briefingDisplayContext(selected?.collectionId ?? null, groups, viewState),
    [groups, selected, viewState.selectedGroupUpdateIds],
  );

  const selectBriefing = (briefing: FeedbackCollection) => {
    setViewState((current) => ({ ...current, selectedCollectionId: briefing.id, selectedGroupId: null }));
    replaceBriefingRoute(briefing.collectionId, viewState.selectedRoundIds[briefing.id] ?? null);
  };

  const selectGroup = (group: BriefingGroup) => {
    setViewState((current) => ({ ...current, selectedGroupId: group.id, selectedCollectionId: null }));
    replaceBriefingGroupRoute(group.key);
  };

  const selectGroupUpdate = (ownerGroupId: string, updateId: string | null) => {
    const ownerGroup = groups.find((group) => group.id === ownerGroupId);
    if (!ownerGroup) return;
    setViewState((current) => {
      const selectedGroupUpdateIds = { ...current.selectedGroupUpdateIds };
      if (updateId && briefingGroupOwnsPendingChange(ownerGroup, updateId, groupBundleOwners)) {
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
        : entry.kind === 'subgroup' ? { ...entry, briefings: entry.briefings.map(updateCollection), members: entry.members?.map(member =>
          member.kind === 'briefing' ? { ...member, briefing: updateCollection(member.briefing) } : member) } : entry),
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
      const selectedId = current.selectedGroupUpdateIds[nextGroup.id];
      if (!selectedId || nextGroup.updates.some(update => update.id === selectedId)
        || nextGroup.trackedProposals?.some(proposal => proposal.request_id === selectedId)) return current;
      const selectedGroupUpdateIds = { ...current.selectedGroupUpdateIds };
      delete selectedGroupUpdateIds[nextGroup.id];
      return { ...current, selectedGroupUpdateIds };
    });
  };

  return (
    <CollectionShell collections={briefings} bundles={bundles} groups={groups} confirmedLoaded={sidebarLoaded} sidebarHidden={sidebarHidden} viewState={{ ...viewState, selectedCollectionId, selectedGroupId }} setViewState={setViewState} onSelect={selectBriefing} onSelectGroup={selectGroup} notice={<>
      {error ? (
        <DetailPaneNotice source="briefing:refresh" severity="error" density="compact" title="Briefings could not be refreshed">{error}</DetailPaneNotice>
      ) : null}
      <InvalidBriefingsNotice rows={invalidBriefings} />
    </>}>
      {isUnopenedEntityRoute(routeResolution) && routeResolution.status !== 'resolving' ? (
        <EntityRouteState kind="briefing" resolution={routeResolution} />
      ) : groupUnavailable ? null
      : hasExplicitTarget && routeStatus !== 'resolved' && routeStatus !== 'resolving' ? (
        <div role="alert" data-route-state={routeStatus}>
          {routeStatus === 'ambiguous' ? 'This Briefing reference matches more than one item. Open a link with a longer reference.'
              : routeStatus === 'error' ? `The Briefing link could not be resolved: ${(initialBriefingId ? explicitError : sidebarQuery.error)?.message}`
                : 'The linked Briefing could not be found.'}
        </div>
      ) : selectedGroup ? (
        <BriefingGroupDetail
          key={selectedGroup.id}
          group={selectedGroup}
          selectedUpdateId={selectedGroupUpdateId}
          onSelectUpdate={(updateId) => selectGroupUpdate(selectedGroup.id, updateId)}
          onDisposition={updateDispositionedGroup}
          onRefresh={() => { void sidebarQuery.refetch(); }}
          onSelectBriefing={selectBriefing}
        />
      ) : selected ? (
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
      ) : routeStatus === 'resolving' ? (
        <EntityRouteState kind="briefing" resolution={{ status: 'resolving' }} />
      ) : sidebarLoaded && !error ? <p className="briefing-empty briefing-empty--selection">No Briefings in this view.</p> : null}
    </CollectionShell>
  );
}

/** Warm the Briefing sidebar and only its explicit, saved, or default selection. */
// Warmed Briefing queries stay for the page, so a later first visit still paints them.
const WARMED_QUERY_GC_TIME_MS = Number.POSITIVE_INFINITY;

export async function warmInitialData(params: Record<string, string>, { instanceInfo }: { instanceInfo?: InstanceInfo | null } = {}): Promise<void> {
  const sidebar = await queryClient.fetchQuery({
    queryKey: browserResourceKeys.briefingSidebar,
    queryFn: ({ signal }) => getBriefingSidebarSnapshot(signal, instanceInfo),
    gcTime: WARMED_QUERY_GC_TIME_MS,
  });
  const viewState = readPersistedViewState(
    BRIEFING_VIEW_STATE_KEY,
    normalizeBriefingCollectionViewState,
    DEFAULT_BRIEFING_COLLECTION_VIEW_STATE,
  );
  const selection = resolveBriefingSelection(sidebar, viewState, params);
  if (!selection.briefing) return;

  const briefingId = selection.briefing.collectionId;
  const displayContext = briefingDisplayContext(briefingId, sidebar.groups, viewState);
  await queryClient.fetchQuery({
    ...briefingTargetQuery(briefingId, selection.roundId, displayContext),
    gcTime: WARMED_QUERY_GC_TIME_MS,
  });
}

export default BriefingView;
