import type { InstanceInfo } from '../../api';
import { DetailPaneNotice } from './DetailPaneNotice';

export function PreviewCopyNotice({ instance }: { instance: InstanceInfo | null }): JSX.Element | null {
  if (instance?.role !== 'preview') return null;

  return (
    <DetailPaneNotice
      severity="info"
      source="preview-copy"
      testId="preview-copy-notice"
    >
      Preview copy — edits stay here and do not change the main instance.
    </DetailPaneNotice>
  );
}
