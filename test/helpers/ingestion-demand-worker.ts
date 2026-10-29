import fs from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import type { IngestionWorkerRequest } from "../../src/ingestion-worker-protocol.js";

const port = parentPort!;
const root = path.dirname(workerData.dbPath);
process.env.HOME = path.join(root, "home");
process.env.CODEX_HOME = path.join(root, "home", ".codex");
const { openDb, setDb } = await import("../../src/db.js");
const { IngestionWorkerService } = await import("../../src/ingestion-worker-service.js");
const { isConversationSourceChangedError } = await import("../../src/conversations/source-store.js");
const ingestion = await import("../../src/ingestion.js");
const db = openDb(workerData.dbPath);
setDb(db);
const log = (message: string, details: Record<string, unknown>) =>
  port.postMessage({ kind: "log", level: "debug", message, details });
ingestion.configureIngestionWorker(() => undefined, () => undefined);

async function barrier(name: string): Promise<void> {
  const gate = path.join(root, name);
  if (!fs.existsSync(gate)) return;
  log("barrier", { name });
  await new Promise<void>((resolve, reject) => {
    const watcher = fs.watch(root, () => {
      if (!fs.existsSync(gate)) { watcher.close(); resolve(); }
    });
    watcher.once("error", reject);
    if (!fs.existsSync(gate)) { watcher.close(); resolve(); }
  });
}

const service = new IngestionWorkerService({
  ingest: async (file, requirements) => {
    const name = path.basename(file);
    log("source_start", { name, ...requirements });
    await barrier(`before-${name}`);
    if (fs.existsSync(path.join(root, `fail-${name}`))) throw new Error(`parser failed: ${name}`);
    await ingestion.ingestBatchForWorker([file], requirements.forceFull, requirements.bypassSameMtimeUnchanged, true);
    await barrier(`after-${name}`);
    log("source_done", { name });
  },
  needsFollowup: ingestion.ingestedPathNeedsFollowup,
  reconcile: ingestion.reconcileForWorker,
  fullIngest: ingestion.triggerFullIngestForWorker,
});
port.on("message", (request: IngestionWorkerRequest) => {
  log("received", { id: request.id, kind: request.kind, ...(request.kind === "ingest" ? { paths: request.paths } : {}) });
  void service.execute(request).then(
    (value) => port.postMessage({ kind: "result", id: request.id, ok: true, value }),
    (error) => port.postMessage({ kind: "result", id: request.id, ok: false, error: String(error),
      ...(isConversationSourceChangedError(error) ? { errorCode: "conversation_source_changed" } : {}) }),
  );
});
port.postMessage({ kind: "ready" });
