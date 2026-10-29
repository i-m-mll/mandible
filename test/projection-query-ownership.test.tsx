// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from './helpers/dom';
import './helpers/ui-workspace-fixture';
import { useProjectionQuery } from '../ui/src/query/useProjectionQuery';
import { projectionKeys } from '../ui/src/query/projectionKeys';
import { snapshotOptions, detailQueryData } from '../ui/src/query/snapshots';
import { invalidateDashboardApiCacheForEvent } from '../ui/src/api';
import { AppShellProvider, useAppShell } from '../ui/src/app-shell';
import { queryClient } from '../ui/src/query/client';
import { LIVE_REFRESH_MIN_INTERVAL_MS, LIVE_REFRESH_DEADLINE_MS, RefreshDeadlineError } from '../ui/src/lib/coalesced-refresh';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe('shared projection Query lifecycle', () => {
  it('reconciles a newer event after the in-flight refresh reaches its query deadline', async () => {
    const signals: AbortSignal[] = [];
    const load = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return load.mock.calls.length === 1 ? new Promise<{ title: string }>(() => {}) : Promise.resolve({ title: 'After timeout event' });
    });
    const options = snapshotOptions(projectionKeys.graph(), load);
    queryClient.setQueryData(options.queryKey, { title: 'Previous' });
    function Pane() {
      const query = useProjectionQuery(options, true);
      return <span>{detailQueryData(query, options)?.title ?? query.error?.name}</span>;
    }
    render(<Pane />);
    expect(screen.getByText('Previous')).toBeTruthy();
    vi.useFakeTimers();
    try {
      await act(async () => {
        invalidateDashboardApiCacheForEvent('ledger:issue:updated');
        await vi.advanceTimersByTimeAsync(1);
        invalidateDashboardApiCacheForEvent('ledger:comment:created');
        await vi.advanceTimersByTimeAsync(LIVE_REFRESH_DEADLINE_MS + LIVE_REFRESH_MIN_INTERVAL_MS);
      });
      expect(signals[0].aborted).toBe(true);
      expect(load).toHaveBeenCalledTimes(2);
      expect(screen.getByText('After timeout event')).toBeTruthy();
      expect(queryClient.getQueryState(options.queryKey)?.isInvalidated).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds a stalled cold read and releases its route barrier with a timeout error', async () => {
    let signal: AbortSignal | undefined;
    let barrierSettled = false;
    const options = snapshotOptions<{ title: string }>(projectionKeys.timeline({ project_ref: 'stalled' }), (nextSignal) => {
      signal = nextSignal;
      return new Promise(() => {});
    });
    function Pane() {
      const query = useProjectionQuery(options, true);
      return <span>{query.error?.name ?? query.fetchStatus}</span>;
    }
    function Frame() {
      const shell = useAppShell();
      return <AppShellProvider value={{ ...shell, registerInitialRouteLoad: (barrier) => {
        void barrier.then(() => { barrierSettled = true; });
      } }}><Pane /></AppShellProvider>;
    }
    vi.useFakeTimers();
    try {
      render(<Frame />);
      expect(barrierSettled).toBe(false);
      await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_REFRESH_DEADLINE_MS + 1); });
      expect(screen.getByText('RefreshDeadlineError')).toBeTruthy();
      expect(signal?.aborted).toBe(true);
      expect(barrierSettled).toBe(true);
      expect(queryClient.getQueryState(options.queryKey)?.error).toBeInstanceOf(RefreshDeadlineError);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry a failed idle projection after only one event', async () => {
    const load = vi.fn(async () => { throw new Error('Single event failed'); });
    const options = snapshotOptions<{ title: string }>(projectionKeys.graph(), load);
    queryClient.setQueryData(options.queryKey, { title: 'Retained' });
    function Pane() {
      const query = useProjectionQuery(options, true);
      return <span>{query.error?.message ?? query.data?.title}</span>;
    }
    render(<Pane />);
    expect(screen.getByText('Retained')).toBeTruthy();
    vi.useFakeTimers();
    try {
      await act(async () => {
        invalidateDashboardApiCacheForEvent('ledger:issue:updated');
        await vi.advanceTimersByTimeAsync(2 * LIVE_REFRESH_MIN_INTERVAL_MS);
      });
      expect(screen.getByText('Single event failed')).toBeTruthy();
      expect(load).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores a snapshot using an equivalent key whose input fields were authored in another order', async () => {
    const original = snapshotOptions(projectionKeys.timeline({ project_ref: 'mandible', include_closed: true }), async () => ({ title: 'Saved projection' }));
    await queryClient.fetchQuery(original);
    queryClient.clear();
    const restarted = snapshotOptions(projectionKeys.timeline({ include_closed: true, project_ref: 'mandible' }), () => new Promise<{ title: string }>(() => {}));
    function Pane() {
      const query = useProjectionQuery(restarted, true);
      return <span>{detailQueryData(query, restarted)?.title ?? 'Pending'}</span>;
    }
    render(<Pane />);
    expect(screen.getByText('Saved projection')).toBeTruthy();
  });

  it.each(['error', 'deactivation'] as const)('settles the initial route barrier on %s', async (completion) => {
    const pending = deferred<{ title: string }>();
    const options = snapshotOptions(projectionKeys.graph({ limit: 1 }), () => pending.promise);
    const barriers: Promise<unknown>[] = [];
    let settled = false;
    const register = (barrier: Promise<unknown>) => {
      barriers.push(barrier);
      void barrier.then(() => { settled = true; });
    };
    function Pane({ active }: { active: boolean }) {
      const query = useProjectionQuery(options, active);
      return <span>{query.fetchStatus}</span>;
    }
    function Frame({ active }: { active: boolean }) {
      const shell = useAppShell();
      return <AppShellProvider value={{ ...shell, active, registerInitialRouteLoad: register }}><Pane active={active} /></AppShellProvider>;
    }
    const view = render(<Frame active />);
    await waitFor(() => expect(barriers).toHaveLength(1));
    expect(settled).toBe(false);
    if (completion === 'error') pending.reject(new Error('Unavailable projection'));
    else view.rerender(<Frame active={false} />);
    await waitFor(() => expect(settled).toBe(true));
  });

  it('normalizes set-valued inputs while preserving ordered Timeline roots and mode-dependent Graph status', () => {
    expect(projectionKeys.graph({ mode: 'work', repo: 'b,a,a', nodeTypes: ['session', 'issue'] }))
      .toEqual(projectionKeys.graph({ mode: 'work', repo: 'a,b', nodeTypes: ['issue', 'session'] }));
    expect(projectionKeys.graph({ mode: 'work' })).not.toEqual(projectionKeys.graph({ mode: 'work', status: 'open' }));
    const roots = [{ id: 'a' }, { id: 'b' }];
    expect(projectionKeys.timeline({ root_row_specs: roots, event_kinds: ['state', 'body', 'comment'], expanded_paths: ['b', 'a'] }))
      .toEqual(projectionKeys.timeline({ root_specs: roots, event_kinds: ['state', 'body', 'comment'], expanded_paths: ['a', 'b'] }));
    expect(projectionKeys.timeline({ event_kinds: [] })).not.toEqual(projectionKeys.timeline({}));
    expect(projectionKeys.timeline({ root_specs: roots })).not.toEqual(projectionKeys.timeline({ root_specs: [...roots].reverse() }));
  });

  it('aborts a hidden read only after the last active same-key consumer leaves', async () => {
    const signals: AbortSignal[] = [];
    const options = snapshotOptions(projectionKeys.graph(), (signal) => {
      signals.push(signal);
      return new Promise<{ title: string }>(() => {});
    });
    function Pane({ active }: { active: boolean }) {
      const query = useProjectionQuery(options, active);
      return <span>{query.fetchStatus}</span>;
    }
    const view = render(<><Pane active /><Pane active /></>);
    await waitFor(() => expect(signals).toHaveLength(1));
    view.rerender(<><Pane active={false} /><Pane active /></>);
    expect(signals[0].aborted).toBe(false);
    view.rerender(<><Pane active={false} /><Pane active={false} /></>);
    await waitFor(() => expect(signals[0].aborted).toBe(true));
    view.rerender(<><Pane active /><Pane active={false} /></>);
    await waitFor(() => expect(signals).toHaveLength(2));
  });

  it('reconciles cached data invalidated while hidden once on activation', async () => {
    let title = 'Before hidden events';
    const load = vi.fn(async () => ({ title }));
    const options = snapshotOptions(projectionKeys.graph(), load);
    function Pane({ active }: { active: boolean }) {
      const query = useProjectionQuery(options, active);
      return <span>{detailQueryData(query, options)?.title ?? 'Pending'}</span>;
    }
    const view = render(<Pane active />);
    expect(await screen.findByText('Before hidden events')).toBeTruthy();
    view.rerender(<Pane active={false} />);
    title = 'After hidden events';
    await act(async () => {
      for (let i = 0; i < 6; i++) invalidateDashboardApiCacheForEvent('ledger:comment:created');
    });
    expect(load).toHaveBeenCalledTimes(1);
    view.rerender(<Pane active />);
    expect(await screen.findByText('After hidden events')).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('coalesces events during a long failed read into one trailing reconciliation without cancellation', async () => {
    const initial = deferred<{ title: string }>();
    const signals: AbortSignal[] = [];
    const load = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return load.mock.calls.length === 1 ? initial.promise : Promise.resolve({ title: 'Current' });
    });
    const options = snapshotOptions(projectionKeys.graph(), load);
    function Pane() {
      const query = useProjectionQuery(options, true);
      return <span>{detailQueryData(query, options)?.title ?? 'Pending'}</span>;
    }
    render(<Pane />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await act(async () => {
      for (let i = 0; i < 10; i++) invalidateDashboardApiCacheForEvent('ledger:relationship:added');
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(signals[0].aborted).toBe(false);
    initial.reject(new Error('Projection failed before reconciliation'));
    expect(await screen.findByText('Current')).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
  });
});
