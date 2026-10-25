// @vitest-environment jsdom
import { act, cleanup, render, screen } from './helpers/dom.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ComponentChildren } from 'preact';
import { AppShellProvider, useAppShell, useLiveLoad, useRouteLoad } from '../ui/src/app-shell';
import { LIVE_REFRESH_DEADLINE_MS, RefreshDeadlineError } from '../ui/src/lib/coalesced-refresh';
import { LogsView } from '../ui/src/views/logs';
import { render as renderWithNotices } from './helpers/notice-test-render.js';
import type { LogsResponse } from '../ui/src/api';
import type { SSEClient, SSEHandler, SSEPayload } from '../ui/src/sse-client';

const TEN_MINUTES_MS = 10 * 60_000;

function silentLogs() {
  const handlers = new Set<SSEHandler>();
  const client = {
    connect: vi.fn(),
    close: vi.fn(),
    on: vi.fn((_type: string, handler: SSEHandler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    }),
  } as unknown as SSEClient;
  const emit = () => { for (const handler of [...handlers]) handler({ type: 'conversation:updated' } as SSEPayload); };
  const loadLogs = vi.fn(async (): Promise<LogsResponse> => ({
    entries: [{ id: 'log-1', level: 'info', event: 'kept-entry', time: '2026-07-04T12:00:01.000Z' }],
    limit: 100, offset: 0, log_file: '', exists: true,
    source: 'daemon_log', older_cursor: null, has_older: false,
  }));
  return { client, emit, loadLogs };
}

function Shell({ active, children }: { active: boolean; children: ComponentChildren }): JSX.Element {
  const parent = useAppShell();
  return <AppShellProvider value={{ ...parent, active }}>{children}</AppShellProvider>;
}

function setDocumentVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  cleanup();
  setDocumentVisibility('visible');
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.location.hash = '';
});

it('loads a view while active and abandons the load on hide', () => {
  const load = vi.fn();
  const abandon = vi.fn();
  function Probe({ target }: { target: string }): null {
    useRouteLoad((register) => {
      load(target);
      register(Promise.resolve());
      return abandon;
    }, [target]);
    return null;
  }
  const view = (active: boolean, target = 'a') => <Shell active={active}><Probe target={target} /></Shell>;

  const rendered = render(view(true));
  expect(load).toHaveBeenCalledTimes(1);
  rendered.rerender(view(false));
  expect(abandon).toHaveBeenCalledTimes(1);
  rendered.rerender(view(false, 'b'));
  expect(load).toHaveBeenCalledTimes(1);

  rendered.rerender(view(true, 'b'));
  expect(load).toHaveBeenCalledTimes(2);
  expect(load).toHaveBeenLastCalledWith('b');
  act(() => setDocumentVisibility('hidden'));
  expect(abandon).toHaveBeenCalledTimes(2);
  act(() => setDocumentVisibility('visible'));
  expect(load).toHaveBeenCalledTimes(3);
});

it('runs a live load on activation, on its interval and on signals, only while active', async () => {
  const load = vi.fn();
  let signal = (): void => undefined;
  function Probe(): null {
    signal = useLiveLoad(load, [], 15_000);
    return null;
  }
  const view = (active: boolean) => <Shell active={active}><Probe /></Shell>;

  const rendered = render(view(true));
  expect(load).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(load).toHaveBeenCalledTimes(3);
  act(() => signal());
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  expect(load).toHaveBeenCalledTimes(4);

  rendered.rerender(view(false));
  act(() => signal());
  await act(() => vi.advanceTimersByTimeAsync(TEN_MINUTES_MS));
  expect(load).toHaveBeenCalledTimes(4);

  rendered.rerender(view(true));
  expect(load).toHaveBeenCalledTimes(5);
});

it('releases the warmup barrier when a hung route load is abandoned', async () => {
  const entries: Promise<unknown>[] = [];
  function Probe(): null {
    useRouteLoad((register) => { register(new Promise(() => undefined)); }, []);
    return null;
  }
  function BarrierShell({ active }: { active: boolean }): JSX.Element {
    const parent = useAppShell();
    return (
      <AppShellProvider value={{ ...parent, active, registerInitialRouteLoad: (entry) => { entries.push(entry); } }}>
        <Probe />
      </AppShellProvider>
    );
  }
  const rendered = render(<BarrierShell active />);
  expect(entries).toHaveLength(1);
  let settled = false;
  void entries[0].then(() => { settled = true; });
  await act(() => vi.advanceTimersByTimeAsync(TEN_MINUTES_MS));
  expect(settled).toBe(false);

  rendered.rerender(<BarrierShell active={false} />);
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(settled).toBe(true);
});

it('coalesces a burst of live signals into the in-flight load and one trailing refresh', async () => {
  let finish = (): void => undefined;
  const load = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  let signal = (): void => undefined;
  function Probe(): null {
    signal = useLiveLoad(load, []);
    return null;
  }
  render(<Shell active><Probe /></Shell>);
  expect(load).toHaveBeenCalledTimes(1);

  act(() => { for (let event = 0; event < 100; event += 1) signal(); });
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(load).toHaveBeenCalledTimes(1);

  await act(async () => { finish(); });
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(load).toHaveBeenCalledTimes(2);
  await act(async () => { finish(); });
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(load).toHaveBeenCalledTimes(2);
});

