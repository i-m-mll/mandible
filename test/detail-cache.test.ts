import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DETAIL_CACHE_LIMITS,
  clearPersistedDetailCache,
  detailRequestKey,
  readPersistedDetail,
  writePersistedDetail,
} from '../ui/src/detail-cache';

function installMemoryLocalStorage(): void {
  const values = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      get length() { return values.size; },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
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

    window.localStorage.setItem('mandible:detail-cache:v1', JSON.stringify({ version: 999, entries: [] }));
    expect(readPersistedDetail('timeline', 'one')).toBeNull();
    expect(window.localStorage.getItem('mandible:detail-cache:v1')).toBeNull();
  });

  it('keeps only the most recently accessed bounded entries per view', () => {
    expect(DETAIL_CACHE_LIMITS.maxEntriesPerNamespace).toBe(2);
    writePersistedDetail('graph', 'one', { id: 1 });
    writePersistedDetail('graph', 'two', { id: 2 });
    expect(readPersistedDetail('graph', 'one')).toEqual({ id: 1 });
    writePersistedDetail('graph', 'three', { id: 3 });

    expect(readPersistedDetail('graph', 'one')).toEqual({ id: 1 });
    expect(readPersistedDetail('graph', 'two')).toBeNull();
    expect(readPersistedDetail('graph', 'three')).toEqual({ id: 3 });
  });

  it('rejects oversized or unserializable payloads without breaking live data', () => {
    expect(writePersistedDetail('conversation', 'huge', 'x'.repeat(DETAIL_CACHE_LIMITS.maxEntryBytes + 1))).toBe(false);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(writePersistedDetail('conversation', 'circular', circular)).toBe(false);
    expect(readPersistedDetail('conversation', 'huge')).toBeNull();
  });
});
