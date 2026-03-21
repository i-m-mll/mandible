// Bug: 2a54b51 — IndexedDB-backed stream event cache for instant hydration
// on tab switch / page reload. Uses raw IndexedDB API (no external deps).

import type { StreamEvent } from './components/stream-renderer/types';

const DB_NAME = 'mandible-stream-cache';
const DB_VERSION = 1;
const STORE_NAME = 'streams';

const DEFAULT_MAX_SESSIONS = 20;

let dbPromise: Promise<IDBDatabase> | null = null;

function getDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'sessionId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

export async function openStreamCache(): Promise<void> {
  await getDb();
}

type CacheRecord = {
  sessionId: string;
  events: StreamEvent[];
  updatedAt: number;
  sizeBytes: number;
};

export async function getCachedEvents(sessionId: string): Promise<StreamEvent[] | null> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(sessionId);
    request.onsuccess = () => {
      const record = request.result as CacheRecord | undefined;
      resolve(record ? record.events : null);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function setCachedEvents(sessionId: string, events: StreamEvent[]): Promise<void> {
  const db = await getDb();
  const json = JSON.stringify(events);
  const sizeBytes = new Blob([json]).size;
  const record: CacheRecord = {
    sessionId,
    events,
    updatedAt: Date.now(),
    sizeBytes,
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(record);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => {
      // Trigger LRU eviction after write
      void evictLRU(DEFAULT_MAX_SESSIONS);
    };
  });
}

export async function clearCachedEvents(sessionId: string): Promise<void> {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(sessionId);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function evictLRU(maxSessions?: number, maxSizeBytes?: number): Promise<void> {
  const limit = maxSessions ?? DEFAULT_MAX_SESSIONS;
  const db = await getDb();

  const records = await new Promise<CacheRecord[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result as CacheRecord[]);
    request.onerror = () => reject(request.error);
  });

  if (records.length <= limit && !maxSizeBytes) return;

  // Sort by updatedAt ascending (oldest first) for eviction
  records.sort((a, b) => a.updatedAt - b.updatedAt);

  const toDelete: string[] = [];

  // Evict by count
  while (records.length - toDelete.length > limit) {
    const victim = records[toDelete.length];
    toDelete.push(victim.sessionId);
  }

  // Evict by total size if maxSizeBytes specified
  if (maxSizeBytes) {
    let totalSize = records.reduce((sum, r) => sum + r.sizeBytes, 0);
    // Remove already-scheduled deletions from total
    for (const id of toDelete) {
      const r = records.find((rec) => rec.sessionId === id);
      if (r) totalSize -= r.sizeBytes;
    }
    let idx = 0;
    while (totalSize > maxSizeBytes && idx < records.length) {
      const candidate = records[idx];
      if (!toDelete.includes(candidate.sessionId)) {
        toDelete.push(candidate.sessionId);
        totalSize -= candidate.sizeBytes;
      }
      idx++;
    }
  }

  if (toDelete.length === 0) return;

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    for (const id of toDelete) {
      store.delete(id);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
