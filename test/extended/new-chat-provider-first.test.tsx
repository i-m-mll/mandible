import { fireEvent, render, screen } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import { NewChatProviderPicker, reduceNewChatDraft, type NewChatDraft } from '../../ui/src/chat';
import { DetailPaneShell } from '../../ui/src/components/shared/DetailPaneShell';

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

  it('renders exactly Codex and Claude as accessible icon choices and abandons on Escape', async () => {
    expect('provider' in draft).toBe(false);
    const onChoose = vi.fn();
    const onDiscard = vi.fn();
    render(
      <DetailPaneShell header={<span>New chat</span>}>
        <span />
        <NewChatProviderPicker draft={draft} onChoose={onChoose} onRetry={vi.fn()} onDiscard={onDiscard} />
      </DetailPaneShell>,
    );
    const choices = await screen.findAllByRole('button');
    expect(choices.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Start with Codex (OpenAI)',
      'Start with Claude',
    ]);
    expect(choices.map((button) => button.querySelector('svg')?.getAttribute('viewBox'))).toEqual([
      '0 0 721 721',
      '0 0 92 64',
    ]);
    const picker = screen.getByRole('dialog', { name: 'Choose a provider for the new chat' });
    expect(document.activeElement).toBe(picker);
    expect(choices).not.toContain(document.activeElement);
    expect(choices.every((button) => button.getAttribute('aria-pressed') === null)).toBe(true);
    expect(screen.queryByText(/Gemini|Antigravity/i)).toBeNull();
    fireEvent.click(choices[1]);
    expect(onChoose).toHaveBeenCalledWith('claude_code');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onDiscard).toHaveBeenCalledOnce();
  });
});
