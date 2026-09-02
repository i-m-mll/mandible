import type { ComponentChildren, JSX } from 'preact';
import { useId } from 'preact/hooks';
import { DisclosureChevronIcon } from './DisclosureChevronIcon';

export type CollapsiblePanelProps = {
  title: ComponentChildren;
  expanded: boolean;
  onExpandedChange(expanded: boolean): void;
  actions?: ComponentChildren;
  persistentContent?: ComponentChildren;
  children: ComponentChildren;
  className?: string;
  headerClassName?: string;
  toggleClassName?: string;
  bodyClassName?: string;
};

/**
 * Shared bordered disclosure panel for secondary detail content. The title and
 * canonical sidebar chevron stay together, and collapsed panels retain equal
 * padding above and below their header.
 */
export function CollapsiblePanel({
  title,
  expanded,
  onExpandedChange,
  actions,
  persistentContent,
  children,
  className = '',
  headerClassName = '',
  toggleClassName = '',
  bodyClassName = '',
}: CollapsiblePanelProps): JSX.Element {
  const bodyId = useId();
  const titleId = useId();

  return (
    <section
      className={`collapsible-panel${expanded ? ' collapsible-panel--expanded' : ''}${className ? ` ${className}` : ''}`}
      aria-labelledby={titleId}
    >
      <div className={`collapsible-panel__header${headerClassName ? ` ${headerClassName}` : ''}`}>
        <button
          type="button"
          className={`collapsible-panel__toggle${toggleClassName ? ` ${toggleClassName}` : ''}`}
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => onExpandedChange(!expanded)}
        >
          <span id={titleId}>{title}</span>
          <DisclosureChevronIcon expanded={expanded} size={13} />
        </button>
        {actions ? <div className="collapsible-panel__actions">{actions}</div> : null}
      </div>
      {persistentContent}
      {expanded ? (
        <div id={bodyId} className={`collapsible-panel__body${bodyClassName ? ` ${bodyClassName}` : ''}`}>
          {children}
        </div>
      ) : null}
    </section>
  );
}
