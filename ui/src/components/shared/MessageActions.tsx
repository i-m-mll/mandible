import { Icon } from '../icons/Icon';
import type { IconName } from '../icons/Icon';
// Bug: a0963df — Unified hover-revealed action bar for messages
// Bug: 02d701a — P3: overflow menu and onInfo callback

import { createContext } from 'preact';
import { createPortal } from 'preact/compat';
import { useContext, useLayoutEffect, useRef, useState } from 'preact/hooks';
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
export type MessageActionsVariant = 'menu' | 'reply-footer';
export const MessageActionsVariantContext = createContext<MessageActionsVariant>('menu');

export type MessageActionsMeta = {
  tokenCount?: number;
  elapsedMs?: number;
  model?: string;
  timestamp?: string;
};

export type MessageActionsProps = {
  variant?: MessageActionsVariant;
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
  variant: explicitVariant,
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
  const inheritedVariant = useContext(MessageActionsVariantContext);
  const variant = explicitVariant ?? inheritedVariant;
  const [copiedFeedback, setCopiedFeedback] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [anchorPoint, setAnchorPoint] = useState<{ x: number; y: number }>();
  const actionRootRef = useRef<HTMLDivElement>(null);
  const ownerRef = useRef<HTMLElement | null>(null);
  const overflowTriggerRef = useRef<HTMLButtonElement>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  const overflowMenuStyle = useAnchoredMenu({
    open: overflowOpen,
    anchorRef: variant === 'menu' ? ownerRef : overflowTriggerRef,
    focusRef: variant === 'menu' ? ownerRef : undefined,
    anchorPoint: variant === 'menu' ? anchorPoint : undefined,
    placement: variant === 'menu' ? 'bottom-start' : 'bottom-end',
    gap: variant === 'menu' ? 0 : 6,
    menuRef: overflowMenuRef,
    onDismiss: () => setOverflowOpen(false),
  });

  const shouldShowResume = showResume ?? !!dagUuid;
  const shouldShowFork = showFork ?? !!dagUuid;

  // Are there any overflow items to show?
  const hasOverflow = shouldShowResume || shouldShowFork || !!onInfo || !!onCopyLink;
  const selectAction = selectMode || isSelected ? onSelect : undefined;
  const hasCompactActions = !!selectAction || !!onCopy || primaryActions.length > 0;
  useLayoutEffect(() => {
    if (variant !== 'menu' || (!hasOverflow && !hasCompactActions)) return;
    const root = actionRootRef.current; const owner = root?.parentElement;
    if (!root || !owner) return;
    ownerRef.current = owner;
    const previousTabIndex = owner.getAttribute('tabindex'); owner.tabIndex = 0;
    owner.setAttribute('data-event-menu-owner', '');
    let gesture: { target: EventTarget | null; selected: boolean } | null = null;
    const observePointer = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-event-menu-owner]') !== owner) { gesture = null; return; }
      const secondary = event.button === 2 || (event.button === 0 && event.ctrlKey);
      if (!secondary) { gesture = null; return; }
      if (event.type === 'mousedown' && gesture?.target === event.target) return;
      gesture = { target: event.target, selected: owner.ownerDocument.getSelection()?.isCollapsed === false };
    };
    const accepts = (event: Event, selected: boolean) => {
      const target = event.target instanceof Element ? event.target : null;
      const control = target?.closest('a[href],area[href],input,textarea,select,button,summary,video,audio,img,canvas,iframe,object,embed,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="menu"],[role="menuitem"],[data-context-menu]');
      const ownDisclosure = control?.matches('.compact-activity__row,.semantic-event__summary,.instruction-message-block__summary');
      return !event.defaultPrevented && target?.closest('[data-event-menu-owner]') === owner
        && !selected
        && (!control || ownDisclosure);
    };
    const open = (event: Event, x: number, y: number, selected: boolean) => {
      if (!accepts(event, selected)) return;
      event.preventDefault(); event.stopPropagation();
      setAnchorPoint({ x, y }); setOverflowOpen(true);
    };
    const context = (event: MouseEvent) => {
      const selected = gesture?.target === event.target ? gesture.selected : owner.ownerDocument.getSelection()?.isCollapsed === false;
      gesture = null; open(event, event.clientX, event.clientY, selected);
    };
    const keyboard = (event: KeyboardEvent) => {
      gesture = null;
      if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
      const rect = owner.getBoundingClientRect(); open(event, rect.left + Math.min(24, rect.width / 2), rect.top + Math.min(24, rect.height / 2), owner.ownerDocument.getSelection()?.isCollapsed === false);
    };
    const clearGesture = () => { gesture = null; };
    owner.ownerDocument.addEventListener('pointerdown', observePointer, true); owner.ownerDocument.addEventListener('mousedown', observePointer, true);
    owner.ownerDocument.addEventListener('keydown', clearGesture, true);
    owner.addEventListener('contextmenu', context); owner.addEventListener('keydown', keyboard);
    return () => {
      owner.removeEventListener('contextmenu', context); owner.removeEventListener('keydown', keyboard); owner.removeAttribute('data-event-menu-owner');
      owner.ownerDocument.removeEventListener('pointerdown', observePointer, true); owner.ownerDocument.removeEventListener('mousedown', observePointer, true);
      owner.ownerDocument.removeEventListener('keydown', clearGesture, true);
      if (owner.getAttribute('tabindex') === '0') { if (previousTabIndex === null) owner.removeAttribute('tabindex'); else owner.setAttribute('tabindex', previousTabIndex); }
      if (ownerRef.current === owner) ownerRef.current = null;
    };
  }, [variant, hasOverflow, hasCompactActions]);
  useLayoutEffect(() => {
    if (overflowOpen && variant === 'menu') overflowMenuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [overflowOpen, variant]);

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
    if (variant === 'menu') ownerRef.current?.focus({ preventScroll: true });
    if (action) action();
  };

  return (
    <div
      ref={actionRootRef}
      className={`message-actions message-actions--${variant} contextual-action-group${overflowOpen ? ' contextual-action-group--persistent' : ''}${selectMode || isSelected ? ' message-actions--selecting' : ''}`}
      data-dag-uuid={dagUuid}
    >
      {/* Primary actions — buttons on right */}
      {variant === 'reply-footer' && selectAction && (
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
      {variant === 'reply-footer' && onCopy && (
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
      {variant === 'reply-footer' && primaryActions.map((action) => (
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
      {(hasOverflow || (variant === 'menu' && hasCompactActions)) && (
        <div className="message-actions__overflow-wrap">
          {variant === 'reply-footer' && <ContextualAction
            ref={overflowTriggerRef}
            className="message-actions__btn message-actions__overflow"
            onClick={handleOverflowToggle}
            title="More actions"
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={overflowOpen}
          >
            <Icon name="menu" /></ContextualAction>}
          {overflowOpen && createPortal(
            <div
              ref={overflowMenuRef}
              className="message-actions__overflow-menu app-anchored-menu"
              role="menu"
              popover="manual"
              style={overflowMenuStyle}
            >
              {variant === 'menu' && selectAction && (
                <button type="button" className="message-actions__overflow-item" role="menuitemcheckbox" aria-checked={isSelected}
                  onClick={(event) => handleOverflowItem(event, () => selectAction(event.shiftKey))}>
                  <Icon name={isSelected ? 'messageSelectionChecked' : 'messageSelect'} /> {isSelected ? 'Deselect message' : 'Select message'}
                </button>
              )}
              {variant === 'menu' && onCopy && (
                <button type="button" className="message-actions__overflow-item" role="menuitem"
                  onClick={(event) => { handleCopy(event); setOverflowOpen(false); ownerRef.current?.focus({ preventScroll: true }); }}>
                  <Icon name="copyMessage" /> {copiedFeedback ? 'Copied' : 'Copy message'}
                </button>
              )}
              {variant === 'menu' && primaryActions.map(action => (
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
