import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { OverflowFade } from '../shared/OverflowFade';

export function ToolCallGroup({ summary, expanded, onExpandedChange, children }: {
  summary: string;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  children: ComponentChildren;
}): JSX.Element {
  const [localExpanded, setLocalExpanded] = useState(false);
  const isExpanded = expanded ?? localExpanded;
  const toggle = (): void => {
    const next = !isExpanded;
    if (expanded === undefined) setLocalExpanded(next);
    onExpandedChange?.(next);
  };

  return (
    <section className={`tool-call-group${isExpanded ? ' tool-call-group--expanded' : ''}`}>
      <button type="button" className="tool-call-group__summary" aria-expanded={isExpanded} onClick={toggle}>
        <span className="tool-call-group__chevron" aria-hidden="true">{isExpanded ? 'v' : '>'}</span>
        <span>{summary}</span>
      </button>
      {isExpanded ? <OverflowFade className="tool-call-group__body" lines={10}>{children}</OverflowFade> : null}
    </section>
  );
}
