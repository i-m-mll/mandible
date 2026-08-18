import type { ComponentChildren } from 'preact';

type SidebarGroupNodeCommonProps = {
  id: string;
  label: string;
  count?: number;
  countLabel?: string;
  countVisibility?: 'always' | 'interaction';
  expanded: boolean;
  onToggle(): void;
  children: ComponentChildren;
  bodyAs?: 'div' | 'ul';
  className?: string;
  bodyClassName?: string;
  canShowMore?: boolean;
  loadingMore?: boolean;
  onShowMore?(): void;
};

export type SidebarGroupNodeProps = SidebarGroupNodeCommonProps & (
  | { presentation: 'category'; leadingIcon?: never }
  | { presentation: 'folder'; leadingIcon: ComponentChildren }
);

export function SidebarGroupNode({
  id,
  label,
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
      <button
        id={headingId}
        type="button"
        className="sidebar-group-node__heading"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={onToggle}
      >
        {leadingIcon ? <span className="sidebar-group-node__leading" aria-hidden="true">{leadingIcon}</span> : null}
        <strong>{label}</strong>
        {count === undefined ? null : <em className="sidebar-group-node__count" aria-label={countLabel}>{count}</em>}
      </button>
      {expanded ? body : null}
    </section>
  );
}
