import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  consumeFileRangeForTest,
  INGEST_RANGE_READ_CHUNK_BYTES,
  MAX_BUFFERED_APPEND_BYTES,
  readAppendForTest,
  readUtf8FileRangeForTest,
} from "../src/ingestion.js";

const INT32_MAX = 2_147_483_647;
let tempDir = "";

async function sparseFile(name: string, size: number): Promise<string> {
  if (!tempDir) tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "mandible-large-range-"));
  const file = path.join(tempDir, name);
  await fsp.writeFile(file, "");
  await fsp.truncate(file, size);
  return file;
}

afterEach(async () => {
  if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true });
  tempDir = "";
});

describe("bounded ingestion range reads", () => {
  it("blocks a single unterminated record beyond the bounded append-record ceiling", async () => {
    const file = await sparseFile("fallback.jsonl", INT32_MAX + 8192);
    expect(MAX_BUFFERED_APPEND_BYTES).toBeLessThan(INT32_MAX);
    await expect(readAppendForTest(file, {
      byte_offset: 0,
      line_count: 0,
      tail_hash: "",
      partial_line: "",
    })).resolves.toEqual({ kind: "blocked", reason: "append_record_exceeds_buffer_limit" });
  });

  it("performs real native reads on a sparse >INT32 logical range with bounded lengths", async () => {
    const file = await sparseFile("native-read.bin", INT32_MAX + 8192);
    const highPosition = INT32_MAX + 1024;
    const payload = Buffer.from("large-position-proof");
    const writer = await fsp.open(file, "r+");
    await writer.write(payload, 0, payload.length, highPosition);
    await writer.close();

    const lengths: number[] = [];
    const positions: number[] = [];
    let closed = false;
    const native = await fsp.open(file, "r");
    const stop = new Error("bounded proof complete");
    await expect(consumeFileRangeForTest(file, 0, INT32_MAX + 4096, () => {
      throw stop;
    }, {
      openFile: async () => ({
        read: async (buffer, offset, length, position) => {
          lengths.push(length);
          positions.push(position);
          return native.read(buffer, offset, length, position);
        },
        close: async () => {
          closed = true;
          await native.close();
        },
      }),
    })).rejects.toBe(stop);
    expect(lengths).toEqual([INGEST_RANGE_READ_CHUNK_BYTES]);
    expect(positions).toEqual([0]);
    expect(closed).toBe(true);

    await expect(readUtf8FileRangeForTest(
      file,
      highPosition,
      highPosition + payload.length,
    )).resolves.toBe(payload.toString("utf8"));
  });

  it("advances by short reads, stops only at zero-byte EOF, and closes on success", async () => {
    const source = Buffer.from("abcdef");
    const positions: number[] = [];
    const lengths: number[] = [];
    const returned = [2, 1, 2, 0];
    let closed = false;
    const chunks: string[] = [];
    const bytesRead = await consumeFileRangeForTest("injected", 0, 20, (chunk) => {
      chunks.push(chunk.toString("utf8"));
    }, {
      chunkBytes: 4,
      openFile: async () => ({
        read: async (buffer, offset, length, position) => {
          positions.push(position);
          lengths.push(length);
          const count = Math.min(returned.shift() ?? 0, source.length - position);
          if (count > 0) source.copy(buffer, offset, position, position + count);
          return { bytesRead: count, buffer };
        },
        close: async () => { closed = true; },
      }),
    });
    expect(bytesRead).toBe(5);
    expect(chunks.join("")).toBe("abcde");
    expect(positions).toEqual([0, 2, 3, 5]);
    expect(lengths).toEqual([4, 4, 4, 4]);
    expect(closed).toBe(true);
  });

  it("decodes UTF-8 split across native chunks and closes after read failures", async () => {
    const text = "A€🙂B";
    const source = Buffer.from(text);
    let decodeClosed = false;
    await expect(readUtf8FileRangeForTest("utf8", 0, source.length, {
      chunkBytes: 2,
      openFile: async () => ({
        read: async (buffer, offset, length, position) => {
          const count = Math.min(length, source.length - position);
          if (count > 0) source.copy(buffer, offset, position, position + count);
          return { bytesRead: count, buffer };
        },
        close: async () => { decodeClosed = true; },
      }),
    })).resolves.toBe(text);
    expect(decodeClosed).toBe(true);

    const failure = new Error("read failed");
    let failureClosed = false;
    await expect(consumeFileRangeForTest("failure", 0, 8, () => undefined, {
      openFile: async () => ({
        read: async () => { throw failure; },
        close: async () => { failureClosed = true; },
      }),
    })).rejects.toBe(failure);
    expect(failureClosed).toBe(true);
  });
});
