// @vitest-environment jsdom
import { ApiError, isApiErrorStatus } from '../ui/src/api';
import { act, cleanup, fireEvent, render, screen, waitFor } from './helpers/dom.js';
import { useCallback } from 'preact/hooks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearPersistedDetailCache, detailRequestKey, writePersistedDetail } from '../ui/src/detail-cache';
import { useKeyedAsyncDetail } from '../ui/src/hooks/useKeyedAsyncDetail';

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

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function DetailHarness({
  id,
  requests,
}: {
  id: string;
  requests: Map<string, Deferred<{ id: string; title: string }>>;
}) {
  const load = useCallback(
    (_signal: AbortSignal) => requests.get(id)!.promise,
    [id, requests],
  );
  const state = useKeyedAsyncDetail({
    requestKey: detailRequestKey('issue', { id }),
    namespace: 'issue-detail',
    load,
  });
  return (
    <div>
      <span data-testid="detail">{state.data ? `${state.data.id}:${state.data.title}` : 'empty'}</span>
      <span data-testid="phase">{state.loading ? 'loading' : state.revalidating ? 'revalidating' : 'ready'}</span>
      <span data-testid="error-status">{isApiErrorStatus(state.failure, 404) ? 'missing' : state.error}</span>
      <span data-testid="stale">{state.stale ? 'stale' : 'fresh'}</span>
      <button type="button" onClick={state.refresh}>Refresh</button>
    </div>
  );
}

describe('useKeyedAsyncDetail', () => {
  beforeEach(() => {
    installMemoryLocalStorage();
    window.localStorage.clear();
    clearPersistedDetailCache();
  });

  afterEach(cleanup);

  it('never lets a late response for an old key overwrite the selected key', async () => {
    const first = deferred<{ id: string; title: string }>();
    const second = deferred<{ id: string; title: string }>();
    const requests = new Map([['first', first], ['second', second]]);
    const view = render(<DetailHarness id="first" requests={requests} />);

    view.rerender(<DetailHarness id="second" requests={requests} />);
    await act(async () => second.resolve({ id: 'second', title: 'selected' }));
    expect(screen.getByTestId('detail').textContent).toBe('second:selected');

    await act(async () => first.resolve({ id: 'first', title: 'late' }));
    expect(screen.getByTestId('detail').textContent).toBe('second:selected');
  });

  it('retains structured API failures for domain decisions', async () => {
    const request = deferred<{ id: string; title: string }>();
    render(<DetailHarness id="missing" requests={new Map([['missing', request]])} />);
    await act(async () => request.reject(new ApiError('No status in this message', 404)));
    await waitFor(() => expect(screen.getByTestId('error-status').textContent).toBe('missing'));
    expect(screen.getByTestId('phase').textContent).toBe('ready');
  });

  it('paints same-key persisted data while revalidating and retains it on refresh', async () => {
    const requestKey = detailRequestKey('issue', { id: 'cached' });
    writePersistedDetail('issue-detail', requestKey, { id: 'cached', title: 'stale' });
    const first = deferred<{ id: string; title: string }>();
    const requests = new Map([['cached', first]]);
    render(<DetailHarness id="cached" requests={requests} />);

    expect(screen.getByTestId('detail').textContent).toBe('cached:stale');
    expect(screen.getByTestId('phase').textContent).toBe('revalidating');
    expect(screen.getByTestId('stale').textContent).toBe('stale');
    await act(async () => first.resolve({ id: 'cached', title: 'fresh' }));
    await waitFor(() => expect(screen.getByTestId('detail').textContent).toBe('cached:fresh'));
    expect(screen.getByTestId('stale').textContent).toBe('fresh');

    const refresh = deferred<{ id: string; title: string }>();
    requests.set('cached', refresh);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(screen.getByTestId('detail').textContent).toBe('cached:fresh');
    expect(screen.getByTestId('phase').textContent).toBe('revalidating');
    expect(screen.getByTestId('stale').textContent).toBe('stale');
  });
});
