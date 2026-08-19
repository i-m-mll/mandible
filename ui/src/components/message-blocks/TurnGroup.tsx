// SHARED COMPONENT — used by BOTH Chat (StreamRenderer) and History (conversations.tsx).
// Changes here affect BOTH views. If you modify rendering for one view,
// the other MUST update automatically because they use this same component.

// Bug: bce7370 — Shared turn layout with two-column grid

import type { ComponentChildren } from 'preact';

export type TurnGroupProps = {
  speaker: 'user' | 'assistant' | 'system';
  children: ComponentChildren;
  footer?: ComponentChildren;
};

export function TurnGroup({
  speaker,
  children,
  footer,
}: TurnGroupProps): JSX.Element {
  const entityClass = `turn-group--${speaker}`;

  return (
    <div className={`turn-group ${entityClass}`}>
      <div className="turn-group__body">
        {children}
        {footer}
      </div>
    </div>
  );
}
