import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  countCompleteLines,
} from "../src/ingestion.js";

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

});
