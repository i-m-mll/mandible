// Browser-local detail cache keys. Refetchable data never moves between origins.
const DETAIL_CACHE_INDEX_KEY = "mandible:detail-cache:v2";
const DETAIL_CACHE_ENTRY_KEY_PREFIX = `${DETAIL_CACHE_INDEX_KEY}:e:`;
const LEGACY_DETAIL_CACHE_KEY = "mandible:detail-cache:v1";

// The index holds only lightweight per-entry metadata. Each cached value lives
// in its own `${ENTRY_KEY_PREFIX}<id>` key so a read parses the small index plus
// exactly one value blob, never the whole cross-namespace envelope.
const INDEX_KEY = DETAIL_CACHE_INDEX_KEY;
const ENTRY_KEY_PREFIX = DETAIL_CACHE_ENTRY_KEY_PREFIX;
const LEGACY_KEYS = [LEGACY_DETAIL_CACHE_KEY];
const CACHE_VERSION = 2;

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

const MAX_ENTRIES = 48;
const MAX_ENTRIES_PER_NAMESPACE = 6;
const MAX_ENTRY_BYTES = 1_500_000;
const MAX_TOTAL_BYTES = 4_000_000;

type IndexEntry = {
  namespace: string;
  key: string;
  storageKey: string;
  storedAt: number;
  accessedAt: number;
  expiresAt: number;
  bytes: number;
};

type CacheIndex = {
  version: number;
  nextId: number;
  entries: IndexEntry[];
};

// Read accesses only bump recency in memory; the write path flushes them so the
// click path never does a multi-MB stringify just to record accessedAt.
const pendingAccess = new Map<string, number>();
let accessClock = 0;
let legacyPurged = false;

function accessKey(namespace: string, key: string): string {
  return `${namespace}\u0000${key}`;
}

function nextAccessStamp(now: number): number {
  accessClock = Math.max(now, accessClock + 1);
  return accessClock;
}

function browserStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function purgeLegacyOnce(storage: Storage): void {
  if (legacyPurged) return;
  legacyPurged = true;
  for (const key of LEGACY_KEYS) {
    try {
      storage.removeItem(key);
    } catch {
      // Best-effort reclamation of the old single-envelope cache.
    }
  }
}

function collectManagedKeys(storage: Storage): string[] {
  const keys: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const name = storage.key(index);
      if (name && (name === INDEX_KEY || name.startsWith(ENTRY_KEY_PREFIX))) {
        keys.push(name);
      }
    }
  } catch {
    // If enumeration fails we fall back to removing the index key alone.
  }
  return keys;
}

function purgeAll(storage: Storage): void {
  for (const name of collectManagedKeys(storage)) {
    try {
      storage.removeItem(name);
    } catch {
      // Browser persistence is an optional stale tier.
    }
  }
  try {
    storage.removeItem(INDEX_KEY);
  } catch {
    // Ignore.
  }
}

function emptyIndex(): CacheIndex {
  return { version: CACHE_VERSION, nextId: 1, entries: [] };
}

function isIndexEntry(entry: unknown): entry is IndexEntry {
  if (!entry || typeof entry !== 'object') return false;
  const candidate = entry as Record<string, unknown>;
  return (
    typeof candidate.namespace === 'string' &&
    typeof candidate.key === 'string' &&
    typeof candidate.storageKey === 'string' &&
    candidate.storageKey.startsWith(ENTRY_KEY_PREFIX) &&
    typeof candidate.storedAt === 'number' &&
    typeof candidate.accessedAt === 'number' &&
    typeof candidate.expiresAt === 'number' &&
    typeof candidate.bytes === 'number'
  );
}

// Reads the metadata index without pruning expired rows: the write path relies
// on seeing expired entries so it can delete their orphaned value blobs.
function readIndex(storage: Storage): CacheIndex {
  purgeLegacyOnce(storage);
  let raw: string | null;
  try {
    raw = storage.getItem(INDEX_KEY);
  } catch {
    return emptyIndex();
  }
  if (!raw) return emptyIndex();
  try {
    const parsed = JSON.parse(raw) as Partial<CacheIndex>;
    if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.entries)) {
      purgeAll(storage);
      return emptyIndex();
    }
    const entries = parsed.entries.filter(isIndexEntry);
    const maxId = entries.reduce((max, entry) => {
      const id = Number(entry.storageKey.slice(ENTRY_KEY_PREFIX.length));
      return Number.isFinite(id) && id > max ? id : max;
    }, 0);
    const nextId = typeof parsed.nextId === 'number' && parsed.nextId > maxId
      ? parsed.nextId
      : maxId + 1;
    return { version: CACHE_VERSION, nextId, entries };
  } catch {
    purgeAll(storage);
    return emptyIndex();
  }
}

function applyPendingAccess(index: CacheIndex): void {
  if (pendingAccess.size === 0) return;
  for (const entry of index.entries) {
    const stamp = pendingAccess.get(accessKey(entry.namespace, entry.key));
    if (stamp !== undefined && stamp > entry.accessedAt) {
      entry.accessedAt = stamp;
    }
  }
  pendingAccess.clear();
}

