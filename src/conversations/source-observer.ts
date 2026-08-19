import { createHash } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import type { ConversationSourceAlias } from "./source-types.js";

const TAIL_HASH_BYTES = 4096;

export interface StableSourceObservation {
  path: string;
  byteLength: number;
  fileMtimeMs: number;
  contentSha256: string;
  tailHash: string;
  bytes: Buffer | null;
}

export interface StableSourceExtentObservation {
  path: string;
  byteLength: number;
  fileMtimeMs: number;
  tailHash: string;
}

export interface SourceReadObservation {
  position: number;
  length: number;
  fileSize: number;
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
      const before = await handle.stat();
      if (!before.isFile()) {
        throw new SourceObservationError("conversation source is not a regular file", "unavailable");
      }
      if (options.maxBytes !== undefined && before.size > options.maxBytes) {
        throw new SourceObservationError("source exceeds bounded cold-read limit", "unsupported");
      }
      const captureBytes = options.captureBytes === true;
      const captured = captureBytes ? Buffer.alloc(before.size) : null;
      const contentHash = createHash("sha256");
      const tailLength = Math.min(TAIL_HASH_BYTES, before.size);
      let position = 0;
      const chunk = Buffer.alloc(Math.min(64 * 1024, Math.max(1, before.size)));
      while (position < before.size) {
        const requested = Math.min(chunk.length, before.size - position);
        options.instrumentation?.({ position, length: requested, fileSize: before.size });
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
          position: before.size - tailLength,
          length: tailLength,
          fileSize: before.size,
        });
        const tailRead = await handle.read(tail, 0, tailLength, before.size - tailLength);
        if (tailRead.bytesRead !== tailLength) {
          throw new SourceObservationError("conversation source changed while reading its tail", "changed");
        }
      }
      const after = await handle.stat();
      if (
        position !== before.size || before.dev !== after.dev || before.ino !== after.ino
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      ) {
        throw new SourceObservationError("conversation source changed while being observed", "changed");
      }
      return {
        path: alias.path,
        byteLength: before.size,
        fileMtimeMs: before.mtimeMs,
        contentSha256: contentHash.digest("hex"),
        tailHash: before.size === 0 ? "" : createHash("sha256").update(tail).digest("hex"),
        bytes: captured,
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
      const before = await handle.stat();
      if (!before.isFile()) {
        throw new SourceObservationError("conversation source is not a regular file", "unavailable");
      }
      const tailLength = Math.min(TAIL_HASH_BYTES, before.size);
      const tail = Buffer.alloc(tailLength);
      if (tailLength > 0) {
        options.instrumentation?.({
          position: before.size - tailLength,
          length: tailLength,
          fileSize: before.size,
        });
        const tailRead = await handle.read(tail, 0, tailLength, before.size - tailLength);
        if (tailRead.bytesRead !== tailLength) {
          throw new SourceObservationError("conversation source changed while reading its tail", "changed");
        }
      }
      const after = await handle.stat();
      if (
        before.dev !== after.dev || before.ino !== after.ino
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      ) {
        throw new SourceObservationError("conversation source changed while being observed", "changed");
      }
      return {
        path: alias.path,
        byteLength: before.size,
        fileMtimeMs: before.mtimeMs,
        tailHash: before.size === 0 ? "" : createHash("sha256").update(tail).digest("hex"),
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
