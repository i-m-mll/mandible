import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

export type SidebarSearchFilterHeaderPanel = {
  id?: string;
  variant?: 'popover' | 'inline';
  ariaLabel?: string;
  onDismiss?: () => void;
  children: ComponentChildren;
};

export type SidebarSearchFilterHeaderFilterTrigger = {
  ariaLabel: string;
  title?: string;
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
  const rootClass = props.className
    ? `sidebar-search-filter ${props.className}`
    : 'sidebar-search-filter';
  const panelVariant = props.panel?.variant ?? 'popover';

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
      const input = inputRef.current;
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

  useEffect(() => {
    if (!props.panel?.onDismiss) return undefined;
    const dismiss = props.panel.onDismiss;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      dismiss();
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target && !rootRef.current?.contains(event.target as Node)) dismiss();
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('pointerdown', handlePointerDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [props.panel?.onDismiss]);

  return (
    <div ref={rootRef} className={rootClass} onFocusOut={props.onBlurWithin} data-testid={props.testId}>
      <div className="sidebar-search-filter__row">
        {props.leadingAction !== undefined ? (
          <div className="sidebar-search-filter__leading">{props.leadingAction}</div>
        ) : null}
        <div className="sidebar-search-filter__search">
          <input
            ref={inputRef}
            type={props.inputType ?? 'search'}
            className="sidebar-search-filter__input"
            placeholder={props.placeholder}
            aria-label={props.searchAriaLabel}
            value={props.value}
            data-testid={props.inputTestId}
            onInput={(event) => props.onValueChange(event.currentTarget.value)}
          />
          {props.value ? (
            <button
              type="button"
              className="sidebar-search-filter__clear"
              aria-label={props.clearAriaLabel}
              title={props.clearAriaLabel}
              onClick={() => props.onValueChange('')}
            >
              <ClearSearchIcon />
            </button>
          ) : null}
        </div>
        {props.filterTrigger !== undefined ? (
          <button
            type="button"
            className={`sidebar-search-filter__trigger${
              props.filterTrigger.open || props.filterTrigger.active ? ' sidebar-search-filter__trigger--active' : ''
            }`}
            aria-label={props.filterTrigger.ariaLabel}
            title={props.filterTrigger.title ?? props.filterTrigger.ariaLabel}
            aria-expanded={props.filterTrigger.open}
            aria-controls={props.panel?.id}
            onClick={props.filterTrigger.onToggle}
          >
            <FilterTriggerIcon />
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
          id={props.panel.id}
          role="dialog"
          aria-label={props.panel.ariaLabel ?? props.filterTrigger?.ariaLabel}
          className={`sidebar-search-filter__panel sidebar-search-filter__panel--${panelVariant}`}
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

function ClearSearchIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d="M3 3l6 6M9 3L3 9" />
    </svg>
  );
}

function FilterTriggerIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 6h16M7 12h10M10 18h4" />
    </svg>
  );
}
