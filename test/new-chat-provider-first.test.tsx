// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { reduceNewChatDraft, type NewChatDraft } from '../ui/src/chat';

const spawn = (attemptCount: number, updatedAt: number, state: 'starting' | 'ready' = 'starting') => ({
  schema: 'mandible-conversation-spawn-receipt@3' as const,
  reservation_id: draft.id,
  request: {
    schema: 'mandible-conversation-spawn-request@3' as const,
    idempotency_key: draft.id,
    provider: 'codex' as const,
    placement: { kind: 'projectless' as const },
  },
  state,
  attempt_count: attemptCount,
  native_session_id: state === 'ready' ? 'controller-1' : null,
  provider_session_id: state === 'ready' ? 'provider-1' : null,
  provider_receipt: null,
  error: null,
  created_at: 1,
  updated_at: updatedAt,
});

const draft: NewChatDraft = {
  id: '10000000-0000-4000-8000-000000000001',
  state: 'choosing',
  placement: { kind: 'project', projectId: 'project-1', checkoutId: 'checkout-1', projectLabel: 'Project' },
};

describe('provider-first new chat', () => {
  it('makes provider immutable and permits cancellation while starting or after failure', () => {
    const starting = reduceNewChatDraft(draft, { type: 'choose', provider: 'codex' });
    expect(starting).toMatchObject({ state: 'starting', provider: 'codex' });
    expect(reduceNewChatDraft(starting, { type: 'choose', provider: 'claude_code' })).toEqual(starting);
    expect(reduceNewChatDraft(starting, { type: 'abandon' })).toMatchObject({ state: 'abandoned', provider: 'codex' });
    const failed = reduceNewChatDraft(starting, {
      type: 'fail',
      failure: { code: 'provider_startup_timeout', message: 'Timed out', retryable: true },
    });
    expect(reduceNewChatDraft(failed, { type: 'retry' })).toMatchObject({ state: 'starting', provider: 'codex' });
    expect(reduceNewChatDraft(failed, { type: 'abandon' })).toMatchObject({ state: 'abandoned', provider: 'codex' });
  });

  it('keeps the accepted reservation identity and ignores stale lifecycle observations', () => {
    const starting = reduceNewChatDraft(draft, { type: 'choose', provider: 'codex' });
    const accepted = reduceNewChatDraft(starting, {
      type: 'accepted',
      conversationId: draft.id,
      spawn: spawn(1, 10),
    });
    expect(accepted).toMatchObject({ state: 'accepted', conversationId: draft.id, spawn: { state: 'starting' } });
    expect(reduceNewChatDraft(accepted, { type: 'observe', spawn: spawn(1, 9, 'ready') })).toEqual(accepted);
    expect(reduceNewChatDraft(accepted, { type: 'observe', spawn: spawn(0, 20, 'ready') })).toEqual(accepted);
    expect(reduceNewChatDraft(accepted, { type: 'observe', spawn: { ...spawn(1, 20, 'ready'), reservation_id: 'other' } })).toEqual(accepted);
    expect(reduceNewChatDraft(accepted, { type: 'observe', spawn: spawn(1, 20, 'ready') })).toMatchObject({
      state: 'accepted',
      conversationId: draft.id,
      spawn: { state: 'ready', updated_at: 20 },
    });
    expect(reduceNewChatDraft(accepted, { type: 'abandon' })).toEqual(accepted);
  });
});