it('aborts a hung live load at its deadline, logs it, and keeps serving signals', async () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const signals: AbortSignal[] = [];
  const load = vi.fn((abort: AbortSignal) => {
    signals.push(abort);
    return new Promise<void>(() => undefined);
  });
  let signal = (): void => undefined;
  function Probe(): null {
    signal = useLiveLoad(load, []);
    return null;
  }
  render(<Shell active><Probe /></Shell>);
  act(() => signal());
  await act(() => vi.advanceTimersByTimeAsync(LIVE_REFRESH_DEADLINE_MS - 1));
  expect(load).toHaveBeenCalledTimes(1);

  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(signals[0].reason).toBeInstanceOf(RefreshDeadlineError);
  expect(consoleError).toHaveBeenCalledWith(expect.any(RefreshDeadlineError));
  expect(load).toHaveBeenCalledTimes(2);
});

it('Logs makes no requests while hidden, whatever the event stream does, and reloads once when shown without clearing', async () => {
  const { client, emit, loadLogs } = silentLogs();
  const view = (active: boolean) => (
    <Shell active={active}>
      <LogsView loadLogs={loadLogs as typeof import('../ui/src/api').getLogs} createSse={() => client} />
    </Shell>
  );

  const rendered = render(view(true));
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(loadLogs).toHaveBeenCalledTimes(1);
  const row = screen.getAllByText('kept-entry')[0];

  rendered.rerender(view(false));
  for (let second = 0; second < TEN_MINUTES_MS / 1_000; second += 1) {
    emit();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
  }
  expect(loadLogs).toHaveBeenCalledTimes(1);

  rendered.rerender(view(true));
  expect(screen.getAllByText('kept-entry')[0]).toBe(row);
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(loadLogs).toHaveBeenCalledTimes(2);
  expect(screen.getAllByText('kept-entry')[0]).toBe(row);
});

it('starts no load for a view mounted while the document is hidden, and loads once when shown', async () => {
  setDocumentVisibility('hidden');
  const { client, loadLogs } = silentLogs();
  render(
    <Shell active>
      <LogsView loadLogs={loadLogs as typeof import('../ui/src/api').getLogs} createSse={() => client} />
    </Shell>,
  );
  await act(() => vi.advanceTimersByTimeAsync(TEN_MINUTES_MS));
  expect(loadLogs).not.toHaveBeenCalled();

  act(() => setDocumentVisibility('visible'));
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(loadLogs).toHaveBeenCalledTimes(1);
  expect(screen.getAllByText('kept-entry').length).toBeGreaterThan(0);
});

it('Logs reads at most once per second while shown, however many events arrive', async () => {
  const { client, emit, loadLogs } = silentLogs();
  render(
    <Shell active>
      <LogsView loadLogs={loadLogs as typeof import('../ui/src/api').getLogs} createSse={() => client} />
    </Shell>,
  );
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(loadLogs).toHaveBeenCalledTimes(1);

  for (let repo = 0; repo < 100; repo += 1) {
    emit();
    await act(() => vi.advanceTimersByTimeAsync(10));
  }
  await act(() => vi.advanceTimersByTimeAsync(2_000));
  expect(loadLogs.mock.calls.length).toBeGreaterThan(1);
  expect(loadLogs.mock.calls.length).toBeLessThanOrEqual(4);
});

it('Logs folds events during its activation load into one trailing read', async () => {
  const { client, emit } = silentLogs();
  let finish = (): void => undefined;
  const loadLogs = vi.fn(() => new Promise<LogsResponse>((resolve) => {
    finish = () => resolve({
      entries: [{ id: 'log-1', level: 'info', event: 'kept-entry', time: '2026-07-04T12:00:01.000Z' }],
      limit: 100, offset: 0, log_file: '', exists: true,
      source: 'daemon_log', older_cursor: null, has_older: false,
    });
  }));
  render(
    <Shell active>
      <LogsView loadLogs={loadLogs as typeof import('../ui/src/api').getLogs} createSse={() => client} />
    </Shell>,
  );
  expect(loadLogs).toHaveBeenCalledTimes(1);
  for (let event = 0; event < 20; event += 1) emit();
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(loadLogs).toHaveBeenCalledTimes(1);

  await act(async () => { finish(); });
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(loadLogs).toHaveBeenCalledTimes(2);
});

it('Logs shows a read that hangs past the deadline as a failed load, then reads again', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { client, emit, loadLogs: answer } = silentLogs();
  const loadLogs = vi.fn((params: unknown, { signal }: { signal?: AbortSignal } = {}) => (loadLogs.mock.calls.length === 1
    ? new Promise<LogsResponse>((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason)))
    : answer()));
  renderWithNotices(
    <Shell active>
      <LogsView loadLogs={loadLogs as typeof import('../ui/src/api').getLogs} createSse={() => client} />
    </Shell>,
  );
  await act(() => vi.advanceTimersByTimeAsync(LIVE_REFRESH_DEADLINE_MS));
  expect(loadLogs).toHaveBeenCalledTimes(1);
  expect(screen.getAllByText(/did not finish within 20 s/).length).toBeGreaterThan(0);

  emit();
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(loadLogs).toHaveBeenCalledTimes(2);
  expect(screen.getAllByText('kept-entry').length).toBeGreaterThan(0);
});
