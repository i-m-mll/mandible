import { parentPort, workerData } from "node:worker_threads";
import SqliteDatabase from "./sqlite.js";
import { writeMetadataBackupFile } from "./ledger/backup.js";
import type { BackupWorkerInput, BackupWorkerResponse } from "./metadata-backup-service.js";

const port = parentPort;
if (!port) throw new Error("Metadata backup requires a worker port.");
const input = workerData as BackupWorkerInput;
let db: SqliteDatabase | undefined;
let response: BackupWorkerResponse;
try {
  db = new SqliteDatabase(input.database, { readonly: true, fileMustExist: true });
  const result = writeMetadataBackupFile(db, input.staging);
  response = { ok: true, value: result };
} catch (error) {
  response = { ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 8192) };
} finally { db?.close(); }
port.postMessage(response);
port.close();
