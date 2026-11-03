import { Icon } from '../icons/Icon';
import type { ComponentChildren } from 'preact';
import { CompactActivityRow } from '../shared/ChatDisclosure';
import { presentReasoning } from '../../../../src/presentation/activity-presentation';
import { ReasoningDetails } from '../shared/ReasoningDetails';

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
  const { summary, details, hasBody } = presentReasoning([content]);
  return (
    <CompactActivityRow
      className="thinking-block"
      icon={<Icon name="thought" />}
      summary={summary}
      metadata={headerMetadata}
      memberRefs={memberRefs}
      disclosure={hasBody || detailsAvailable ? {
        content: <ReasoningDetails parts={details} />,
        regionLabel: `${summary} details`,
        defaultExpanded: !defaultCollapsed,
        expanded,
        onExpandedChange,
      } : undefined}
    />
  );
}
