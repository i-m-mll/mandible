import { parentPort, workerData } from "node:worker_threads";
import { CURRENT_SCHEMA_VERSION, setDb, SQLITE_COLD_START_TUNING } from "../db.js";
import { openReadOnlyLedger } from "../db-read.js";
import { runLedgerRead, type LedgerReadRequest, type LedgerReadResponse } from "./registry.js";

const port = parentPort;
if (!port) throw new Error("ledger reader worker requires a parent port");
const dbPath = (workerData as { dbPath?: unknown }).dbPath;
if (typeof dbPath !== "string" || !dbPath) throw new Error("ledger reader worker requires a database path");

const ledger = openReadOnlyLedger(dbPath);
const db = ledger.db;
const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
if (Number(version?.value) !== CURRENT_SCHEMA_VERSION) {
  throw new Error(`ledger reader schema version ${version?.value ?? "missing"} does not match ${CURRENT_SCHEMA_VERSION}`);
}
db.pragma(`mmap_size = ${SQLITE_COLD_START_TUNING.mmapSizeBytes}`);
db.pragma("cache_size = -8192");
db.pragma(`temp_store = ${SQLITE_COLD_START_TUNING.tempStore}`);
setDb(db);

port.on("message", (request: LedgerReadRequest) => {
  let response: LedgerReadResponse;
  try {
    response = { id: request.id, ok: true, value: runLedgerRead(db, request.kind, request.params) };
  } catch (error) {
    response = { id: request.id, ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  port.postMessage(response);
});
process.once("exit", () => ledger.close());
