import { Icon } from '../icons/Icon';
// SHARED COMPONENT — used by BOTH Chat (StreamRenderer) and History (conversations.tsx).
// Changes here affect BOTH views. If you modify rendering for one view,
// the other MUST update automatically because they use this same component.

// Bug: bce7370 — Aggregate stats footer for multi-block assistant groups

import { useState } from 'preact/hooks';
import { ContextualAction } from '../shared/ContextualAction';

export type GroupFooterProps = {
  totalTokens?: number;
  onCopyAll: () => void;
  onOpenMarkdown?: () => void;
  onSelect?: () => void;
  isSelected?: boolean;
};

export function GroupFooter({
  totalTokens,
  onCopyAll,
  onOpenMarkdown,
  onSelect,
  isSelected,
}: GroupFooterProps): JSX.Element {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    onCopyAll();
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="group-footer contextual-action-group">
      <div className="group-footer__row">
        <ContextualAction
          className="group-footer__btn"
          onClick={handleCopy}
          title={copied ? 'Copied' : 'Copy all'}
          aria-label={copied ? 'Copied' : 'Copy all messages'}
        >
          {copied ? (
            <Icon name="messageCopied" size={14} />
          ) : (
            <Icon name="copyMessage" size={14} />
          )}
        </ContextualAction>
        {/* Bug: 0a1ad82 — Select button for turn selection */}
        {onSelect && (
          <ContextualAction
            className={`group-footer__btn${isSelected ? ' group-footer__btn--selected' : ''}`}
            onClick={onSelect}
            title={isSelected ? 'Deselect' : 'Select'}
            aria-label={isSelected ? 'Deselect turn' : 'Select turn'}
          >
            {isSelected ? (
              <Icon name="messageSelected" size={14} />
            ) : (
              <Icon name="selectMessage" size={14} />
            )}
          </ContextualAction>
        )}
        {onOpenMarkdown && (
          <ContextualAction
            className="group-footer__btn"
            onClick={onOpenMarkdown}
            title="Open markdown"
            aria-label="Open turn as markdown"
          >
            <Icon name="resumeConversation" size={14} />
          </ContextualAction>
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
