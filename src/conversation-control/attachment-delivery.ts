import { retainedAttachmentPath, verifiedAttachmentBytes } from "./attachment-store.js";
import type { ChatAttachment, StoredAttachmentFile } from "./attachments.js";
import type { UserInput } from "./generated/codex-app-server/v2/UserInput.js";
import { getDbPath } from "../db.js";

export type NativeImage = { file: StoredAttachmentFile; path: string; bytes: Buffer };

/** No ordinary file contents enter this text. Images remain separate native inputs. */
export function attachmentProviderContext(message: string, attachments: readonly ChatAttachment[], dbPath: string = getDbPath()): {
  text: string;
  images: NativeImage[];
} {
  const lines = [message];
  const images: NativeImage[] = [];
  for (const attachment of attachments) {
    if (attachment.kind === "file") {
      verifiedAttachmentBytes(attachment.file, dbPath);
      lines.push(`Attached file: ${attachment.file.name}\nRetained readable path: ${retainedAttachmentPath(attachment.file.id, dbPath)}`);
    } else if (attachment.kind === "image") {
      images.push({ file: attachment.file, path: retainedAttachmentPath(attachment.file.id, dbPath), bytes: verifiedAttachmentBytes(attachment.file, dbPath) });
      lines.push(`Attached image: ${attachment.file.name}`);
    } else {
      const target = attachment.target;
      lines.push(`Annotation ${attachment.ordinal}: ${attachment.text}\nPage: ${target.url}\nElement: ${target.element_text ?? "(no element text)"}\nSelector: ${target.selector ?? "(none)"}\nBounds: ${JSON.stringify(target.rect)}\nViewport: ${JSON.stringify(target.viewport)}${target.revision ? `\nRevision: ${target.revision}` : ""}`);
      if (attachment.screenshot) {
        images.push({ file: attachment.screenshot, path: retainedAttachmentPath(attachment.screenshot.id, dbPath), bytes: verifiedAttachmentBytes(attachment.screenshot, dbPath) });
      }
    }
  }
  return { text: lines.filter(Boolean).join("\n\n"), images };
}

export function codexAttachmentInput(message: string, attachments: readonly ChatAttachment[], dbPath?: string): UserInput[] {
  const context = attachmentProviderContext(message, attachments, dbPath);
  return [
    { type: "text", text: context.text, text_elements: [] },
    ...context.images.map((image): UserInput => ({ type: "localImage", path: image.path })),
  ];
}

export function claudeAttachmentContent(message: string, attachments: readonly ChatAttachment[], dbPath?: string): Array<
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
> {
  const context = attachmentProviderContext(message, attachments, dbPath);
  return [
    { type: "text", text: context.text },
    ...context.images.map((image) => ({ type: "image" as const, source: {
      type: "base64" as const, media_type: image.file.media_type, data: image.bytes.toString("base64"),
    } })),
  ];
}
