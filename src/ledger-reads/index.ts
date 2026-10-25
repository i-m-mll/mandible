import { Worker } from "node:worker_threads";
import { getDb, type Db } from "../db.js";
import { runLedgerRead, type LedgerReadKind, type LedgerReadParams, type LedgerReadResult, type LedgerReadResponse } from "./registry.js";

export type { LedgerReadKind, LedgerReadParams, LedgerReadResult } from "./registry.js";

export interface LedgerReader {
  run<K extends LedgerReadKind>(kind: K, params: LedgerReadParams<K>): Promise<LedgerReadResult<K>>;
  close(): Promise<void>;
}

/** Tests explicitly choose the calling thread's injected, often in-memory database. */
export function inlineLedgerReader(database: () => Db = getDb): LedgerReader {
  return {
    async run(kind, params) { return runLedgerRead(database(), kind, params); },
    async close() {},
  };
}

interface PendingRead {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface ReaderSlot {
  worker: Worker | null;
  pending: Map<number, PendingRead>;
}

export function workerLedgerReaderPool(dbPath: string, { size }: { size: number }): LedgerReader {
  if (!Number.isInteger(size) || size < 1) throw new Error("ledger reader pool size must be a positive integer");
  let closing = false;
  let nextId = 1;
  const slots: ReaderSlot[] = Array.from({ length: size }, () => ({ worker: null, pending: new Map() }));

  function rejectPending(slot: ReaderSlot, error: Error): void {
    for (const pending of slot.pending.values()) pending.reject(error);
    slot.pending.clear();
  }

  function spawn(slot: ReaderSlot): void {
    const url = new URL(import.meta.url);
    url.pathname = `${url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1)}worker${url.pathname.endsWith(".ts") ? ".ts" : ".js"}`;
    url.search = "";
    url.hash = "";
    const worker = new Worker(url, {
      workerData: { dbPath },
      execArgv: process.execArgv.filter(arg => arg !== "--input-type=module"),
    });
    slot.worker = worker;
    worker.on("message", (message: LedgerReadResponse) => {
      const pending = slot.pending.get(message.id);
      if (!pending) return;
      slot.pending.delete(message.id);
      if (message.ok) pending.resolve(message.value);
      else pending.reject(new Error(message.message));
    });
    worker.on("error", error => rejectPending(slot, error));
    worker.on("exit", code => {
      slot.worker = null;
      rejectPending(slot, new Error(`ledger reader worker exited with code ${code}`));
    });
  }

  for (const slot of slots) spawn(slot);

  return {
    run<K extends LedgerReadKind>(kind: K, params: LedgerReadParams<K>): Promise<LedgerReadResult<K>> {
      if (closing) return Promise.reject(new Error("ledger reader pool is closing"));
      const slot = slots.reduce((best, candidate) => candidate.pending.size < best.pending.size ? candidate : best);
      if (!slot.worker) spawn(slot);
      const id = nextId++;
      return new Promise((resolve, reject) => {
        slot.pending.set(id, { resolve: value => resolve(value as LedgerReadResult<K>), reject });
        try {
          slot.worker!.postMessage({ id, kind, params });
        } catch (error) {
          slot.pending.delete(id);
          reject(error);
        }
      });
    },
    async close() {
      closing = true;
      await Promise.all(slots.map(async slot => {
        rejectPending(slot, new Error("ledger reader pool stopped"));
        if (slot.worker) await slot.worker.terminate();
      }));
    },
  };
}
