import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { warmLedger } from "../src/ledger-warm.js";
import { longestEventLoopBlockMs, SYNCHRONOUS_WAIT_MS } from "./helpers/event-loop-blocking.js";

it("T5: warms a 50 MB file and reports its bytes without blocking the event loop", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mandible-ledger-warm-"));
  const dbPath = path.join(root, "ledger.db");
  const bytes = 50 * 1024 * 1024;
  const logger = vi.fn();
  try {
    await writeFile(dbPath, Buffer.alloc(bytes, 1));
    const longestTurnMs = await longestEventLoopBlockMs(async () => {
      const result = await warmLedger(dbPath, logger);
      expect(result.ok).toBe(true);
      expect(result.bytes).toBe(bytes);
    });
    expect(logger).toHaveBeenCalledWith("info", "ledger_warm", {
      bytes,
      ms: expect.any(Number),
    });
    expect(longestTurnMs).toBeLessThan(SYNCHRONOUS_WAIT_MS);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
