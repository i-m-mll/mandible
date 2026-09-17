import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import {
  getBriefingSidebarSnapshot,
  getCachedBriefingSidebarSnapshot,
  isApiErrorStatus,
  type BriefingBundle,
  type BriefingGroup,
  type BriefingSidebarSnapshot,
  type InstanceInfo,
} from '../api';
import { useAppShell } from '../app-shell';
import { briefingGroupRoute, briefingRoute } from '../routing';
import { BriefingDocumentRenderer } from './feedback/BriefingDocumentRenderer';
import { BriefingGroupDetail } from './feedback/BriefingGroupDetail';
import { CollectionShell } from './feedback/CollectionShell';
import { DetailPaneNotice } from '../components/shared/DetailPaneNotice';
import { resolveFeedbackCollection, type FeedbackCollection } from './feedback/collection-model';
import { useBriefingCollectionViewState } from './feedback/collection-view-state';
import {
  briefingGroupOwnsUpdate,
  indexBriefingGroupBundleOwners,
  resolveBriefingGroupProjection,
} from './feedback/briefing-group-projection';
import { OperationalIncidentsRegion } from './operational-incidents';
import { subscribeClientAuthSessionState } from '../client-auth-token';

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

export function BriefingView({ instance, initialBriefingId, initialRoundId, initialGroupId, sidebarHidden = false, nowMs, keepSubmittedAnnotations = false }: BriefingViewProps): JSX.Element {
  const appShell = useAppShell();
  const [viewState, setViewState] = useBriefingCollectionViewState();
  const [sidebar, setSidebar] = useState<BriefingSidebarSnapshot>(() =>
    getCachedBriefingSidebarSnapshot(nowMs) ?? { briefings: [], bundles: [], groups: [] });
  const { briefings, bundles, groups } = sidebar;
  const [error, setError] = useState<string | null>(null);
  const [sidebarLoaded, setSidebarLoaded] = useState(false);
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
    const exact = groups.find((group) => group.id === initialGroupId);
    const prefixMatches = exact ? [] : groups.filter((group) => group.id.startsWith(initialGroupId));
    const group = exact ?? (prefixMatches.length === 1 ? prefixMatches[0] : null);
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
        setError(null);
      }
    } catch (cause) {
      if (!signal.aborted && request === sequence.current) {
        setError(isApiErrorStatus(cause, 401) || isApiErrorStatus(cause, 403)
          ? 'Authentication is required to load Briefings.'
          : cause instanceof Error ? cause.message : String(cause));
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
    const unsubscribe = subscribeClientAuthSessionState((state) => {
      if (state === 'enrolled') setReloadNonce((value) => value + 1);
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
    const fallbackGroup = groups.find((group) => viewState.collectionLifecycle === 'all'
      || (viewState.collectionLifecycle === 'archived' ? group.archivedAt != null : group.archivedAt == null));
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
  const groupBundleOwners = useMemo(() => indexBriefingGroupBundleOwners(groups), [groups]);
  const selectedGroupUpdateId = selectedGroup
    ? resolveBriefingGroupProjection(
      selectedGroup,
      viewState.selectedGroupUpdateIds[selectedGroup.id],
      groupBundleOwners,
    ).selectedUpdate?.id ?? null
    : null;
  const explicitRoundId = selected ? viewState.selectedRoundIds[selected.id] ?? null : null;
  const selectedDisplayContext = useMemo(() => {
    if (!selected) return undefined;
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
  }, [groupBundleOwners, groups, selected, viewState.selectedGroupUpdateIds]);

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
    <CollectionShell collections={briefings} bundles={bundles} groups={groups} loadError={error} sidebarHidden={sidebarHidden} viewState={viewState} setViewState={setViewState} onSelect={selectBriefing} onSelectGroup={selectGroup} notice={error ? (
      <DetailPaneNotice severity="error" density="compact" title="Briefings could not be refreshed">{error}</DetailPaneNotice>
    ) : null}>
      <OperationalIncidentsRegion instance={instance} active={appShell.active} />
      {selectedGroup ? (
        <BriefingGroupDetail
          key={selectedGroup.id}
          group={selectedGroup}
          selectedUpdateId={selectedGroupUpdateId}
          onSelectUpdate={(updateId) => selectGroupUpdate(selectedGroup.id, updateId)}
          onDisposition={updateDispositionedGroup}
        />
      ) : !selected ? <p className="briefing-empty briefing-empty--selection">No Briefings in this view.</p> : (
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

export default BriefingView;
