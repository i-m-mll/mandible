import type { ComponentChildren } from 'preact';
import { useId, useState } from 'preact/hooks';
import { OverflowFade } from '../shared/OverflowFade';
import { DisclosureChevronIcon } from '../shared/DisclosureChevronIcon';

export function ToolCallGroup({ summary, expanded, onExpandedChange, children }: {
  summary: string;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  children: ComponentChildren;
}): JSX.Element {
  const [localExpanded, setLocalExpanded] = useState(false);
  const bodyId = useId();
  const isExpanded = expanded ?? localExpanded;
  const toggle = (): void => {
    const next = !isExpanded;
    if (expanded === undefined) setLocalExpanded(next);
    onExpandedChange?.(next);
  };

  return (
    <section className={`tool-call-group${isExpanded ? ' tool-call-group--expanded' : ''}`}>
      <button type="button" className="tool-call-group__summary" aria-expanded={isExpanded} aria-controls={bodyId} onClick={toggle}>
        <span className="tool-call-group__summary-text">{summary}</span>
        <span className="tool-call-group__chevron"><DisclosureChevronIcon expanded={isExpanded} /></span>
      </button>
      {isExpanded ? (
        <div id={bodyId} role="region" aria-label={`${summary} details`}>
          <OverflowFade className="tool-call-group__body" lines={10}>{children}</OverflowFade>
        </div>
      ) : null}
    </section>
  );
}
