import type { QueryClient, QueryKey } from '@tanstack/preact-query';
import { isBriefingEvent } from '../../../src/contracts';
import { isSpaceEvent, SPACE_EVENTS } from '../../../src/spaces/events';

export const browserResourceKeys = {
  briefings: ['briefing'] as const,
  briefingSidebar: ['briefing', 'sidebar'] as const,
  briefingProjections: (briefingId: string) => ['briefing', 'projection', briefingId] as const,
  briefingProjection: (briefingId: string, roundId: string | null, submissionId: string | null, displayContext?: { groupId: string; proposalBundleId: string | null }) =>
    ['briefing', 'projection', briefingId, roundId, submissionId, displayContext ?? null] as const,
  spaceItems: (spaceId: string | null | undefined) => ['space', spaceId ?? null, 'items'] as const,
  spaceDocument: (spaceId: string | null | undefined) => ['space', spaceId ?? null, 'document'] as const,
};

export function browserResourceKeysForEvent(type: string, data?: unknown): readonly QueryKey[] {
  if (isBriefingEvent(type)) return [browserResourceKeys.briefings];
  if (!isSpaceEvent(type) || !data || typeof data !== 'object') return [];
  if (type === SPACE_EVENTS.SPACE_DOCUMENT_SETTINGS_UPDATED) return [['space']];
  const id = (data as { space_id?: unknown }).space_id;
  return typeof id === 'string' ? [browserResourceKeys.spaceDocument(id), browserResourceKeys.spaceItems(id)] : [];
}

export async function refreshBrowserResources(client: QueryClient, keys: readonly QueryKey[]): Promise<void> {
  await Promise.all(keys.map((queryKey) => client.cancelQueries({ queryKey })));
  await Promise.all(keys.map((queryKey) => client.invalidateQueries({ queryKey })));
}
