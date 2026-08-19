import type { ComponentChildren } from 'preact';

type SidebarGroupNodeCommonProps = {
  id: string;
  label: string;
  headingDescription?: string;
  expanded: boolean;
  onToggle(): void;
  children: ComponentChildren;
  bodyAs?: 'div' | 'ul';
  className?: string;
  bodyClassName?: string;
  canShowMore?: boolean;
  loadingMore?: boolean;
  onShowMore?(): void;
  action?: {
    label: string;
    icon: 'new-chat' | 'add-project';
    onPress(): void;
  };
};

export type SidebarGroupNodeProps = SidebarGroupNodeCommonProps & (
  | {
    presentation: 'category';
    leadingIcon?: never;
    count?: never;
    countLabel?: never;
    countVisibility?: never;
  }
  | {
    presentation: 'folder';
    leadingIcon: ComponentChildren;
    count?: number;
    countLabel?: string;
    countVisibility?: 'always' | 'interaction';
  }
);

export function SidebarGroupNode({
  id,
  label,
  headingDescription,
  count,
  countLabel,
  countVisibility = 'always',
  presentation,
  expanded,
  onToggle,
  leadingIcon,
  children,
  bodyAs = 'div',
  className = '',
  bodyClassName = '',
  canShowMore = false,
  loadingMore = false,
  onShowMore,
  action,
}: SidebarGroupNodeProps): JSX.Element {
  const headingId = `${id}-heading`;
  const bodyId = `${id}-body`;
  const showMore = canShowMore && onShowMore ? (
    <button
      type="button"
      className="sidebar-group-node__show-more"
      onClick={onShowMore}
      disabled={loadingMore}
    >
      Show more
    </button>
  ) : null;
  const body = bodyAs === 'ul' ? (
    <ul id={bodyId} className={bodyClassName}>
      {children}
      {showMore ? <li className="sidebar-group-node__show-more-row">{showMore}</li> : null}
    </ul>
  ) : (
    <div id={bodyId} className={bodyClassName}>
      {children}
      {showMore ? <div className="sidebar-group-node__show-more-row">{showMore}</div> : null}
    </div>
  );

  return (
    <section
      className={`sidebar-group-node sidebar-group-node--${presentation}${leadingIcon ? ' sidebar-group-node--with-icon' : ''}${count === undefined ? ' sidebar-group-node--without-count' : ''}${countVisibility === 'interaction' ? ' sidebar-group-node--interaction-count' : ''}${className ? ` ${className}` : ''}`}
      aria-labelledby={headingId}
    >
      <div className="sidebar-group-node__header">
        <button
          id={headingId}
          type="button"
          className="sidebar-group-node__heading"
          aria-expanded={expanded}
          aria-controls={bodyId}
          aria-description={headingDescription}
          onClick={onToggle}
        >
          {leadingIcon ? <span className="sidebar-group-node__leading" aria-hidden="true">{leadingIcon}</span> : null}
          <strong>{label}</strong>
          {count === undefined ? null : <em className="sidebar-group-node__count" aria-label={countLabel}>{count}</em>}
        </button>
        {action ? (
          <button
            type="button"
            className="sidebar-group-node__action"
            aria-label={action.label}
            title={action.label}
            onClick={action.onPress}
          >
            {action.icon === 'new-chat' ? <SidebarNewChatIcon /> : <SidebarAddProjectIcon />}
          </button>
        ) : null}
      </div>
      {expanded ? body : null}
    </section>
  );
}

export function SidebarNewChatIcon({ size = 14 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-sidebar-action-icon="new-chat"
    >
      <path d="M5 4h10a2 2 0 0 1 2 2v3" />
      <path d="M5 4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8" />
      <path d="M17 13v8M13 17h8" />
    </svg>
  );
}

function SidebarAddProjectIcon(): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
      data-sidebar-action-icon="add-project"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
