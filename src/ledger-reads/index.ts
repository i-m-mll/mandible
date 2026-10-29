import { randomUUID } from "node:crypto";
import { fullTextQueryKey, isFullTextSearch, pendingSearch, type SearchUpdate, type SearchQuery } from "../conversations/full-text-search-jobs.js";
import { FULL_TEXT_SEARCH_OBSERVER_LEASE_MS, type FullTextSearchPending, type FullTextSearchProgress } from "../conversations/full-text-search-contract.js";
import { repairConversationSourceReadiness } from "../ingestion.js";
import { Worker } from "node:worker_threads";
import { getDb, type Db } from "../db.js";
import { isConversationRead, runLedgerRead, type LedgerReadKind, type LedgerReadParams, type LedgerReadResult, type LedgerReadResponse } from "./registry.js";
export type { LedgerReadKind, LedgerReadParams, LedgerReadResult } from "./registry.js";
export interface LedgerReader {
  run<K extends LedgerReadKind>(kind: K, params: LedgerReadParams<K>, options?: {
    signal?: AbortSignal;
  }): Promise<LedgerReadResult<K>>;
  close(): Promise<void>;
}
/** Tests explicitly choose the calling thread's injected, often in-memory database. */
export function inlineLedgerReader(database: () => Db = getDb): LedgerReader {
  return {
    async run<K extends LedgerReadKind>(kind: K, params: LedgerReadParams<K>): Promise<LedgerReadResult<K>> {
      return await runLedgerRead(database(), kind, params);
    },
    async close() { },
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
export function workerLedgerReaderPool(dbPath: string, { size }: {
  size: number;
}): LedgerReader {
  if (!Number.isInteger(size) || size < 1)
    throw new Error("ledger reader pool size must be a positive integer");
  let closing = false;
  let nextId = 1;
  const slots: ReaderSlot[] = Array.from({ length: size }, () => ({ worker: null, pending: new Map() }));
  const conversationSlot: ReaderSlot = { worker: null, pending: new Map() };
  const allSlots = [...slots, conversationSlot];
  interface Mirror {
    key: string;
    update: SearchUpdate;
    observers: Map<string, number>;
    query: SearchQuery;
    kind: LedgerReadKind;
    accessed: number;
    progress:FullTextSearchProgress;
  }
  const searches = new Map<string, Mirror>();
  const searchKeys = new Map<string, string>();
  function mirrorResult(update: SearchUpdate): {
    status: number;
    json: string;
  } {
    return { status: update.state === "pending" ? 202 : update.state === "complete" ? 200 : 409, json: JSON.stringify(update) };
  }
  function workerRun<K extends LedgerReadKind>(slot: ReaderSlot, kind: K, params: LedgerReadParams<K>): Promise<LedgerReadResult<K>> {
    if (!slot.worker)
      spawn(slot);
    const id = nextId++;
    return new Promise((resolve, reject) => {
      slot.pending.set(id, { resolve: value => resolve(value as LedgerReadResult<K>), reject });
      try {
        slot.worker!.postMessage({ id, kind, params });
      }
      catch (error) {
        slot.pending.delete(id);
        reject(error);
      }
    });
  }
  function releaseObserver(searchId: string, observer: string): void {
    const mirror = searches.get(searchId);
    if (!mirror)
      return;
    mirror.observers.delete(observer);
    void workerRun(conversationSlot, mirror.kind, { query: { ...mirror.query, search_id: searchId, observer_token: observer, cancel: "true" } } as LedgerReadParams<typeof mirror.kind>).catch(() => { });
  }
  const leaseTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, mirror] of searches) {
      for (const [token, expiry] of mirror.observers)
        if (expiry <= now)
          releaseObserver(id, token);
      if (now - mirror.accessed > 300000) {
        searches.delete(id);
        if (searchKeys.get(mirror.key) === id)
          searchKeys.delete(mirror.key);
      }
    }
  }, 1000);
  leaseTimer.unref();
  function rejectPending(slot: ReaderSlot, error: Error): void {
    for (const pending of slot.pending.values())
      pending.reject(error);
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
    worker.on("message", (message: LedgerReadResponse | {
      kind: "search_update";
      update: SearchUpdate;
    } | {
      kind: "source_repair";
      id: number;
      conversationId: string;
    }) => {
      if ("kind" in message) {
        if (message.kind === "search_update") {
          const mirror = searches.get(message.update.search_id);
          if (mirror) {
            mirror.update = message.update;
            if(message.update.state === "pending")mirror.progress={...message.update.progress};
          }
        }
        else {
          void repairConversationSourceReadiness(getDb(), message.conversationId, { priority: false }).then(() => {
            if (slot.worker === worker)
              worker.postMessage({ kind: "source_repair_done", id: message.id });
          }, () => {
            if (slot.worker === worker)
              worker.postMessage({ kind: "source_repair_done", id: message.id });
          });
        }
        return;
      }
      const pending = slot.pending.get(message.id);
      if (!pending)
        return;
      slot.pending.delete(message.id);
      if (message.ok)
        pending.resolve(message.value);
      else
        pending.reject(new Error(message.message));
    });
    worker.on("error", error => rejectPending(slot, error));
    worker.on("exit", code => {
      if (slot.worker !== worker)
        return;
      slot.worker = null;
      if (slot === conversationSlot)
        for (const [searchId, mirror] of searches) {
          mirror.update = { state: "expired", search_id: searchId, reason: "worker_restarted", coverage: { ...mirror.progress, failed: 0, complete: false } };
        }
      rejectPending(slot, new Error(`ledger reader worker exited with code ${code}`));
    });
  }
  for (const slot of slots)
    spawn(slot);
  return {
    run<K extends LedgerReadKind>(kind: K, params: LedgerReadParams<K>, options?: {
      signal?: AbortSignal;
    }): Promise<LedgerReadResult<K>> {
      if (closing)
        return Promise.reject(new Error("ledger reader pool is closing"));
      const query = "query" in params ? params.query as SearchQuery : undefined;
      if (query && isFullTextSearch(kind, query)) {
        const key = fullTextQueryKey(kind, query);
        const requested = query.search_id;
        const previousId = searchKeys.get(key);
        if (previousId && searches.get(previousId)?.update.state !== "pending")
          searchKeys.delete(key);
        const searchId = requested || searchKeys.get(key) || randomUUID();
        let mirror = searches.get(searchId);
        const observer = query.observer_token || randomUUID();
        if (!mirror && !requested) {
          const active = [...searches.values()].filter(item => item.update.state === "pending").length;
          if (active >= 9)
            return Promise.resolve(mirrorResult({ state: "incomplete", search_id: searchId, reason: "admission_full", coverage: { eligible: 0, prepared: 0, scanned: 0, matched: 0, failed: 0, complete: false } }) as LedgerReadResult<K>);
          if (searches.size >= 128)
            for (const [id, item] of searches)
              if (item.update.state !== "pending") {
                searches.delete(id);
                if (searchKeys.get(item.key) === id)
                  searchKeys.delete(item.key);
                if (searches.size < 128)
                  break;
              }
          mirror = { key, update: pendingSearch(searchId, observer), observers: new Map(), query: { ...query }, kind, accessed: Date.now(),progress:{eligible:0,prepared:0,scanned:0,matched:0} };
          searches.set(searchId, mirror);
          searchKeys.set(key, searchId);
          void workerRun(conversationSlot, kind, { query: { ...query, search_id: searchId, observer_token: observer }, searchStart: true } as LedgerReadParams<K>).then(value => {
            const result = value as {
              status: number;
              json: string;
            };
            const body = JSON.parse(result.json) as SearchUpdate;
            if (mirror && mirror.update.state === "pending")
              mirror.update = body;
          }, () => {
            if (mirror)
              mirror.update = { state: "expired", search_id: searchId, reason: "worker_restarted", coverage: { ...mirror.progress, failed: 0, complete: false } };
          });
        }
        if (!mirror && requested)
          return Promise.resolve(mirrorResult({ state: "expired", search_id: searchId, reason: "snapshot_expired", coverage: { eligible: 0, prepared: 0, scanned: 0, matched: 0, failed: 0, complete: false } }) as LedgerReadResult<K>);
        if (mirror) {
          mirror.accessed = Date.now();
          if (mirror.key !== key)
            return Promise.resolve(mirrorResult({ state: "superseded", search_id: searchId, reason: "query_mismatch", coverage: { eligible: 0, prepared: 0, scanned: 0, matched: 0, failed: 0, complete: false } }) as LedgerReadResult<K>);
          if (query.cancel === "true") {
            releaseObserver(searchId, observer);
            return Promise.resolve(mirrorResult({ state: "incomplete", search_id: searchId, reason: "cancelled", coverage: { ...mirror.progress, failed: 0, complete: false } }) as LedgerReadResult<K>);
          }
          else {
            if (mirror.update.state === "pending") {
              if (!mirror.observers.has(observer) && mirror.observers.size >= 128)
                return Promise.resolve(mirrorResult({ state: "incomplete", search_id: searchId, reason: "admission_full", coverage: { eligible: 0, prepared: 0, scanned: 0, matched: 0, failed: 0, complete: false } }) as LedgerReadResult<K>);
              mirror.observers.set(observer, Date.now() + FULL_TEXT_SEARCH_OBSERVER_LEASE_MS);
            }
            if (options?.signal?.aborted)
              releaseObserver(searchId, observer);
            else
              options?.signal?.addEventListener("abort", () => releaseObserver(searchId, observer), { once: true });
          }
          if (mirror.update.state === "pending") {
            void workerRun(conversationSlot, kind, { query: { ...query, search_id: searchId, observer_token: observer } } as LedgerReadParams<K>).catch(() => { });
            return Promise.resolve(mirrorResult({ ...mirror.update, observer_token: observer } as FullTextSearchPending) as LedgerReadResult<K>);
          }
          if (mirror.update.state !== "complete")
            return Promise.resolve(mirrorResult(mirror.update) as LedgerReadResult<K>);
        }
        return workerRun(conversationSlot, kind, { query: { ...query, search_id: searchId, observer_token: observer } } as LedgerReadParams<K>).then(value => {
          const result = value as {
            json: string;
          };
          const body = JSON.parse(result.json) as SearchUpdate;
          if (mirror && (body.state === "expired" || (body.state === "superseded" && body.reason !== "query_mismatch")))
            mirror.update = body;
          return value;
        });
      }
      const slot = isConversationRead(kind) ? conversationSlot : slots.reduce((best, candidate) => candidate.pending.size < best.pending.size ? candidate : best);
      return workerRun(slot, kind, params);
    },
    async close() {
      closing = true;
      clearInterval(leaseTimer);
      await Promise.all(allSlots.map(async (slot) => {
        rejectPending(slot, new Error("ledger reader pool stopped"));
        if (slot.worker)
          await slot.worker.terminate();
      }));
    },
  };
}
