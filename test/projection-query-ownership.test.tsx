// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from './helpers/dom';
import './helpers/ui-workspace-fixture';
import { useProjectionQuery } from '../ui/src/query/useProjectionQuery';
import { projectionKeys } from '../ui/src/query/projectionKeys';
import { snapshotOptions, detailQueryData } from '../ui/src/query/snapshots';
import { invalidateDashboardApiCacheForEvent } from '../ui/src/api';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe('shared projection Query lifecycle', () => {
  it('normalizes set-valued inputs while preserving ordered Timeline roots and mode-dependent Graph status', () => {
    expect(projectionKeys.graph({ mode: 'work', repo: 'b,a,a', nodeTypes: ['session', 'issue'] }))
      .toEqual(projectionKeys.graph({ mode: 'work', repo: 'a,b', nodeTypes: ['issue', 'session'] }));
    expect(projectionKeys.graph({ mode: 'work' })).not.toEqual(projectionKeys.graph({ mode: 'work', status: 'open' }));
    const roots = [{ id: 'a' }, { id: 'b' }];
    expect(projectionKeys.timeline({ root_row_specs: roots, event_kinds: [], expanded_paths: ['b', 'a'] }))
      .toEqual(projectionKeys.timeline({ root_specs: roots, event_kinds: ['state', 'body', 'comment'], expanded_paths: ['a', 'b'] }));
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
