import { usePersistedViewState } from '../../hooks/usePersistedViewState';

import type {
  FeedbackCollectionKind,
  FeedbackCollectionState,
} from './collection-model';

export const BRIEFING_VIEW_STATE_KEY = 'mandible.briefing.viewState:v1';

export type BriefingCollectionViewState = {
  filter: 'pending' | 'judged';
  source: string | null;
  healthOpen: boolean | null;
  expandedCandidateId: string | null;
  collectionKindFilter: 'all' | FeedbackCollectionKind;
  collectionSourceFilter: string;
  collectionStateFilter: 'all' | FeedbackCollectionState;
  pinnedCollectionIds: string[];
  selectedCollectionId: string | null;
};

export const DEFAULT_BRIEFING_COLLECTION_VIEW_STATE: BriefingCollectionViewState = {
  filter: 'pending',
  source: null,
  healthOpen: null,
  expandedCandidateId: null,
  collectionKindFilter: 'all',
  collectionSourceFilter: '',
  collectionStateFilter: 'all',
  pinnedCollectionIds: [],
  selectedCollectionId: null,
};

const KINDS = new Set<FeedbackCollectionKind>(['recurring_feed', 'bounded_ask']);
const STATES = new Set<FeedbackCollectionState>([
  'open',
  'submitted',
  'expired',
  'cancelled',
  'closed',
]);

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function normalizeBriefingCollectionViewState(
  value: unknown,
  defaults: Readonly<BriefingCollectionViewState> = DEFAULT_BRIEFING_COLLECTION_VIEW_STATE,
): BriefingCollectionViewState {
  const row = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const kind = row.collectionKindFilter;
  const state = row.collectionStateFilter;
  const rawPins = Array.isArray(row.pinnedCollectionIds) ? row.pinnedCollectionIds : [];
  const pinnedCollectionIds = [...new Set(
    rawPins.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== ''),
  )].slice(0, 1000);

  return {
    filter: row.filter === 'judged' ? 'judged' : defaults.filter,
    source: optionalString(row.source) ?? defaults.source,
    healthOpen: typeof row.healthOpen === 'boolean' ? row.healthOpen : null,
    expandedCandidateId: optionalString(row.expandedCandidateId),
    collectionKindFilter:
      kind === 'all' || KINDS.has(kind as FeedbackCollectionKind)
        ? kind as 'all' | FeedbackCollectionKind
        : defaults.collectionKindFilter,
    collectionSourceFilter:
      typeof row.collectionSourceFilter === 'string' ? row.collectionSourceFilter : defaults.collectionSourceFilter,
    collectionStateFilter:
      state === 'all' || STATES.has(state as FeedbackCollectionState)
        ? state as 'all' | FeedbackCollectionState
        : defaults.collectionStateFilter,
    pinnedCollectionIds,
    selectedCollectionId: optionalString(row.selectedCollectionId),
  };
}

export function useBriefingCollectionViewState() {
  return usePersistedViewState(
    BRIEFING_VIEW_STATE_KEY,
    normalizeBriefingCollectionViewState,
    DEFAULT_BRIEFING_COLLECTION_VIEW_STATE,
  );
}

