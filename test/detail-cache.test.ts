// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DETAIL_CACHE_LIMITS,
  clearPersistedDetailCache,
  detailRequestKey,
  readPersistedDetail,
  writePersistedDetail,
} from '../ui/src/detail-cache';

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

  it('keeps oversized payloads for this page only and rejects unserializable ones', async () => {
    const huge = 'x'.repeat(DETAIL_CACHE_LIMITS.maxEntryBytes + 1);
    expect(writePersistedDetail('conversation', 'huge', huge)).toBe(false);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(writePersistedDetail('conversation', 'circular', circular)).toBe(false);
    expect(readPersistedDetail('conversation', 'circular')).toBeNull();
    expect(readPersistedDetail('conversation', 'huge')).toBe(huge);
    vi.resetModules();
    const reloaded = await import('../ui/src/detail-cache');
    expect(reloaded.readPersistedDetail('conversation', 'huge')).toBeNull();
  });
});
