import { fireEvent, render, screen } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import { NewChatProviderPicker, reduceNewChatDraft, type NewChatDraft } from '../../ui/src/chat';
import { DetailPaneShell } from '../../ui/src/components/shared/DetailPaneShell';

const draft: NewChatDraft = {
  id: '10000000-0000-4000-8000-000000000001',
  state: 'choosing',
  placement: { projectId: 'project-1', checkoutId: 'checkout-1', projectLabel: 'Project' },
};

describe('provider-first new chat', () => {
  it('makes provider immutable and permits only same-provider retry or discard after failure', () => {
    const starting = reduceNewChatDraft(draft, { type: 'choose', provider: 'codex' });
    expect(starting).toMatchObject({ state: 'starting', provider: 'codex' });
    expect(reduceNewChatDraft(starting, { type: 'choose', provider: 'claude_code' })).toEqual(starting);
    const failed = reduceNewChatDraft(starting, {
      type: 'fail',
      failure: { code: 'provider_startup_timeout', message: 'Timed out', retryable: true },
    });
    expect(reduceNewChatDraft(failed, { type: 'retry' })).toMatchObject({ state: 'starting', provider: 'codex' });
    expect(reduceNewChatDraft(failed, { type: 'abandon' })).toMatchObject({ state: 'abandoned', provider: 'codex' });
  });

  it('renders exactly Codex and Claude as accessible icon choices and abandons on Escape', async () => {
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
    expect(screen.queryByText(/Gemini|Antigravity/i)).toBeNull();
    fireEvent.click(choices[1]);
    expect(onChoose).toHaveBeenCalledWith('claude_code');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onDiscard).toHaveBeenCalledOnce();
  });
});
