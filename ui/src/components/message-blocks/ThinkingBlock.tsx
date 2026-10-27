import { Icon } from '../icons/Icon';
import { CompactActivityRow } from '../shared/ChatDisclosure';
import { plainActivityHeader } from './activityText';

export type ThinkingBlockProps = {
  content: string;
  defaultCollapsed?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  memberRefs?: string;
  detailsAvailable?: boolean;
};

export function ThinkingBlock({
  content,
  defaultCollapsed = true,
  expanded,
  onExpandedChange,
  memberRefs,
  detailsAvailable = false,
}: ThinkingBlockProps): JSX.Element {
  const parts = content.split('\n').map((line) => plainActivityHeader(line).trim()).filter(Boolean);
  const summary = parts[0] ?? 'Thought';
  const remaining = parts.slice(1);
  return (
    <CompactActivityRow
      className="thinking-block"
      icon={<Icon name="thought" />}
      summary={summary}
      memberRefs={memberRefs}
      disclosure={remaining.length > 0 || detailsAvailable ? {
        content: <div className="thinking-block__body"><pre>{remaining.join('\n')}</pre></div>,
        regionLabel: `${summary} details`,
        defaultExpanded: !defaultCollapsed,
        expanded,
        onExpandedChange,
      } : undefined}
    />
  );
}
