import { open } from "node:fs/promises";
import type { Logger } from "./types.js";

type LedgerWarmResult = {
  bytes: number;
  ms: number;
} & ({ ok: true } | { ok: false; error: string });

export async function warmLedger(dbPath: string, logger: Logger): Promise<LedgerWarmResult> {
  const started = performance.now();
  let bytes = 0;
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (const filePath of [dbPath, `${dbPath}-wal`]) {
      const file = await open(filePath, "r").catch((error: NodeJS.ErrnoException) => {
        if (filePath !== dbPath && error.code === "ENOENT") return null;
        throw error;
      });
      if (!file) continue;
      try {
        // Bound the pass to the current size even if writes keep extending the WAL.
        const { size } = await file.stat();
        let position = 0;
        while (position < size) {
          const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - position), position);
          if (bytesRead === 0) break;
          bytes += bytesRead;
          position += bytesRead;
        }
      } finally {
        await file.close();
      }
    }
  } catch (error) {
    const result = { ok: false as const, bytes, ms: performance.now() - started, error: String(error) };
    logger("error", "ledger_warm_failed", result);
    return result;
  }
  const result = { ok: true as const, bytes, ms: performance.now() - started };
  logger("info", "ledger_warm", { bytes: result.bytes, ms: result.ms });
  return result;
}

export function startLedgerWarmTimer(dbPath: string, logger: Logger): { stop: () => Promise<void> } {
  let pending: Promise<LedgerWarmResult> | null = null;
  const timer = setInterval(() => {
    if (pending) return;
    pending = warmLedger(dbPath, logger).finally(() => { pending = null; });
  }, 10 * 60 * 1000);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      await pending;
    },
  };
}
