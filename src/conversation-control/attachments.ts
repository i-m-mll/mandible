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
