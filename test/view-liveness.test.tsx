// @vitest-environment jsdom
import { act, cleanup, render, screen } from './helpers/dom.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import { AppShellProvider, useAppShell, useLiveRefresh, useRegisterInitialRouteLoad } from '../ui/src/app-shell';
import { LogsView } from '../ui/src/views/logs';
import type { LogsResponse } from '../ui/src/api';
import type { SSEClient, SSEHandler, SSEPayload } from '../ui/src/sse-client';

const TEN_MINUTES_MS = 10 * 60_000;

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

it('loads a view on mount and once per activation, never on hide, and polls only while active', async () => {
  const load = vi.fn();
  const poll = vi.fn();
  let signal = (): void => undefined;
  function Probe(): null {
    const register = useRegisterInitialRouteLoad();
    useEffect(() => { load(); register(Promise.resolve()); }, [register]);
    signal = useLiveRefresh(poll, 15_000);
    return null;
  }
  const view = (active: boolean) => <Shell active={active}><Probe /></Shell>;

  const rendered = render(view(true));
  expect(load).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  act(() => signal());
  expect(poll).toHaveBeenCalledTimes(3);

  rendered.rerender(view(false));
  act(() => signal());
  await act(() => vi.advanceTimersByTimeAsync(TEN_MINUTES_MS));
  expect(load).toHaveBeenCalledTimes(1);
  expect(poll).toHaveBeenCalledTimes(3);

  rendered.rerender(view(true));
  expect(load).toHaveBeenCalledTimes(2);
  act(() => setDocumentVisibility('hidden'));
  act(() => setDocumentVisibility('visible'));
  expect(load).toHaveBeenCalledTimes(3);
  expect(poll).toHaveBeenCalledTimes(3);
});

it('Logs makes no requests while hidden, whatever the event stream does, and reloads once when shown without clearing', async () => {
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
