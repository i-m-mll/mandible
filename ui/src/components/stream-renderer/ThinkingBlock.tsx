// Bug: aa35aeb — Console tab renderer: collapsible thinking block

import { useState } from 'preact/hooks';
import type { ThinkingBlockProps } from './types';

export function ThinkingBlock({ thinking, defaultExpanded = false }: ThinkingBlockProps): JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div className="thinking-block">
      <button
        type="button"
        className="thinking-block__header"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
      >
        <span className="thinking-block__chevron">{expanded ? '▾' : '▸'}</span>
        <span>Thinking</span>
      </button>
      {expanded && (
        <div className="thinking-block__body">
          <pre>{thinking}</pre>
        </div>
      )}
    </div>
  );
}
