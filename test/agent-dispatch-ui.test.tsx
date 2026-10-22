import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppShellProvider } from '../ui/src/app-shell';
import { AgentDispatchDialog } from '../ui/src/components/agent-dispatch/AgentDispatchDialog';
import { LedgerIssueDetail } from '../ui/src/components/ledger/IssueDetail';
import type { LedgerIssueDetailProjection } from '../ui/src/api';
import { __resetBrowserSessionForTests } from '../ui/src/client-auth-token';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  cleanup();
  __resetBrowserSessionForTests();
  vi.unstubAllGlobals();
});

describe('issue header launch-agent affordance', () => {
  function detail(): LedgerIssueDetailProjection {
    return {
    work_notes: '', work_notes_revision: null, worker_status: 'none',
    issue_branches: [], dependencies: [], dependency_warning: false, timeline_partial: false,
      id: 'ledger-issue-1', display_id: 'ce83a84', detail_stage: 'full',
      project: { work_repo_id: null, project_key: 'mandible', id: 'proj-1', display_name: 'mandible', remote_identity: '', upstream_identity: '', repo_id: 'mandible', repo_name: 'mandible', repo_root: null, default_branch: 'main' },
      title: 'Agent dispatch affordances', body: 'Body', status: 'open', resolution: null,
      kind: 'feature', priority: 'normal', source: 'mandible', created_at: 0, updated_at: 0,
      closed_at: null, author: { id: null, type: 'mandible_user', display: 'Mandible', legacy_display: 'Mandible', attribution: null },
      labels: [], aliases: [], comments: [], relationships: [], sessions: [], work_units: [],
      auth_requests: [], associated_artifacts: [], timeline: [], checkpoints: [],
    };
  }

  it('offers a confirm-first launch item without dispatching from the menu click', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/client-auth/whoami') {
        return jsonResponse({ authenticated: true, session: {
          family_id: 'agent-dispatch-test', audience: 'production', csrf_token: 'csrf',
          effect_ceiling: ['agent:dispatch'],
        } });
      }
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      calls.push({ url: String(input), body });
      return jsonResponse({ plan: {
        subject_kind: 'issue', subject_label: 'issue ce83a84', instruction: '',
        cwd: '/Users/example/work', prompt: 'Issue context',
        capability_surface: ['Starts a full interactive Claude Code session.'],
      } });
    }));

    render(<LedgerIssueDetail detail={detail()} onAddComment={() => undefined} />);
    fireEvent.click(screen.getByLabelText('Issue actions'));
    fireEvent.click(screen.getByText('Launch agent…'));

    expect(await screen.findByTestId('agent-dispatch-dialog')).toBeTruthy();
    await waitFor(() => expect(calls.some((call) => call.url === '/api/agent-dispatch/preview')).toBe(true));
    expect(calls.find((call) => call.url === '/api/agent-dispatch/preview')).toMatchObject({
      url: '/api/agent-dispatch/preview',
      body: { subject: { kind: 'issue', issue_ref: 'ce83a84' } },
    });
  });
});

describe('dispatch dialog contract', () => {
  it('surfaces a preview failure instead of offering confirmation', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/client-auth/whoami') {
        return jsonResponse({ authenticated: true, session: { csrf_token: 'csrf' } });
      }
      return jsonResponse({ error: 'human credential required' }, 403);
    });
    vi.stubGlobal('fetch', fetchMock);
    const noticeHost = document.createElement('div');
    document.body.append(noticeHost);
    try {
      render(<AppShellProvider value={{ active: true, noticeHost, rightSidebar: null,
        registerRightSidebar: () => () => undefined, registerInitialRouteLoad: () => undefined,
        setViewSidebarWidth: () => undefined }}>
        <AgentDispatchDialog subject={{ kind: 'issue', issue_ref: 'ce83a84' }} instruction="do the thing" title="Start an agent" onClose={() => undefined} />
      </AppShellProvider>);
      expect((await screen.findByTestId('agent-dispatch-error')).textContent).toContain('human credential required');
      expect((screen.getByRole('button', { name: 'Start agent' }) as HTMLButtonElement).disabled).toBe(true);
      expect(fetchMock.mock.calls.some(([input]) => String(input) === '/api/agent-dispatch/preview')).toBe(true);
      expect(fetchMock.mock.calls.some(([input]) => String(input) === '/api/agent-dispatch')).toBe(false);
    } finally {
      cleanup();
      noticeHost.remove();
    }
  });
});
