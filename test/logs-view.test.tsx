import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LogsView, parseLogsHash } from '../../ui/src/views/logs';
import type { LogsResponse } from '../../ui/src/api';
import type { SSEClient, SSEHandler, SSEPayload } from '../../ui/src/sse-client';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.location.hash = '';
});

describe('LogsView', () => {
  it('parses shareable hash filters', () => {
    expect(parseLogsHash('#/logs?levels=error,warn&subsystem=auth&event=auth_failure&q=needle&related=issue:abc')).toMatchObject({
      levels: ['error', 'warn'],
      subsystem: 'auth',
      event: 'auth_failure',
      q: 'needle',
      related: 'issue:abc',
    });
  });

  it('renders structured fields, entity links, and refreshes from SSE reconciliation', async () => {
    window.location.hash = '#/logs?levels=error,warn&q=needle';
    let sseHandler: SSEHandler | null = null;
    const client = {
      connect: vi.fn(),
      close: vi.fn(),
      on: vi.fn((_type: string, handler: SSEHandler) => {
        sseHandler = handler;
        return vi.fn();
      }),
    } as unknown as SSEClient;
    const response: LogsResponse = {
      entries: [{
        id: 'log-1',
        level: 'error',
        event: 'auth_failure',
        message: 'auth failed',
        subsystem: 'auth',
        time: '2026-07-04T12:00:00.000Z',
        issue_id: 'issue-1',
        auth_request_id: 'auth-1',
        repo_id: 'mandible',
        detail: { nested: 'value' },
      }],
      limit: 500,
      offset: 0,
      log_file: '',
      exists: true,
      source: 'daemon_log',
      facets: {
        subsystems: ['auth'],
        events: ['auth_failure'],
        entity_refs: [
          { type: 'issue', value: 'issue-1', count: 1 },
          { type: 'auth_request', value: 'auth-1', count: 1 },
        ],
        latest_ts: '2026-07-04T12:00:00.000Z',
      },
    };
    const loadLogs = vi.fn(async () => response);

    render(<LogsView loadLogs={loadLogs} createSse={() => client} />);

    await waitFor(() => expect(loadLogs).toHaveBeenCalledWith(expect.objectContaining({
      levels: ['error', 'warn'],
      q: 'needle',
    })));
    expect(await screen.findByText('auth_failure')).toBeTruthy();

    fireEvent.click(screen.getByText('auth failed'));
    const issueLink = await screen.findByText('issue-1');
    expect(issueLink.closest('a')?.getAttribute('href')).toBe('#/issues?issue=issue-1&repo=mandible');
    const authLink = screen.getByText('auth-1');
    expect(authLink.closest('a')?.getAttribute('href')).toBe('#/auth?request=auth-1');
    expect(screen.getByText('detail')).toBeTruthy();
    expect(screen.getByText('object')).toBeTruthy();

    const autoScroll = screen.getByRole('checkbox', { name: 'Auto-scroll' }) as HTMLInputElement;
    sseHandler?.({ type: 'auth:updated' } as SSEPayload);
    await waitFor(() => expect(loadLogs).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('checkbox', { name: 'Auto-scroll' })).toBe(autoScroll);
    expect(autoScroll.checked).toBe(true);
  });

  it('shows initial loading only in the body and keeps the auto-scroll control mounted', async () => {
    let resolveLoad!: (response: LogsResponse) => void;
    const pending = new Promise<LogsResponse>((resolve) => {
      resolveLoad = resolve;
    });
    const loadLogs = vi.fn(() => pending);

    const { container } = render(<LogsView loadLogs={loadLogs} createSse={() => ({
      connect: vi.fn(),
      close: vi.fn(),
      on: vi.fn(() => vi.fn()),
    }) as unknown as SSEClient} />);

    expect(screen.getByText('Loading logs…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /refresh/i })).toBeNull();
    const autoScroll = screen.getByRole('checkbox', { name: 'Auto-scroll' });
    const scrollRegion = container.querySelector('.logs-scroll-region') as HTMLDivElement;
    Object.defineProperty(scrollRegion, 'scrollHeight', { configurable: true, value: 640 });
    scrollRegion.scrollTop = 0;

    resolveLoad({
      entries: [{ id: 'tail-row', level: 'info', event: 'tail', time: '2026-07-04T12:00:00.000Z' }],
      limit: 100,
      offset: 0,
      log_file: '',
      exists: true,
      source: 'daemon_log',
      older_cursor: null,
      has_older: false,
    });
    await waitFor(() => expect(screen.getAllByText('tail')).toHaveLength(2));
    expect(scrollRegion.scrollTop).toBe(640);
    expect(screen.getByRole('checkbox', { name: 'Auto-scroll' })).toBe(autoScroll);
  });

  it('prepends cursor pages without duplicates and keeps live refreshes incremental', async () => {
    let sseHandler: SSEHandler | null = null;
    const client = {
      connect: vi.fn(),
      close: vi.fn(),
      on: vi.fn((_type: string, handler: SSEHandler) => {
        sseHandler = handler;
        return vi.fn();
      }),
    } as unknown as SSEClient;
    let newestRequest = 0;
    const loadLogs = vi.fn(async (params?: { before?: string }): Promise<LogsResponse> => {
      if (params?.before) {
        return {
          entries: [
            { id: 'log-1', level: 'info', event: 'one', time: '2026-07-04T12:00:01.000Z' },
            { id: 'log-2', level: 'info', event: 'two', time: '2026-07-04T12:00:02.000Z' },
          ],
          limit: 100, offset: 0, log_file: '', exists: true,
          source: 'daemon_log', older_cursor: null, has_older: false,
        };
      }
      newestRequest += 1;
      return {
        entries: [
          { id: 'log-2', level: 'info', event: 'two', time: '2026-07-04T12:00:02.000Z' },
          { id: 'log-3', level: 'info', event: 'three', time: '2026-07-04T12:00:03.000Z' },
          ...(newestRequest > 1
            ? [{ id: 'log-4', level: 'info', event: 'four', time: '2026-07-04T12:00:04.000Z' }]
            : []),
        ],
        limit: 100, offset: 0, log_file: '', exists: true,
        source: 'daemon_log', older_cursor: 'older-page', has_older: true,
      };
    });

    const { container } = render(
      <LogsView loadLogs={loadLogs as typeof import('../../ui/src/api').getLogs} createSse={() => client} />,
    );
    await waitFor(() => expect(screen.getAllByText('three')).toHaveLength(2));
    const scrollRegion = container.querySelector('.logs-scroll-region') as HTMLDivElement;
    let scrollHeight = 200;
    Object.defineProperty(scrollRegion, 'scrollHeight', { configurable: true, get: () => scrollHeight });
    scrollRegion.scrollTop = 20;
    fireEvent.click(screen.getByRole('button', { name: 'Load older entries' }));
    scrollHeight = 300;
    await waitFor(() => expect(screen.getAllByText('one')).toHaveLength(2));
    expect(scrollRegion.scrollTop).toBe(120);
    expect(screen.getAllByText('two')).toHaveLength(2);

    expect((screen.getByRole('checkbox', { name: 'Auto-scroll' }) as HTMLInputElement).checked).toBe(false);
    sseHandler?.({ type: 'log:new' } as SSEPayload);
    await waitFor(() => expect(screen.getAllByText('four')).toHaveLength(2));
    expect(screen.getAllByText('two')).toHaveLength(2);
    expect((screen.getByRole('checkbox', { name: 'Auto-scroll' }) as HTMLInputElement).checked).toBe(false);
  });
});
