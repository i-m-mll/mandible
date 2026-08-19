import { orderByPinnedIds } from '../../components/shared/orderedPins';
import type { BriefingCollectionSort } from './collection-view-state';

export type FeedbackCollection = {
  id: string;
  collectionId: string;
  label: string;
  itemCount: number;
  latestRoundId: string;
  createdAt: number;
  updatedAt: number;
};

export function feedbackCollectionIdentity(briefingId: string): string {
  return `briefing:${encodeURIComponent(briefingId)}`;
}

export function resolveFeedbackCollection(
  briefings: readonly FeedbackCollection[],
  briefingRef: string,
): FeedbackCollection | null {
  const exact = briefings.find((briefing) => briefing.collectionId === briefingRef);
  if (exact) return exact;
  const matches = briefings.filter((briefing) => briefing.collectionId.startsWith(briefingRef));
  return matches.length === 1 ? matches[0] : null;
}

export function filterFeedbackCollections(briefings: readonly FeedbackCollection[], search: string): FeedbackCollection[] {
  const needle = search.trim().toLocaleLowerCase();
  return needle ? briefings.filter((briefing) => briefing.label.toLocaleLowerCase().includes(needle)) : [...briefings];
}

export function orderFeedbackCollections(
  briefings: readonly FeedbackCollection[],
  pinnedIds: readonly string[],
  sort: BriefingCollectionSort = 'activity',
): FeedbackCollection[] {
  const compare = sort === 'name'
    ? (left: FeedbackCollection, right: FeedbackCollection) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id)
    : sort === 'round-count'
      ? (left: FeedbackCollection, right: FeedbackCollection) => (right.itemCount - left.itemCount) || left.label.localeCompare(right.label) || left.id.localeCompare(right.id)
      : (left: FeedbackCollection, right: FeedbackCollection) => (right.updatedAt - left.updatedAt) || left.id.localeCompare(right.id);
  return orderByPinnedIds(
    briefings,
    pinnedIds,
    (briefing) => briefing.id,
    compare,
  );
}

export function moveVisiblePinnedCollection(pinnedIds: readonly string[], visiblePinnedIds: readonly string[], briefingId: string, targetIndex: number): string[] {
  const visible = new Set(visiblePinnedIds);
  const slots = pinnedIds.map((id, index) => visible.has(id) ? index : -1).filter((index) => index >= 0);
  const ordered = slots.map((index) => pinnedIds[index]);
  const current = ordered.indexOf(briefingId);
  if (current < 0) return [...pinnedIds];
  const [moved] = ordered.splice(current, 1);
  ordered.splice(Math.max(0, Math.min(targetIndex, ordered.length)), 0, moved);
  const next = [...pinnedIds];
  slots.forEach((slot, index) => { next[slot] = ordered[index]; });
  return next;
}
