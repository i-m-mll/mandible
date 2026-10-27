import { Icon } from '../icons/Icon';
// Bug: a0963df — Unified hover-revealed action bar for messages
// Bug: 02d701a — P3: overflow menu and onInfo callback

import { useRef, useState } from 'preact/hooks';
import { useAnchoredMenu } from '../../hooks/useAnchoredMenu';
import { ContextualAction } from './ContextualAction';

export type MessageActionsMeta = {
  tokenCount?: number;
  elapsedMs?: number;
  model?: string;
  timestamp?: string;
};

export type MessageActionsProps = {
  onCopy?: () => void;
  onResume?: () => void;
  onFork?: () => void;
  onInfo?: () => void;
  dagUuid?: string;              // for resume/fork targeting
  showResume?: boolean;          // show resume action (default true when dagUuid present)
  showFork?: boolean;            // show fork action (default true when dagUuid present)
  metadata?: MessageActionsMeta;
  onSelect?: (shiftKey: boolean) => void;
  isSelected?: boolean;
  selectMode?: boolean;
};

export function MessageActions({
  onCopy,
  onResume,
  onFork,
  onInfo,
  dagUuid,
  showResume,
  showFork,
  onSelect,
  isSelected = false,
  selectMode = false,
}: MessageActionsProps): JSX.Element {
  const [copiedFeedback, setCopiedFeedback] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowTriggerRef = useRef<HTMLButtonElement>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  const overflowMenuStyle = useAnchoredMenu({
    open: overflowOpen,
    anchorRef: overflowTriggerRef,
    menuRef: overflowMenuRef,
    onDismiss: () => setOverflowOpen(false),
  });

  const shouldShowResume = showResume ?? !!dagUuid;
  const shouldShowFork = showFork ?? !!dagUuid;

  // Are there any overflow items to show?
  const hasOverflow = shouldShowResume || shouldShowFork || !!onInfo;

  const handleCopy = (e: MouseEvent) => {
    e.stopPropagation();
    if (onCopy) {
      onCopy();
      setCopiedFeedback(true);
      setTimeout(() => setCopiedFeedback(false), 1200);
    }
  };

  const handleOverflowToggle = (e: MouseEvent) => {
    e.stopPropagation();
    setOverflowOpen((prev) => !prev);
  };

  const handleOverflowItem = (e: MouseEvent, action: (() => void) | undefined) => {
    e.stopPropagation();
    setOverflowOpen(false);
    if (action) action();
  };

  return (
    <div
      className={`message-actions contextual-action-group${selectMode || isSelected ? ' message-actions--selecting' : ''}`}
      data-dag-uuid={dagUuid}
    >
      {/* Primary actions — buttons on right */}
      {onSelect && (selectMode || isSelected) && (
        <button
          type="button"
          className={`message-actions__btn${isSelected ? ' message-actions__btn--selected' : ''}`}
          onClick={(event) => { event.stopPropagation(); onSelect(event.shiftKey); }}
          title={isSelected ? 'Deselect' : 'Select'}
          aria-label={isSelected ? 'Deselect message' : 'Select message'}
          aria-pressed={isSelected}
        >
          <Icon name={isSelected ? 'messageSelectionChecked' : 'messageSelect'} />
        </button>
      )}
      {onCopy && (
        <ContextualAction
          className="message-actions__btn"
          onClick={handleCopy}
          title={copiedFeedback ? 'Copied' : 'Copy'}
          aria-label={copiedFeedback ? 'Copied' : 'Copy message'}
        >
          {copiedFeedback ? (
            <Icon name="messageCopied" size={14} />
          ) : (
            <Icon name="copyMessage" size={14} />
          )}
        </ContextualAction>
      )}

      {/* Overflow menu — secondary actions behind ellipsis */}
      {hasOverflow && (
        <div className="message-actions__overflow-wrap">
          <ContextualAction
            ref={overflowTriggerRef}
            className="message-actions__btn message-actions__overflow"
            onClick={handleOverflowToggle}
            title="More actions"
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={overflowOpen}
          >
            <Icon name="menu" /></ContextualAction>
          {overflowOpen && (
            <div
              ref={overflowMenuRef}
              className="message-actions__overflow-menu app-anchored-menu"
              role="menu"
              popover="manual"
              style={overflowMenuStyle}
            >
              {shouldShowFork && (
                <button
                  type="button"
                  className="message-actions__overflow-item"
                  role="menuitem"
                  onClick={(e) => handleOverflowItem(e, onFork)}
                >
                  <Icon name="forkConversation" /> Fork
                </button>
              )}
              {shouldShowResume && (
                <button
                  type="button"
                  className="message-actions__overflow-item"
                  role="menuitem"
                  onClick={(e) => handleOverflowItem(e, onResume)}
                >
                  <Icon name="resume" /> Resume
                </button>
              )}
              {onInfo && (
                <button
                  type="button"
                  className="message-actions__overflow-item"
                  role="menuitem"
                  onClick={(e) => handleOverflowItem(e, onInfo)}
                >
                  <Icon name="information" /> Info
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
