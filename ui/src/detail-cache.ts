const STORAGE_KEY = 'mandible:detail-cache:v1';
const CACHE_VERSION = 1;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_ENTRIES = 12;
const MAX_ENTRIES_PER_NAMESPACE = 2;
const MAX_ENTRY_BYTES = 1_000_000;
const MAX_TOTAL_BYTES = 3_500_000;

type PersistedEntry = {
  namespace: string;
  key: string;
  storedAt: number;
  accessedAt: number;
  expiresAt: number;
  bytes: number;
  value: unknown;
};

type PersistedEnvelope = {
  version: number;
  entries: PersistedEntry[];
};

function browserStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function emptyEnvelope(): PersistedEnvelope {
  return { version: CACHE_VERSION, entries: [] };
}

function readEnvelope(now = Date.now()): PersistedEnvelope {
  const storage = browserStorage();
  if (!storage) return emptyEnvelope();
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return emptyEnvelope();
    const parsed = JSON.parse(raw) as Partial<PersistedEnvelope>;
    if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.entries)) {
      storage.removeItem(STORAGE_KEY);
      return emptyEnvelope();
    }
    return {
      version: CACHE_VERSION,
      entries: parsed.entries.filter((entry): entry is PersistedEntry => (
        !!entry &&
        typeof entry.namespace === 'string' &&
        typeof entry.key === 'string' &&
        typeof entry.expiresAt === 'number' &&
        entry.expiresAt > now &&
        typeof entry.accessedAt === 'number' &&
        typeof entry.bytes === 'number'
      )),
    };
  } catch {
    try {
      storage.removeItem(STORAGE_KEY);
    } catch {
      // Browser persistence is an optional stale tier.
    }
    return emptyEnvelope();
  }
}

function writeEnvelope(envelope: PersistedEnvelope): boolean {
  const storage = browserStorage();
  if (!storage) return false;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(envelope));
    return true;
  } catch {
    // Quota, privacy mode, and serialization failures must never block live data.
    return false;
  }
}

function serializedBytes(value: unknown): number | null {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return null;
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

export function detailRequestKey(namespace: string, request: unknown): string {
  return `${namespace}:${JSON.stringify(stableValue(request))}`;
}

export function readPersistedDetail<T>(namespace: string, key: string): T | null {
  const now = Date.now();
  const envelope = readEnvelope(now);
  const entry = envelope.entries.find((candidate) => (
    candidate.namespace === namespace && candidate.key === key
  ));
  if (!entry) return null;
  entry.accessedAt = Math.max(now, ...envelope.entries.map((candidate) => candidate.accessedAt + 1));
  writeEnvelope(envelope);
  return entry.value as T;
}

export function writePersistedDetail(
  namespace: string,
  key: string,
  value: unknown,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
): boolean {
  const bytes = serializedBytes(value);
  if (bytes === null || bytes > MAX_ENTRY_BYTES) return false;
  const now = Date.now();
  const envelope = readEnvelope(now);
  const accessedAt = Math.max(now, ...envelope.entries.map((entry) => entry.accessedAt + 1));
  envelope.entries = envelope.entries.filter((entry) => !(
    entry.namespace === namespace && entry.key === key
  ));
  envelope.entries.push({
    namespace,
    key,
    storedAt: now,
    accessedAt,
    expiresAt: now + Math.max(1, maxAgeMs),
    bytes,
    value,
  });

  const newestFirst = [...envelope.entries].sort((left, right) => right.accessedAt - left.accessedAt);
  const namespaceCounts = new Map<string, number>();
  let totalBytes = 0;
  envelope.entries = newestFirst.filter((entry) => {
    const namespaceCount = namespaceCounts.get(entry.namespace) ?? 0;
    if (
      namespaceCount >= MAX_ENTRIES_PER_NAMESPACE ||
      totalBytes + entry.bytes > MAX_TOTAL_BYTES ||
      totalBytes >= MAX_TOTAL_BYTES
    ) return false;
    namespaceCounts.set(entry.namespace, namespaceCount + 1);
    totalBytes += entry.bytes;
    return true;
  }).slice(0, MAX_ENTRIES);
  const retained = envelope.entries.some((entry) => entry.namespace === namespace && entry.key === key);
  return retained && writeEnvelope(envelope);
}

export function clearPersistedDetailCache(): void {
  try {
    browserStorage()?.removeItem(STORAGE_KEY);
  } catch {
    // Best-effort invalidation only.
  }
}

export const DETAIL_CACHE_LIMITS = {
  maxAgeMs: DEFAULT_MAX_AGE_MS,
  maxEntries: MAX_ENTRIES,
  maxEntriesPerNamespace: MAX_ENTRIES_PER_NAMESPACE,
  maxEntryBytes: MAX_ENTRY_BYTES,
  maxTotalBytes: MAX_TOTAL_BYTES,
} as const;
