import type { ComponentChildren } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { DisclosureChevronIcon } from './DisclosureChevronIcon';

export type ChatDisclosureProps = {
  summary: ComponentChildren;
  children: ComponentChildren;
  regionLabel: string;
  expanded?: boolean;
  defaultExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  leading?: ComponentChildren;
  trailing?: ComponentChildren;
  className?: string;
};

/** Shared accessible disclosure for compact rows in Chat and History. */
export function ChatDisclosure({
  summary,
  children,
  regionLabel,
  expanded,
  defaultExpanded = false,
  onExpandedChange,
  leading,
  trailing,
  className = '',
}: ChatDisclosureProps): JSX.Element {
  const [localExpanded, setLocalExpanded] = useState(defaultExpanded);
  const isExpanded = expanded ?? localExpanded;
  const bodyId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const previousExpanded = useRef(isExpanded);

  useEffect(() => {
    if (previousExpanded.current && !isExpanded && bodyRef.current?.contains(document.activeElement)) {
      buttonRef.current?.focus();
    }
    previousExpanded.current = isExpanded;
  }, [isExpanded]);

  const toggle = (): void => {
    const next = !isExpanded;
    if (expanded === undefined) setLocalExpanded(next);
    onExpandedChange?.(next);
  };

  return (
    <section className={`chat-disclosure${isExpanded ? ' chat-disclosure--expanded' : ''}${className ? ` ${className}` : ''}`}>
      <button
        ref={buttonRef}
        type="button"
        className="chat-disclosure__summary"
        aria-expanded={isExpanded}
        aria-controls={bodyId}
        onClick={toggle}
      >
        <span className="chat-disclosure__chevron"><DisclosureChevronIcon expanded={isExpanded} /></span>
        {leading ? <span className="chat-disclosure__leading" aria-hidden="true">{leading}</span> : null}
        <span className="chat-disclosure__summary-text">{summary}</span>
        {trailing ? <span className="chat-disclosure__trailing">{trailing}</span> : null}
      </button>
      {isExpanded ? (
        <div ref={bodyRef} id={bodyId} role="region" aria-label={regionLabel} className="chat-disclosure__body">
          {children}
        </div>
      ) : null}
    </section>
  );
}
