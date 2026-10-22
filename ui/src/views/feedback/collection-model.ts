import type { BriefingCollectionSort } from './collection-view-state';

export type FeedbackCollection = {
  id: string;
  collectionId: string;
  label: string;
  description: string | null;
  publicationMode: 'reviewed-document' | 'published-report' | null;
  unansweredDirectiveCount: number;
  latestRoundId: string;
  createdAt: number;
  updatedAt: number;
};

export function feedbackCollectionIdentity(briefingId: string): string {
  return `briefing:${encodeURIComponent(briefingId)}`;
}

export function filterFeedbackCollections(briefings: readonly FeedbackCollection[], search: string): FeedbackCollection[] {
  const needle = search.trim().toLocaleLowerCase();
  return needle ? briefings.filter((briefing) => briefing.label.toLocaleLowerCase().includes(needle)) : [...briefings];
}

export function orderFeedbackCollections(
  briefings: readonly FeedbackCollection[],
  sort: BriefingCollectionSort = 'activity',
): FeedbackCollection[] {
  const compare = sort === 'name'
    ? (left: FeedbackCollection, right: FeedbackCollection) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id)
    : sort === 'unanswered-count'
      ? (left: FeedbackCollection, right: FeedbackCollection) => (right.unansweredDirectiveCount - left.unansweredDirectiveCount) || left.label.localeCompare(right.label) || left.id.localeCompare(right.id)
      : (left: FeedbackCollection, right: FeedbackCollection) => (right.updatedAt - left.updatedAt) || left.id.localeCompare(right.id);
  return [...briefings].sort(compare);
}
