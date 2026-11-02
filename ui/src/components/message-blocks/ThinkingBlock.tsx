import { Icon } from '../icons/Icon';
import type { ComponentChildren } from 'preact';
import { CompactActivityRow } from '../shared/ChatDisclosure';
import { plainActivityHeader } from './activityText';

export type ThinkingBlockProps = {
  content: string;
  defaultCollapsed?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean, trigger?: HTMLElement) => void;
  memberRefs?: string;
  detailsAvailable?: boolean;
  headerMetadata?: ComponentChildren;
};

export function ThinkingBlock({
  content,
  defaultCollapsed = true,
  expanded,
  onExpandedChange,
  memberRefs,
  detailsAvailable = false,
  headerMetadata,
}: ThinkingBlockProps): JSX.Element {
  const parts = content.split('\n').map((line) => plainActivityHeader(line).trim()).filter(Boolean);
  const summary = parts[0] ?? 'Thought';
  const remaining = parts.slice(1);
  return (
    <CompactActivityRow
      className="thinking-block"
      icon={<Icon name="thought" />}
      summary={summary}
      metadata={headerMetadata}
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
