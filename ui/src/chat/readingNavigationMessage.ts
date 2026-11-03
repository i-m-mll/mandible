import type { ReadingRevealResult } from './readingProjection';

export function readingNavigationFailureMessage(status: Exclude<ReadingRevealResult['status'], 'revealed' | 'cancelled'>): string {
  switch (status) {
    case 'source-unavailable': return 'The entry’s source is unavailable.';
    case 'position-space-changed': return 'The conversation changed before this entry could be shown.';
    case 'not-renderable': return 'This entry cannot be shown.';
    case 'unsuccessful': return 'Could not bring this entry into view.';
  }
}
