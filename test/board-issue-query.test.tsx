// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from './helpers/dom';
import { AppShellProvider, useAppShell } from '../ui/src/app-shell';
import { queryClient } from '../ui/src/query/client';
import { boardIssueKey, useBoardIssueFacts } from '../ui/src/query/boardIssues';
import { invalidateDashboardApiCacheForEvent, invalidateDashboardCaches } from '../ui/src/api';
import { buildSpaceViewModel } from '../ui/src/views/spaces/collectionModel';
import { LIVE_REFRESH_MIN_INTERVAL_MS, LIVE_REFRESH_DEADLINE_MS } from '../ui/src/lib/coalesced-refresh';
import type { SpaceFactPacket } from '../ui/src/api';

const canonical = (name: string) => name.repeat(64);
function model(refs: string[]) {
  return buildSpaceViewModel({
    space: { id: 'board', project_id: 'space-project', metadata: {}, default_renderer: 'board' },
    items: refs.map((ref, index) => ({ id: `item-${index}`, ref_type: 'issue', ref_id: ref, ref_uri: null })),
    occurrences: refs.map((_, index) => ({ id: `occ-${index}`, item_id: `item-${index}`, renderer: 'board' })), edges: [],
  } as SpaceFactPacket);
}
function Pane({ value, active = true, name = 'facts' }: { value: ReturnType<typeof model>; active?: boolean; name?: string }) {
  const shell = useAppShell();
  return <AppShellProvider value={{ ...shell, active }}><Facts value={value} name={name} /></AppShellProvider>;
}
function Facts({ value, name }: { value: ReturnType<typeof model>; name: string }) {
  const { facts, failed, pending } = useBoardIssueFacts(value);
  return <div data-testid={name}>{JSON.stringify({ facts, errors: failed.length, pending })}</div>;
}
function result(ref: string, status = 'none') {
  return new Response(JSON.stringify({ resolution: { ref, kind: 'issue', resolved: true, entity: { id: ref.replace('issue:', ''), worker_status: status, kind: 'bug', labels: [] } } }));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function facts(name = 'facts') {
  return JSON.parse(screen.getByTestId(name).textContent!) as { facts: Record<string, { worker_status: string }>; errors: number; pending: boolean };
}
async function flushEvents() {
  await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_REFRESH_MIN_INTERVAL_MS + 1); });
}
beforeEach(() => { queryClient.clear(); });
afterEach(() => { cleanup(); queryClient.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Board issue Query lifecycle', () => {
  it('bounds admission, shares duplicates, publishes completed reads, and cancels only abandoned identities', async () => {
    const pending: { ref: string; signal: AbortSignal; task: ReturnType<typeof deferred<Response>> }[] = [];
    let inFlight = 0;
    let peak = 0;
    let immediate = false;
    const fetcher = vi.fn((url: string, init: RequestInit) => {
      const ref = new URL(url, 'http://test').searchParams.get('ref')!;
      if (immediate) return Promise.resolve(result(ref, 'blocked'));
      const signal = init.signal as AbortSignal;
      const task = deferred<Response>();
      const entry = { ref, signal, task };
      pending.push(entry);
      inFlight++;
      peak = Math.max(peak, inFlight);
      signal.addEventListener('abort', () => task.reject(signal.reason), { once: true });
      return task.promise.finally(() => { inFlight--; });
    });
    vi.stubGlobal('fetch', fetcher);
    const many = model(['a', 'b', 'c', 'd', 'e', 'f', 'a'].map(canonical));
    const one = model([canonical('a')]);
    const ui = render(<><Pane value={many} /><Pane value={one} name="second" /></>);
    await waitFor(() => expect(pending).toHaveLength(4));
    pending.find((entry) => entry.ref === `issue:${canonical('b')}`)!.task.resolve(result(`issue:${canonical('b')}`, 'done'));
    await waitFor(() => expect(facts().facts['item-1']?.worker_status).toBe('done'));
    expect(facts().facts['item-0']).toBeUndefined();
    await waitFor(() => expect(pending).toHaveLength(5));
    ui.rerender(<><Pane value={many} active={false} /><Pane value={one} name="second" /></>);
    await waitFor(() => expect(pending.filter((entry) => entry.signal.aborted)).toHaveLength(3));
    expect(pending[0].signal.aborted).toBe(false);
    expect(pending.some((entry) => entry.ref === `issue:${canonical('f')}`)).toBe(false);
    ui.rerender(<><Pane value={many} active={false} /><Pane value={one} name="second" active={false} /></>);
    await waitFor(() => expect(pending[0].signal.aborted).toBe(true));
    vi.useFakeTimers();
    invalidateDashboardCaches();
    await flushEvents();
    expect(pending).toHaveLength(5);
    immediate = true;
    ui.rerender(<><Pane value={many} /><Pane value={one} name="second" active={false} /></>);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(Object.keys(facts().facts)).toHaveLength(7);
    expect(peak).toBe(4);
    expect(fetcher.mock.calls.every(([url]) => url.startsWith('/api/spaces/resolve?'))).toBe(true);
  });

  it('keeps pending reads across packet replacement and performs one trailing refresh after a newer event burst', async () => {
    const first = deferred<Response>();
    const id = canonical('a');
    const fetcher = vi.fn((url: string) => fetcher.mock.calls.length === 1 ? first.promise : Promise.resolve(result(`issue:${id}`, 'blocked')));
    vi.stubGlobal('fetch', fetcher);
    const ui = render(<Pane value={model([id, id])} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    ui.rerender(<Pane value={model([id, id])} />);
    vi.useFakeTimers();
    for (let index = 0; index < 10; index++) invalidateDashboardApiCacheForEvent('ledger:issue:updated', { issue_id: id });
    await flushEvents();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { first.resolve(result(`issue:${id}`, 'none')); await vi.advanceTimersByTimeAsync(1); });
    await flushEvents();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(Object.values(facts().facts).map((entry) => entry.worker_status)).toEqual(['blocked', 'blocked']);
  });

  it('starts the read deadline after admission and reconciles an event after timeout without retrying indefinitely', async () => {
    const signals: AbortSignal[] = [];
    const id = canonical('a');
    const fetcher = vi.fn((_url: string, init: RequestInit) => {
      signals.push(init.signal as AbortSignal);
      return signals.length === 1 ? new Promise<Response>(() => {}) : Promise.resolve(result(`issue:${id}`, 'done'));
    });
    vi.stubGlobal('fetch', fetcher);
    vi.useFakeTimers();
    render(<Pane value={model([id])} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    invalidateDashboardApiCacheForEvent('ledger:issue:updated', { issue_id: id });
    await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_REFRESH_DEADLINE_MS + LIVE_REFRESH_MIN_INTERVAL_MS); });
    expect(signals[0].aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(facts().facts['item-0'].worker_status).toBe('done');
  });
  it('revalidates warm aliases on activation and on collisions with a different issue identity', async () => {
    const id = canonical('a');
    let mode: 'resolved' | 'pending' | 'ambiguous' = 'resolved';
    const pending = deferred<Response>();
    const fetcher = vi.fn(async () => {
      if (mode === 'pending') return pending.promise;
      return mode === 'ambiguous'
        ? new Response(JSON.stringify({ resolution: { ref: 'issue:alias', kind: 'issue', resolved: false, entity: null, error: 'ambiguous' } }))
        : result(`issue:${id}`, 'blocked');
    });
    vi.stubGlobal('fetch', fetcher);
    const value = model(['alias']);
    const ui = render(<Pane value={value} />);
    await waitFor(() => expect(facts().facts['item-0']?.worker_status).toBe('blocked'));
    ui.rerender(<Pane value={value} active={false} />);
    mode = 'pending';
    ui.rerender(<Pane value={value} />);
    expect(facts().facts['item-0']).toBeUndefined();
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    pending.resolve(result(`issue:${id}`, 'blocked'));
    await waitFor(() => expect(facts().facts['item-0']?.worker_status).toBe('blocked'));
    mode = 'ambiguous';
    vi.useFakeTimers();
    for (const type of ['heartbeat', 'auth:output', 'session:updated', 'space:occurrence:updated']) invalidateDashboardApiCacheForEvent(type, { space_id: 'board' });
    await flushEvents();
    expect(fetcher).toHaveBeenCalledTimes(2);
    invalidateDashboardApiCacheForEvent('ledger:issue:created', { issue_id: canonical('b') });
    invalidateDashboardApiCacheForEvent('ledger:event:created', { entity_type: 'issue', entity_id: canonical('b'), event_type: 'issue.created' });
    await flushEvents();
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(facts().facts['item-0']).toBeUndefined();
  });

  it('refreshes a completed identity while another member of the family refresh is stalled', async () => {
    const a = canonical('a'), b = canonical('b');
    const slow = deferred<Response>();
    const reads = new Map<string, number>();
    const fetcher = vi.fn(async (url: string) => {
      const ref = new URL(url, 'http://test').searchParams.get('ref')!;
      const count = (reads.get(ref) ?? 0) + 1; reads.set(ref, count);
      if (ref === `issue:${b}` && count === 2) return slow.promise;
      return result(ref, count >= 3 ? 'blocked' : count === 2 ? 'done' : 'none');
    });
    vi.stubGlobal('fetch', fetcher);
    render(<Pane value={model([a, b])} />);
    await waitFor(() => expect(Object.keys(facts().facts)).toHaveLength(2));
    vi.useFakeTimers();
    invalidateDashboardApiCacheForEvent('ledger:event:created', { entity_type: 'work_unit', entity_id: 'work-unit', event_type: 'work_unit.updated' });
    await flushEvents();
    expect(facts().facts['item-0'].worker_status).toBe('done');
    expect(reads.get(`issue:${b}`)).toBe(2);
    invalidateDashboardApiCacheForEvent('ledger:issue:updated', { issue_id: a });
    await flushEvents();
    expect(facts().facts['item-0'].worker_status).toBe('blocked');
    expect(reads.get(`issue:${a}`)).toBe(3);
    expect(reads.get(`issue:${b}`)).toBe(2);
    slow.resolve(result(`issue:${b}`, 'done'));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  });

  it('does not spend a queued identity deadline before transport admission', async () => {
    const started: { ref: string; signal: AbortSignal }[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
      started.push({ ref: new URL(url, 'http://test').searchParams.get('ref')!, signal: init.signal as AbortSignal });
      return new Promise<Response>(() => {});
    }));
    vi.useFakeTimers();
    render(<Pane value={model(['a', 'b', 'c', 'd', 'e'].map(canonical))} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(started).toHaveLength(4);
    await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_REFRESH_DEADLINE_MS); });
    expect(started).toHaveLength(5);
    expect(started[4].signal.aborted).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_REFRESH_DEADLINE_MS - 2); });
    expect(started[4].signal.aborted).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(2); });
    expect(started[4].signal.aborted).toBe(true);
    expect(facts().errors).toBe(5);
  });

  it('keeps Space contexts distinct, skips non-issues, and preserves pending reads when membership grows', async () => {
    const pending = deferred<Response>();
    let pendingSignal: AbortSignal | undefined;
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      const params = new URL(url, 'http://test').searchParams;
      if (params.get('ref') === 'issue:alias' && params.get('project') === 'space-project') {
        pendingSignal = init.signal as AbortSignal;
        return pending.promise;
      }
      return result(params.get('ref')!, 'blocked');
    });
    vi.stubGlobal('fetch', fetcher);
    const original = model(['alias']);
    const foreign = model(['alias']); foreign.space.project_id = 'foreign-project';
    const ui = render(<><Pane value={original} /><Pane value={foreign} name="foreign" /></>);
    await waitFor(() => expect(facts('foreign').facts['item-0']?.worker_status).toBe('blocked'));
    expect(facts().facts['item-0']).toBeUndefined();
    const expanded = model(['alias', canonical('b'), 'artifact']);
    expanded.itemsById['item-2'].ref_type = 'artifact';
    ui.rerender(<><Pane value={expanded} /><Pane value={foreign} name="foreign" /></>);
    await waitFor(() => expect(facts().facts['item-1']?.worker_status).toBe('blocked'));
    expect(pendingSignal?.aborted).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(3);
    pending.resolve(result('issue:resolved-alias', 'done'));
    await waitFor(() => expect(facts().facts['item-0']?.worker_status).toBe('done'));
    expect(facts('foreign').facts['item-0'].worker_status).toBe('blocked');
    expect(facts().facts['item-2']).toBeUndefined();
  });

  it('verifies a warm alias even when structural sharing and the clock leave its payload timestamp unchanged', async () => {
    vi.useFakeTimers();
    const id = canonical('a');
    const payload = { ref: `issue:${id}`, kind: 'issue', resolved: true, entity: { id, worker_status: 'none', kind: 'bug', labels: [] } };
    const key = boardIssueKey('issue:alias', 'space-project');
    queryClient.setQueryData(key, payload);
    const timestamp = queryClient.getQueryState(key)!.dataUpdatedAt;
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ resolution: payload })));
    vi.stubGlobal('fetch', fetcher);
    render(<Pane value={model(['alias'])} />);
    expect(facts().facts['item-0']).toBeUndefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryState(key)!.dataUpdatedAt).toBe(timestamp);
    expect(facts().facts['item-0']?.worker_status).toBe('none');
  });

});
