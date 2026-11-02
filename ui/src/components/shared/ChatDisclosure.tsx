import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { DisclosureChevronIcon } from './DisclosureChevronIcon';

export type CompactActivityDisclosure = {
  content: ComponentChildren;
  regionLabel: string;
  expanded?: boolean;
  defaultExpanded?: boolean;
  onExpandedChange?: (expanded: boolean, trigger?: HTMLElement) => void;
};

export type CompactActivityRowProps = {
  icon?: JSX.Element;
  summary: string;
  disclosure?: CompactActivityDisclosure;
  className?: string;
  memberRefs?: string;
  actions?: ComponentChildren;
  metadata?: ComponentChildren;
};

/** The sole compact row geometry for tool and provider activity. */
export function CompactActivityRow({
  icon,
  summary,
  disclosure,
  className = '',
  memberRefs,
  actions,
  metadata,
}: CompactActivityRowProps): JSX.Element {
  const [localExpanded, setLocalExpanded] = useState(disclosure?.defaultExpanded ?? false);
  const isExpanded = disclosure?.expanded ?? localExpanded;
  const bodyId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const previousExpanded = useRef(isExpanded);
  const restoreFocusAfterCollapse = previousExpanded.current
    && !isExpanded
    && Boolean(bodyRef.current?.contains(document.activeElement));

  useEffect(() => {
    if (restoreFocusAfterCollapse) {
      buttonRef.current?.focus();
    }
    previousExpanded.current = isExpanded;
  }, [isExpanded, restoreFocusAfterCollapse]);

  const rootClass = `compact-activity${isExpanded ? ' compact-activity--expanded' : ''}${className ? ` ${className}` : ''}`;
  const rowClass = `compact-activity__row${disclosure ? '' : ' compact-activity__row--inert'}${icon ? '' : ' compact-activity__row--no-icon'}`;
  const rowContent = (
    <>
      {icon ? <span className="compact-activity__icon" aria-hidden="true">{icon}</span> : null}
      <span className="compact-activity__summary" title={summary}>{summary}</span>
      {metadata ? <span className="compact-activity__metadata">{metadata}</span> : null}
      {disclosure ? (
        <span className="compact-activity__chevron" aria-hidden="true">
          <DisclosureChevronIcon expanded={isExpanded} />
        </span>
      ) : null}
    </>
  );
  const heading = (row: JSX.Element) => actions
    ? <div className="compact-activity__heading contextual-action-owner">{row}{actions}</div> : row;

  if (!disclosure) {
    return <div className={rootClass}>{heading(<div className={rowClass} data-member-refs={memberRefs}>{rowContent}</div>)}</div>;
  }

  const toggle = (event: MouseEvent): void => {
    const next = !isExpanded;
    if (disclosure.expanded === undefined) setLocalExpanded(next);
    disclosure.onExpandedChange?.(next, event.currentTarget as HTMLElement);
  };

  return (
    <div className={rootClass}>
      {heading(<button
        ref={buttonRef}
        type="button"
        className={rowClass}
        data-member-refs={memberRefs}
        aria-expanded={isExpanded}
        aria-controls={bodyId}
        onClick={toggle}
      >
        {rowContent}
      </button>)}
      {isExpanded ? (
        <div ref={bodyRef} id={bodyId} role="region" aria-label={disclosure.regionLabel} className="compact-activity__details">
          {disclosure.content}
        </div>
      ) : null}
    </div>
  );
}
