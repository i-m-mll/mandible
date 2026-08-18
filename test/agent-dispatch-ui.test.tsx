import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentDispatchDialog } from '../ui/src/components/agent-dispatch/AgentDispatchDialog';
import { LedgerIssueDetail } from '../ui/src/components/ledger/IssueDetail';
import type { LedgerIssueDetailProjection } from '../ui/src/api';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('issue header launch-agent affordance', () => {
  function detail(): LedgerIssueDetailProjection {
    return {
      id: 'ledger-issue-1', display_id: 'ce83a84', detail_stage: 'full',
      project: { id: 'proj-1', display_name: 'mandible', remote_identity: '', upstream_identity: '', repo_id: 'mandible', repo_name: 'mandible', repo_root: null, default_branch: 'main' },
      title: 'Agent dispatch affordances', body: 'Body', status: 'open', resolution: null,
      kind: 'feature', priority: 'unknown', source: 'mandible', created_at: 0, updated_at: 0,
      closed_at: null, author: { id: null, type: 'mandible_user', display: 'Mandible' },
      labels: [], aliases: [], comments: [], relationships: [], sessions: [], work_units: [],
      auth_requests: [], associated_artifacts: [], timeline: [], checkpoints: [], conflicts: [],
      sync: { state: 'clean', outbox: {} },
    } as unknown as LedgerIssueDetailProjection;
  }

  it('offers a confirm-first launch item without dispatching from the menu click', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: '/api/agent-dispatch/preview',
      body: { subject: { kind: 'issue', issue_ref: 'ce83a84' } },
    });
  });
});

describe('dispatch dialog contract', () => {
  it('surfaces a preview failure instead of offering confirmation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'human credential required' }, 403)));
    render(<AgentDispatchDialog subject={{ kind: 'issue', issue_ref: 'ce83a84' }} instruction="do the thing" title="Start an agent" onClose={() => undefined} />);
    expect((await screen.findByTestId('agent-dispatch-error')).textContent).toContain('human credential required');
    expect((screen.getByRole('button', { name: 'Start agent' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
