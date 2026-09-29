import { useState } from 'preact/hooks';
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
}: {
  kind: 'system' | 'event' | 'tool_result';
  content: string;
  label?: string;
  isError?: boolean;
  unmatched?: boolean;
  detailsAvailable?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}): JSX.Element {
  const [localExpanded, setLocalExpanded] = useState(false);
  const isExpanded = expanded ?? localExpanded;
  const title = unmatched
    ? (isError ? 'Unmatched tool error' : 'Unmatched tool result')
    : kind === 'system'
      ? 'System'
      : (isError ? 'Error event' : 'Event');
  const canCollapse = content.length > 500 || detailsAvailable;
  const visible = isExpanded || !canCollapse ? content : `${content.slice(0, 500).trimEnd()}…`;

  return (
    <details className={`semantic-event${isError ? ' semantic-event--error' : ''}`} open={isExpanded || !canCollapse}>
      <summary
        className="semantic-event__summary"
        onClick={(event) => {
          if (!canCollapse) event.preventDefault();
          else {
            event.preventDefault();
            const next = !isExpanded;
            if (expanded === undefined) setLocalExpanded(next);
            onExpandedChange?.(next);
          }
        }}
      >
        <span>{title}</span>
        {label && <span className="semantic-event__label">{label}</span>}
      </summary>
      <pre className="semantic-event__content">{visible}</pre>
    </details>
  );
}

export function UnmatchedToolResultBlock({ result, expanded, onExpandedChange }: {
  result: ToolResultContentBlock;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}): JSX.Element {
  return (
    <SemanticEventBlock
      kind="tool_result"
      content={result.fullText ?? extractResultText(result.content)}
      isError={result.is_error}
      unmatched
      detailsAvailable={result.source?.detailsLoaded === false}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
    />
  );
}
