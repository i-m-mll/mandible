// SHARED COMPONENT — used by BOTH Chat (StreamRenderer) and History (conversations.tsx).
// Changes here affect BOTH views. If you modify rendering for one view,
// the other MUST update automatically because they use this same component.

// Bug: bce7370 — Collapsible thinking block

import { useState } from 'preact/hooks';

export type ThinkingBlockProps = {
  content: string;
  defaultCollapsed?: boolean;
};

export function ThinkingBlock({ content, defaultCollapsed = true }: ThinkingBlockProps): JSX.Element {
  // Short blocks stay expanded — only collapse if >= 10 lines.
  // TODO: make this threshold configurable via settings (issue 6a7bedf).
  const lineCount = content.split('\n').length;
  const shouldCollapse = defaultCollapsed && lineCount >= 10;
  const [collapsed, setCollapsed] = useState(shouldCollapse);

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
        className={`thinking-block__bubble${collapsed ? '' : ' thinking-block__bubble--expanded'}`}
        onClick={() => setCollapsed((prev) => !prev)}
        aria-expanded={!collapsed}
        title={collapsed ? 'Expand thinking' : 'Collapse thinking'}
      >
        {collapsed ? (
          <div className="thinking-block__collapsed">
            <span className="thinking-block__chevron">{'\u25B8'}</span>
            <span className="thinking-block__label">Thinking</span>
          </div>
        ) : (
          <div className="thinking-block__expanded-header">
            <span className="thinking-block__chevron">{'\u25BE'}</span>
            <span className="thinking-block__label">Thinking</span>
          </div>
        )}
        {!collapsed && (
          <div className="thinking-block__body">
            <pre>{content}</pre>
          </div>
        )}
      </button>
    </div>
  );
}
