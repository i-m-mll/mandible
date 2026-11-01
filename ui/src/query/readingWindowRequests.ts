import type { ConversationPositionWindow, ConversationWindowRequest } from '../api';
import { normalizeWindowTarget } from './conversationKeys';

export type ReadingWindowRequestResult =
  | { status: 'readable'; window: ConversationPositionWindow }
  | { status: 'cancelled' | 'busy' | 'position-space-changed' }
  | { status: 'failed'; error: unknown };

/** Supervises Query transports only; all fetched data remains in Query. */
export class ReadingWindowRequests {
  private generation = 0;
  private scope: { conversationId: string; positionSpaceId: string } | null = null;
  private pending = new Map<string, { controller: AbortController; result: Promise<ReadingWindowRequestResult> }>();

  select(conversationId: string, positionSpaceId: string): void {
    if (this.scope?.conversationId === conversationId && this.scope.positionSpaceId === positionSpaceId) return;
    this.cancel();
    this.scope = { conversationId, positionSpaceId };
  }

  cancel(): void {
    this.generation += 1;
    for (const request of this.pending.values()) request.controller.abort();
    this.pending.clear();
  }

  read(
    request: ConversationWindowRequest,
    queryRead: (conversationId: string, request: ConversationWindowRequest) => Promise<ConversationPositionWindow>,
  ): Promise<ReadingWindowRequestResult> {
    const scope = this.scope;
    if (!scope) return Promise.resolve({ status: 'cancelled' });
    const scoped = { ...request, expected_position_space_id: scope.positionSpaceId };
    const key = JSON.stringify([scope, normalizeWindowTarget(scoped)]);
    const existing = this.pending.get(key);
    if (existing) return existing.result;
    if (this.pending.size >= 2) return Promise.resolve({ status: 'busy' });
    const generation = this.generation;
    const controller = new AbortController();
    const signal = request.signal ? AbortSignal.any([controller.signal, request.signal]) : controller.signal;
    const result = Promise.resolve().then(async (): Promise<ReadingWindowRequestResult> => {
      try {
        if (signal.aborted || generation !== this.generation) return { status: 'cancelled' };
        const window = await queryRead(scope.conversationId, { ...scoped, signal });
        if (signal.aborted || generation !== this.generation) return { status: 'cancelled' };
        if (window.conversation.id !== scope.conversationId) return { status: 'cancelled' };
        if (window.position_space_id !== scope.positionSpaceId) return { status: 'position-space-changed' };
        return { status: 'readable', window };
      } catch (error) {
        if (signal.aborted || generation !== this.generation) return { status: 'cancelled' };
        if (error && typeof error === 'object' && 'code' in error && error.code === 'position_space_changed') {
          return { status: 'position-space-changed' };
        }
        return { status: 'failed', error };
      } finally {
        if (this.pending.get(key)?.controller === controller) this.pending.delete(key);
      }
    });
    this.pending.set(key, { controller, result });
    return result;
  }
}
