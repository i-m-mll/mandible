import { useState } from 'preact/hooks';
import type { ToolResultContentBlock } from '../stream-renderer/types';
import { extractResultText } from './ToolUseBlock';

export function SemanticEventBlock({
  kind,
  content,
  label,
  isError = false,
  unmatched = false,
}: {
  kind: 'system' | 'event' | 'tool_result';
  content: string;
  label?: string;
  isError?: boolean;
  unmatched?: boolean;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const title = unmatched
    ? (isError ? 'Unmatched tool error' : 'Unmatched tool result')
    : kind === 'system'
      ? 'System'
      : (isError ? 'Error event' : 'Event');
  const canCollapse = content.length > 500;
  const visible = expanded || !canCollapse ? content : `${content.slice(0, 500).trimEnd()}…`;

  return (
    <details className={`semantic-event${isError ? ' semantic-event--error' : ''}`} open={expanded || !canCollapse}>
      <summary
        className="semantic-event__summary"
        onClick={(event) => {
          if (!canCollapse) event.preventDefault();
          else setExpanded((value) => !value);
        }}
      >
        <span>{title}</span>
        {label && <span className="semantic-event__label">{label}</span>}
      </summary>
      <pre className="semantic-event__content">{visible}</pre>
    </details>
  );
}

export function UnmatchedToolResultBlock({ result }: { result: ToolResultContentBlock }): JSX.Element {
  return (
    <SemanticEventBlock
      kind="tool_result"
      content={result.fullText ?? extractResultText(result.content)}
      isError={result.is_error}
      unmatched
    />
  );
}
