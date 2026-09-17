import { normalizeOrderedPinIds } from '../../components/shared/orderedPins';
import { usePersistedViewState } from '../../hooks/usePersistedViewState';

export const BRIEFING_VIEW_STATE_KEY = 'mandible.briefing.viewState:v1';
export type BriefingCollectionSort = 'activity' | 'name' | 'unanswered-count';
export type BriefingCollectionLifecycle = 'active' | 'all' | 'archived';
export type BriefingCollectionViewState = {
  collectionSourceFilter: string;
  pinnedOnly: boolean;
  collectionSort: BriefingCollectionSort;
  collectionLifecycle: BriefingCollectionLifecycle;
  pinnedCollectionIds: string[];
  pinnedSectionCollapsed: boolean;
  collapsedBundleIds: string[];
  collapsedGroupIds: string[];
  collapsedGroupSubgroupKeys: string[];
  selectedGroupUpdateIds: Record<string, string>;
  selectedGroupId: string | null;
  selectedSurface: 'briefing' | 'incidents';
  selectedCollectionId: string | null;
  selectedRoundIds: Record<string, string>;
};
export const DEFAULT_BRIEFING_COLLECTION_VIEW_STATE: BriefingCollectionViewState = {
  collectionSourceFilter: '', pinnedOnly: false, collectionSort: 'activity', collectionLifecycle: 'active', pinnedCollectionIds: [], pinnedSectionCollapsed: false,
  collapsedBundleIds: [],
  collapsedGroupIds: [], collapsedGroupSubgroupKeys: [], selectedGroupUpdateIds: {}, selectedGroupId: null,
  selectedSurface: 'briefing', selectedCollectionId: null, selectedRoundIds: {},
};
export function normalizeBriefingCollectionViewState(value: unknown): BriefingCollectionViewState {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const rawPins = Array.isArray(row.pinnedCollectionIds) ? row.pinnedCollectionIds : [];
  const rawRounds = row.selectedRoundIds && typeof row.selectedRoundIds === 'object' && !Array.isArray(row.selectedRoundIds) ? row.selectedRoundIds as Record<string, unknown> : {};
  const rawGroupUpdates = row.selectedGroupUpdateIds && typeof row.selectedGroupUpdateIds === 'object' && !Array.isArray(row.selectedGroupUpdateIds) ? row.selectedGroupUpdateIds as Record<string, unknown> : {};
  const selectedGroupId = typeof row.selectedGroupId === 'string' && row.selectedGroupId.trim() ? row.selectedGroupId : null;
  return {
    collectionSourceFilter: typeof row.collectionSourceFilter === 'string' ? row.collectionSourceFilter : '',
    pinnedOnly: row.pinnedOnly === true,
    collectionSort: row.collectionSort === 'name' || row.collectionSort === 'unanswered-count'
      ? row.collectionSort
      : 'activity',
    collectionLifecycle: row.collectionLifecycle === 'all' || row.collectionLifecycle === 'archived'
      ? row.collectionLifecycle
      : 'active',
    pinnedCollectionIds: normalizeOrderedPinIds(rawPins),
    pinnedSectionCollapsed: row.pinnedSectionCollapsed === true,
    collapsedBundleIds: normalizeOrderedPinIds(Array.isArray(row.collapsedBundleIds) ? row.collapsedBundleIds : []),
    collapsedGroupIds: normalizeOrderedPinIds(Array.isArray(row.collapsedGroupIds) ? row.collapsedGroupIds : []),
    collapsedGroupSubgroupKeys: normalizeOrderedPinIds(Array.isArray(row.collapsedGroupSubgroupKeys) ? row.collapsedGroupSubgroupKeys : []),
    selectedGroupUpdateIds: Object.fromEntries(Object.entries(rawGroupUpdates).filter((entry): entry is [string, string] => Boolean(entry[0]) && typeof entry[1] === 'string' && Boolean(entry[1].trim())).slice(0, 1000)),
    selectedGroupId,
    selectedSurface: row.selectedSurface === 'incidents' ? 'incidents' : 'briefing',
    selectedCollectionId: !selectedGroupId && typeof row.selectedCollectionId === 'string' && row.selectedCollectionId.trim() ? row.selectedCollectionId : null,
    selectedRoundIds: Object.fromEntries(Object.entries(rawRounds).filter((entry): entry is [string, string] => Boolean(entry[0]) && typeof entry[1] === 'string' && Boolean(entry[1].trim())).slice(0, 1000)),
  };
}
export function useBriefingCollectionViewState() {
  return usePersistedViewState(BRIEFING_VIEW_STATE_KEY, normalizeBriefingCollectionViewState, DEFAULT_BRIEFING_COLLECTION_VIEW_STATE);
}
