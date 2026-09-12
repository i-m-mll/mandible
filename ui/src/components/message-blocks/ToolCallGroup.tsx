import type { ComponentChildren } from 'preact';
import { ChatDisclosure } from '../shared/ChatDisclosure';
import { ToolActivityIcon } from './ToolActivityIcon';

export function ToolCallGroup({ summary, icons, expanded, onExpandedChange, children }: {
  summary: string;
  icons: readonly string[];
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  children: ComponentChildren;
}): JSX.Element {
  return (
    <ChatDisclosure
      className="tool-call-group"
      summary={summary}
      regionLabel={`${summary} details`}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      leading={(
        <span className="tool-call-group__icons">
          {icons.map((icon) => <ToolActivityIcon key={icon} icon={icon} className="tool-call-group__icon" />)}
        </span>
      )}
    >
      <div className="tool-call-group__body">{children}</div>
    </ChatDisclosure>
  );
}
