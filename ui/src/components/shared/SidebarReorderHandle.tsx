import type { JSX } from 'preact';

import { ContextualAction } from './ContextualAction';
import type { SidebarReorderBinding } from './sidebar-order';

export function SidebarReorderHandle({
  binding,
  testId,
}: {
  binding: SidebarReorderBinding;
  testId?: string;
}): JSX.Element {
  return (
    <ContextualAction
      {...binding.handle}
      className="sidebar-reorder-handle"
      data-testid={testId}
      title={binding.handle['aria-label']}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 14 14"
        fill="currentColor"
        aria-hidden="true"
      >
        <circle cx="4" cy="3" r="1" />
        <circle cx="10" cy="3" r="1" />
        <circle cx="4" cy="7" r="1" />
        <circle cx="10" cy="7" r="1" />
        <circle cx="4" cy="11" r="1" />
        <circle cx="10" cy="11" r="1" />
      </svg>
    </ContextualAction>
  );
}
