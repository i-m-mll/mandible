import { createPortal } from 'preact/compat';
import { useContext, useEffect, useRef } from 'preact/hooks';
import { DetailPaneOverlayContext } from '../components/shared/DetailPaneShell';
import { ChatFailureNotice, chatSpawnFailureNotice } from './ChatFailureNotice';
import type { NewChatDraft, NewChatProvider } from './newChatDraft';

function ProviderMark({ provider }: { provider: NewChatProvider }): JSX.Element {
  // Exact upstream geometry, retained at the picker's existing mark authority:
  // OpenAI-Logos-2025.zip/OpenAI-black-monoblossom.svg
  // https://cdn.openai.com/brand/OpenAI-Logos-2025.zip
  // SHA-256 7be72f1fea831d3ba81a545cee79b7e0ae69449d5d7837c9571ccbfb4aa1e00b
  // Anthropic press kit/Anthropic symbol - Slate.svg
  // https://www.anthropic.com/press-kit
  // SHA-256 d55918884053460f24c958fca3fba8d10b48fdd86e73ba3cd1237713bc0a03bb
  return provider === 'codex' ? (
    <svg className="new-chat-provider-picker__mark" viewBox="0 0 721 721" aria-hidden="true">
      <path d="M304.246 294.611V249.028C304.246 245.189 305.687 242.309 309.044 240.392L400.692 187.612C413.167 180.415 428.042 177.058 443.394 177.058C500.971 177.058 537.44 221.682 537.44 269.182C537.44 272.54 537.44 276.379 536.959 280.218L441.954 224.558C436.197 221.201 430.437 221.201 424.68 224.558L304.246 294.611ZM518.245 472.145V363.224C518.245 356.505 515.364 351.707 509.608 348.349L389.174 278.296L428.519 255.743C431.877 253.826 434.757 253.826 438.115 255.743L529.762 308.523C556.154 323.879 573.905 356.505 573.905 388.171C573.905 424.636 552.315 458.225 518.245 472.141V472.145ZM275.937 376.182L236.592 353.152C233.235 351.235 231.794 348.354 231.794 344.515V238.956C231.794 187.617 271.139 148.749 324.4 148.749C344.555 148.749 363.264 155.468 379.102 167.463L284.578 222.164C278.822 225.521 275.942 230.319 275.942 237.039V376.186L275.937 376.182ZM360.626 425.122L304.246 393.455V326.283L360.626 294.616L417.002 326.283V393.455L360.626 425.122ZM396.852 570.989C376.698 570.989 357.989 564.27 342.151 552.276L436.674 497.574C442.431 494.217 445.311 489.419 445.311 482.699V343.552L485.138 366.582C488.495 368.499 489.936 371.379 489.936 375.219V480.778C489.936 532.117 450.109 570.985 396.852 570.985V570.989ZM283.134 463.99L191.486 411.211C165.094 395.854 147.343 363.229 147.343 331.562C147.343 294.616 169.415 261.509 203.48 247.593V356.991C203.48 363.71 206.361 368.508 212.117 371.866L332.074 441.437L292.729 463.99C289.372 465.907 286.491 465.907 283.134 463.99ZM277.859 542.68C223.639 542.68 183.813 501.895 183.813 451.514C183.813 447.675 184.294 443.836 184.771 439.997L279.295 494.698C285.051 498.056 290.812 498.056 296.568 494.698L417.002 425.127V470.71C417.002 474.549 415.562 477.429 412.204 479.346L320.557 532.126C308.081 539.323 293.206 542.68 277.854 542.68H277.859ZM396.852 599.776C454.911 599.776 503.37 558.513 514.41 503.812C568.149 489.896 602.696 439.515 602.696 388.176C602.696 354.587 588.303 321.962 562.392 298.45C564.791 288.373 566.231 278.296 566.231 268.224C566.231 199.611 510.571 148.267 446.274 148.267C433.322 148.267 420.846 150.184 408.37 154.505C386.775 133.392 357.026 119.958 324.4 119.958C266.342 119.958 217.883 161.22 206.843 215.921C153.104 229.837 118.557 280.218 118.557 331.557C118.557 365.146 132.95 397.771 158.861 421.283C156.462 431.36 155.022 441.437 155.022 451.51C155.022 520.123 210.682 571.466 274.978 571.466C287.931 571.466 300.407 569.549 312.883 565.228C334.473 586.341 364.222 599.776 396.852 599.776Z" fill="black" />
    </svg>
  ) : (
    <svg className="new-chat-provider-picker__mark" viewBox="0 0 92 64" aria-hidden="true">
      <path d="M66.4915 0H52.5029L78.0115 64H92.0001L66.4915 0Z" fill="#141413" />
      <path d="M26.08 0L0.571472 64H14.8343L20.0512 50.56H46.7374L51.9543 64H66.2172L40.7086 0H26.08ZM24.6647 38.6743L33.3943 16.1829L42.1239 38.6743H24.6647Z" fill="#141413" />
    </svg>
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
  const dialog = useRef<HTMLDivElement>(null);
  const closeable = draft.state !== 'ready' && draft.state !== 'abandoned';

  useEffect(() => {
    if (!closeable) return undefined;
    dialog.current?.focus();
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
