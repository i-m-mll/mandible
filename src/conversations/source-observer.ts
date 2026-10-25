import { createHash } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import type { ConversationSourceAlias } from "./source-types.js";

const TAIL_HASH_BYTES = 4096;

export interface SourceFilesystemIdentity {
  device: string;
  inode: string;
  ctimeNs: string;
}

export function sourceFilesystemIdentity(stat: fs.BigIntStats): SourceFilesystemIdentity {
  return {
    device: stat.dev.toString(10),
    inode: stat.ino.toString(10),
    ctimeNs: stat.ctimeNs.toString(10),
  };
}

export function sameSourceFilesystemIdentity(
  left: SourceFilesystemIdentity,
  right: SourceFilesystemIdentity,
): boolean {
  return left.device === right.device && left.inode === right.inode && left.ctimeNs === right.ctimeNs;
}

export function numericSourceExtent(stat: fs.BigIntStats): { byteLength: number; fileMtimeMs: number } {
  const byteLength = Number(stat.size);
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new SourceObservationError("conversation source extent exceeds safe integer range", "unsupported");
  }
  return { byteLength, fileMtimeMs: Number(stat.mtimeNs) / 1_000_000 };
}

export interface StableSourceObservation {
  path: string;
  byteLength: number;
  fileMtimeMs: number;
  contentSha256: string;
  tailHash: string;
  bytes: Buffer | null;
  filesystemIdentity: SourceFilesystemIdentity;
}

export interface StableSourceExtentObservation {
  path: string;
  byteLength: number;
  fileMtimeMs: number;
  tailHash: string;
  filesystemIdentity: SourceFilesystemIdentity;
}

export interface SourceReadObservation {
  position: number;
  length: number;
  fileSize: number;
}

export interface SourceByteRange {
  offset: number;
  length: number;
}

export interface StableSourceRangeObservation {
  path: string;
  byteLength: number;
  fileMtimeMs: number;
  filesystemIdentity: SourceFilesystemIdentity;
  ranges: Buffer[];
  prefixSha256?: string;
}

export type SourceReadInstrumentation = (read: SourceReadObservation) => void;

export class SourceObservationError extends Error {
  constructor(
    message: string,
    readonly kind: "unavailable" | "unsupported" | "changed",
  ) {
    super(message);
  }
}

export class ConversationSourceChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationSourceChangedError";
  }
}

export function insideSourceRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/**
 * Open and observe one declared source alias without following a final symlink.
 * The descriptor is checked before and after the read so callers never compare
 * indexed facts with bytes from a moving or replaced file.
 */
