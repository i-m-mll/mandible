import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import {
  getBriefingBundles,
  getBriefings,
  getCachedBriefingBundles,
  getCachedBriefings,
  isApiErrorStatus,
  type BriefingBundle,
  type InstanceInfo,
} from '../api';
import { useAppShell } from '../app-shell';
import { briefingRoute } from '../routing';
import { BriefingDocumentRenderer } from './feedback/BriefingDocumentRenderer';
import { CollectionShell } from './feedback/CollectionShell';
import { resolveFeedbackCollection, type FeedbackCollection } from './feedback/collection-model';
import { useBriefingCollectionViewState } from './feedback/collection-view-state';
import { OperationalIncidentsRegion } from './operational-incidents';

export type BriefingViewProps = {
  instance: InstanceInfo | null;
  initialBriefingId?: string | null;
  initialRoundId?: string | null;
  sidebarHidden?: boolean;
  nowMs?: number;
};

function replaceBriefingRoute(briefingId: string, roundId?: string | null): void {
  window.history.replaceState(null, '', briefingRoute(briefingId, roundId));
}

export function BriefingView({ instance, initialBriefingId, initialRoundId, sidebarHidden = false, nowMs }: BriefingViewProps): JSX.Element {
  const appShell = useAppShell();
  const [viewState, setViewState] = useBriefingCollectionViewState();
  const [briefings, setBriefings] = useState<FeedbackCollection[]>(() => getCachedBriefings(nowMs) ?? []);
  const [bundles, setBundles] = useState<BriefingBundle[]>(() => getCachedBriefingBundles(nowMs) ?? []);
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
      selectedRoundIds: initialRoundId
        ? { ...current.selectedRoundIds, [id]: initialRoundId }
        : current.selectedRoundIds,
    }));
  }, [briefings, initialBriefingId, initialRoundId, setViewState]);

  const load = useCallback(async (signal: AbortSignal) => {
    const request = ++sequence.current;
    try {
      const [next, nextBundles] = await Promise.all([getBriefings(signal), getBriefingBundles(signal)]);
      if (!signal.aborted && request === sequence.current) {
        setBriefings(next);
        setBundles(nextBundles);
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
  const explicitRoundId = selected ? viewState.selectedRoundIds[selected.id] ?? null : null;

  const selectBriefing = (briefing: FeedbackCollection) => {
    setViewState((current) => ({ ...current, selectedCollectionId: briefing.id }));
    replaceBriefingRoute(briefing.collectionId, viewState.selectedRoundIds[briefing.id] ?? null);
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

  return (
    <CollectionShell collections={briefings} bundles={bundles} loadError={error} sidebarHidden={sidebarHidden} viewState={viewState} setViewState={setViewState} onSelect={selectBriefing}>
      <OperationalIncidentsRegion instance={instance} active={appShell.active} />
      {error ? <p className="briefing-error" role="alert">{error}</p> : null}
      {!selected ? <p className="briefing-empty briefing-empty--selection">Select a Briefing.</p> : (
        <BriefingDocumentRenderer
          key={`${selected.collectionId}:${explicitRoundId ?? 'latest'}`}
          briefingId={selected.collectionId}
          briefingTitle={selected.label}
          roundId={explicitRoundId}
          instance={instance}
          onRoundChange={selectRound}
        />
      )}
    </CollectionShell>
  );
}

export default BriefingView;
