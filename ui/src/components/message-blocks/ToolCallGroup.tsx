import { Icon } from '../icons/Icon';
import type { IconName } from '../icons/Icon';
import type { ComponentChildren } from 'preact';
import { CompactActivityRow } from '../shared/ChatDisclosure';

export function ToolCallGroup({ summary, icon, expanded, onExpandedChange, children, className, memberRefs, headerMetadata }: {
  summary: string;
  icon: IconName;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean, trigger?: HTMLElement) => void;
  children: ComponentChildren;
  className?: string;
  memberRefs?: string;
  headerMetadata?: ComponentChildren;
}): JSX.Element {
  return (
    <CompactActivityRow
      className={`tool-call-group${className ? ` ${className}` : ''}`}
      collection
      icon={<Icon name={icon} />}
      summary={summary}
      metadata={headerMetadata}
      memberRefs={memberRefs}
      disclosure={{
        content: <div className="tool-call-group__body activity-nested-headers">{children}</div>,
        regionLabel: `${summary} details`,
        expanded,
        onExpandedChange,
      }}
    />
  );
}
