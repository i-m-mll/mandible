// Bug: a0963df — Unified hover-revealed action bar for messages

import { useState } from 'preact/hooks';

export type MessageActionsProps = {
  onCopy?: () => void;
  onResume?: () => void;
  onFork?: () => void;
  dagUuid?: string;              // for resume/fork targeting
  showResume?: boolean;          // show resume action (default true when dagUuid present)
  showFork?: boolean;            // show fork action (default true when dagUuid present)
};

export function MessageActions({
  onCopy,
  onResume,
  onFork,
  dagUuid,
  showResume,
  showFork,
}: MessageActionsProps): JSX.Element {
  const [copiedFeedback, setCopiedFeedback] = useState(false);

  const shouldShowResume = showResume ?? !!dagUuid;
  const shouldShowFork = showFork ?? !!dagUuid;

  const handleCopy = (e: MouseEvent) => {
    e.stopPropagation();
    if (onCopy) {
      onCopy();
      setCopiedFeedback(true);
      setTimeout(() => setCopiedFeedback(false), 1200);
    }
  };

  const handleResume = (e: MouseEvent) => {
    e.stopPropagation();
    if (onResume) onResume();
  };

  const handleFork = (e: MouseEvent) => {
    e.stopPropagation();
    if (onFork) onFork();
  };

  return (
    <div className="message-actions" data-dag-uuid={dagUuid}>
      {onCopy && (
        <button
          type="button"
          className="message-actions__btn"
          onClick={handleCopy}
          title={copiedFeedback ? 'Copied' : 'Copy'}
          aria-label={copiedFeedback ? 'Copied' : 'Copy message'}
        >
          {copiedFeedback ? '\u2713' : 'Copy'}
        </button>
      )}
      {shouldShowResume && (
        <button
          type="button"
          className="message-actions__btn"
          onClick={handleResume}
          title="Resume from this message"
          aria-label="Resume"
        >
          &#x21A9;
        </button>
      )}
      {shouldShowFork && (
        <button
          type="button"
          className="message-actions__btn"
          onClick={handleFork}
          title="Fork a new branch from this message"
          aria-label="Fork"
        >
          &#x2441;
        </button>
      )}
    </div>
  );
}
