// SHARED COMPONENT — used by BOTH Chat (StreamRenderer) and History (conversations.tsx).
// Changes here affect BOTH views. If you modify rendering for one view,
// the other MUST update automatically because they use this same component.

// Bug: bce7370 — Aggregate stats footer for multi-block assistant groups

import { useState } from 'preact/hooks';

export type GroupFooterProps = {
  totalTokens?: number;
  onCopyAll: () => void;
  onSelect?: () => void;
  isSelected?: boolean;
};

export function GroupFooter({ totalTokens, onCopyAll, onSelect, isSelected }: GroupFooterProps): JSX.Element {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    onCopyAll();
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="group-footer">
      <hr className="group-footer__separator" />
      <div className="group-footer__row">
        <button
          type="button"
          className="group-footer__btn"
          onClick={handleCopy}
          title={copied ? 'Copied' : 'Copy all'}
          aria-label={copied ? 'Copied' : 'Copy all messages'}
        >
          {copied ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </button>
        {/* Bug: 0a1ad82 — Select button for turn selection */}
        {onSelect && (
          <button
            type="button"
            className={`group-footer__btn${isSelected ? ' group-footer__btn--selected' : ''}`}
            onClick={onSelect}
            title={isSelected ? 'Deselect' : 'Select'}
            aria-label={isSelected ? 'Deselect turn' : 'Select turn'}
          >
            {isSelected ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="3" ry="3" />
                <polyline points="17 8 10 16 7 13" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="3" ry="3" />
              </svg>
            )}
          </button>
        )}
        {totalTokens != null && (
          <span className="group-footer__stat">
            {totalTokens.toLocaleString()} tokens
          </span>
        )}
      </div>
    </div>
  );
}
