import { parentPort, workerData } from "node:worker_threads";
import { openDb, setDb } from "./db.js";
import {
  configureIngestionWorker,
  ingestBatchForWorker,
  reconcileForWorker,
  triggerFullIngestForWorker,
} from "./ingestion.js";
import type { IngestionWorkerRequest, IngestionWorkerResponse } from "./ingestion-worker-protocol.js";
import type { Logger } from "./types.js";

const port = parentPort;
if (!port) {
  throw new Error("ingestion worker requires a parent port");
}

const dbPath = (workerData as { dbPath?: unknown }).dbPath;
if (typeof dbPath !== "string" || !dbPath) {
  throw new Error("ingestion worker requires a database path");
}

// A synchronous busy wait in this thread does not freeze HTTP, but short waits
// plus explicit retry give shutdown and newer dirty paths a chance to proceed.
const db = openDb(dbPath, { busyTimeoutMs: 100 });
setDb(db);

const send = (message: IngestionWorkerResponse): void => port.postMessage(message);
const logger: Logger = (level, message, details) => send({
  kind: "log",
  level,
  message,
  details,
});
configureIngestionWorker(logger, (event, data) => send({ kind: "broadcast", event, data }));

let requestChain = Promise.resolve();
port.on("message", (request: IngestionWorkerRequest) => {
  // Preserve watcher and explicit-ingest ordering on the single writer.
  requestChain = requestChain.then(() => handle(request));
});
send({ kind: "ready" });

async function handle(request: IngestionWorkerRequest): Promise<void> {
  try {
    const value = await withBusyRetry(async () => {
      if (request.kind === "ingest") {
        await ingestBatchForWorker(request.paths, request.forceFull === true);
        return undefined;
      }
      if (request.kind === "reconcile") {
        await reconcileForWorker(request.repairLegacyOrphans === true);
        return undefined;
      }
      return triggerFullIngestForWorker();
    });
    send({ kind: "result", id: request.id, ok: true, value });
  } catch (error) {
    send({ kind: "result", id: request.id, ok: false, error: String(error) });
  }
}

async function withBusyRetry<T>(operation: () => Promise<T>): Promise<T> {
  let delayMs = 10;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isSqliteBusy(error) || attempt >= 7) throw error;
      logger("debug", "ingestion_worker_busy_backoff", { attempt: attempt + 1, delay_ms: delayMs });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(250, delayMs * 2);
    }
  }
}

function isSqliteBusy(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED"
    || /SQLITE_(?:BUSY|LOCKED)|database is locked/i.test(String(error));
}

process.once("exit", () => {
  try { db.close(); } catch { /* best effort */ }
});
