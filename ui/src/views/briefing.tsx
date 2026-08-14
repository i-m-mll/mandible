import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';

import {
  projectBoundedAskCollection,
  projectBriefingRecurringCollections,
  getCachedBriefingQueue,
  type AskProjection,
  type BriefingQueue,
  type InstanceInfo,
} from '../api';
import { AppShellProvider, useAppShell } from '../app-shell';
import { CollectionShell } from './feedback/CollectionShell';
import { BoundedAskRenderer } from './feedback/BoundedAskRenderer';
import { feedbackCollectionIdentity } from './feedback/collection-model';
import { useBriefingCollectionViewState } from './feedback/collection-view-state';
import { RecurringReviewRenderer } from './feedback/RecurringReviewRenderer';

export * from './feedback/RecurringReviewRenderer';

export type BriefingViewProps = {
  instance: InstanceInfo | null;
  initialFilter?: string;
  initialCandidateId?: string | null;
  initialAskId?: string | null;
  sidebarHidden?: boolean;
  nowMs?: number;
};

export function BriefingView({
  instance,
  initialFilter,
  initialCandidateId,
  initialAskId,
  sidebarHidden = false,
  nowMs,
}: BriefingViewProps): JSX.Element {
  const appShell = useAppShell();
  const [viewState, setViewState] = useBriefingCollectionViewState();
  const [queue, setQueue] = useState<BriefingQueue | null>(() => getCachedBriefingQueue(nowMs));
  const [loadedAsk, setLoadedAsk] = useState<AskProjection | null>(null);
  const [askId, setAskId] = useState<string | null>(initialAskId ?? null);
  const onQueueChange = useCallback((next: BriefingQueue | null) => setQueue(next), []);
  useEffect(() => {
    if (initialAskId) {
      setAskId(initialAskId);
      setViewState((current) => ({
        ...current,
        selectedCollectionId: feedbackCollectionIdentity('bounded_ask', initialAskId),
      }));
      return;
    }
    setViewState((current) => current.selectedCollectionId?.startsWith('bounded_ask:')
      ? {
          ...current,
          selectedCollectionId: current.source
            ? feedbackCollectionIdentity('recurring_feed', current.source)
            : null,
        }
      : current);
  }, [initialAskId, setViewState]);

  const collections = useMemo(() => [
    ...(queue ? projectBriefingRecurringCollections(queue) : []),
    ...(loadedAsk ? [projectBoundedAskCollection(loadedAsk)] : []),
  ], [loadedAsk, queue]);
  const selectedAsk = Boolean(
    askId && viewState.selectedCollectionId === feedbackCollectionIdentity('bounded_ask', askId),
  );
  const selectedAskId = askId;

  return (
    <CollectionShell
      collections={collections}
      sidebarHidden={sidebarHidden}
      viewState={viewState}
      setViewState={setViewState}
    >
      <div hidden={selectedAsk}>
        <AppShellProvider value={{ ...appShell, active: appShell.active && !selectedAsk }}>
          <RecurringReviewRenderer
            instance={instance}
            viewState={viewState}
            setViewState={setViewState}
            onQueueChange={onQueueChange}
            initialFilter={initialFilter}
            initialCandidateId={initialCandidateId}
            nowMs={nowMs}
          />
        </AppShellProvider>
      </div>
      {selectedAskId ? (
        <div hidden={!selectedAsk}>
          <AppShellProvider value={{ ...appShell, active: appShell.active && selectedAsk }}>
            <BoundedAskRenderer
              askId={selectedAskId}
              instance={instance}
              onAskChange={setLoadedAsk}
            />
          </AppShellProvider>
        </div>
      ) : null}
    </CollectionShell>
  );
}

export default BriefingView;
