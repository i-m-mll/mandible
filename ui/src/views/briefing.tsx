import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import {
  getBriefing,
  getBriefingSidebarSnapshot,
  getCachedBriefingSidebarSnapshot,
  ApiError,
  type BriefingBundle,
  type BriefingGroup,
  type BriefingSidebarSnapshot,
  type InstanceInfo,
} from '../api';
import { writePersistedDetail } from '../detail-cache';
import { useAppShell } from '../app-shell';
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
import { subscribeClientAccessState } from '../client-auth-token';
import {
  briefingProjectionCacheKey,
  BRIEFING_PROJECTION_CACHE_NAMESPACE,
} from './feedback/briefing-projection-cache';

export type BriefingViewProps = {
  instance: InstanceInfo | null;
  initialBriefingId?: string | null;
  initialRoundId?: string | null;
  initialGroupId?: string | null;
  sidebarHidden?: boolean;
  nowMs?: number;
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

export function BriefingView({ instance, initialBriefingId, initialRoundId, initialGroupId, sidebarHidden = false, nowMs, keepSubmittedAnnotations = false }: BriefingViewProps): JSX.Element {
  const appShell = useAppShell();
  const [viewState, setViewState] = useBriefingCollectionViewState();
  const [sidebar, setSidebar] = useState<BriefingSidebarSnapshot>(() =>
    getCachedBriefingSidebarSnapshot(nowMs) ?? { briefings: [], bundles: [], groups: [] });
  const { briefings, bundles, groups } = sidebar;
  const [error, setError] = useState<string | null>(null);
  const [accessUnavailable, setAccessUnavailable] = useState(false);
  const [sidebarLoaded, setSidebarLoaded] = useState(() => getCachedBriefingSidebarSnapshot(nowMs) !== null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const sequence = useRef(0);

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

  const load = useCallback(async (signal: AbortSignal) => {
    const request = ++sequence.current;
    try {
      const next = await getBriefingSidebarSnapshot(signal);
      if (!signal.aborted && request === sequence.current) {
        setSidebar(next);
        setSidebarLoaded(true);
        setAccessUnavailable(false);
        setError(null);
      }
    } catch (cause) {
      if (!signal.aborted && request === sequence.current) {
        if (cause instanceof ApiError && cause.code === 'local_access_unavailable') {
          setAccessUnavailable(true);
          setError(null);
          return;
        }
        setAccessUnavailable(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }
  }, []);

  useEffect(() => {
    if (!appShell.active) return undefined;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [appShell.active, load, reloadNonce]);

  useEffect(() => {
    if (!appShell.active) return undefined;
    const reloadWhenVisible = () => {
      if (document.visibilityState === 'visible') setReloadNonce((value) => value + 1);
    };
    const unsubscribe = subscribeClientAccessState((state) => {
      if (state.phase === 'ready') setReloadNonce((value) => value + 1);
    });
    window.addEventListener('focus', reloadWhenVisible);
    document.addEventListener('visibilitychange', reloadWhenVisible);
    return () => {
      unsubscribe();
      window.removeEventListener('focus', reloadWhenVisible);
      document.removeEventListener('visibilitychange', reloadWhenVisible);
    };
  }, [appShell.active]);

  useEffect(() => {
    if (!appShell.active) return undefined;
    let timer: number | null = null;
    const reconcile = (event: Event) => {
      const type = (event as CustomEvent<{ type?: string }>).detail?.type;
      if (type !== 'reconnected' && !type?.startsWith('briefing:')) return;
      if (timer !== null) return;
      timer = window.setTimeout(() => { timer = null; setReloadNonce((value) => value + 1); }, 100);
    };
    window.addEventListener('briefing:sse', reconcile);
    return () => {
      window.removeEventListener('briefing:sse', reconcile);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [appShell.active]);

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
    <CollectionShell collections={briefings} bundles={bundles} groups={groups} loadError={error ?? (accessUnavailable ? 'Local access is resuming.' : null)} confirmedLoaded={sidebarLoaded} sidebarHidden={sidebarHidden} viewState={viewState} setViewState={setViewState} onSelect={selectBriefing} onSelectGroup={selectGroup} notice={error ? (
      <DetailPaneNotice source="briefing:refresh" severity="error" density="compact" title="Briefings could not be refreshed">{error}</DetailPaneNotice>
    ) : null}>
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
  const sidebar = await getBriefingSidebarSnapshot();
  const viewState = readPersistedViewState(
    BRIEFING_VIEW_STATE_KEY,
    normalizeBriefingCollectionViewState,
    DEFAULT_BRIEFING_COLLECTION_VIEW_STATE,
  );
  const selection = resolveBriefingSelection(sidebar, viewState, params);
  if (!selection.briefing) return;

  const briefingId = selection.briefing.collectionId;
  const displayContext = briefingDisplayContext(selection.briefing, sidebar.groups, viewState);
  const projection = await getBriefing(briefingId, selection.roundId, null, undefined, displayContext);
  writePersistedDetail(
    BRIEFING_PROJECTION_CACHE_NAMESPACE,
    briefingProjectionCacheKey(briefingId, selection.roundId, null, displayContext),
    projection,
  );
}

export default BriefingView;
