// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DETAIL_CACHE_LIMITS,
  clearPersistedDetailCache,
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

  it('bounds snapshots by namespace, total count and bytes while preserving recently read entries', () => {
    const limits = DETAIL_CACHE_LIMITS;
    for (let i = 0; i < limits.maxEntriesPerNamespace; i++) writePersistedDetail('issue', String(i), { i });
    expect(readPersistedDetail('issue', '0')).toEqual({ i: 0 });
    writePersistedDetail('issue', 'new', { i: 'new' });
    expect(readPersistedDetail('issue', '0')).toEqual({ i: 0 });
    expect(readPersistedDetail('issue', '1')).toBeNull();
    for (let i = 0; i < limits.maxEntries + 5; i++) writePersistedDetail(`space-${i}`, 'one', { i });
    let index = JSON.parse(window.localStorage.getItem('mandible:detail-cache:v2')!);
    expect(index.entries).toHaveLength(limits.maxEntries);
    const payload = 'x'.repeat(1_000_000);
    for (let i = 0; i < 5; i++) writePersistedDetail(`big-${i}`, 'one', payload);
    index = JSON.parse(window.localStorage.getItem('mandible:detail-cache:v2')!);
    expect(index.entries.reduce((sum: number, entry: { bytes: number }) => sum + entry.bytes, 0)).toBeLessThanOrEqual(limits.maxTotalBytes);
    expect(readPersistedDetail('big-0', 'one')).toBeNull();
    expect(readPersistedDetail('big-4', 'one')).toBe(payload);
  });

  it('returns no snapshot after quota refusal or a corrupted value', () => {
    setItemSpy.mockImplementationOnce(() => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); });
    expect(writePersistedDetail('issue', 'quota', { title: 'Unsaved' })).toBe(false);
    expect(readPersistedDetail('issue', 'quota')).toBeNull();
    expect(writePersistedDetail('issue', 'corrupt', { title: 'Saved' })).toBe(true);
    const index = JSON.parse(window.localStorage.getItem('mandible:detail-cache:v2')!);
    window.localStorage.setItem(index.entries[0].storageKey, '{broken');
    expect(readPersistedDetail('issue', 'corrupt')).toBeNull();
  });

  it('rejects oversized and unserializable snapshots without retaining a second payload cache', async () => {
    const huge = 'x'.repeat(DETAIL_CACHE_LIMITS.maxEntryBytes + 1);
    expect(writePersistedDetail('conversation', 'huge', huge)).toBe(false);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(writePersistedDetail('conversation', 'circular', circular)).toBe(false);
    expect(readPersistedDetail('conversation', 'circular')).toBeNull();
    expect(readPersistedDetail('conversation', 'huge')).toBeNull();
  });
});