export async function observeStableSourceAlias(
  alias: ConversationSourceAlias,
  options: {
    captureBytes?: boolean;
    maxBytes?: number;
    instrumentation?: SourceReadInstrumentation;
  } = {},
): Promise<StableSourceObservation> {
  if (alias.availability !== "available") {
    throw new SourceObservationError("conversation source alias is unavailable", "unavailable");
  }
  try {
    const declaredRoot = path.resolve(alias.rootPath);
    const declared = path.resolve(alias.rootPath, alias.relativePath);
    if (declared !== path.resolve(alias.path) || !insideSourceRoot(declaredRoot, declared)) {
      throw new SourceObservationError("conversation source alias escapes its declared root", "unavailable");
    }
    const rootReal = await fs.promises.realpath(declaredRoot);
    const fileReal = await fs.promises.realpath(declared);
    if (!insideSourceRoot(rootReal, fileReal)) {
      throw new SourceObservationError("conversation source resolves outside its declared root", "unavailable");
    }
    const handle = await fs.promises.open(fileReal, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) {
        throw new SourceObservationError("conversation source is not a regular file", "unavailable");
      }
      const beforeExtent = numericSourceExtent(before);
      const beforeIdentity = sourceFilesystemIdentity(before);
      if (options.maxBytes !== undefined && beforeExtent.byteLength > options.maxBytes) {
        throw new SourceObservationError("source exceeds bounded cold-read limit", "unsupported");
      }
      const captureBytes = options.captureBytes === true;
      const captured = captureBytes ? Buffer.alloc(beforeExtent.byteLength) : null;
      const contentHash = createHash("sha256");
      const tailLength = Math.min(TAIL_HASH_BYTES, beforeExtent.byteLength);
      let position = 0;
      const chunk = Buffer.alloc(Math.min(64 * 1024, Math.max(1, beforeExtent.byteLength)));
      while (position < beforeExtent.byteLength) {
        const requested = Math.min(chunk.length, beforeExtent.byteLength - position);
        options.instrumentation?.({ position, length: requested, fileSize: beforeExtent.byteLength });
        const { bytesRead } = await handle.read(chunk, 0, requested, position);
        if (bytesRead === 0) break;
        const slice = chunk.subarray(0, bytesRead);
        contentHash.update(slice);
        if (captured) slice.copy(captured, position);
        position += bytesRead;
      }
      const tail = Buffer.alloc(tailLength);
      if (tailLength > 0) {
        options.instrumentation?.({
          position: beforeExtent.byteLength - tailLength,
          length: tailLength,
          fileSize: beforeExtent.byteLength,
        });
        const tailRead = await handle.read(tail, 0, tailLength, beforeExtent.byteLength - tailLength);
        if (tailRead.bytesRead !== tailLength) {
          throw new SourceObservationError("conversation source changed while reading its tail", "changed");
        }
      }
      const after = await handle.stat({ bigint: true });
      const afterExtent = numericSourceExtent(after);
      if (
        position !== beforeExtent.byteLength
        || !sameSourceFilesystemIdentity(beforeIdentity, sourceFilesystemIdentity(after))
        || beforeExtent.byteLength !== afterExtent.byteLength || before.mtimeNs !== after.mtimeNs
      ) {
        throw new SourceObservationError("conversation source changed while being observed", "changed");
      }
      return {
        path: alias.path,
        byteLength: beforeExtent.byteLength,
        fileMtimeMs: beforeExtent.fileMtimeMs,
        contentSha256: contentHash.digest("hex"),
        tailHash: beforeExtent.byteLength === 0 ? "" : createHash("sha256").update(tail).digest("hex"),
        bytes: captured,
        filesystemIdentity: beforeIdentity,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof SourceObservationError) throw error;
    throw new SourceObservationError(
      error instanceof Error ? error.message : "conversation source could not be read",
      "unavailable",
    );
  }
}

/**
 * Validate a declared source through the same root/realpath/no-follow boundary
 * while reading only its tail. This is the bounded fast path for comparing an
 * already indexed extent; changed extents still use the full hashing observer.
 */
export async function observeStableSourceAliasExtent(
  alias: ConversationSourceAlias,
  options: { instrumentation?: SourceReadInstrumentation } = {},
): Promise<StableSourceExtentObservation> {
  if (alias.availability !== "available") {
    throw new SourceObservationError("conversation source alias is unavailable", "unavailable");
  }
  try {
    const declaredRoot = path.resolve(alias.rootPath);
    const declared = path.resolve(alias.rootPath, alias.relativePath);
    if (declared !== path.resolve(alias.path) || !insideSourceRoot(declaredRoot, declared)) {
      throw new SourceObservationError("conversation source alias escapes its declared root", "unavailable");
    }
    const rootReal = await fs.promises.realpath(declaredRoot);
    const fileReal = await fs.promises.realpath(declared);
    if (!insideSourceRoot(rootReal, fileReal)) {
      throw new SourceObservationError("conversation source resolves outside its declared root", "unavailable");
    }
    const handle = await fs.promises.open(fileReal, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) {
        throw new SourceObservationError("conversation source is not a regular file", "unavailable");
      }
      const beforeExtent = numericSourceExtent(before);
      const beforeIdentity = sourceFilesystemIdentity(before);
      const tailLength = Math.min(TAIL_HASH_BYTES, beforeExtent.byteLength);
      const tail = Buffer.alloc(tailLength);
      if (tailLength > 0) {
        options.instrumentation?.({
          position: beforeExtent.byteLength - tailLength,
          length: tailLength,
          fileSize: beforeExtent.byteLength,
        });
        const tailRead = await handle.read(tail, 0, tailLength, beforeExtent.byteLength - tailLength);
        if (tailRead.bytesRead !== tailLength) {
          throw new SourceObservationError("conversation source changed while reading its tail", "changed");
        }
      }
      const after = await handle.stat({ bigint: true });
      const afterExtent = numericSourceExtent(after);
      if (
        !sameSourceFilesystemIdentity(beforeIdentity, sourceFilesystemIdentity(after))
        || beforeExtent.byteLength !== afterExtent.byteLength || before.mtimeNs !== after.mtimeNs
      ) {
        throw new SourceObservationError("conversation source changed while being observed", "changed");
      }
      return {
        path: alias.path,
        byteLength: beforeExtent.byteLength,
        fileMtimeMs: beforeExtent.fileMtimeMs,
        tailHash: beforeExtent.byteLength === 0 ? "" : createHash("sha256").update(tail).digest("hex"),
        filesystemIdentity: beforeIdentity,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof SourceObservationError) throw error;
    throw new SourceObservationError(
      error instanceof Error ? error.message : "conversation source could not be read",
      "unavailable",
    );
  }
}

