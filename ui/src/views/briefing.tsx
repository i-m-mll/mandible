import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import {
  getBriefingBundles,
  getBriefingGroups,
  getBriefings,
  getCachedBriefingBundles,
  getCachedBriefingGroups,
  getCachedBriefings,
  isApiErrorStatus,
  type BriefingBundle,
  type BriefingGroup,
  type InstanceInfo,
} from '../api';
import { useAppShell } from '../app-shell';
import { briefingGroupRoute, briefingRoute } from '../routing';
import { BriefingDocumentRenderer } from './feedback/BriefingDocumentRenderer';
import { BriefingGroupDetail } from './feedback/BriefingGroupDetail';
import { CollectionShell } from './feedback/CollectionShell';
import { resolveFeedbackCollection, type FeedbackCollection } from './feedback/collection-model';
import { useBriefingCollectionViewState } from './feedback/collection-view-state';
import { OperationalIncidentsRegion } from './operational-incidents';

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
  const [briefings, setBriefings] = useState<FeedbackCollection[]>(() => getCachedBriefings(nowMs) ?? []);
  const [bundles, setBundles] = useState<BriefingBundle[]>(() => getCachedBriefingBundles(nowMs) ?? []);
  const [groups, setGroups] = useState<BriefingGroup[]>(() => getCachedBriefingGroups(nowMs) ?? []);
  const [error, setError] = useState<string | null>(null);
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
      const [next, nextBundles, nextGroups] = await Promise.all([
        getBriefings(signal),
        getBriefingBundles(signal),
        getBriefingGroups(signal),
      ]);
      if (!signal.aborted && request === sequence.current) {
        setBriefings(next);
        setBundles(nextBundles);
        setGroups(nextGroups);
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
  const selectedGroupUpdateId = selectedGroup
    ? selectedGroup.updates.find((update) => update.id === viewState.selectedGroupUpdateIds[selectedGroup.id])?.id
      ?? selectedGroup.updates[0]?.id
      ?? null
    : null;
  const explicitRoundId = selected ? viewState.selectedRoundIds[selected.id] ?? null : null;

  const selectBriefing = (briefing: FeedbackCollection) => {
    setViewState((current) => ({ ...current, selectedCollectionId: briefing.id, selectedGroupId: null }));
    replaceBriefingRoute(briefing.collectionId, viewState.selectedRoundIds[briefing.id] ?? null);
  };

  const selectGroup = (group: BriefingGroup) => {
    setViewState((current) => ({ ...current, selectedGroupId: group.id, selectedCollectionId: null }));
    window.history.replaceState(null, '', briefingGroupRoute(group.id));
  };

  const selectGroupUpdate = (updateId: string) => {
    if (!selectedGroup) return;
    setViewState((current) => ({
      ...current,
      selectedGroupUpdateIds: { ...current.selectedGroupUpdateIds, [selectedGroup.id]: updateId },
    }));
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
    setBriefings((current) => current.map(updateCollection));
    setBundles((current) => current.map((bundle) => ({
      ...bundle,
      members: bundle.members.map((member) => ({ ...member, briefing: updateCollection(member.briefing) })),
      layout: bundle.layout.map((entry) => entry.kind === 'briefing'
        ? { ...entry, briefing: updateCollection(entry.briefing) }
        : { ...entry, briefings: entry.briefings.map(updateCollection) }),
    })));
    setGroups((current) => current.map((group) => ({
      ...group,
      updates: group.updates.map((update) => ({
        ...update,
        members: update.members.map((member) => ({ ...member, briefing: updateCollection(member.briefing) })),
        layout: update.layout.map((entry) => entry.kind === 'briefing'
          ? { ...entry, briefing: updateCollection(entry.briefing) }
          : { ...entry, briefings: entry.briefings.map(updateCollection) }),
      })),
    })));
  };

  return (
    <CollectionShell collections={briefings} bundles={bundles} groups={groups} loadError={error} sidebarHidden={sidebarHidden} viewState={viewState} setViewState={setViewState} onSelect={selectBriefing} onSelectGroup={selectGroup}>
      <OperationalIncidentsRegion instance={instance} active={appShell.active} />
      {error ? <p className="briefing-error" role="alert">{error}</p> : null}
      {selectedGroup ? (
        <BriefingGroupDetail
          group={selectedGroup}
          selectedUpdateId={selectedGroupUpdateId}
          onSelectUpdate={selectGroupUpdate}
        />
      ) : !selected ? <p className="briefing-empty briefing-empty--selection">Select a Briefing or group.</p> : (
        <BriefingDocumentRenderer
          key={`${selected.collectionId}:${explicitRoundId ?? 'latest'}`}
          briefingId={selected.collectionId}
          briefingTitle={selected.label}
          roundId={explicitRoundId}
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
