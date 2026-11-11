import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useId, useState } from 'preact/hooks';
import type { ChatAttachment } from '../../../../src/conversation-control/attachments';
import { AnnotationPreviewContent } from '../../chat/AnnotationPreviewContent';
import { attachmentContentUrl } from '../../chat/attachmentApi';
import { browserSessionFetch } from '../../client-auth-token';
import { Icon } from '../icons/Icon';
import { appTip } from './AppHoverTips';
import { DetailPaneModal, type DetailPaneModalProps } from './DetailPaneModal';
import { OverflowFade } from './OverflowFade';
import './AttachmentPill.css';

const PREVIEW_TEXT_LIMIT = 20_000;

function attachmentLabel(attachment: ChatAttachment): string {
  return attachment.kind === 'annotation' ? `Annotation ${attachment.ordinal}` : attachment.file.name;
}

export function attachmentKey(attachment: ChatAttachment): string {
  return `${attachment.kind}:${attachment.kind === 'annotation' ? attachment.id : attachment.file.id}`;
}

/** The non-wrapping, horizontally scrolling row of attachment pills. */
export function AttachmentPillRow({ label, className = '', children }: {
  label: string;
  className?: string;
  children: ComponentChildren;
}): JSX.Element {
  return (
    <OverflowFade direction="horizontal" className={`attachment-pill-overflow${className ? ` ${className}` : ''}`}>
      <div className="attachment-pill-row" aria-label={label}>{children}</div>
    </OverflowFade>
  );
}

export function AttachmentPill({ attachment, highlighted = false, onOpen, onRemove, removeDisabled = false }: {
  attachment: ChatAttachment;
  highlighted?: boolean;
  onOpen(): void;
  onRemove?(): void;
  removeDisabled?: boolean;
}): JSX.Element {
  const label = attachmentLabel(attachment);
  const icon = attachment.kind === 'annotation' ? 'attachmentAnnotation' : attachment.kind === 'image' ? 'attachmentImage' : 'attachmentFile';
  return (
    <div className={`attachment-pill${highlighted ? ' attachment-pill--new' : ''}`}>
      <button type="button" className="attachment-pill__body" {...appTip(label)} onClick={onOpen}>
        <span aria-hidden="true"><Icon name={icon} /></span>
        <span className="attachment-pill__name">{label}</span>
      </button>
      {onRemove && (
        <button type="button" className="attachment-pill__remove" aria-label={`Remove ${label}`} {...appTip(`Remove ${label}`)}
          disabled={removeDisabled} onClick={onRemove}><Icon name="dismiss" /></button>
      )}
    </div>
  );
}

function useAttachmentText(attachment: ChatAttachment | null): string | null {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    setText(null);
    if (attachment?.kind !== 'file') return undefined;
    let active = true;
    void browserSessionFetch(attachmentContentUrl(attachment.file))
      .then(async (response) => {
        if (!response.ok) throw new Error(`Preview unavailable (${response.status}).`);
        return response.text();
      })
      .then((content) => { if (active) setText(content.slice(0, PREVIEW_TEXT_LIMIT)); })
      .catch((error: unknown) => { if (active) setText(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [attachment]);
  return text;
}

/** The bounded preview of one attachment; `actions` are placed in its header beside the close control. */
export function AttachmentPreviewModal({ attachment, onClose, actions, excludeAboveRef, scrollOwnerSelector }: {
  attachment: ChatAttachment | null;
  onClose(): void;
  actions?: JSX.Element;
} & Pick<DetailPaneModalProps, 'excludeAboveRef' | 'scrollOwnerSelector'>): JSX.Element | null {
  const titleId = useId();
  const text = useAttachmentText(attachment);
  return (
    <DetailPaneModal open={Boolean(attachment)} onClose={onClose} titleId={titleId}
      title={attachment ? attachmentLabel(attachment) : ''} closeLabel="Close attachment preview"
      excludeAboveRef={excludeAboveRef} scrollOwnerSelector={scrollOwnerSelector}
      headerActions={actions} className="attachment-preview-modal" panelClassName="attachment-preview">
      {attachment?.kind === 'annotation' ? <AnnotationPreviewContent annotation={attachment} screenshotUrl={attachmentContentUrl} />
        : attachment?.kind === 'image' ? <img src={attachmentContentUrl(attachment.file)} alt={attachment.file.name} />
          : <pre>{text ?? ''}</pre>}
    </DetailPaneModal>
  );
}