/**
 * Read only caller-selected immutable JSONL records from one verified alias.
 * The descriptor and extent are checked before and after the reads, so a large
 * transcript never has to be materialized merely to show one page. When an
 * indexed prefix is supplied, it is streamed through SHA-256 and the requested
 * ranges are captured from that same stream; appended bytes are never retained.
 */
export async function observeStableSourceAliasRanges(
  alias: ConversationSourceAlias,
  ranges: readonly SourceByteRange[],
  options: {
    maxRangeBytes?: number;
    maxTotalBytes?: number;
    instrumentation?: SourceReadInstrumentation;
    /** Stream and verify an indexed prefix while capturing requested ranges from those same bytes. */
    prefix?: { byteLength: number; contentSha256: string; filesystemIdentity: Pick<SourceFilesystemIdentity, "device" | "inode"> };
  } = {},
): Promise<StableSourceRangeObservation> {
  if (alias.availability !== "available") {
    throw new SourceObservationError("conversation source alias is unavailable", "unavailable");
  }
  const maxRangeBytes = options.maxRangeBytes ?? 64 * 1024 * 1024;
  const maxTotalBytes = options.maxTotalBytes ?? 128 * 1024 * 1024;
  const totalRequested = ranges.reduce((sum, range) => sum + range.length, 0);
  if (ranges.some((range) => !Number.isSafeInteger(range.offset) || range.offset < 0
      || !Number.isSafeInteger(range.length) || range.length < 0 || range.length > maxRangeBytes)
      || !Number.isSafeInteger(totalRequested) || totalRequested > maxTotalBytes) {
    throw new SourceObservationError("requested source page exceeds bounded range-read limit", "unsupported");
  }
  const prefix = options.prefix;
  if (prefix && (!Number.isSafeInteger(prefix.byteLength) || prefix.byteLength < 0
      || !/^[a-f0-9]{64}$/i.test(prefix.contentSha256)
      || ranges.some((range) => range.offset + range.length > prefix.byteLength))) {
    throw new SourceObservationError("requested source page is outside its indexed prefix", "unsupported");
  }
  try {
    const declaredRoot = path.resolve(alias.rootPath);
    const declared = path.resolve(alias.rootPath, alias.relativePath);
    if (declared !== path.resolve(alias.path) || !insideSourceRoot(declaredRoot, declared)) {
      throw new SourceObservationError("conversation source alias escapes its declared root", "unavailable");
    }
    const rootReal = await fs.promises.realpath(declaredRoot);
    const fileReal = await fs.promises.realpath(declared);
    if (!insideSourceRoot(rootReal, fileReal)) {
      throw new SourceObservationError("conversation source resolves outside its declared root", "unavailable");
    }
    const handle = await fs.promises.open(fileReal, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) throw new SourceObservationError("conversation source is not a regular file", "unavailable");
      const beforeExtent = numericSourceExtent(before);
      const beforeIdentity = sourceFilesystemIdentity(before);
      const buffers = ranges.map((range) => Buffer.alloc(range.length));
      if (prefix) {
        if (beforeExtent.byteLength < prefix.byteLength
            || beforeIdentity.device !== prefix.filesystemIdentity.device
            || beforeIdentity.inode !== prefix.filesystemIdentity.inode) {
          throw new SourceObservationError("conversation source no longer contains the indexed prefix", "changed");
        }
        const orderedRanges = ranges.map((range, index) => ({ ...range, index }))
          .sort((left, right) => left.offset - right.offset || left.length - right.length);
        const prefixHash = createHash("sha256");
        const chunk = Buffer.alloc(64 * 1024);
        let position = 0;
        let rangeIndex = 0;
        while (position < prefix.byteLength) {
          const requested = Math.min(chunk.length, prefix.byteLength - position);
          options.instrumentation?.({ position, length: requested, fileSize: beforeExtent.byteLength });
          const result = await handle.read(chunk, 0, requested, position);
          if (result.bytesRead !== requested) {
            throw new SourceObservationError("conversation source changed while hashing its indexed prefix", "changed");
          }
          const chunkEnd = position + requested;
          const bytes = chunk.subarray(0, requested);
          prefixHash.update(bytes);
          while (rangeIndex < orderedRanges.length && orderedRanges[rangeIndex].offset < chunkEnd) {
            const range = orderedRanges[rangeIndex];
            const overlapStart = Math.max(position, range.offset);
            const overlapEnd = Math.min(chunkEnd, range.offset + range.length);
            if (overlapStart < overlapEnd) {
              bytes.copy(
                buffers[range.index],
                overlapStart - range.offset,
                overlapStart - position,
                overlapEnd - position,
              );
            }
            if (range.offset + range.length <= chunkEnd) rangeIndex += 1;
            else break;
          }
          position = chunkEnd;
        }
        const prefixSha256 = prefixHash.digest("hex");
        if (prefixSha256 !== prefix.contentSha256.toLowerCase()) {
          throw new SourceObservationError("conversation source prefix no longer matches its indexed version", "changed");
        }
        const after = await handle.stat({ bigint: true });
        const afterExtent = numericSourceExtent(after);
        const afterIdentity = sourceFilesystemIdentity(after);
        if (afterExtent.byteLength < prefix.byteLength
            || beforeIdentity.device !== afterIdentity.device
            || beforeIdentity.inode !== afterIdentity.inode) {
          throw new SourceObservationError("conversation source changed while its indexed prefix was verified", "changed");
        }
        return {
          path: alias.path,
          byteLength: afterExtent.byteLength,
          fileMtimeMs: afterExtent.fileMtimeMs,
          filesystemIdentity: afterIdentity,
          ranges: buffers,
          prefixSha256,
        };
      }
      for (const [index, range] of ranges.entries()) {
        if (range.offset + range.length > beforeExtent.byteLength) {
          throw new SourceObservationError("source record range is outside the observed extent", "changed");
        }
        let read = 0;
        while (read < range.length) {
          const length = Math.min(1024 * 1024, range.length - read);
          options.instrumentation?.({ position: range.offset + read, length, fileSize: beforeExtent.byteLength });
          const result = await handle.read(buffers[index], read, length, range.offset + read);
          if (result.bytesRead === 0) break;
          read += result.bytesRead;
        }
        if (read !== range.length) {
          throw new SourceObservationError("conversation source changed during range read", "changed");
        }
      }
      const after = await handle.stat({ bigint: true });
      const afterExtent = numericSourceExtent(after);
      if (!sameSourceFilesystemIdentity(beforeIdentity, sourceFilesystemIdentity(after))
          || beforeExtent.byteLength !== afterExtent.byteLength || before.mtimeNs !== after.mtimeNs) {
        throw new SourceObservationError("conversation source changed while ranges were read", "changed");
      }
      return {
        path: alias.path,
        byteLength: beforeExtent.byteLength,
        fileMtimeMs: beforeExtent.fileMtimeMs,
        filesystemIdentity: beforeIdentity,
        ranges: buffers,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof SourceObservationError) throw error;
    throw new SourceObservationError(
      error instanceof Error ? error.message : "conversation source ranges could not be read",
      "unavailable",
    );
  }
}
