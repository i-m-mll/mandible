import type { ComponentChildren } from 'preact';
import { CompactActivityRow } from '../shared/ChatDisclosure';
import { ToolActivityIcon } from './ToolActivityIcon';

export function ToolCallGroup({ summary, icon, expanded, onExpandedChange, children, className }: {
  summary: string;
  icon: string;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  children: ComponentChildren;
  className?: string;
}): JSX.Element {
  return (
    <CompactActivityRow
      className={`tool-call-group${className ? ` ${className}` : ''}`}
      icon={<ToolActivityIcon icon={icon} />}
      summary={summary}
      disclosure={{
        content: <div className="tool-call-group__body">{children}</div>,
        regionLabel: `${summary} details`,
        expanded,
        onExpandedChange,
      }}
    />
  );
}
