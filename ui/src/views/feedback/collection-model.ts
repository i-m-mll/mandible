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

export function orderFeedbackCollections(briefings: readonly FeedbackCollection[], pinnedIds: readonly string[]): FeedbackCollection[] {
  const pinnedOrder = new Map<string, number>();
  for (const id of pinnedIds) if (!pinnedOrder.has(id)) pinnedOrder.set(id, pinnedOrder.size);
  return [...briefings].sort((left, right) => {
    const leftPin = pinnedOrder.get(left.id);
    const rightPin = pinnedOrder.get(right.id);
    if (leftPin !== undefined && rightPin !== undefined) return leftPin - rightPin;
    if (leftPin !== undefined) return -1;
    if (rightPin !== undefined) return 1;
    return (right.updatedAt - left.updatedAt) || left.id.localeCompare(right.id);
  });
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
