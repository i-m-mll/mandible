// SHARED COMPONENT — used by BOTH Chat (StreamRenderer) and History (conversations.tsx).
// Changes here affect BOTH views. If you modify rendering for one view,
// the other MUST update automatically because they use this same component.

// Bug: bce7370 — Shared turn layout with two-column grid

import type { ComponentChildren } from 'preact';

export type TurnGroupProps = {
  speaker: 'user' | 'assistant' | 'system';
  children: ComponentChildren;
  footer?: ComponentChildren;
  isShort?: boolean;
};

const BADGE_LABELS: Record<string, string> = {
  user: 'You',
  assistant: 'Assistant',
  system: 'System',
};

export function TurnGroup({ speaker, children, footer, isShort }: TurnGroupProps): JSX.Element {
  const entityClass = `turn-group--${speaker}`;
  const shortClass = isShort ? ' turn-group--short' : '';

  return (
    <div className={`turn-group ${entityClass}${shortClass}`} style={{ position: 'relative' }}>
      <div className="turn-group__speaker">
        <span className="turn-group__badge">{BADGE_LABELS[speaker] ?? speaker}</span>
      </div>
      <div className="turn-group__body">
        {children}
        {footer}
      </div>
    </div>
  );
}
