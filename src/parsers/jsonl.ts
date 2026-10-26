import * as crypto from "node:crypto";
import { openLogicalSource } from "../conversations/logical-source.js";
import * as readline from "node:readline";
import { ConversationSourceChangedError } from "../conversations/source-observer.js";
import type { ParserSourceSnapshot } from "./types.js";

export interface JsonlFileRecords<T> {
  records: T[];
  sourceHash: string;
  sourceSnapshot: ParserSourceSnapshot;
}

function parseJsonlLine<T>(line: string, records: T[]): void {
  if (!line.trim()) return;
  try {
    records.push(JSON.parse(line) as T);
  } catch {
    // A provider may be interrupted halfway through its final JSONL row.
  }
}

/**
 * Parse JSONL without retaining a whole-file string or a second full line array.
 * Parsed records remain in memory because the provider parsers currently make
 * multiple ordered passes over them, but raw source bytes are released by the
 * stream as soon as each line is decoded.
 */
export async function readJsonlFileRecords<T>(filePath: string): Promise<JsonlFileRecords<T>> {
  const records: T[] = [];
  const handle = await openLogicalSource(filePath);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error("conversation source is not a regular file");
    const byteLength = Number(before.size);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new Error("conversation source extent exceeds safe integer range");
    }

    const filesystemDevice = before.dev.toString(10);
    const filesystemInode = before.ino.toString(10);
    const sourceHash = crypto.createHash("sha256");
    const completeHash = crypto.createHash("sha256");
    let bytesRead = 0;
    let completeByteLength = 0;
    let completeLineCount = 0;
    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let completeTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const updateTail = (tail: Buffer, bytes: Buffer): Buffer => {
      if (bytes.length >= 4096) return Buffer.from(bytes.subarray(bytes.length - 4096));
      const joined = tail.length === 0 ? bytes : Buffer.concat([tail, bytes]);
      return joined.length > 4096 ? Buffer.from(joined.subarray(joined.length - 4096)) : Buffer.from(joined);
    };

    const input = byteLength > 0
      ? handle.createReadStream({ start: 0, end: byteLength - 1, autoClose: false })
      : null;
    if (input) {
      input.on("data", (rawChunk) => {
        const chunk = rawChunk as Buffer;
        sourceHash.update(chunk);
        bytesRead += chunk.length;
        const data = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
        const newline = data.lastIndexOf(0x0a);
        if (newline >= 0) {
          const complete = data.subarray(0, newline + 1);
          completeHash.update(complete);
          completeByteLength += complete.length;
          for (const byte of complete) if (byte === 0x0a) completeLineCount += 1;
          completeTail = updateTail(completeTail, complete);
          pending = Buffer.from(data.subarray(newline + 1));
        } else {
          pending = Buffer.from(data);
        }
      });
      const lines = readline.createInterface({ input, crlfDelay: Infinity });
      for await (const line of lines) parseJsonlLine<T>(line, records);
    }

    const after = await handle.stat({ bigint: true });
    if (
      bytesRead !== byteLength
      || Number(after.size) < byteLength
      || before.dev !== after.dev
      || before.ino !== after.ino
    ) {
      throw new ConversationSourceChangedError("conversation source changed while being parsed");
    }

    const trailingLine = pending.toString("utf8");
    if (trailingLine.trim()) {
      try {
        JSON.parse(trailingLine);
        completeHash.update(pending);
        completeByteLength += pending.length;
        completeTail = updateTail(completeTail, pending);
      } catch {
        // The parser ignores an interrupted final row; do not seal its bytes.
      }
    }

    const sourceHashHex = sourceHash.digest("hex");
    const snapshotHash = completeByteLength === byteLength
      ? sourceHashHex
      : completeHash.digest("hex");
    return {
      records,
      sourceHash: sourceHashHex,
      sourceSnapshot: {
        kind: "full",
        contentHash: snapshotHash,
        byteLength: completeByteLength,
        completeLineCount,
        tailHash: completeByteLength > 0
          ? crypto.createHash("sha256").update(completeTail).digest("hex")
          : "",
        filesystemDevice,
        filesystemInode,
      },
    };
  } finally {
    await handle.close();
  }
}

/** Read only until the first provider record accepted by `match`. */
export async function findJsonlRecord<T>(
  filePath: string,
  match: (record: T) => boolean,
  maxBytes = 256 * 1024,
): Promise<T | null> {
  const handle = await openLogicalSource(filePath);
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    const raw = buffer.subarray(0, bytesRead).toString("utf8");
    const completePrefix = bytesRead < maxBytes
      ? raw
      : raw.slice(0, Math.max(0, raw.lastIndexOf("\n") + 1));
    for (const line of completePrefix.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as T;
        if (match(record)) return record;
      } catch {
        // Ignore an interrupted provider row and keep looking.
      }
    }
    return null;
  } finally {
    await handle.close();
  }
}

/** Parse an append-sized JSONL string without allocating an array of lines. */
export function parseJsonlStringRecords<T>(raw: string): T[] {
  const records: T[] = [];
  let start = 0;
  while (start < raw.length) {
    const newline = raw.indexOf("\n", start);
    const end = newline === -1 ? raw.length : newline;
    parseJsonlLine<T>(raw.slice(start, end), records);
    if (newline === -1) break;
    start = newline + 1;
  }
  return records;
}
