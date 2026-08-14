import { useCallback, useMemo, useState } from 'preact/hooks';

import {
  projectBriefingRecurringCollections,
  type BriefingQueue,
  type InstanceInfo,
} from '../api';
import { CollectionShell } from './feedback/CollectionShell';
import { useBriefingCollectionViewState } from './feedback/collection-view-state';
import { RecurringReviewRenderer } from './feedback/RecurringReviewRenderer';

export * from './feedback/RecurringReviewRenderer';

export type BriefingViewProps = {
  instance: InstanceInfo | null;
  initialFilter?: string;
  initialCandidateId?: string | null;
  sidebarHidden?: boolean;
  nowMs?: number;
};

export function BriefingView({
  instance,
  initialFilter,
  initialCandidateId,
  sidebarHidden = false,
  nowMs,
}: BriefingViewProps): JSX.Element {
  const [viewState, setViewState] = useBriefingCollectionViewState();
  const [queue, setQueue] = useState<BriefingQueue | null>(null);
  const onQueueChange = useCallback((next: BriefingQueue | null) => setQueue(next), []);
  const collections = useMemo(
    () => queue ? projectBriefingRecurringCollections(queue) : [],
    [queue],
  );

  return (
    <CollectionShell
      collections={collections}
      sidebarHidden={sidebarHidden}
      viewState={viewState}
      setViewState={setViewState}
    >
      <RecurringReviewRenderer
        instance={instance}
        viewState={viewState}
        setViewState={setViewState}
        onQueueChange={onQueueChange}
        initialFilter={initialFilter}
        initialCandidateId={initialCandidateId}
        nowMs={nowMs}
      />
    </CollectionShell>
  );
}

export default BriefingView;
