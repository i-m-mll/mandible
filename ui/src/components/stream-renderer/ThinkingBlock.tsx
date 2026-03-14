// Bug: aa35aeb — Console tab renderer: collapsible thinking block

import { useState } from 'preact/hooks';
import type { ThinkingBlockProps } from './types';

export function ThinkingBlock({ thinking, defaultExpanded = false }: ThinkingBlockProps): JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div className="thinking-block">
      <div className="thinking-block__gutter" aria-hidden="true">
        <svg viewBox="0 0 16 16">
          <path
            d="M5.1 12.8c.3.8 1.2 1.2 2.1 1.2h1.6c.9 0 1.8-.4 2.1-1.2M5.8 11.4h4.4M5.3 10.2c-.9-.8-1.6-2-1.6-3.3C3.7 4.2 5.7 2 8 2s4.3 2.2 4.3 4.9c0 1.3-.7 2.5-1.6 3.3-.3.3-.5.7-.5 1.1v.1H5.8v-.1c0-.4-.2-.8-.5-1.1Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <button
        type="button"
        className={`thinking-block__bubble${expanded ? ' thinking-block__bubble--expanded' : ''}`}
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        title={expanded ? 'Collapse thinking' : 'Expand thinking'}
      >
        {expanded ? (
          <div className="thinking-block__body">
            <pre>{thinking}</pre>
          </div>
        ) : (
          <div className="thinking-block__collapsed">…</div>
        )}
      </button>
    </div>
  );
}
