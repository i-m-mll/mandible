import type { ComponentChildren, JSX } from 'preact';
import { ContextualAction } from './ContextualAction';
import { DisclosureChevronIcon } from './DisclosureChevronIcon';
import { SidebarDisclosureRegion } from './SidebarDisclosureRegion';
import { SidebarReorderHandle } from './SidebarReorderHandle';
import type { SidebarReorderBinding } from './sidebar-order';

type SidebarGroupNodeCommonProps = {
  id: string;
  label: string;
  headingDescription?: string;
  expanded: boolean;
  onToggle(): void;
  selection?: {
    selected: boolean;
    label: string;
    onSelect(): void;
  };
  children: ComponentChildren;
  bodyAs?: 'div' | 'ul';
  className?: string;
  bodyClassName?: string;
  bodyAttributes?: { 'data-sidebar-reorder-list': string };
  showDisclosure?: boolean;
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
    /** Keep the action visible while this group is expanded. */
    persistentWhenExpanded?: boolean;
  };
  reorder?: SidebarReorderBinding;
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
    presentation: 'nested';
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
  selection,
  leadingIcon,
  children,
  bodyAs = 'div',
  className = '',
  bodyClassName = '',
  bodyAttributes,
  showDisclosure = true,
  canShowMore = false,
  loadingMore = false,
  onShowMore,
  testIds,
  action,
  reorder,
}: SidebarGroupNodeProps): JSX.Element {
  const headingId = `${id}-heading`;
  const disclosureId = `${id}-disclosure`;
  const bodyId = `${id}-body`;
  const controllerId = selection && showDisclosure ? disclosureId : headingId;
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
  const toggleFromHeader = (event: JSX.TargetedMouseEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    if (target.closest('button, a, input, select, textarea, [role="button"]')) return;
    onToggle();
  };
  const activateHeading = () => {
    selection?.onSelect();
    onToggle();
  };

  return (
    <section
      className={`sidebar-group-node sidebar-group-node--${presentation}${expanded ? ' sidebar-group-node--expanded' : ''}${selection ? ' sidebar-group-node--selectable' : ''}${leadingIcon ? ' sidebar-group-node--with-icon' : ''}${count === undefined ? ' sidebar-group-node--without-count' : ''}${countVisibility === 'interaction' ? ' sidebar-group-node--interaction-count' : ''}${reorder ? ' sidebar-reorder-item' : ''}${reorder?.dragging ? ' sidebar-reorder-item--dragging' : ''}${reorder?.dropTarget ? ' sidebar-reorder-item--drop-target' : ''}${className ? ` ${className}` : ''}`}
      aria-labelledby={headingId}
      data-testid={testIds?.root}
    >
      <div
        className={`sidebar-group-node__header contextual-action-owner${selection?.selected ? ' sidebar-group-node__header--selected' : ''}`}
        {...reorder?.root}
        onClick={toggleFromHeader}
      >
        <button
          id={headingId}
          type="button"
          className="sidebar-group-node__heading"
          aria-expanded={selection ? undefined : expanded}
          aria-controls={selection ? undefined : bodyId}
          aria-current={selection?.selected ? 'page' : undefined}
          aria-label={selection?.label}
          aria-description={headingDescription}
          data-testid={testIds?.heading}
          aria-describedby={reorder?.control['aria-describedby']}
          aria-keyshortcuts={reorder?.control['aria-keyshortcuts']}
          onKeyDown={reorder?.control.onKeyDown}
          onClick={activateHeading}
        >
          {leadingIcon ? <span className="sidebar-group-node__leading" aria-hidden="true">{leadingIcon}</span> : null}
          <strong>{label}</strong>
          {count === undefined ? null : <em className="sidebar-group-node__count" aria-label={countLabel}>{count}</em>}
        </button>
        {showDisclosure ? (
          <button
            id={disclosureId}
            type="button"
            className="sidebar-group-node__disclosure"
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`}
            aria-expanded={expanded}
            aria-controls={bodyId}
            onClick={onToggle}
          >
            <DisclosureChevronIcon expanded={expanded} />
          </button>
        ) : null}
        {reorder?.handleOnly ? (
          <span className="sidebar-group-node__reorder-slot contextual-action-group">
            <SidebarReorderHandle binding={reorder} testId={testIds?.dragHandle} />
          </span>
        ) : null}
        {action ? (
          <span className={`sidebar-group-node__action-slot contextual-action-group${action?.persistentWhenExpanded && expanded ? ' contextual-action-group--persistent' : ''}`}>
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
        controllerId={controllerId}
        expanded={expanded}
        contentAs={bodyAs}
        contentClassName={bodyClassName}
        contentAttributes={bodyAttributes}
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

export function SidebarBriefingBundleIcon({ expanded, size = 14 }: { expanded: boolean; size?: number }): JSX.Element {
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
      data-sidebar-group-icon-state={expanded ? 'layers' : 'briefcase'}
    >
      {expanded ? (
        <>
          <path d="m12 2 9 5-9 5-9-5 9-5Z" />
          <path d="m3 12 9 5 9-5" />
          <path d="m3 17 9 5 9-5" />
        </>
      ) : (
        <>
          <rect x="2" y="7" width="20" height="14" rx="2" />
          <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          <path d="M2 12h20" />
        </>
      )}
    </svg>
  );
}
