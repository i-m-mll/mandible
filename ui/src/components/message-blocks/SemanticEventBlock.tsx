import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { CompactActivityRow } from '../shared/ChatDisclosure';
import type { ToolResultContentBlock } from '../stream-renderer/types';
import { extractResultText } from './ToolUseBlock';

export function SemanticEventBlock({
  kind,
  content,
  label,
  isError = false,
  unmatched = false,
  detailsAvailable = false,
  expanded,
  onExpandedChange,
  headerMetadata,
}: {
  kind: 'system' | 'event' | 'tool_result';
  content: string;
  label?: string;
  isError?: boolean;
  unmatched?: boolean;
  detailsAvailable?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean, trigger?: HTMLElement) => void;
  headerMetadata?: ComponentChildren;
}): JSX.Element {
  const [localExpanded, setLocalExpanded] = useState(false);
  const isExpanded = expanded ?? localExpanded;
  const title = unmatched
    ? (isError ? 'Unmatched tool error' : 'Unmatched tool result')
    : kind === 'system'
      ? 'System'
      : kind === 'tool_result' ? (isError ? 'Tool error' : 'Tool result') : (isError ? 'Error event' : 'Event');
  const canCollapse = content.length > 500 || detailsAvailable;
  const body = <pre className="semantic-event__content">{content}</pre>;
  return <div className={`semantic-event-block${isError ? ' semantic-event--error' : ''}`}>
    <CompactActivityRow summary={title} metadata={label || headerMetadata ? <>{label && <span className="semantic-event__label">{label}</span>}{headerMetadata}</> : undefined}
      disclosure={canCollapse ? { content: body, regionLabel: `${title} details`, expanded: isExpanded, onExpandedChange: (next, trigger) => {
        if (expanded === undefined) setLocalExpanded(next); onExpandedChange?.(next, trigger);
      } } : undefined} />
    {!canCollapse && body}
  </div>;
}

export function UnmatchedToolResultBlock({ result, expanded, onExpandedChange, unmatched = true, headerMetadata }: {
  result: ToolResultContentBlock;
  unmatched?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean, trigger?: HTMLElement) => void;
  headerMetadata?: ComponentChildren;
}): JSX.Element {
  return (
    <SemanticEventBlock
      kind="tool_result"
      content={result.fullText ?? extractResultText(result.content)}
      isError={result.is_error}
      unmatched={unmatched}
      detailsAvailable={result.source?.detailsLoaded === false}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      headerMetadata={headerMetadata}
    />
  );
}
