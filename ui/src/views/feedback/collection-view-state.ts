import { normalizeOrderedPinIds } from '../../components/shared/orderedPins';
import { usePersistedViewState } from '../../hooks/usePersistedViewState';
import type { BriefingGroup } from '../../api';

// Bundle validation requires unique, trimmed subgroup names. A new bundle or
// position therefore does not create a new disclosure identity; a rename does.
export function briefingSubgroupKey(groupId: string, name: string): string {
  return JSON.stringify([groupId, name]);
}

export function migrateBriefingSubgroupKeys(keys: string[], groups: readonly BriefingGroup[]): string[] {
  const isNamedKey = (key: string) => {
    try {
      const value: unknown = JSON.parse(key);
      return Array.isArray(value) && value.length === 2
        && value.every((part) => typeof part === 'string' && part.length > 0);
    } catch { return false; }
  };
  if (keys.every(isNamedKey)) return keys;
  const candidates = new Map<string, Set<string | null>>();
  for (const group of groups) {
    const bundles = [group.current, ...group.updates, ...(group.history ?? []).flatMap(
      (entry) => [entry.priorBase, entry.proposal, entry.resultingBase],
    )];
    for (const bundle of bundles) {
      if (!bundle) continue;
      bundle.layout.forEach((entry, index) => {
        const legacyKey = `${group.id}:${bundle.id}:${index}`;
        const names = candidates.get(legacyKey) ?? new Set<string | null>();
        names.add(entry.kind === 'subgroup' ? briefingSubgroupKey(group.id, entry.name) : null);
        candidates.set(legacyKey, names);
      });
    }
  }
  // Consume positional state once a complete collection snapshot is available.
  // Missing or conflicting historical layouts cannot identify the user's choice.
  // Do not let such keys later attach to an unrelated subgroup at that position.
  return [...new Set(keys.flatMap((key) => {
    if (isNamedKey(key)) return [key];
    const names = candidates.get(key);
    const name = names?.size === 1 ? [...names][0] : null;
    return name ? [name] : [];
  }))];
}

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
  selectedCollectionId: string | null;
  selectedRoundIds: Record<string, string>;
};
export const DEFAULT_BRIEFING_COLLECTION_VIEW_STATE: BriefingCollectionViewState = {
  collectionSourceFilter: '', pinnedOnly: false, collectionSort: 'activity', collectionLifecycle: 'active', pinnedCollectionIds: [], pinnedSectionCollapsed: false,
  collapsedBundleIds: [],
  collapsedGroupIds: [], collapsedGroupSubgroupKeys: [], selectedGroupUpdateIds: {}, selectedGroupId: null,
  selectedCollectionId: null, selectedRoundIds: {},
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
    selectedCollectionId: !selectedGroupId && typeof row.selectedCollectionId === 'string' && row.selectedCollectionId.trim() ? row.selectedCollectionId : null,
    selectedRoundIds: Object.fromEntries(Object.entries(rawRounds).filter((entry): entry is [string, string] => Boolean(entry[0]) && typeof entry[1] === 'string' && Boolean(entry[1].trim())).slice(0, 1000)),
  };
}
export function useBriefingCollectionViewState() {
  return usePersistedViewState(BRIEFING_VIEW_STATE_KEY, normalizeBriefingCollectionViewState, DEFAULT_BRIEFING_COLLECTION_VIEW_STATE);
}
