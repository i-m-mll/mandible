import { parentPort, workerData } from "node:worker_threads";
import { configureSearchJobRuntime, type SearchUpdate } from "../conversations/full-text-search-jobs.js";
import { CURRENT_SCHEMA_VERSION, setDb, SQLITE_COLD_START_TUNING } from "../db.js";
import { openReadOnlyLedger } from "../db-read.js";
import { runLedgerRead, type LedgerReadRequest, type LedgerReadResponse } from "./registry.js";
const port = parentPort;
if (!port)
    throw new Error("ledger reader worker requires a parent port");
const dbPath = (workerData as {
    dbPath?: unknown;
}).dbPath;
if (typeof dbPath !== "string" || !dbPath)
    throw new Error("ledger reader worker requires a database path");
const ledger = openReadOnlyLedger(dbPath);
const db = ledger.db;
const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
    value: string;
} | undefined;
if (Number(version?.value) !== CURRENT_SCHEMA_VERSION) {
    throw new Error(`ledger reader schema version ${version?.value ?? "missing"} does not match ${CURRENT_SCHEMA_VERSION}`);
}
db.pragma(`mmap_size = ${SQLITE_COLD_START_TUNING.mmapSizeBytes}`);
db.pragma("cache_size = -8192");
db.pragma(`temp_store = ${SQLITE_COLD_START_TUNING.tempStore}`);
setDb(db);
let nextRepairId = 1;
const repairs = new Map<number, () => void>();
configureSearchJobRuntime(db, {
    publish(update: SearchUpdate) { port.postMessage({ kind: "search_update", update }); },
    repair(conversationId) {
        const id = nextRepairId++;
        return new Promise<void>(resolve => {
            repairs.set(id, resolve);
            port.postMessage({ kind: "source_repair", id, conversationId });
        });
    },
});
port.on("message", async (request: LedgerReadRequest | {
    kind: "source_repair_done";
    id: number;
}) => {
    if (request.kind === "source_repair_done") {
        repairs.get(request.id)?.();
        repairs.delete(request.id);
        return;
    }
    let response: LedgerReadResponse;
    try {
        response = { id: request.id, ok: true, value: await runLedgerRead(db, request.kind, request.params) };
    }
    catch (error) {
        response = { id: request.id, ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    port.postMessage(response);
});
process.once("exit", () => ledger.close());
