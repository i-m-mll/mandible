import { detailRequestKey } from '../../detail-cache';

export const BRIEFING_PROJECTION_CACHE_NAMESPACE = 'briefing-projection';

export type BriefingProjectionDisplayContext = {
  groupId: string;
  proposalBundleId: string | null;
} | null | undefined;

export function briefingProjectionCacheKey(
  briefingId: string,
  roundId?: string | null,
  submissionId?: string | null,
  displayContext?: BriefingProjectionDisplayContext,
): string {
  return detailRequestKey(BRIEFING_PROJECTION_CACHE_NAMESPACE, {
    briefingId,
    roundId: roundId ?? null,
    submissionId: submissionId ?? null,
    displayContext: displayContext ?? null,
  });
}
