import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import {
  getCachedFeedbackCollections,
  getFeedbackCollections,
  type InstanceInfo,
} from '../api';
import { AppShellProvider, useAppShell } from '../app-shell';
import { CollectionShell } from './feedback/CollectionShell';
import { BoundedAskRenderer } from './feedback/BoundedAskRenderer';
import {
  feedbackCollectionIdentity,
  legacyFeedbackCollectionIdentity,
} from './feedback/collection-model';
import type { FeedbackCollection } from './feedback/collection-model';
import { useBriefingCollectionViewState } from './feedback/collection-view-state';
import { OperationalIncidentsRegion } from './operational-incidents';
import { RecurringReviewRenderer } from './feedback/RecurringReviewRenderer';

export * from './feedback/RecurringReviewRenderer';

export type BriefingViewProps = {
  instance: InstanceInfo | null;
  initialFilter?: string;
  initialCandidateId?: string | null;
  initialAskId?: string | null;
  initialCollectionId?: string | null;
  sidebarHidden?: boolean;
  nowMs?: number;
};

export function BriefingView({
  instance,
  initialFilter,
  initialCandidateId,
  initialAskId,
  initialCollectionId,
  sidebarHidden = false,
  nowMs,
}: BriefingViewProps): JSX.Element {
  const appShell = useAppShell();
  const [viewState, setViewState] = useBriefingCollectionViewState();
  const [collections, setCollections] = useState<FeedbackCollection[]>(
    () => getCachedFeedbackCollections(nowMs) ?? [],
  );
  const [reloadNonce, setReloadNonce] = useState(0);
  const loadSequence = useRef(0);
  useEffect(() => {
    const routedCollectionId = initialCollectionId ?? initialAskId;
    if (routedCollectionId) {
      setViewState((current) => ({
        ...current,
        selectedCollectionId: feedbackCollectionIdentity(routedCollectionId),
      }));
    }
  }, [initialAskId, initialCollectionId, setViewState]);
  useEffect(() => {
    if (initialCandidateId && !initialAskId && !initialCollectionId) {
      setViewState((current) => current.selectedCollectionId === null ? current : { ...current, selectedCollectionId: null, source: null });
    }
  }, [initialAskId, initialCandidateId, initialCollectionId, setViewState]);

  const loadCollections = useCallback(async (signal: AbortSignal) => {
    const sequence = ++loadSequence.current;
    try {
      const next = await getFeedbackCollections(signal);
      if (!signal.aborted && sequence === loadSequence.current) setCollections(next);
    } catch {
      // Keep the last reconciled list. A transient poll failure must not flicker
      // the sidebar or disturb browser-owned filter, pin, selection, or scroll.
    }
  }, []);

  useEffect(() => {
    if (!appShell.active) return undefined;
    const controller = new AbortController();
    void loadCollections(controller.signal);
    return () => controller.abort();
  }, [appShell.active, loadCollections, reloadNonce]);

  useEffect(() => {
    if (!appShell.active) return undefined;
    const interval = window.setInterval(() => setReloadNonce((value) => value + 1), 60_000);
    return () => window.clearInterval(interval);
  }, [appShell.active]);

  useEffect(() => {
    if (collections.length === 0) return;
    const legacyIds = new Map(
      collections.map((collection) => [legacyFeedbackCollectionIdentity(collection), collection.id]),
    );
    setViewState((current) => {
      const selectedCollectionId = current.selectedCollectionId
        ? legacyIds.get(current.selectedCollectionId) ?? current.selectedCollectionId
        : null;
      const pinnedCollectionIds = current.pinnedCollectionIds.map(
        (id) => legacyIds.get(id) ?? id,
      );
      const changed = selectedCollectionId !== current.selectedCollectionId
        || pinnedCollectionIds.some((id, index) => id !== current.pinnedCollectionIds[index]);
      return changed ? { ...current, selectedCollectionId, pinnedCollectionIds } : current;
    });
  }, [collections, setViewState]);

  useEffect(() => {
    if (!appShell.active) return undefined;
    let timer: number | null = null;
    const reconcile = (event: Event) => {
      const type = (event as CustomEvent<{ type?: string }>).detail?.type;
      if (type !== 'reconnected'
          && type !== 'feedback:collection-updated'
          && !type?.startsWith('ask:')
          && !type?.startsWith('briefing:')) return;
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        setReloadNonce((value) => value + 1);
      }, 100);
    };
    window.addEventListener('feedback:sse', reconcile);
    return () => {
      window.removeEventListener('feedback:sse', reconcile);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [appShell.active]);

  const selectedCollection = useMemo(() => (
    collections.find((collection) => collection.id === viewState.selectedCollectionId)
      ?? null
  ), [collections, viewState.selectedCollectionId]);
  const routedAskId = initialAskId && viewState.selectedCollectionId === feedbackCollectionIdentity(initialAskId)
    ? initialAskId
    : null;
  const selectedAskId = selectedCollection?.interactionMode === 'explicit_submit'
    ? selectedCollection.collectionId
    : selectedCollection === null ? routedAskId : null;
  const selectedAsk = selectedAskId !== null;
  const selectedCollectionUnavailable = viewState.selectedCollectionId !== null && selectedCollection === null && !routedAskId;

  return (
    <CollectionShell
      collections={collections}
      sidebarHidden={sidebarHidden}
      viewState={viewState}
      setViewState={setViewState}
    >
      {/* Issue 5308097 spec §8: operational incidents come FIRST, before the
          recurring findings and bounded asks. An unattended executor failure
          outranks review work, and it stays visible whichever collection is
          selected — including while a bounded ask is open — because it is not
          part of the feedback collection model at all. */}
      <OperationalIncidentsRegion instance={instance} active={appShell.active} />
      <div hidden={selectedAsk || selectedCollectionUnavailable}>
        <AppShellProvider value={{ ...appShell, active: appShell.active && !selectedAsk && !selectedCollectionUnavailable }}>
          <RecurringReviewRenderer
            instance={instance}
            viewState={viewState}
            setViewState={setViewState}
            initialFilter={initialFilter}
            initialCandidateId={initialCandidateId}
            nowMs={nowMs}
            selectedCollectionSource={selectedCollection?.source ?? null}
          />
        </AppShellProvider>
      </div>
      {selectedCollectionUnavailable ? <div className="briefing-error" role="alert">The selected feedback collection is unavailable.</div> : null}
      {selectedAskId ? (
        <div hidden={!selectedAsk}>
          <AppShellProvider value={{ ...appShell, active: appShell.active && selectedAsk }}>
            <BoundedAskRenderer
              askId={selectedAskId}
              instance={instance}
            />
          </AppShellProvider>
        </div>
      ) : null}
    </CollectionShell>
  );
}

export default BriefingView;
