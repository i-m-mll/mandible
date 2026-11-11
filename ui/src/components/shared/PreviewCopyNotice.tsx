import { Icon } from '../icons/Icon';
import type { InstanceInfo } from '../../api';
import type { ComponentChildren } from 'preact';

import './PreviewCopyNotice.css';

export function PreviewCopyNotice({ instance, action }: { instance: InstanceInfo | null; action?: ComponentChildren }): JSX.Element | null {
  if (instance?.role !== 'preview') return null;
  const scope = instance.allowed_effects.includes('notes:source')
    ? 'edits do not mutate the main DB, external files, or user settings, except interface notes, which are saved to the main instance'
    : 'edits do not mutate the main DB, external files, or user settings';

  return (
    <div
      className="preview-copy-banner"
      data-testid="preview-copy-notice"
    >
      <span role="status" aria-live="polite" aria-atomic="true">Preview instance</span>
      <span className="preview-copy-banner__info" tabIndex={0} aria-label={scope}>
        <Icon name="info" size={15} />
        <span className="preview-copy-banner__tooltip" role="tooltip">{scope}</span>
      </span>
      {action}
    </div>
  );
}
