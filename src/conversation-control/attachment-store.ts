import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db.js";
import { getDbPath } from "../db.js";
import { MAX_ATTACHMENT_BYTES, MAX_MESSAGE_ATTACHMENTS, type AnnotationTarget, type ChatAttachment, type StoredAttachmentFile } from "./attachments.js";

type Row = StoredAttachmentFile;

export class AttachmentValidationError extends Error {}

function imageType(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) return "image/jpeg";
  if (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

function plainText(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  return Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes);
}

function safeName(name: string): boolean {
  return name.length > 0 && name.length <= 180 && !/[\x00-\x1f\x7f/\\]/.test(name) && name !== "." && name !== "..";
}

function checkMedia(name: string, mediaType: string, bytes: Buffer): void {
  const image = imageType(bytes);
  if (mediaType.startsWith("image/")) {
    if (image !== mediaType) throw new AttachmentValidationError("Image bytes do not match a supported PNG, JPEG, GIF, or WebP type");
    return;
  }
  const textTypes = new Set(["text/plain", "text/markdown", "text/x-python", "text/javascript", "text/typescript", "text/css", "text/html", "text/csv", "application/json", "application/xml", "application/javascript"]);
  const textExtensions = new Set([".txt", ".md", ".markdown", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".py", ".rs", ".go", ".sh", ".css", ".html", ".xml", ".csv", ".toml", ".yaml", ".yml", ".sql", ".c", ".h", ".cpp", ".hpp", ".java", ".rb", ".swift"]);
  if (!textTypes.has(mediaType) && !(mediaType === "application/octet-stream" && textExtensions.has(path.extname(name).toLowerCase()))) {
    throw new AttachmentValidationError("Unsupported file type; attach text/code or PNG, JPEG, GIF, or WebP images");
  }
  if (!plainText(bytes)) throw new AttachmentValidationError("Text/code attachment is not valid UTF-8 text");
}

export class ChatAttachmentStore {
  private readonly root: string;

  constructor(private readonly db: Db, dbPath: string = db.name === ":memory:" ? getDbPath() : db.name) {
    this.root = path.resolve(path.dirname(dbPath), "chat-attachments");
  }

  put(input: { name: string; media_type: string; data_base64: string }): StoredAttachmentFile {
    if (typeof input.name !== "string" || !safeName(input.name)) throw new AttachmentValidationError("Attachment name is invalid");
    if (typeof input.media_type !== "string" || typeof input.data_base64 !== "string") throw new AttachmentValidationError("Attachment type and base64 bytes are required");
    if (input.data_base64.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data_base64)) {
      throw new AttachmentValidationError("Attachment base64 is invalid or exceeds 5 MiB");
    }
    const bytes = Buffer.from(input.data_base64, "base64");
    if (bytes.length < 1 || bytes.length > MAX_ATTACHMENT_BYTES) throw new AttachmentValidationError("Attachment must contain 1 byte to 5 MiB");
    checkMedia(input.name, input.media_type, bytes);
    const file: StoredAttachmentFile = {
      id: randomUUID(), name: input.name, media_type: input.media_type,
      byte_length: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const destination = this.pathFor(file.id);
    fs.writeFileSync(destination, bytes, { flag: "wx", mode: 0o400 });
    try {
      this.db.prepare(`INSERT INTO chat_attachment_files (id,name,media_type,byte_length,sha256,created_at)
        VALUES (?,?,?,?,?,?)`).run(file.id, file.name, file.media_type, file.byte_length, file.sha256, Date.now());
    } catch (error) {
      fs.unlinkSync(destination);
      throw error;
    }
    return file;
  }

  get(id: string): StoredAttachmentFile | null {
    if (!/^[0-9a-f-]{36}$/.test(id)) return null;
    return this.db.prepare("SELECT id,name,media_type,byte_length,sha256 FROM chat_attachment_files WHERE id = ?").get(id) as Row | undefined ?? null;
  }

  content(file: StoredAttachmentFile): Buffer {
    const bytes = fs.readFileSync(this.pathFor(file.id));
    if (bytes.length !== file.byte_length || createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
      throw new Error(`Retained attachment ${file.id} failed its custody hash`);
    }
    return bytes;
  }

  pathFor(id: string): string { return path.join(this.root, id); }