function serialize(value: unknown): string | null {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return null;
  }
  return typeof serialized === 'string' ? serialized : null;
}

export function readPersistedDetail<T>(namespace: string, key: string): T | null {
  const now = Date.now();
  const storage = browserStorage();
  if (!storage) return null;
  const index = readIndex(storage);
  const entry = index.entries.find((candidate) => (
    candidate.namespace === namespace && candidate.key === key
  ));
  if (!entry || entry.expiresAt <= now) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(entry.storageKey);
  } catch {
    return null;
  }
  if (raw == null) return null;
  let value: T;
  try {
    value = JSON.parse(raw) as T;
  } catch {
    return null;
  }
  // Batch the recency bump in memory; do not write back on the read path.
  pendingAccess.set(accessKey(namespace, key), nextAccessStamp(now));
  return value;
}

export function writePersistedDetail(
  namespace: string,
  key: string,
  value: unknown,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
): boolean {
  const serialized = serialize(value);
  if (serialized === null) return false;
  const now = Date.now();
  const storage = browserStorage();
  if (!storage) return false;
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > MAX_ENTRY_BYTES) return false;

  const index = readIndex(storage);
  applyPendingAccess(index);

  // Drop expired rows and any prior copy of this key, reclaiming their blobs.
  const staleKeys: string[] = [];
  index.entries = index.entries.filter((entry) => {
    if (entry.expiresAt <= now || (entry.namespace === namespace && entry.key === key)) {
      staleKeys.push(entry.storageKey);
      return false;
    }
    return true;
  });

  const id = index.nextId;
  index.nextId += 1;
  const newEntry: IndexEntry = {
    namespace,
    key,
    storageKey: `${ENTRY_KEY_PREFIX}${id}`,
    storedAt: now,
    accessedAt: nextAccessStamp(now),
    expiresAt: now + Math.max(1, maxAgeMs),
    bytes,
  };
  index.entries.push(newEntry);

  // Evict newest-first under the per-namespace count cap and the global caps.
  const newestFirst = [...index.entries].sort((left, right) => right.accessedAt - left.accessedAt);
  const namespaceCounts = new Map<string, number>();
  const survivors: IndexEntry[] = [];
  let totalBytes = 0;
  for (const entry of newestFirst) {
    const namespaceCount = namespaceCounts.get(entry.namespace) ?? 0;
    if (
      namespaceCount >= MAX_ENTRIES_PER_NAMESPACE ||
      survivors.length >= MAX_ENTRIES ||
      totalBytes + entry.bytes > MAX_TOTAL_BYTES
    ) {
      staleKeys.push(entry.storageKey);
      continue;
    }
    namespaceCounts.set(entry.namespace, namespaceCount + 1);
    totalBytes += entry.bytes;
    survivors.push(entry);
  }
  index.entries = survivors;

  const retained = survivors.includes(newEntry);
  if (!retained) {
    // The new value does not fit the budget; persist the pruning only.
    flush(storage, index, staleKeys);
    return false;
  }

  try {
    storage.setItem(newEntry.storageKey, serialized);
  } catch {
    // Quota or privacy mode: back the new entry out and keep the cache coherent.
    index.entries = survivors.filter((entry) => entry !== newEntry);
    flush(storage, index, staleKeys);
    return false;
  }
  flush(storage, index, staleKeys);
  return true;
}

function flush(storage: Storage, index: CacheIndex, staleKeys: string[]): void {
  for (const staleKey of staleKeys) {
    try {
      storage.removeItem(staleKey);
    } catch {
      // Orphaned blobs are reclaimed on the next clear/prefix sweep.
    }
  }
  try {
    storage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    // A failed index write leaves the prior index in place; live data is safe.
  }
}

export function removePersistedDetail(namespace: string, key: string): void {
  pendingAccess.delete(accessKey(namespace, key));
  const storage = browserStorage();
  if (!storage) return;
  const index = readIndex(storage);
  const removed = index.entries.filter((entry) => entry.namespace === namespace && entry.key === key);
  index.entries = index.entries.filter((entry) => entry.namespace !== namespace || entry.key !== key);
  flush(storage, index, removed.map((entry) => entry.storageKey));
}

export function clearPersistedDetailCache(): void {
  pendingAccess.clear();
  const storage = browserStorage();
  if (!storage) return;
  purgeAll(storage);
  for (const key of LEGACY_KEYS) {
    try {
      storage.removeItem(key);
    } catch {
      // Best-effort invalidation only.
    }
  }
}

export const DETAIL_CACHE_LIMITS = {
  maxAgeMs: DEFAULT_MAX_AGE_MS,
  maxEntries: MAX_ENTRIES,
  maxEntriesPerNamespace: MAX_ENTRIES_PER_NAMESPACE,
  maxEntryBytes: MAX_ENTRY_BYTES,
  maxTotalBytes: MAX_TOTAL_BYTES,
} as const;
