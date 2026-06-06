import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';

import { appReducer, applySSEEvent, initialState, selectBadgeCounts } from '../ui/src/state';
import { parseRouteFromHash } from '../ui/src/routing';
import { AuthQueueView } from '../ui/src/views/auth';
import { ReviewView } from '../ui/src/views/review';
import { SessionsView } from '../ui/src/views/sessions';
import { SettingsView } from '../ui/src/views/settings';
import { WorkOverviewView } from '../ui/src/views/work';
import { ArtifactsView } from '../ui/src/views/artifacts';
import { getInstructionMessageMeta } from '../ui/src/views/conversations';
import { LedgerIssueDetail } from '../ui/src/components/ledger/IssueDetail';
import { useSidebarResize } from '../ui/src/hooks/useSidebarResize';
import {
  resolveIssueIdDeepLink,
  resolveIssueRepoDeepLink,
  type IssueRepoSummary,
} from '../ui/src/views/issues';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setViewportWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  });
  fireEvent(window, new Event('resize'));
}

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

describe('App routing', () => {
  it('routes legacy monitor hashes into console', () => {
    expect(parseRouteFromHash('#/sessions?session=s1')).toEqual({
      tab: 'console',
      params: { session: 's1' },
    });
  });
});

describe('SettingsView', () => {
  it('renders a close button when an onClose handler is supplied', () => {
    const onClose = vi.fn();
    render(
      h(SettingsView, {
        settings: {},
        onSave: async () => undefined,
        onClose,
      }),
    );

    fireEvent.click(screen.getByLabelText('Close settings'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not show deprecated Reaper controls', () => {
    render(
      h(SettingsView, {
        settings: {
          reaper_enabled: 'true',
          reaper_claude_idle_minutes: '30',
          reaper_codex_idle_minutes: '45',
        },
        onSave: async () => undefined,
      }),
    );

    expect(screen.queryByText('Reaper')).toBeNull();
    expect(screen.queryByText('Claude idle threshold')).toBeNull();
    expect(screen.queryByText('Codex idle threshold')).toBeNull();
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

    expect(screen.getAllByText('Repo One').length).toBeGreaterThan(0);
    expect(screen.getAllByText('main').length).toBeGreaterThan(0);
  });

  it('uses a sidebar/detail layout with advanced work filters', async () => {
    const onRescan = vi.fn();
    render(
      h(WorkOverviewView, {
        repos: [
          { id: 'old', name: 'Zeta Repo', path: '/repo/zeta' },
          { id: 'new', name: 'Alpha Repo', path: '/repo/alpha' },
        ],
        branchesByRepo: {
          old: [
            {
              name: 'legacy',
              status: 'clean',
              last_commit_message: 'Older work',
              last_commit_date: '2024-01-01T10:00:00Z',
            },
          ],
          new: [
            {
              name: 'feature/work',
              status: 'dirty',
              last_commit_message: 'Fresh work',
              last_commit_date: '2024-01-03T10:00:00Z',
            },
          ],
        },
        onRescan,
      }),
    );

    expect(screen.queryByText('Rescan')).toBeNull();
    expect(screen.getByLabelText('Repositories')).toBeTruthy();
    expect(screen.getByLabelText('Repository details')).toBeTruthy();
    expect(screen.getByPlaceholderText('Search repos...')).toBeTruthy();
    expect(screen.getAllByText('Alpha Repo').length).toBeGreaterThan(0);
    expect(screen.getByText('feature/work')).toBeTruthy();
    expect(screen.getAllByText('\u2191 Push').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByLabelText('Advanced filters'));
    expect(screen.getByText('Show excluded')).toBeTruthy();
    expect(screen.getByText('Refresh now')).toBeTruthy();
    fireEvent.click(screen.getByText('Refresh now'));
    expect(onRescan).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByDisplayValue('Last activity'), { target: { value: 'name' } });
    fireEvent.click(screen.getByTitle('Reverse sort direction'));
    await waitFor(() => {
      const repoNames = Array.from(document.querySelectorAll('.work-repo-item__name'))
        .map((node) => node.textContent ?? '');
      expect(repoNames[0]).toContain('Alpha Repo');
    });

    fireEvent.click(screen.getByText('Zeta Repo'));
    expect(screen.getByText('legacy')).toBeTruthy();
  });
});

describe('issue deep links', () => {
  const repos: IssueRepoSummary[] = [
    {
      repo_id: 'mandible',
      repo_name: 'mandible',
      repo_root: '/Users/mll/Main/10 Projects/05 Utils/mandible',
      open_count: 1,
      merged_count: 0,
      closed_count: 0,
      issues: [
        {
          id: '4c26383',
          repo_id: 'mandible',
          repo_name: 'mandible',
          title: 'Daemon reload toast link',
          status: 'open',
          labels: ['error'],
          author: 'MLL',
          created_at: '2026-05-30T12:00:00.000Z',
          description: '',
        },
      ],
    },
  ];

  it('resolves repo paths and full issue ids to Issues tab route values', () => {
    const repoId = resolveIssueRepoDeepLink(
      repos,
      '/Users/mll/Main/10 Projects/05 Utils/mandible',
    );
    const issueId = resolveIssueIdDeepLink(
      repos[0],
      '4c2638313a4cd447fa61cc4faa1ff63526a92221c7629db1dca75b565af41c6a',
    );

    expect(repoId).toBe('mandible');
    expect(issueId).toBe('4c26383');
  });
});

describe('useSidebarResize', () => {
  function stubLocalStorage(initial: Record<string, string> = {}): void {
    const store = new Map(Object.entries(initial));
    const localStorageStub = {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key);
      }),
      clear: vi.fn(() => {
        store.clear();
      }),
    };

    vi.stubGlobal('localStorage', localStorageStub);
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: localStorageStub,
    });
  }

  function ResizeProbe() {
    const { width } = useSidebarResize({
      defaultWidth: 420,
      minWidth: 280,
      storageKey: 'sidebar-width:test',
    });

    return h('div', {
      'data-testid': 'sidebar',
      'data-width': width === null ? 'auto' : String(width),
      style: width === null ? {} : { width: `${width}px` },
    });
  }

  it('drops and restores inline width immediately across the mobile breakpoint', async () => {
    stubLocalStorage({ 'sidebar-width:test': '480' });
    setViewportWidth(1024);

    render(h(ResizeProbe, {}));
    const sidebar = screen.getByTestId('sidebar');

    expect(sidebar.getAttribute('data-width')).toBe('480');
    expect((sidebar as HTMLElement).style.width).toBe('480px');

    setViewportWidth(700);
    await waitFor(() => expect(sidebar.getAttribute('data-width')).toBe('auto'));
    expect((sidebar as HTMLElement).style.width).toBe('');

    setViewportWidth(701);
    await waitFor(() => expect(sidebar.getAttribute('data-width')).toBe('480'));
    expect((sidebar as HTMLElement).style.width).toBe('480px');
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

    expect(screen.queryByRole('heading', { name: 'Auth Evidence' })).toBeNull();
    expect(screen.getByText('resolved by')).toBeTruthy();
    expect(screen.getByText('Merge feature/x')).toBeTruthy();
    expect(screen.queryByText('Timeline')).toBeNull();
    expect(document.body.innerHTML).not.toContain('onerror');
    expect(document.body.innerHTML).not.toContain('<script');
  });

  it('linkifies typed ledger issue and comment references outside code', () => {
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
      title: 'Refs',
      body: 'See [issue:def456], #789abcd, auth request 2257522a, merge 204ade09bc3a, [comment:mandible/def456#com_2], next `020a65b`, commit `7714da1`, current commit is f026c06, superseding the earlier 7714da1, artifact://sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, <feedbax://runs/demo>, repo://mandible@main/results/report.md, and `#deadbee` in code.',
      status: 'open',
      resolution: null,
      kind: 'feature',
      priority: 'normal',
      source: 'mandible',
      author: { id: null, type: 'agent', display: 'Codex' },
      created_at: Date.now(),
      updated_at: Date.now(),
      closed_at: null,
      aliases: [],
      labels: ['feature', 'merged'],
      comments: [
        {
          id: 'com_1',
          body: 'Local [comment:#com_1]',
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
          id: '2257522a-39a2-467b-b3f8-491aea66754c',
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
          link_type: 'references',
          link_source: 'auth_queue',
          link_created_at: Date.now(),
          metadata: {},
        },
      ],
      conflicts: [],
      sync: { state: 'clean', outbox: {}, open_conflicts: 0, latest_jobs: [] },
    } as const;

    render(h(LedgerIssueDetail, { detail }));

    const issueLinks = Array.from(document.querySelectorAll('a.ledger-xref')).map((node) => ({
      text: node.textContent,
      href: (node as HTMLAnchorElement).getAttribute('href'),
    }));
    expect(issueLinks).toContainEqual({ text: 'def456', href: '#/issues?repo=mandible&issue=def456' });
    expect(issueLinks).toContainEqual({ text: '#789abcd', href: '#/issues?repo=mandible&issue=789abcd' });
    expect(issueLinks).toContainEqual({
      text: '2257522a',
      href: '#/auth?request=2257522a',
    });
    expect(issueLinks.some((link) => link.text === '204ade09bc3a')).toBe(false);
    expect(issueLinks).toContainEqual({
      text: 'def456#com_2',
      href: '#/issues?repo=mandible&issue=def456&comment=com_2',
    });
    expect(issueLinks).toContainEqual({
      text: '020a65b',
      href: '#/issues?repo=mandible&issue=020a65b',
    });
    expect(issueLinks.some((link) => link.text === '7714da1')).toBe(false);
    expect(issueLinks.some((link) => link.text === 'f026c06')).toBe(false);
    expect(issueLinks).toContainEqual({
      text: 'abc123#com_1',
      href: '#/issues?repo=mandible&issue=abc123&comment=com_1',
    });
    const artifactLinks = Array.from(document.querySelectorAll('a.artifact-xref')).map((node) => ({
      text: node.textContent,
      href: (node as HTMLAnchorElement).getAttribute('href'),
    }));
    expect(artifactLinks).toContainEqual({
      text: 'artifact://sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      href: '#/artifacts?ref=artifact%3A%2F%2Fsha256%2Faaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(artifactLinks).toContainEqual({
      text: 'feedbax://runs/demo',
      href: '#/artifacts?ref=feedbax%3A%2F%2Fruns%2Fdemo',
    });
    expect(artifactLinks).toContainEqual({
      text: 'repo://mandible@main/results/report.md',
      href: '#/artifacts?ref=repo%3A%2F%2Fmandible%40main%2Fresults%2Freport.md',
    });
    const codeBlocks = Array.from(document.querySelectorAll('code'));
    expect(codeBlocks.some((node) => node.innerHTML.includes('#deadbee'))).toBe(true);
    expect(codeBlocks.some((node) => Boolean(node.querySelector('a')))).toBe(false);
  });

  it('normalizes imported comments with escaped newline sequences before Markdown rendering', () => {
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
      title: 'Escaped newlines',
      body: 'Body',
      status: 'open',
      resolution: null,
      kind: 'feature',
      priority: 'normal',
      source: 'mandible',
      author: { id: null, type: 'agent', display: 'Codex' },
      created_at: Date.now(),
      updated_at: Date.now(),
      closed_at: null,
      aliases: [],
      labels: ['feature'],
      comments: [
        {
          id: 'com_1',
          body: 'Implemented on branch.\\n\\nCommit:\\n- abc1234 — summary',
          author: { id: null, type: 'agent', display: 'Codex' },
          source: 'session',
          created_at: Date.now(),
          updated_at: null,
        },
      ],
      relationships: [],
      work_units: [],
      sessions: [],
      auth_requests: [],
      conflicts: [],
      sync: { state: 'clean', outbox: {}, open_conflicts: 0, latest_jobs: [] },
    } as const;

    render(h(LedgerIssueDetail, { detail }));

    expect(document.body.textContent).not.toContain('\\n');
    expect(screen.getByText('Commit:')).toBeTruthy();
    expect(screen.getByText(/abc1234/)).toBeTruthy();
  });

  it('renders associated artifacts as compact links into the artifacts view', () => {
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
      title: 'Artifacts',
      body: 'Body',
      status: 'open',
      resolution: null,
      kind: 'feature',
      priority: 'normal',
      source: 'mandible',
      author: { id: null, type: 'agent', display: 'Codex' },
      created_at: Date.now(),
      updated_at: Date.now(),
      closed_at: null,
      aliases: [],
      labels: ['feature'],
      comments: [],
      relationships: [],
      work_units: [],
      sessions: [],
      auth_requests: [],
      associated_artifacts: [
        {
          id: 'artifact:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          algorithm: 'sha256',
          content_hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          uri: 'artifact://sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          media_type: 'text/markdown',
          role: 'report',
          provider_id: 'provider_1',
          manifest_id: 'manifest_1',
          custody_mode: 'managed',
          availability: 'present',
          created_at: Date.now(),
          refs: ['repo://mandible@main/results/report.md'],
          links: [
            {
              id: 'link_1',
              entity_type: 'issue',
              entity_id: 'iss_1',
              link_type: 'produced_by',
              role: 'report',
              repo_id: 'mandible',
              provider_id: 'provider_1',
              source: 'artifact_registry',
              metadata: {},
              created_at: Date.now(),
              updated_at: Date.now(),
            },
          ],
        },
      ],
      conflicts: [],
      sync: { state: 'clean', outbox: {}, open_conflicts: 0, latest_jobs: [] },
    } as const;

    render(h(LedgerIssueDetail, { detail }));

    expect(screen.getByText('Associated Artifacts')).toBeTruthy();
    const link = screen.getByText('repo://mandible@main/results/report.md').closest('a') as HTMLAnchorElement | null;
    expect(link?.getAttribute('href')).toBe(
      '#/artifacts?artifact=artifact%3Asha256%3Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    expect(screen.getByText('linked + referenced')).toBeTruthy();
    expect(screen.getByText('report · text/markdown · provider_1 · present')).toBeTruthy();
  });

  it('keeps issue and comment provenance behind metadata controls', () => {
    const now = Date.now();
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
      title: 'Metadata',
      body: 'Body',
      status: 'open',
      resolution: null,
      kind: 'umbrella',
      priority: 'high',
      source: 'git_bug',
      author: { id: null, type: 'external_adapter', display: 'MLL' },
      created_at: now,
      updated_at: now,
      closed_at: null,
      aliases: [],
      labels: ['feature'],
      comments: [
        {
          id: 'com_1',
          body: 'Comment',
          author: { id: null, type: 'external_adapter', display: 'MLL' },
          source: 'git_bug',
          created_at: now,
          updated_at: null,
        },
      ],
      relationships: [],
      work_units: [],
      sessions: [],
      auth_requests: [],
      conflicts: [],
      sync: { state: 'clean', outbox: {}, open_conflicts: 0, latest_jobs: [] },
    } as const;

    render(h(LedgerIssueDetail, { detail }));

    const issueHeader = document.querySelector('.ledger-issue-detail__header');
    const issueMeta = document.querySelector('.ledger-issue-detail__meta');
    const issueVisibleMeta = Array.from(issueMeta?.querySelectorAll(':scope > span') ?? [])
      .map((node) => node.textContent)
      .join(' ');
    expect(issueVisibleMeta).toContain('MLL');
    expect(issueVisibleMeta).not.toContain('git_bug');
    expect(issueVisibleMeta).not.toContain('umbrella');
    expect(issueHeader?.querySelector('[aria-label="Issue metadata"]')).toBeTruthy();

    const commentHeader = document.querySelectorAll('.ledger-comment-card__header')[1];
    const commentVisibleMeta = Array.from(commentHeader?.querySelectorAll(':scope > span, :scope > time') ?? [])
      .map((node) => node.textContent)
      .join(' ');
    expect(commentVisibleMeta).toContain('MLL');
    expect(commentVisibleMeta).not.toContain('external adapter');
    expect(commentVisibleMeta).not.toContain('git_bug');
    expect(commentHeader?.querySelector('[aria-label="Comment metadata"]')).toBeTruthy();
  });

  it('keeps issue actions in the header overflow menu while preserving the comment composer button', () => {
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
      title: 'Actions',
      body: 'Body',
      status: 'open',
      resolution: null,
      kind: 'feature',
      priority: 'normal',
      source: 'mandible',
      author: { id: null, type: 'mandible_user', display: 'Mandible' },
      created_at: Date.now(),
      updated_at: Date.now(),
      closed_at: null,
      aliases: [],
      labels: ['feature'],
      comments: [],
      relationships: [],
      work_units: [],
      sessions: [],
      auth_requests: [],
      conflicts: [],
      sync: { state: 'clean', outbox: {}, open_conflicts: 0, latest_jobs: [] },
    } as const;

    render(h(LedgerIssueDetail, {
      detail,
      onAddComment: () => undefined,
      onSetStatus: () => undefined,
      onStartAgent: () => undefined,
    }));

    expect(document.querySelector('.ledger-issue-detail__actions')).toBeNull();
    expect(screen.getByText('Add Comment')).toBeTruthy();
    const visibleLabels = Array.from(document.querySelectorAll('.ledger-label')).map((node) => node.textContent);
    expect(visibleLabels).toContain('feature');
    expect(visibleLabels).not.toContain('merged');
    expect(screen.queryByText('Start Agent')).toBeNull();
    expect(screen.queryByText('Close Issue')).toBeNull();

    fireEvent.click(screen.getByLabelText('Issue actions'));

    expect(screen.getByText('Start Agent')).toBeTruthy();
    expect(screen.getByText('Close Issue')).toBeTruthy();
    expect(screen.getAllByText('Add Comment')).toHaveLength(2);
  });
});

