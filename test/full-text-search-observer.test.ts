import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFullTextSearch } from '../ui/src/query/fullTextSearch';
import type { FullTextSearchPending, FullTextSearchResponse } from '../src/conversations/full-text-search-contract';

const progress = { eligible: 4, prepared: 4, scanned: 1, matched: 1 };
const pending: FullTextSearchPending = {
  state: 'pending', search_id: 'search-a', observer_token: 'observer-a',
  phase: 'scanning', progress, retry_after_ms: 400,
};
const coverage = { ...progress, scanned: 4, failed: 0, complete: true as const };
const complete = { state: 'complete' as const, search_id: 'search-a', snapshot_id: 'search-a',
  coverage, rows: ['exact match'] };

afterEach(() => vi.useRealTimers());

describe('full-text search observers', () => {
  it('publishes only complete results, follows server pacing, backs off unchanged progress and releases its observer', async () => {
    vi.useFakeTimers();
    const request = vi.fn<() => Promise<FullTextSearchResponse<{ rows: string[] }>>>()
      .mockResolvedValueOnce(pending).mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(pending).mockResolvedValueOnce(complete);
    const release = vi.fn().mockResolvedValue(undefined);
    const onPending = vi.fn();
    const settled = vi.fn();
    const result = readFullTextSearch(request, release, { onPending }).then(value => { settled(value); return value; });
    await vi.advanceTimersByTimeAsync(399);
    expect(request).toHaveBeenCalledTimes(1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenLastCalledWith({ search_id: 'search-a', observer_token: 'observer-a' });
    await vi.advanceTimersByTimeAsync(499);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual(complete);
    expect(onPending).toHaveBeenCalledTimes(3);
    expect(release).toHaveBeenCalledExactlyOnceWith({ search_id: 'search-a', observer_token: 'observer-a' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['incomplete', 'superseded', 'expired'] as const)('stops a %s job without retrying or fabricating rows', async state => {
    vi.useFakeTimers();
    const terminal = { state, search_id: 'search-a', reason: 'source_unavailable' as const,
      coverage: { ...coverage, failed: 1, complete: false } };
    const request = vi.fn().mockResolvedValueOnce(pending).mockResolvedValueOnce(terminal);
    const release = vi.fn().mockResolvedValue(undefined);
    const result = readFullTextSearch(request, release);
    await vi.advanceTimersByTimeAsync(400);
    expect(await result).toEqual(terminal);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts waiting immediately and refuses a completion arriving after cancellation', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let finish!: (value: typeof complete) => void;
    const request = vi.fn().mockResolvedValueOnce(pending).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const release = vi.fn().mockResolvedValue(undefined);
    const result = readFullTextSearch(request, release, { signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(400);
    controller.abort();
    finish(complete);
    await rejected;
    expect(release).toHaveBeenCalledExactlyOnceWith({ search_id: 'search-a', observer_token: 'observer-a' });
    expect(vi.getTimerCount()).toBe(0);

    const waiting = new AbortController();
    const second = readFullTextSearch(vi.fn().mockResolvedValue(pending), release, { signal: waiting.signal });
    const stopped = expect(second).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    waiting.abort();
    await stopped;
    expect(vi.getTimerCount()).toBe(0);
  });
});
