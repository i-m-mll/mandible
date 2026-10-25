import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { workerLedgerReaderPool } from "../src/ledger-reads/index.js";

it("keeps a one-second ledger read off the main loop and transports worker errors", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-ledger-reader-"));
  const dbPath = path.join(root, "ledger.db");
  const db = openDb(dbPath);
  const reader = workerLedgerReaderPool(dbPath, { size: 2 });
  let longestTurnMs = 0;
  let last = performance.now();
  const resolutionMs = 5;
  const timer = setInterval(() => {
    const now = performance.now();
    longestTurnMs = Math.max(longestTurnMs, now - last - resolutionMs);
    last = now;
  }, resolutionMs);
  try {
    const result = await reader.run("diagnostics_delay", { ms: 1000 });
    await new Promise(resolve => setTimeout(resolve, resolutionMs));
    expect(result.elapsed_ms).toBeGreaterThanOrEqual(1000);
    expect(result.iterations).toBeGreaterThan(0);
    expect(longestTurnMs).toBeLessThan(150);
    await expect(reader.run("timeline_projection", {}))
      .rejects.toThrow("project_id or project_ref is required");
  } finally {
    clearInterval(timer);
    await reader.close();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
