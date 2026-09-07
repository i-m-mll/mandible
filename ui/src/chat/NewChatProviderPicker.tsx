import { createPortal } from 'preact/compat';
import { useContext, useEffect, useRef } from 'preact/hooks';
import { DetailPaneOverlayContext } from '../components/shared/DetailPaneShell';
import { ChatFailureNotice, chatSpawnFailureNotice } from './ChatFailureNotice';
import type { NewChatDraft, NewChatProvider } from './newChatDraft';

function ProviderMark({ provider }: { provider: NewChatProvider }): JSX.Element {
  return provider === 'codex' ? (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.75a5.2 5.2 0 0 1 4.8 3.2 5.2 5.2 0 0 1 4 7.7 5.2 5.2 0 0 1-5.6 6.8A5.2 5.2 0 0 1 7.2 18a5.2 5.2 0 0 1-4-7.7A5.2 5.2 0 0 1 8.8 3.5 5.2 5.2 0 0 1 12 2.75Z" /><path d="m8.1 9.5 3.9-2.25 3.9 2.25v4.5L12 16.25 8.1 14Z" /></svg>
  ) : (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 4.5 21h3.8l1.5-4h4.4l1.5 4h3.8L12 3Zm0 7.2 1.2 3.5h-2.4l1.2-3.5Z" /></svg>
  );
}

export function NewChatProviderPicker({
  draft,
  onChoose,
  onRetry,
  onDiscard,
}: {
  draft: NewChatDraft;
  onChoose(provider: NewChatProvider): void;
  onRetry(): void;
  onDiscard(): void;
}): JSX.Element | null {
  const overlay = useContext(DetailPaneOverlayContext);
  const firstButton = useRef<HTMLButtonElement>(null);
  const closeable = draft.state === 'choosing' || draft.state === 'failed';

  useEffect(() => {
    if (!closeable) return undefined;
    firstButton.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDiscard();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [closeable, onDiscard, overlay?.host]);

  if (!overlay?.host || draft.state === 'abandoned' || draft.state === 'ready') return null;
  const busy = draft.state === 'starting';
  return createPortal(
    <div
      className="new-chat-provider-picker"
      role="dialog"
      aria-modal="true"
      aria-label="Choose a provider for the new chat"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && closeable) onDiscard();
      }}
    >
      <div className="new-chat-provider-picker__panel">
        <span className="sr-only">Choose a provider</span>
        <div className="new-chat-provider-picker__choices">
          {(['codex', 'claude_code'] as const).map((provider, index) => (
            <button
              key={provider}
              ref={index === 0 ? firstButton : undefined}
              type="button"
              className={`new-chat-provider-picker__provider new-chat-provider-picker__provider--${provider}`}
              aria-label={provider === 'codex' ? 'Start with Codex (OpenAI)' : 'Start with Claude'}
              title={provider === 'codex' ? 'Codex (OpenAI)' : 'Claude'}
              disabled={busy || draft.state === 'failed'}
              onClick={() => onChoose(provider)}
            >
              <ProviderMark provider={provider} />
            </button>
          ))}
        </div>
        {busy ? <div className="new-chat-provider-picker__status" role="status">Starting provider…</div> : null}
        {draft.state === 'failed' ? (
          <div className="new-chat-provider-picker__failure">
            <ChatFailureNotice failure={chatSpawnFailureNotice(draft.failure)} onRetry={draft.failure.retryable ? onRetry : undefined} />
            <button type="button" className="btn btn--ghost btn--sm" onClick={onDiscard}>Discard</button>
          </div>
        ) : null}
      </div>
    </div>,
    overlay.host,
  );
}
