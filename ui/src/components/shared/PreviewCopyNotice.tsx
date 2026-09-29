import type { InstanceInfo } from '../../api';
import { InfoIcon } from '../icons/TabIcons';
import './PreviewCopyNotice.css';

export function PreviewCopyNotice({ instance }: { instance: InstanceInfo | null }): JSX.Element | null {
  if (instance?.role !== 'preview') return null;

  return (
    <div
      className="preview-copy-banner"
      data-testid="preview-copy-notice"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span>Preview instance</span>
      <span className="preview-copy-banner__info" tabIndex={0} aria-label="edits do not mutate the main DB, external files, or user settings">
        <InfoIcon size={15} />
        <span className="preview-copy-banner__tooltip" role="tooltip">edits do not mutate the main DB, external files, or user settings</span>
      </span>
    </div>
  );
}
