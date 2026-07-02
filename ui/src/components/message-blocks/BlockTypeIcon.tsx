// SHARED COMPONENT — used by BOTH Chat (StreamRenderer) and History (conversations.tsx).
// Changes here affect BOTH views. If you modify rendering for one view,
// the other MUST update automatically because they use this same component.

// Bug: bce7370 — Gutter icon for block types

export type BlockTypeIconType = 'thinking' | 'plan' | 'tool_use' | 'tool_result' | 'system' | 'event';

export type BlockTypeIconProps = {
  type: BlockTypeIconType;
};

export function BlockTypeIcon({ type }: BlockTypeIconProps): JSX.Element | null {
  if (type === 'thinking') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M5.1 12.8c.3.8 1.2 1.2 2.1 1.2h1.6c.9 0 1.8-.4 2.1-1.2M5.8 11.4h4.4M5.3 10.2c-.9-.8-1.6-2-1.6-3.3C3.7 4.2 5.7 2 8 2s4.3 2.2 4.3 4.9c0 1.3-.7 2.5-1.6 3.3-.3.3-.5.7-.5 1.1v.1H5.8v-.1c0-.4-.2-.8-.5-1.1Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  // Bug: 722e318 — Fix 3: tool_result should have no gutter icon
  if (type === 'tool_use') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="m9.9 2.4 1.8 1.8-2 2 1.9 1.9 2-2 1.8 1.8-.8 2.6-2.2 2.1-2.7.9-1.8-1.9.8-2.6-2.1-2.1-2.6.8L3 6.6l.9-2.7 2.1-2.1 2.6-.8Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.1"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (type === 'system' || type === 'event' || type === 'plan') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle
          cx="8"
          cy="8"
          r="5.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
        />
        <path
          d="M8 7.2v3.2M8 5.1h.01"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return null;
}
