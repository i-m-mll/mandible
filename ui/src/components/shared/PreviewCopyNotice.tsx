import type { InstanceInfo } from '../../api';
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
      Preview copy — edits stay here and do not change the main instance.
    </div>
  );
}
