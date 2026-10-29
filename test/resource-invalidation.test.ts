// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import './helpers/ui-workspace-fixture';
import { queryClient } from '../ui/src/query/client';
import { projectionKeys } from '../ui/src/query/projectionKeys';
import { browserResourceKeys } from '../ui/src/query/browserResources';
import { invalidateDashboardApiCacheForEvent, invalidateDashboardCaches } from '../ui/src/api';
import { SPACE_EVENTS } from '../src/spaces/events';

describe('production resource event routing', () => {
  it('scopes space packets and document resources by authoritative space identity', async () => {
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    const packetA = projectionKeys.spacePacket(a.slice(0, 8));
    const packetB = projectionKeys.spacePacket(b);
    const keysA = [packetA, browserResourceKeys.spaceDocument(a)];
    const keysB = [packetB, browserResourceKeys.spaceDocument(b)];
    queryClient.setQueryData(packetA, { space: { id: a } });
    for (const key of [...keysA.slice(1), ...keysB]) queryClient.setQueryData(key, { space: { id: b } });
    invalidateDashboardApiCacheForEvent(SPACE_EVENTS.SPACE_BLOCK_CHANGED, { space_id: a });
    await Promise.resolve();
    for (const key of keysA) expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    for (const key of keysB) expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false);
  });

  it('excludes unrelated packet dependencies but reconciles every resource after an event gap', async () => {
    const packet = projectionKeys.spacePacket('space-a');
    const document = browserResourceKeys.spaceDocument('space-a');
    const issue = ['issue-detail', 'issue-a', 'repo-a'];
    for (const key of [packet, document, issue]) queryClient.setQueryData(key, { title: 'Retained' });
    invalidateDashboardApiCacheForEvent('conversation:updated');
    expect(queryClient.getQueryState(packet)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(document)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(issue)?.isInvalidated).toBe(true);
    invalidateDashboardCaches();
    await Promise.resolve();
    for (const key of [packet, document, issue]) {
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
      expect(queryClient.getQueryData(key)).toEqual({ title: 'Retained' });
    }
  });
});
