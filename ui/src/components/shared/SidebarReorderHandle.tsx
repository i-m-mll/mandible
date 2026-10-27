import { Icon } from '../icons/Icon';
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
      <Icon name="reorder" size={14} />
    </ContextualAction>
  );
}
