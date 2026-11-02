import { Icon } from '../icons/Icon';
import type { IconName } from '../icons/Icon';
// Bug: a0963df — Unified hover-revealed action bar for messages
// Bug: 02d701a — P3: overflow menu and onInfo callback

import { createContext } from 'preact';
import { createPortal } from 'preact/compat';
import { useContext, useRef, useState } from 'preact/hooks';
import { useAnchoredMenu } from '../../hooks/useAnchoredMenu';
import { ContextualAction } from './ContextualAction';

export const MessageLinkContext = createContext<((blockId: string) => void) | null>(null);

export type MessagePrimaryAction = {
  id: string;
  title: string;
  label: string;
  icon: IconName;
  onAction: () => void;
};

export const MessagePrimaryActionsContext = createContext<readonly MessagePrimaryAction[]>([]);

export type MessageActionsMeta = {
  tokenCount?: number;
  elapsedMs?: number;
  model?: string;
  timestamp?: string;
};

export type MessageActionsProps = {
  blockId?: string;
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
  blockId,
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
  const onCopyLink = useContext(MessageLinkContext);
  const primaryActions = useContext(MessagePrimaryActionsContext);
  const [copiedFeedback, setCopiedFeedback] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [overflowCompact, setOverflowCompact] = useState(false);
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
  const hasOverflow = shouldShowResume || shouldShowFork || !!onInfo || !!onCopyLink;
  const selectAction = selectMode || isSelected ? onSelect : undefined;
  const hasCompactActions = !!selectAction || !!onCopy || primaryActions.length > 0;

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
    setOverflowCompact(getComputedStyle(e.currentTarget as HTMLElement).getPropertyValue('--message-actions-compact').trim() === '1');
    setOverflowOpen((prev) => !prev);
  };

  const handleOverflowItem = (e: MouseEvent, action: (() => void) | undefined) => {
    e.stopPropagation();
    setOverflowOpen(false);
    if (action) action();
  };

  return (
    <div
      className={`message-actions contextual-action-group${overflowOpen ? ' contextual-action-group--persistent' : ''}${selectMode || isSelected ? ' message-actions--selecting' : ''}`}
      data-dag-uuid={dagUuid}
    >
      {/* Primary actions — buttons on right */}
      {selectAction && (
        <button
          type="button"
          className={`message-actions__btn message-actions__primary${isSelected ? ' message-actions__btn--selected' : ''}`}
          onClick={(event) => { event.stopPropagation(); selectAction(event.shiftKey); }}
          title={isSelected ? 'Deselect' : 'Select'}
          aria-label={isSelected ? 'Deselect message' : 'Select message'}
          aria-pressed={isSelected}
        >
          <Icon name={isSelected ? 'messageSelectionChecked' : 'messageSelect'} />
        </button>
      )}
      {onCopy && (
        <ContextualAction
          className="message-actions__btn message-actions__primary"
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
      {primaryActions.map((action) => (
        <ContextualAction
          key={action.id}
          className="message-actions__btn message-actions__primary"
          title={action.title}
          aria-label={action.label}
          onClick={(event) => { event.stopPropagation(); action.onAction(); }}
        >
          <Icon name={action.icon} size={14} />
        </ContextualAction>
      ))}

      {/* Overflow menu — secondary actions behind ellipsis */}
      {(hasOverflow || hasCompactActions) && (
        <div className={`message-actions__overflow-wrap${hasOverflow ? '' : ' message-actions__overflow-wrap--compact-only'}`}>
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
          {overflowOpen && createPortal(
            <div
              ref={overflowMenuRef}
              className="message-actions__overflow-menu app-anchored-menu"
              role="menu"
              popover="manual"
              style={overflowMenuStyle}
            >
              {overflowCompact && selectAction && (
                <button type="button" className="message-actions__overflow-item" role="menuitemcheckbox" aria-checked={isSelected}
                  onClick={(event) => handleOverflowItem(event, () => selectAction(event.shiftKey))}>
                  <Icon name={isSelected ? 'messageSelectionChecked' : 'messageSelect'} /> {isSelected ? 'Deselect message' : 'Select message'}
                </button>
              )}
              {overflowCompact && onCopy && (
                <button type="button" className="message-actions__overflow-item" role="menuitem"
                  onClick={(event) => { handleCopy(event); setOverflowOpen(false); }}>
                  <Icon name="copyMessage" /> {copiedFeedback ? 'Copied' : 'Copy message'}
                </button>
              )}
              {overflowCompact && primaryActions.map(action => (
                <button key={action.id} type="button" className="message-actions__overflow-item" role="menuitem" aria-label={action.label}
                  onClick={(event) => handleOverflowItem(event, action.onAction)}>
                  <Icon name={action.icon} /> {action.title}
                </button>
              ))}
              {onCopyLink && (
                <button
                  type="button"
                  className="message-actions__overflow-item"
                  role="menuitem"
                  disabled={!blockId}
                  title={blockId ? undefined : 'Available when this message is saved'}
                  onClick={(e) => handleOverflowItem(e, blockId ? () => onCopyLink(blockId) : undefined)}
                >
                  <Icon name="copyLink" /> Copy link
                </button>
              )}
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
            </div>, document.body,
          )}
        </div>
      )}
    </div>
  );
}
