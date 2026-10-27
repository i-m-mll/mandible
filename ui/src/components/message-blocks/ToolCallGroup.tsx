import { Icon } from '../icons/Icon';
import type { IconName } from '../icons/Icon';
import type { ComponentChildren } from 'preact';
import { CompactActivityRow } from '../shared/ChatDisclosure';

export function ToolCallGroup({ summary, icon, expanded, onExpandedChange, children, className, memberRefs }: {
  summary: string;
  icon: IconName;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  children: ComponentChildren;
  className?: string;
  memberRefs?: string;
}): JSX.Element {
  return (
    <CompactActivityRow
      className={`tool-call-group${className ? ` ${className}` : ''}`}
      icon={<Icon name={icon} />}
      summary={summary}
      memberRefs={memberRefs}
      disclosure={{
        content: <div className="tool-call-group__body">{children}</div>,
        regionLabel: `${summary} details`,
        expanded,
        onExpandedChange,
      }}
    />
  );
}
