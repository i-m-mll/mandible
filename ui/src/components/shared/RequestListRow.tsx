import type { ComponentChildren } from 'preact';

type RequestListRowProps = {
  leading: ComponentChildren;
  title: ComponentChildren;
  metadata: ComponentChildren;
  selected: boolean;
  selection: 'current' | 'toggle';
  onSelect(): void;
  label?: string;
  requestId?: string;
  actions?: ComponentChildren;
};

export function RequestListRow({ leading, title, metadata, selected, selection,
  onSelect, label, requestId, actions }: RequestListRowProps): JSX.Element {
  const row = (
    <button
      type="button"
      className={`auth-sidebar-item${selected ? ' auth-sidebar-item--selected' : ''}`}
      aria-current={selection === 'current' && selected ? 'true' : undefined}
      aria-pressed={selection === 'toggle' ? selected : undefined}
      aria-label={label}
      data-request-id={requestId}
      onClick={onSelect}
    >
      {leading}
      <span className="auth-sidebar-item__body">
        <span className="auth-sidebar-item__title-row">
          <span className="auth-sidebar-item__title">{title}</span>
        </span>
        <span className="auth-sidebar-item__metadata">{metadata}</span>
      </span>
    </button>
  );
  return actions ? (
    <div className={`request-list-row${selected ? ' request-list-row--selected' : ''}`}>
      {row}
      <div className="request-list-row__actions">{actions}</div>
    </div>
  ) : row;
}
