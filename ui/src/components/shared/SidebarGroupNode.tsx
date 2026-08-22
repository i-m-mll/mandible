import type { ComponentChildren, JSX } from 'preact';
import { ContextualAction } from './ContextualAction';
import { SidebarDisclosureRegion } from './SidebarDisclosureRegion';

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
  testIds?: {
    root?: string;
    heading?: string;
    action?: string;
    dragHandle?: string;
  };
  action?: {
    label: string;
    icon: ComponentChildren;
    onPress(): void;
  };
  drag?: {
    active: boolean;
    onStart(): void;
    onOver(event: JSX.TargetedDragEvent<HTMLDivElement>): void;
    onDrop(event: JSX.TargetedDragEvent<HTMLDivElement>): void;
    onEnd(): void;
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
  testIds,
  action,
  drag,
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
    <>
      {children}
      {showMore ? <li className="sidebar-group-node__show-more-row">{showMore}</li> : null}
    </>
  ) : (
    <>
      {children}
      {showMore ? <div className="sidebar-group-node__show-more-row">{showMore}</div> : null}
    </>
  );

  return (
    <section
      className={`sidebar-group-node sidebar-group-node--${presentation}${leadingIcon ? ' sidebar-group-node--with-icon' : ''}${count === undefined ? ' sidebar-group-node--without-count' : ''}${countVisibility === 'interaction' ? ' sidebar-group-node--interaction-count' : ''}${drag ? ' sidebar-group-node--draggable' : ''}${drag?.active ? ' sidebar-group-node--dragging' : ''}${className ? ` ${className}` : ''}`}
      aria-labelledby={headingId}
      data-testid={testIds?.root}
    >
      <div
        className="sidebar-group-node__header contextual-action-owner"
        draggable={drag ? true : undefined}
        data-testid={testIds?.dragHandle}
        onDragStart={drag?.onStart}
        onDragOver={drag?.onOver}
        onDrop={drag?.onDrop}
        onDragEnd={drag?.onEnd}
      >
        <button
          id={headingId}
          type="button"
          className="sidebar-group-node__heading"
          aria-expanded={expanded}
          aria-controls={bodyId}
          aria-description={headingDescription}
          data-testid={testIds?.heading}
          onClick={onToggle}
        >
          {leadingIcon ? <span className="sidebar-group-node__leading" aria-hidden="true">{leadingIcon}</span> : null}
          <strong>{label}</strong>
          {count === undefined ? null : <em className="sidebar-group-node__count" aria-label={countLabel}>{count}</em>}
        </button>
        {action ? (
          <span className="sidebar-group-node__action-slot contextual-action-group">
            <ContextualAction
              className="sidebar-group-node__action"
              aria-label={action.label}
              title={action.label}
              data-testid={testIds?.action}
              onClick={action.onPress}
            >
              {action.icon}
            </ContextualAction>
          </span>
        ) : null}
      </div>
      <SidebarDisclosureRegion
        id={bodyId}
        controllerId={headingId}
        expanded={expanded}
        contentAs={bodyAs}
        contentClassName={bodyClassName}
      >
        {body}
      </SidebarDisclosureRegion>
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

export function SidebarAddProjectIcon(): JSX.Element {
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

export function SidebarBriefingBundleIcon({ size = 14 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-sidebar-group-icon="briefing-bundle"
    >
      <path d="M7 3.5h10a2 2 0 0 1 2 2v12" />
      <path d="M5 6.5h10a2 2 0 0 1 2 2v11" />
      <rect x="3" y="9.5" width="12" height="11" rx="2" />
    </svg>
  );
}
