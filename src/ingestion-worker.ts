import { isSqliteBusy } from "./sqlite.js";
import { parentPort, workerData } from "node:worker_threads";
import { openDb, setDb } from "./db.js";
import {
  configureIngestionWorker,
  ingestBatchForWorker,
  ingestedPathNeedsFollowup,
  reconcileForWorker,
  triggerFullIngestForWorker,
} from "./ingestion.js";
import type { IngestionWorkerRequest, IngestionWorkerResponse } from "./ingestion-worker-protocol.js";
import { IngestionWorkerService } from "./ingestion-worker-service.js";
import { isConversationSourceChangedError } from "./conversations/source-store.js";
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
db.pragma("wal_autocheckpoint = 0");
setDb(db);

const send = (message: IngestionWorkerResponse): void => port.postMessage(message);
const logger: Logger = (level, message, details) => send({
  kind: "log",
  level,
  message,
  details,
});
configureIngestionWorker(logger, (event, data) => send({ kind: "broadcast", event, data }));

const checkpointIntervalMs = (workerData as { checkpointIntervalMs?: number }).checkpointIntervalMs ?? 10_000;
const checkpointTimer = setInterval(() => {
  try {
    const { log, checkpointed } = db.prepare("PRAGMA wal_checkpoint(NOOP)").get() as {
      log: number;
      checkpointed: number;
    };
    if (log - checkpointed > 1000) db.pragma("wal_checkpoint(PASSIVE)");
  } catch (error) {
    if (!isSqliteBusy(error)) throw error;
  }
}, checkpointIntervalMs);

const service = new IngestionWorkerService({
  ingest: (filePath, requirements, withinPass) => withBusyRetry(() => ingestBatchForWorker(
    [filePath], requirements.forceFull, requirements.bypassSameMtimeUnchanged, true, undefined, withinPass,
  )),
  needsFollowup: ingestedPathNeedsFollowup,
  reconcile: (startup, cooperate, ingest) => withBusyRetry(() => reconcileForWorker(startup, cooperate, ingest)),
  fullIngest: (cooperate, ingest) => withBusyRetry(() => triggerFullIngestForWorker(cooperate, ingest)),
});
port.on("message", (request: IngestionWorkerRequest) => {
  void handle(request);
});
send({ kind: "ready" });

async function handle(
  request: IngestionWorkerRequest,
): Promise<void> {
  try {
    const value = await service.execute(request);
    send({ kind: "result", id: request.id, ok: true, value });
  } catch (error) {
    send({
      kind: "result",
      id: request.id,
      ok: false,
      error: String(error),
      ...(isConversationSourceChangedError(error) ? { errorCode: "conversation_source_changed" as const } : {}),
    });
  }
}

/** A batch aggregates per-file failures; it is retryable when every one of them lost the write lock. */
function isLockContention(error: unknown): boolean {
  if (error instanceof AggregateError) {
    const errors = Array.from(error.errors);
    return errors.length > 0 && errors.every(isLockContention);
  }
  return isSqliteBusy(error);
}

async function withBusyRetry<T>(operation: () => Promise<T>): Promise<T> {
  let delayMs = 10;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isLockContention(error) || attempt >= 7) throw error;
      logger("debug", "ingestion_worker_busy_backoff", { attempt: attempt + 1, delay_ms: delayMs });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(250, delayMs * 2);
    }
  }
}



process.once("exit", () => {
  clearInterval(checkpointTimer);
  try { db.close(); } catch { /* best effort */ }
});
