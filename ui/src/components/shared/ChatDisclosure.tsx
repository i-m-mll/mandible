import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { DisclosureChevronIcon } from './DisclosureChevronIcon';

export type CompactActivityDisclosure = {
  content: ComponentChildren;
  regionLabel: string;
  expanded?: boolean;
  defaultExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
};

export type CompactActivityRowProps = {
  icon: JSX.Element;
  summary: string;
  disclosure?: CompactActivityDisclosure;
  className?: string;
};

/** The sole compact row geometry for tool and provider activity. */
export function CompactActivityRow({
  icon,
  summary,
  disclosure,
  className = '',
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
  const rowContent = (
    <>
      <span className="compact-activity__icon" aria-hidden="true">{icon}</span>
      <span className="compact-activity__summary" title={summary}>{summary}</span>
      {disclosure ? (
        <span className="compact-activity__chevron" aria-hidden="true">
          <DisclosureChevronIcon expanded={isExpanded} />
        </span>
      ) : null}
    </>
  );

  if (!disclosure) {
    return <div className={rootClass}><div className="compact-activity__row compact-activity__row--inert">{rowContent}</div></div>;
  }

  const toggle = (): void => {
    const next = !isExpanded;
    if (disclosure.expanded === undefined) setLocalExpanded(next);
    disclosure.onExpandedChange?.(next);
  };

  return (
    <div className={rootClass}>
      <button
        ref={buttonRef}
        type="button"
        className="compact-activity__row"
        aria-expanded={isExpanded}
        aria-controls={bodyId}
        onClick={toggle}
      >
        {rowContent}
      </button>
      {isExpanded ? (
        <div ref={bodyRef} id={bodyId} role="region" aria-label={disclosure.regionLabel} className="compact-activity__details">
          {disclosure.content}
        </div>
      ) : null}
    </div>
  );
}
