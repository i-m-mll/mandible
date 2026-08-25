import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DETAIL_CACHE_LIMITS,
  clearPersistedDetailCache,
  detailRequestKey,
  readPersistedDetail,
  writePersistedDetail,
} from '../../ui/src/detail-cache';

let setItemSpy: ReturnType<typeof vi.fn>;

function installMemoryLocalStorage(): void {
  const values = new Map<string, string>();
  setItemSpy = vi.fn((key: string, value: string) => values.set(key, value));
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      get length() { return values.size; },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => setItemSpy(key, value),
    } satisfies Storage,
  });
}

describe('persisted detail cache', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    window.localStorage.clear();
    clearPersistedDetailCache();
    vi.useRealTimers();
  });

  it('builds stable request keys without conflating different selections', () => {
    expect(detailRequestKey('issue', { repo: 'mandible', id: 'abc' })).toBe(
      detailRequestKey('issue', { id: 'abc', repo: 'mandible' }),
    );
    expect(detailRequestKey('issue', { id: 'abc' })).not.toBe(
      detailRequestKey('issue', { id: 'def' }),
    );
  });

  it('expires entries and invalidates incompatible envelopes safely', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T12:00:00Z'));
    expect(writePersistedDetail('timeline', 'one', { rows: [1] }, 100)).toBe(true);
    expect(readPersistedDetail('timeline', 'one')).toEqual({ rows: [1] });

    vi.advanceTimersByTime(101);
    expect(readPersistedDetail('timeline', 'one')).toBeNull();

    window.localStorage.setItem('mandible:detail-cache:v2', JSON.stringify({ version: 999, entries: [] }));
    expect(readPersistedDetail('timeline', 'one')).toBeNull();
    expect(window.localStorage.getItem('mandible:detail-cache:v2')).toBeNull();
  });

  it('never writes to storage on the read path', () => {
    writePersistedDetail('graph', 'one', { id: 1 });
    setItemSpy.mockClear();
    expect(readPersistedDetail('graph', 'one')).toEqual({ id: 1 });
    expect(readPersistedDetail('graph', 'one')).toEqual({ id: 1 });
    expect(setItemSpy).not.toHaveBeenCalled();
  });

  it('stores each entry in its own key so unrelated namespaces are untouched', () => {
    writePersistedDetail('graph', 'g', { id: 'g' });
    writePersistedDetail('timeline', 't', { id: 't' });
    setItemSpy.mockClear();
    // Writing a new conversation must not re-serialize graph/timeline blobs.
    writePersistedDetail('conversations', 'c', { id: 'c' });
    const writtenKeys = setItemSpy.mock.calls.map((call) => call[0] as string);
    // Exactly the new value blob plus the shared index are written.
    expect(writtenKeys).toContain('mandible:detail-cache:v2');
    expect(writtenKeys.filter((key) => key.startsWith('mandible:detail-cache:v2:e:'))).toHaveLength(1);
    expect(readPersistedDetail('graph', 'g')).toEqual({ id: 'g' });
    expect(readPersistedDetail('timeline', 't')).toEqual({ id: 't' });
    expect(readPersistedDetail('conversations', 'c')).toEqual({ id: 'c' });
  });

  it('keeps only the most recently accessed bounded entries per namespace', () => {
    const cap = DETAIL_CACHE_LIMITS.maxEntriesPerNamespace;
    expect(cap).toBeGreaterThan(2);
    for (let i = 0; i < cap; i += 1) {
      writePersistedDetail('graph', `k${i}`, { id: i });
    }
    // Touch the oldest entry so recency, not insertion order, protects it.
    expect(readPersistedDetail('graph', 'k0')).toEqual({ id: 0 });
    // One more write exceeds the per-namespace cap and evicts the LRU entry.
    writePersistedDetail('graph', 'overflow', { id: 'overflow' });

    expect(readPersistedDetail('graph', 'k0')).toEqual({ id: 0 });
    expect(readPersistedDetail('graph', 'k1')).toBeNull();
    expect(readPersistedDetail('graph', 'overflow')).toEqual({ id: 'overflow' });
  });

  it('evicts across namespaces once the global byte budget is exceeded', () => {
    const chunk = 'x'.repeat(600_000);
    // Each ~600 KB entry lives in a distinct namespace, so per-namespace caps do
    // not evict; only the global total-bytes budget can.
    for (let i = 0; i < 8; i += 1) {
      expect(writePersistedDetail(`ns${i}`, 'blob', { chunk, i })).toBe(true);
    }
    // 8 * 600 KB = 4.8 MB exceeds the 4 MB budget, so the oldest are gone.
    expect(readPersistedDetail('ns0', 'blob')).toBeNull();
    expect(readPersistedDetail('ns7', 'blob')).not.toBeNull();
  });

  it('rejects oversized or unserializable payloads without breaking live data', () => {
    expect(writePersistedDetail('conversation', 'huge', 'x'.repeat(DETAIL_CACHE_LIMITS.maxEntryBytes + 1))).toBe(false);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(writePersistedDetail('conversation', 'circular', circular)).toBe(false);
    expect(readPersistedDetail('conversation', 'huge')).toBeNull();
  });
});
