import { cleanup, fireEvent, render, screen, waitFor } from './helpers/dom.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LogsView, parseLogsHash } from '../ui/src/views/logs';
import type { LogsResponse } from '../ui/src/api';
import type { SSEClient, SSEHandler, SSEPayload } from '../ui/src/sse-client';

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
      <LogsView loadLogs={loadLogs as typeof import('../ui/src/api').getLogs} createSse={() => client} />,
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
