import { Icon } from '../icons/Icon';
import type { ComponentChildren, JSX } from 'preact';
import { useCallback, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useAnchoredMenu } from '../../hooks/useAnchoredMenu';
import { ContextualAction } from './ContextualAction';
import { OfficialProviderMark, type OfficialProviderMarkKind } from './OfficialProviderMark';
import { SidebarReorderHandle } from './SidebarReorderHandle';
import type { SidebarReorderBinding } from './sidebar-order';

export type SidebarItemRowProps = {
  label: string;
  selectionLabel: string;
  selectionDescription?: string;
  selected?: boolean;
  className?: string;
  provider?: SidebarItemProvider;
  trailingReveal?: 'interaction' | 'persistent-pin';
  leading?: ComponentChildren;
  badges?: ComponentChildren;
  actions?: ComponentChildren;
  selectRef?: (element: HTMLButtonElement | null) => void;
  tabIndex?: number;
  ariaCurrent?: 'true';
  onSelect(): void;
  onKeyDown?: JSX.KeyboardEventHandler<HTMLButtonElement>;
  reorder?: SidebarReorderBinding;
};

export type SidebarLeadingActionRowProps = {
  label: string;
  icon: ComponentChildren;
  onPress(): void;
  testId?: string;
};

export function SidebarLeadingActionRow({
  label,
  icon,
  onPress,
  testId,
}: SidebarLeadingActionRowProps): JSX.Element {
  return (
    <button
      type="button"
      className="sidebar-leading-action-row"
      data-testid={testId}
      onClick={onPress}
    >
      <span className="sidebar-leading-action-row__icon" aria-hidden="true">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

export function SidebarItemRow({
  label,
  selectionLabel,
  selectionDescription,
  selected = false,
  className,
  provider,
  trailingReveal = 'interaction',
  leading,
  badges,
  actions,
  selectRef,
  tabIndex,
  ariaCurrent,
  onSelect,
  onKeyDown,
  reorder,
}: SidebarItemRowProps): JSX.Element {
  const rowRef = useRef<HTMLDivElement>(null);
  const trailingRef = useRef<HTMLSpanElement>(null);
  const syncTrailingWidth = useCallback((element: HTMLSpanElement | null) => {
    if (!element) {
      rowRef.current?.style.setProperty('--sidebar-item-row-trailing-width', '0px');
      rowRef.current?.style.setProperty('--sidebar-item-row-persistent-width', '0px');
      return;
    }
    const row = rowRef.current ?? element.closest<HTMLElement>('.sidebar-item-row');
    const persistent = row?.classList.contains('sidebar-item-row--persistent-pin') === true;
    const restingWidth = Math.ceil(element.getBoundingClientRect().width);
    const overflowWidth = persistent
      ? Math.ceil(element.querySelector<HTMLElement>('.sidebar-item-row__overflow')?.getBoundingClientRect().width ?? 0)
      : 0;
    row?.style.setProperty(
      '--sidebar-item-row-trailing-width',
      `${restingWidth + (overflowWidth > 0 ? overflowWidth + 2 : 0)}px`,
    );
    row?.style.setProperty('--sidebar-item-row-persistent-width', `${restingWidth}px`);
  }, []);

  useLayoutEffect(() => {
    syncTrailingWidth(trailingRef.current);
  }, [actions, provider, syncTrailingWidth, trailingReveal]);

  return (
    <div
      ref={rowRef}
      {...reorder?.root}
      className={`sidebar-item-row contextual-action-owner${selected ? ' sidebar-item-row--selected' : ''}${provider?.mark ? ' sidebar-item-row--has-provider-mark' : ''}${trailingReveal === 'persistent-pin' ? ' sidebar-item-row--persistent-pin' : ''}${reorder ? ' sidebar-reorder-item' : ''}${reorder?.dragging ? ' sidebar-reorder-item--dragging' : ''}${reorder?.dropTarget ? ' sidebar-reorder-item--drop-target' : ''}${className ? ` ${className}` : ''}`}
    >
      <button
        ref={selectRef}
        type="button"
        className="sidebar-list-item sidebar-item-row__select"
        aria-label={selectionLabel}
        aria-description={selectionDescription ?? (provider ? `Provider: ${provider.label}` : undefined)}
        aria-current={ariaCurrent}
        tabIndex={tabIndex}
        title={label}
        onClick={onSelect}
        aria-describedby={reorder?.control['aria-describedby']}
        aria-keyshortcuts={reorder?.control['aria-keyshortcuts']}
        onKeyDown={(event) => {
          reorder?.control.onKeyDown(event);
          if (!event.defaultPrevented) onKeyDown?.(event);
        }}
      >
        <span className="sidebar-item-row__content">
          {leading ? <span className="sidebar-item-row__leading">{leading}</span> : null}
          <span className="sidebar-item-row__label">{label}</span>
          {badges ? <span className="sidebar-item-row__badges">{badges}</span> : null}
        </span>
      </button>
      {provider?.mark || actions || reorder?.handleOnly ? (
        <span
          ref={(element) => {
            trailingRef.current = element;
            syncTrailingWidth(element);
          }}
          className="sidebar-item-row__trailing contextual-action-scope"
        >
          {reorder?.handleOnly ? (
            <span className="sidebar-item-row__reorder contextual-action-group">
              <SidebarReorderHandle binding={reorder} />
            </span>
          ) : null}
          {actions ? <span className={`sidebar-item-row__actions contextual-action-group${trailingReveal === 'persistent-pin' ? ' contextual-action-group--persistent' : ''}`}>{actions}</span> : null}
          {provider?.mark ? (
            <span className="sidebar-item-row__provider">
              <OfficialProviderMark
                kind={provider.mark}
                className="sidebar-item-row__provider-mark"
                accessibleLabel={`Provider: ${provider.label}`}
              />
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

export function SidebarItemBadge({
  children,
  className,
  title,
  ariaLabel,
}: {
  children: ComponentChildren;
  className?: string;
  title?: string;
  ariaLabel?: string;
}): JSX.Element {
  return (
    <span
      className={`sidebar-item-row__badge${className ? ` ${className}` : ''}`}
      title={title}
      aria-label={ariaLabel}
    >
      {children}
    </span>
  );
}

export type SidebarItemProvider = {
  label: string;
  mark: OfficialProviderMarkKind | null;
};

export function SidebarItemPinAction({
  label,
  pressed,
  disabled = false,
  actionRef,
  onPress,
}: {
  label: string;
  pressed: boolean;
  disabled?: boolean;
  actionRef?: (element: HTMLButtonElement | null) => void;
  onPress(): void;
}): JSX.Element {
  const actionLabel = `${pressed ? 'Unpin' : 'Pin'} ${label}`;
  return (
    <ContextualAction
      ref={actionRef}
      className={`sidebar-item-row__action sidebar-item-row__pin${pressed ? ' sidebar-item-row__pin--active' : ''}`}
      aria-label={actionLabel}
      aria-pressed={pressed}
      title={actionLabel}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onPress();
      }}
    >
      <Icon name={pressed ? 'unpin' : 'pin'} size={14} />
    </ContextualAction>
  );
}

export type SidebarItemOverflowAction = {
  id: string;
  label: string;
  ariaLabel?: string;
  disabled?: boolean;
  onSelect(): void;
};

export function SidebarItemOverflowMenu({
  label,
  actions,
}: {
  label: string;
  actions: readonly SidebarItemOverflowAction[];
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLSpanElement>(null);
  const menuStyle = useAnchoredMenu({
    open,
    anchorRef: triggerRef,
    menuRef,
    onDismiss: () => setOpen(false),
  });
  if (actions.length === 0) return null;

  return (
    <span
      className={`sidebar-item-row__overflow${open ? ' sidebar-item-row__overflow--open' : ''}`}
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.stopPropagation();
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
    >
      <ContextualAction
        ref={triggerRef}
        className="sidebar-item-row__action sidebar-item-row__overflow-trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        <Icon name="sidebarMore" size={15} />
      </ContextualAction>
      {open ? (
        <span
          ref={menuRef}
          className="sidebar-item-row__menu app-anchored-menu"
          role="menu"
          popover="manual"
          aria-label={label}
          style={menuStyle}
        >
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              aria-label={action.ariaLabel}
              disabled={action.disabled}
              onClick={() => {
                setOpen(false);
                action.onSelect();
              }}
            >
              {action.label}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}
