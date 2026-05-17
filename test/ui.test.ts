import { render, screen, fireEvent, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';

import { appReducer, applySSEEvent, initialState, selectBadgeCounts } from '../ui/src/state';
import { AuthQueueView } from '../ui/src/views/auth';
import { ReviewView } from '../ui/src/views/review';
import { SessionsView } from '../ui/src/views/sessions';
import { WorkOverviewView } from '../ui/src/views/work';
import { LedgerIssueDetail } from '../ui/src/components/ledger/IssueDetail';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(): void {
  const mockFetch = vi.fn((input: RequestInfo) => {
    const url = String(input);
    if (url.includes('/api/review/diff')) {
      return Promise.resolve(
        new Response('<div class="diff">diff</div>', {
          headers: { 'content-type': 'text/html' },
        }),
      );
    }
    if (url.includes('/api/review/spec')) {
      return Promise.resolve(
        new Response(JSON.stringify({ markdown: 'spec', commits: ['c1'] }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify([]), {
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  vi.stubGlobal('fetch', mockFetch);
}

describe('SessionsView', () => {
  it('renders session data and triggers navigate', () => {
    const onNavigate = vi.fn();
    render(
      h(SessionsView, {
        sessions: [{ id: 's1', status: 'active', task: 'Plan work', branch: 'main' }],
        newSessionIds: {},
        onNavigate,
        onKill: () => undefined,
      }),
    );

    expect(screen.getByText('Plan work')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Actions'));
    fireEvent.click(screen.getByText('Go to'));
    expect(onNavigate).toHaveBeenCalledWith('s1');
  });
});

describe('AuthQueueView', () => {
  it('navigates between sidebar items', async () => {
    stubFetch();
    render(
      h(AuthQueueView, {
        queue: [
          { id: 'a1', title: 'First auth', repo: 'repo', base: 'main', head: 'feat' },
          { id: 'a2', title: 'Second auth', repo: 'repo', base: 'main', head: 'feat2' },
        ],
        outputs: {},
        onApprove: () => undefined,
        onReject: () => undefined,
      }),
    );

    expect(screen.getAllByText('First auth').length).toBeGreaterThan(0);
    const secondItem = document.querySelector('[data-request-id="a2"]');
    expect(secondItem).toBeTruthy();
    fireEvent.click(secondItem as Element);
    await waitFor(() => expect(screen.getAllByText('Second auth').length).toBeGreaterThan(0));
    expect(screen.getByText('Force Dismiss')).toBeTruthy();
  });
});

describe('WorkOverviewView', () => {
  it('renders repo and branch data', () => {
    render(
      h(WorkOverviewView, {
        repos: [{ id: 'r1', name: 'Repo One', path: '/repo/one' }],
        branchesByRepo: {
          r1: [
            { name: 'main', status: 'clean', ahead: 1, behind: 0, last_commit_message: 'Init' },
          ],
        },
        onRescan: () => undefined,
      }),
    );

    expect(screen.getByText('Repo One')).toBeTruthy();
    expect(screen.getAllByText('main').length).toBeGreaterThan(0);
  });
});

describe('ReviewView', () => {
  it('renders spec and diff', async () => {
    render(
      h(ReviewView, {
        params: { repo: 'repo', base: 'main', head: 'feat' },
        loaders: {
          diff: async () => '<div class="diff">diff</div>',
          spec: async () => ({ markdown: 'spec text', commits: ['c1'] }),
        },
      }),
    );

    await waitFor(() => expect(screen.getByText('spec text')).toBeTruthy());
    expect(screen.getByText('c1')).toBeTruthy();
  });
});

describe('LedgerIssueDetail', () => {
  it('renders ledger issue evidence and sanitizes Markdown HTML', () => {
    const detail = {
      id: 'iss_1',
      display_id: 'abc123',
      project: {
        id: 'proj_1',
        display_name: 'Mandible',
        remote_identity: '',
        upstream_identity: '',
        repo_id: 'mandible',
        repo_name: 'mandible',
        repo_root: '/repo',
        default_branch: 'main',
      },
      title: 'Ledger **issue**',
      body: 'Body <img src=x onerror="alert(1)">',
      status: 'closed',
      resolution: 'merged',
      kind: 'feature',
      priority: 'normal',
      source: 'git_bug',
      author: { id: null, type: 'agent', display: 'Codex' },
      created_at: Date.now(),
      updated_at: Date.now(),
      closed_at: Date.now(),
      aliases: [],
      labels: ['feature'],
      comments: [
        {
          id: 'com_1',
          body: '<script>alert(1)</script>Comment',
          author: { id: null, type: 'agent', display: 'Codex' },
          source: 'session',
          created_at: Date.now(),
          updated_at: null,
        },
      ],
      relationships: [],
      work_units: [],
      sessions: [],
      auth_requests: [
        {
          id: 'auth_1',
          type: 'merge',
          title: 'Merge feature/x',
          status: 'completed',
          repo: 'mandible',
          base_branch: 'main',
          head_branch: 'feature/x',
          created_at: Date.now(),
          approved_at: null,
          resolved_at: Date.now(),
          skipped_at: null,
          exit_code: 0,
          error: null,
          link_type: 'resolves',
          link_source: 'auth_queue',
          link_created_at: Date.now(),
          metadata: {},
        },
      ],
      conflicts: [],
      sync: { state: 'clean', outbox: {}, open_conflicts: 0, latest_jobs: [] },
    } as const;

    render(h(LedgerIssueDetail, { detail }));

    expect(screen.getByText('Auth Evidence')).toBeTruthy();
    expect(screen.getByText('Merge feature/x')).toBeTruthy();
    expect(document.body.innerHTML).not.toContain('onerror');
    expect(document.body.innerHTML).not.toContain('<script');
  });
});

describe('SSE handling', () => {
  it('updates badge counts from SSE events', () => {
    let state = initialState;
    state = applySSEEvent(state, {
      type: 'session:registered',
      session: { id: 's1', status: 'active' },
    });
    state = applySSEEvent(state, {
      type: 'auth:new',
      request: { id: 'a1', status: 'pending' },
    });
    state = applySSEEvent(state, {
      type: 'work:branch:updated',
      repo_id: 'r1',
      branch: { name: 'main', status: 'dirty' },
    });

    const badges = selectBadgeCounts(state);
    expect(badges.sessions).toBe(1);
    expect(badges.auth).toBe(1);
    expect(badges.work).toBe(1);
  });

  it('keeps badge counts stable when cached inbox data is partial', () => {
    const state = {
      ...initialState,
      inboxData: {},
    };

    const badges = selectBadgeCounts(state as typeof initialState);
    expect(badges.inbox).toBe(0);
  });

  it('appends streaming output', () => {
    let state = appReducer(initialState, {
      type: 'authOutput',
      requestId: 'a1',
      chunk: 'line1\n',
    });
    state = appReducer(state, {
      type: 'authOutput',
      requestId: 'a1',
      chunk: 'line2\n',
    });
    expect(state.authOutputs.a1).toBe('line1\nline2\n');
  });
});
