import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  countCompleteLines,
  INGEST_COMPRESSION_CONCURRENCY,
  stageCompressedBlockContents,
} from "../../src/ingestion.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("ingestion allocation bounds", () => {
  it("counts complete lines with a streaming byte scan", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mandible-line-count-"));
    tempRoots.push(root);
    const filePath = path.join(root, "large.jsonl");
    const completeRows = Array.from({ length: 20_000 }, (_, index) => `{"index":${index}}\n`).join("");
    await fs.writeFile(filePath, `${completeRows}{"truncated":`, "utf8");

    await expect(countCompleteLines(filePath)).resolves.toBe(20_000);
  });

  it("bounds compression concurrency and preserves staged block order", async () => {
    const contents = Array.from({ length: 13 }, (_, index) => `block-${index}`);
    let active = 0;
    let maxActive = 0;
    const staged = await stageCompressedBlockContents(contents, async (content) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const index = Number(content.slice("block-".length));
      await new Promise((resolve) => setTimeout(resolve, (4 - (index % 4)) * 2));
      active -= 1;
      return Buffer.from(`compressed:${content}`);
    });

    try {
      expect(maxActive).toBe(INGEST_COMPRESSION_CONCURRENCY);
      expect(staged.length).toBe(contents.length);
      expect(contents.map((_, index) => staged.read(index).toString("utf8"))).toEqual(
        contents.map((content) => `compressed:${content}`),
      );
    } finally {
      await staged.dispose();
    }
  });
});
