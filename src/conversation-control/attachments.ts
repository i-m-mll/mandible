/** One attachment shape across drafts, submission, persistence, and providers. */
export type StoredAttachmentFile = {
  id: string;
  name: string;
  media_type: string;
  byte_length: number;
  sha256: string;
};

export type AnnotationTarget = {
  url: string;
  selector?: string;
  element_text?: string;
  element?: string;
  source_file?: string;
  react_components?: string;
  css_classes?: string;
  computed_styles?: string;
  selected_text?: string;
  nearby_text?: string;
  rect: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
  revision?: string;
};

export type ChatAttachment =
  | { kind: "file"; file: StoredAttachmentFile }
  | { kind: "image"; file: StoredAttachmentFile }
  | { kind: "annotation"; id: string; ordinal: number; text: string; target: AnnotationTarget; screenshot?: StoredAttachmentFile };

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENTS = 16;

export function annotationContextFields(target: AnnotationTarget): Array<{ label: string; value: string }> {
  const fields: Array<{ label: string; value: string | undefined }> = [
    { label: "Page URL", value: target.url },
    { label: "Element", value: target.element },
    { label: "Location", value: target.selector },
    { label: "Source", value: target.source_file },
    { label: "React", value: target.react_components },
    { label: "Selected text", value: target.selected_text },
    { label: "Element text", value: target.element_text === target.selected_text || target.element_text === target.nearby_text ? undefined : target.element_text },
    { label: "Nearby text", value: target.nearby_text },
    { label: "Classes", value: target.css_classes },
    { label: "Computed styles", value: target.computed_styles },
    { label: "Bounds", value: JSON.stringify(target.rect) },
    { label: "Viewport", value: JSON.stringify(target.viewport) },
    { label: "Revision", value: target.revision },
  ];
  return fields.filter((field): field is { label: string; value: string } => Boolean(field.value));
}