  /** Replace all client-supplied file metadata with server authority. */
  resolve(input: unknown): ChatAttachment[] {
    if (input === undefined) return [];
    if (!Array.isArray(input) || input.length > MAX_MESSAGE_ATTACHMENTS) throw new AttachmentValidationError("A message may contain at most 16 attachments");
    return input.map((value: unknown): ChatAttachment => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new AttachmentValidationError("Attachment must be an object");
      const attachment = value as Record<string, unknown>;
      const resolveFile = (candidate: unknown): StoredAttachmentFile => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new AttachmentValidationError("Attachment file is missing");
        const supplied = candidate as Record<string, unknown>;
        const file = typeof supplied.id === "string" ? this.get(supplied.id) : null;
        if (!file || Object.keys(file).some((key) => supplied[key] !== file[key as keyof StoredAttachmentFile])) {
          throw new AttachmentValidationError("Attachment metadata does not match retained bytes");
        }
        this.content(file);
        return file;
      };
      if (attachment.kind === "file" || attachment.kind === "image") {
        const file = resolveFile(attachment.file);
        if ((attachment.kind === "image") !== file.media_type.startsWith("image/")) throw new AttachmentValidationError("Attachment kind does not match file type");
        return { kind: attachment.kind, file };
      }
      if (attachment.kind !== "annotation") throw new AttachmentValidationError("Unsupported attachment kind");
      const target = attachment.target as Record<string, unknown> | null;
      const rect = target?.rect as Record<string, unknown> | null;
      const viewport = target?.viewport as Record<string, unknown> | null;
      const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
      if (typeof attachment.id !== "string" || !attachment.id || attachment.id.length > 128
          || !Number.isSafeInteger(attachment.ordinal) || (attachment.ordinal as number) < 1
          || typeof attachment.text !== "string" || !attachment.text.trim() || attachment.text.length > 10_000
          || !target || typeof target.url !== "string" || !target.url || target.url.length > 2_000
          || !rect || ![rect.x, rect.y, rect.width, rect.height].every(finite) || (rect.width as number) < 0 || (rect.height as number) < 0
          || !viewport || ![viewport.width, viewport.height].every(finite) || (viewport.width as number) <= 0 || (viewport.height as number) <= 0
          || [target.selector, target.element_text, target.revision, target.element, target.source_file,
            target.react_components, target.css_classes, target.computed_styles, target.selected_text,
            target.nearby_text].some((v) => v !== undefined && (typeof v !== "string" || v.length > 2_000))) {
        throw new AttachmentValidationError("Annotation metadata is invalid");
      }
      const screenshot = attachment.screenshot === undefined ? undefined : resolveFile(attachment.screenshot);
      if (screenshot && !screenshot.media_type.startsWith("image/")) throw new AttachmentValidationError("Annotation screenshot must be an image");
      const canonicalTarget: AnnotationTarget = {
        url: target.url as string,
        rect: { x: rect.x as number, y: rect.y as number, width: rect.width as number, height: rect.height as number },
        viewport: { width: viewport.width as number, height: viewport.height as number },
        ...(typeof target.selector === "string" ? { selector: target.selector } : {}),
        ...(typeof target.element_text === "string" ? { element_text: target.element_text } : {}),
        ...(typeof target.element === "string" ? { element: target.element } : {}),
        ...(typeof target.source_file === "string" ? { source_file: target.source_file } : {}),
        ...(typeof target.react_components === "string" ? { react_components: target.react_components } : {}),
        ...(typeof target.css_classes === "string" ? { css_classes: target.css_classes } : {}),
        ...(typeof target.computed_styles === "string" ? { computed_styles: target.computed_styles } : {}),
        ...(typeof target.selected_text === "string" ? { selected_text: target.selected_text } : {}),
        ...(typeof target.nearby_text === "string" ? { nearby_text: target.nearby_text } : {}),
        ...(typeof target.revision === "string" ? { revision: target.revision } : {}),
      };
      return { kind: "annotation", id: attachment.id, ordinal: attachment.ordinal as number, text: attachment.text,
        target: canonicalTarget, ...(screenshot ? { screenshot } : {}) };
    });
  }
}

/** Stable provider-readable file location; IDs, never client paths, choose the file. */
export function retainedAttachmentPath(id: string, dbPath: string = getDbPath()): string {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new AttachmentValidationError("Invalid retained attachment ID");
  return path.resolve(path.dirname(dbPath), "chat-attachments", id);
}

export function verifiedAttachmentBytes(file: StoredAttachmentFile, dbPath: string = getDbPath()): Buffer {
  const bytes = fs.readFileSync(retainedAttachmentPath(file.id, dbPath));
  if (bytes.length !== file.byte_length || createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
    throw new AttachmentValidationError("Retained attachment bytes changed after submission");
  }
  return bytes;
}
