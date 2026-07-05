import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
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
      total: 1,
      limit: 500,
      offset: 0,
      log_file: '',
      exists: true,
      source: 'daemon_log',
      facets: {
        levels: [{ value: 'error', count: 1 }],
        subsystems: [{ value: 'auth', count: 1 }],
        events: [{ value: 'auth_failure', count: 1 }],
        entity_refs: [
          { type: 'issue', value: 'issue-1', count: 1 },
          { type: 'auth_request', value: 'auth-1', count: 1 },
        ],
        latest_ts: '2026-07-04T12:00:00.000Z',
        latest_heartbeat_ts: null,
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

    sseHandler?.({ type: 'auth:updated' } as SSEPayload);
    await waitFor(() => expect(loadLogs).toHaveBeenCalledTimes(2));
  });
});