describe('ArtifactsView', () => {
  it('renders HumbleB knowledge backrefs in artifact detail', async () => {
    const artifact = {
      id: 'artifact:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      algorithm: 'sha256',
      content_hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      uri: 'artifact://sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      media_type: 'text/markdown',
      role: 'report',
      size_bytes: 42,
      provider_id: 'feedbax',
      manifest_id: null,
      metadata: { title: 'Demo Report' },
      pinned: false,
      custody_mode: 'managed',
      home_repo_id: 'mandible',
      repo_locator: {},
      availability: 'present',
      retention: {},
      reference: {},
      created_at: Date.now(),
      aliases: [],
      links: [],
    };
    const mockFetch = vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts?')) {
        return Promise.resolve(
          new Response(JSON.stringify({ artifacts: [artifact] }), {
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.endsWith('/content')) {
        return Promise.resolve(
          new Response(JSON.stringify({
            content: {
              artifact_id: artifact.id,
              status: 'unavailable',
              kind: 'unavailable',
              media_type: 'text/markdown',
              size_bytes: 0,
              source: null,
              preview: null,
              download: { available: false, media_type: 'text/markdown', size_bytes: 0, filename: null },
              reason: 'No inline preview is available.',
            },
          }), {
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.endsWith('/knowledge-backrefs')) {
        return Promise.resolve(
          new Response(JSON.stringify({
            backrefs: [
              {
                id: 'kb_1',
                source_type: 'artifact',
                source_id: artifact.id,
                provider_id: 'humbleb',
                ref_type: 'claim',
                external_id: 'claim_1',
                external_ref: 'humbleb://claims/claim_1',
                status: 'indexed',
                metadata: {},
                created_at: Date.now(),
                updated_at: Date.now(),
              },
            ],
          }), {
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.includes(encodeURIComponent(artifact.id))) {
        return Promise.resolve(
          new Response(JSON.stringify({ artifact }), {
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    });
    vi.stubGlobal('fetch', mockFetch);

    render(h(ArtifactsView, { initialArtifactId: artifact.id }));

    await waitFor(() => expect(screen.getByText('humbleb://claims/claim_1')).toBeTruthy());
    const filterButton = screen.getByLabelText('Artifact filters');
    expect(filterButton.textContent).not.toContain('⋯');
    expect(filterButton.querySelector('svg')).toBeTruthy();
    expect(screen.getByText('Knowledge Backrefs')).toBeTruthy();
    expect(screen.getByText('claim')).toBeTruthy();
    expect(screen.getByText('indexed')).toBeTruthy();
  });
});

describe('conversation instruction message labels', () => {
  it('recognizes project AGENTS.md and CLAUDE.md instruction messages', () => {
    expect(getInstructionMessageMeta('AGENTS.md instructions for /Users/me/repo\n# Agent Instructions')).toEqual({
      filename: 'AGENTS.md',
      scope: 'Project',
      path: '/Users/me/repo',
    });
    expect(getInstructionMessageMeta('# CLAUDE.md instructions for /Users/me/repo\n# Rules')).toEqual({
      filename: 'CLAUDE.md',
      scope: 'Project',
      path: '/Users/me/repo',
    });
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
