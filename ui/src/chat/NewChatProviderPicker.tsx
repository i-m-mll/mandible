import { createPortal } from 'preact/compat';
import { useContext, useEffect, useRef } from 'preact/hooks';
import { DetailPaneOverlayContext } from '../components/shared/DetailPaneShell';
import { OfficialProviderMark } from '../components/shared/OfficialProviderMark';
import { ChatFailureNotice, chatSpawnFailureNotice } from './ChatFailureNotice';
import type { NewChatDraft, NewChatProvider } from './newChatDraft';

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
  const dialog = useRef<HTMLDivElement>(null);
  const closeable = draft.state !== 'accepted' && draft.state !== 'abandoned';

  useEffect(() => {
    if (!closeable) return undefined;
    dialog.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDiscard();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [closeable, onDiscard, overlay?.host]);

  if (!overlay?.host || draft.state === 'abandoned' || draft.state === 'accepted') return null;
  const busy = draft.state === 'starting';
  return createPortal(
    <div
      ref={dialog}
      className="new-chat-provider-picker"
      role="dialog"
      aria-modal="true"
      aria-label="Choose a provider for the new chat"
      tabIndex={-1}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && closeable) onDiscard();
      }}
    >
      <div className="new-chat-provider-picker__panel">
        <span className="sr-only">Choose a provider</span>
        <div className="new-chat-provider-picker__choices">
          {(['codex', 'claude_code'] as const).map((provider) => (
            <button
              key={provider}
              type="button"
              className={`new-chat-provider-picker__provider new-chat-provider-picker__provider--${provider}`}
              aria-label={provider === 'codex' ? 'Start with Codex (OpenAI)' : 'Start with Claude'}
              title={provider === 'codex' ? 'Codex (OpenAI)' : 'Claude'}
              disabled={busy || draft.state === 'failed'}
              onClick={() => onChoose(provider)}
            >
              <OfficialProviderMark
                kind={provider === 'codex' ? 'openai' : 'anthropic'}
                className="new-chat-provider-picker__mark"
              />
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
