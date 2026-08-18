import type { ComponentChildren, JSX } from 'preact';
import { useRef, useState } from 'preact/hooks';

export type SidebarItemRowProps = {
  label: string;
  selectionLabel: string;
  selectionDescription?: string;
  selected?: boolean;
  className?: string;
  leading?: ComponentChildren;
  badges?: ComponentChildren;
  actions?: ComponentChildren;
  selectRef?: (element: HTMLButtonElement | null) => void;
  tabIndex?: number;
  ariaCurrent?: 'true';
  onSelect(): void;
  onKeyDown?: JSX.KeyboardEventHandler<HTMLButtonElement>;
};

export function SidebarItemRow({
  label,
  selectionLabel,
  selectionDescription,
  selected = false,
  className,
  leading,
  badges,
  actions,
  selectRef,
  tabIndex,
  ariaCurrent,
  onSelect,
  onKeyDown,
}: SidebarItemRowProps): JSX.Element {
  return (
    <div className={`sidebar-item-row${selected ? ' sidebar-item-row--selected' : ''}${className ? ` ${className}` : ''}`}>
      <button
        ref={selectRef}
        type="button"
        className="sidebar-list-item sidebar-item-row__select"
        aria-label={selectionLabel}
        aria-description={selectionDescription}
        aria-current={ariaCurrent}
        tabIndex={tabIndex}
        title={label}
        onClick={onSelect}
        onKeyDown={onKeyDown}
      >
        {leading ? <span className="sidebar-item-row__leading">{leading}</span> : null}
        <span className="sidebar-item-row__label">{label}</span>
        {badges ? <span className="sidebar-item-row__badges">{badges}</span> : null}
      </button>
      {actions ? <span className="sidebar-item-row__actions">{actions}</span> : null}
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

export type SidebarItemProviderTone = 'claude' | 'codex' | 'gemini';

export function SidebarItemProviderDot({
  label,
  tone,
}: {
  label: string;
  tone: SidebarItemProviderTone;
}): JSX.Element {
  const accessibleLabel = `Provider: ${label}`;
  return (
    <span
      className={`sidebar-item-row__provider-dot sidebar-item-row__provider-dot--${tone}`}
      role="img"
      aria-label={accessibleLabel}
      title={accessibleLabel}
    />
  );
}

function PinIcon(): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 17v5" />
      <path d="M5 17h14" />
      <path d="M7 17l2-8-2-3V3h10v3l-2 3 2 8" />
    </svg>
  );
}

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
    <button
      ref={actionRef}
      type="button"
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
      <PinIcon />
    </button>
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
  if (actions.length === 0) return null;

  return (
    <span
      className="sidebar-item-row__overflow"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="sidebar-item-row__action sidebar-item-row__overflow-trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
        >
          <circle cx="5" cy="12" r="1.75" />
          <circle cx="12" cy="12" r="1.75" />
          <circle cx="19" cy="12" r="1.75" />
        </svg>
      </button>
      {open ? (
        <span className="sidebar-item-row__menu" role="menu" aria-label={label}>
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              aria-label={action.ariaLabel}
              disabled={action.disabled}
              onClick={(event) => {
                event.stopPropagation();
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
