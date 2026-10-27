import { Icon } from '../icons/Icon';
import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { useAnchoredMenu } from '../../hooks/useAnchoredMenu';

export type SidebarSearchFilterHeaderPanel = {
  id?: string;
  variant?: 'popover' | 'inline';
  role?: 'dialog' | 'menu';
  ariaLabel?: string;
  onDismiss?: () => void;
  children: ComponentChildren;
};

export type SidebarSearchFilterHeaderFilterTrigger = {
  ariaLabel: string;
  title?: string;
  kind?: 'filter' | 'menu';
  open: boolean;
  active?: boolean;
  count?: number;
  onToggle: () => void;
};

export type SidebarSearchFilterHeaderProps = {
  value: string;
  onValueChange: (value: string) => void;
  placeholder: string;
  searchAriaLabel: string;
  clearAriaLabel: string;
  inputType?: 'text' | 'search';
  searchSlot?: ComponentChildren;
  leadingAction?: ComponentChildren;
  actionSlot?: ComponentChildren;
  filterTrigger?: SidebarSearchFilterHeaderFilterTrigger;
  summarySlot?: ComponentChildren;
  panel?: SidebarSearchFilterHeaderPanel;
  onBlurWithin?: JSX.FocusEventHandler<HTMLDivElement>;
  className?: string;
  testId?: string;
  inputTestId?: string;
  captureFindShortcut?: boolean;
};

export function SidebarSearchFilterHeader(props: SidebarSearchFilterHeaderProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const filterTriggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const dismissRef = useRef(props.panel?.onDismiss);
  dismissRef.current = props.panel?.onDismiss;
  const rootClass = props.className
    ? `sidebar-search-filter ${props.className}`
    : 'sidebar-search-filter';
  const panelVariant = props.panel?.variant ?? 'popover';
  const popoverOpen = props.panel !== undefined && panelVariant === 'popover';
  const panelStyle = useAnchoredMenu({
    open: popoverOpen,
    anchorRef: rootRef,
    menuRef: panelRef,
    focusRef: filterTriggerRef,
    onDismiss: () => dismissRef.current?.(),
    placement: 'bottom-start',
    gap: -2,
    anchorInset: 12,
    matchAnchorWidth: true,
  });

  useEffect(() => {
    if (props.captureFindShortcut === false) return undefined;
    const focusViewSearch = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented
        || event.isComposing
        || event.altKey
        || event.shiftKey
        || (!event.metaKey && !event.ctrlKey)
        || event.key.toLowerCase() !== 'f'
      ) {
        return;
      }
      const input = inputRef.current
        ?? rootRef.current?.querySelector<HTMLInputElement>('input')
        ?? null;
      if (!input || input.disabled || isInsideInactivePanel(input)) return;
      const target = event.target;
      if (target instanceof HTMLElement && target !== input && isEditableTarget(target)) return;
      event.preventDefault();
      input.focus();
      input.select();
    };
    window.addEventListener('keydown', focusViewSearch);
    return () => window.removeEventListener('keydown', focusViewSearch);
  }, [props.captureFindShortcut]);

  return (
    <div ref={rootRef} className={rootClass} onFocusOut={props.onBlurWithin} data-testid={props.testId}>
      <div className="sidebar-search-filter__row">
        {props.leadingAction !== undefined ? (
          <div className="sidebar-search-filter__leading">{props.leadingAction}</div>
        ) : null}
        <div className="sidebar-search-filter__search">
          {props.searchSlot !== undefined ? props.searchSlot : <input
            ref={inputRef}
            type={props.inputType ?? 'search'}
            className="sidebar-search-filter__input"
            placeholder={props.placeholder}
            aria-label={props.searchAriaLabel}
            value={props.value}
            data-testid={props.inputTestId}
            onInput={(event) => props.onValueChange(event.currentTarget.value)}
          />}
          {props.searchSlot === undefined && props.value ? (
            <button
              type="button"
              className="sidebar-search-filter__clear"
              aria-label={props.clearAriaLabel}
              title={props.clearAriaLabel}
              onClick={() => props.onValueChange('')}
            >
              <Icon name="clearSearch" />
            </button>
          ) : null}
        </div>
        {props.filterTrigger !== undefined ? (
          <button
            ref={filterTriggerRef}
            type="button"
            className={`sidebar-search-filter__trigger${
              props.filterTrigger.open || props.filterTrigger.active ? ' sidebar-search-filter__trigger--active' : ''
            }`}
            aria-label={props.filterTrigger.ariaLabel}
            title={props.filterTrigger.title ?? props.filterTrigger.ariaLabel}
            aria-expanded={props.filterTrigger.open}
            aria-haspopup={props.filterTrigger.kind === 'menu' ? 'menu' : undefined}
            aria-controls={props.panel?.id}
            onClick={props.filterTrigger.onToggle}
          >
            {props.filterTrigger.kind === 'menu' ? <Icon name="sidebarMenu" /> : <Icon name="filter" />}
            {props.filterTrigger.count !== undefined && props.filterTrigger.count > 0 ? (
              <span className="sidebar-search-filter__badge">{props.filterTrigger.count}</span>
            ) : null}
          </button>
        ) : null}
        {props.actionSlot !== undefined ? (
          <div className="sidebar-search-filter__action">{props.actionSlot}</div>
        ) : null}
      </div>
      {props.summarySlot !== undefined ? (
        <div className="sidebar-search-filter__summary">{props.summarySlot}</div>
      ) : null}
      {props.panel !== undefined ? (
        <div
          ref={panelRef}
          id={props.panel.id}
          role={props.panel.role ?? 'dialog'}
          popover="manual"
          aria-label={props.panel.ariaLabel ?? props.filterTrigger?.ariaLabel}
          className={`sidebar-search-filter__panel sidebar-search-filter__panel--${panelVariant}${panelVariant === 'popover' ? ' app-anchored-menu' : ''}`}
          style={panelVariant === 'popover' ? panelStyle : undefined}
        >
          {props.panel.children}
        </div>
      ) : null}
    </div>
  );
}

function isInsideInactivePanel(input: HTMLInputElement): boolean {
  return input.closest('[hidden], [aria-hidden="true"]') !== null;
}

function isEditableTarget(target: HTMLElement): boolean {
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || target.isContentEditable;
}
