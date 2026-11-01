import fs from "node:fs";
import path from "node:path";

const attachmentBrand: unique symbol = Symbol("opened artifact attachment");

export interface OpenedArtifactAttachment {
  readonly name: string;
  readonly [attachmentBrand]: true;
}

export interface AttachmentIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export type AttachmentErrorCode =
  | "file_rpc_attachment_invalid"
  | "file_rpc_attachment_missing"
  | "file_rpc_attachment_changed"
  | "file_rpc_attachment_unsupported"
  | "file_rpc_attachment_io_error";

export class ArtifactAttachmentError extends Error {
  constructor(readonly code: AttachmentErrorCode, readonly status: number, readonly attachment?: string) {
    super(attachment ? `${code}: ${attachment}` : code);
  }
}

const opened = new WeakMap<OpenedArtifactAttachment, { fd: number; identity: AttachmentIdentity }>();
const qualifiedSpools = new Set<string>();

function qualifyNoFollow(spool: string, flags: number): void {
  if (qualifiedSpools.has(spool)) return;
  const probe = fs.mkdtempSync(path.join(spool, ".acquisition-"));
  const target = path.join(probe, "target");
  const link = path.join(probe, "link");
  try {
    fs.writeFileSync(target, "", { mode: 0o600 });
    fs.symlinkSync("target", link);
    let fd: number;
    try {
      fd = fs.openSync(link, flags);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOOP") {
        throw new ArtifactAttachmentError("file_rpc_attachment_unsupported", 501);
      }
      qualifiedSpools.add(spool);
      return;
    }
    fs.closeSync(fd);
    throw new ArtifactAttachmentError("file_rpc_attachment_unsupported", 501);
  } finally {
    for (const entry of [link, target]) {
      try { fs.unlinkSync(entry); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    fs.rmdirSync(probe);
  }
}

export function isOpenedArtifactAttachment(value: unknown): value is OpenedArtifactAttachment {
  return typeof value === "object" && value !== null && opened.has(value as OpenedArtifactAttachment);
}

export function borrowArtifactAttachment(source: OpenedArtifactAttachment): { fd: number; identity: AttachmentIdentity } {
  const record = opened.get(source);
  if (!record) throw new Error("Artifact attachment is not open");
  return record;
}

export function acquireArtifactAttachment(spool: string, name: string): OpenedArtifactAttachment {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  if (!(process.platform === "darwin" || process.platform === "linux")
    || !Number.isInteger(O_NOFOLLOW) || O_NOFOLLOW === 0
    || !Number.isInteger(O_NONBLOCK) || O_NONBLOCK === 0 || !process.getuid) {
    throw new ArtifactAttachmentError("file_rpc_attachment_unsupported", 501, name);
  }
  let fd: number | undefined;
  try {
    qualifyNoFollow(spool, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    fd = fs.openSync(path.join(spool, name), O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1) {
      throw new ArtifactAttachmentError("file_rpc_attachment_invalid", 400, name);
    }
    const source: OpenedArtifactAttachment = Object.freeze({ name, [attachmentBrand]: true as const });
    opened.set(source, { fd, identity: { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs } });
    return source;
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    if (error instanceof ArtifactAttachmentError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new ArtifactAttachmentError("file_rpc_attachment_missing", 400, name);
    if (["ELOOP", "EISDIR", "ENOTDIR", "EACCES", "EPERM", "ENXIO"].includes(code ?? "")) {
      throw new ArtifactAttachmentError("file_rpc_attachment_invalid", 400, name);
    }
    if (["ENOTSUP", "EOPNOTSUPP", "EINVAL", "ENOSYS"].includes(code ?? "")) {
      throw new ArtifactAttachmentError("file_rpc_attachment_unsupported", 501, name);
    }
    throw new ArtifactAttachmentError("file_rpc_attachment_io_error", 500, name);
  }
}

export function closeArtifactAttachment(source: OpenedArtifactAttachment): void {
  const record = opened.get(source);
  if (!record) return;
  opened.delete(source);
  fs.closeSync(record.fd);
}
