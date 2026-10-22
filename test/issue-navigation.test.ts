import { issueDetailProjection, render } from './helpers/ui-workspace-fixture';
import { screen, fireEvent, waitFor, cleanup, act } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { IssuesView, resolveIssueIdDeepLink, resolveIssueRepoDeepLink, type IssueRepoSummary } from '../ui/src/views/issues';

describe('issue deep links', () => {
  function stubIssuesLocalStorage(initial: Record<string, string> = {}): void {
    const store = new Map(Object.entries(initial));
    const localStorageStub = {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => store.set(key, value)),
      removeItem: vi.fn((key: string) => store.delete(key)),
      clear: vi.fn(() => store.clear()),
    };
    vi.stubGlobal('localStorage', localStorageStub);
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: localStorageStub,
    });
  }

  const repos: IssueRepoSummary[] = [
    {
      repo_id: 'mandible',
      repo_name: 'mandible',
      repo_root: '/Users/fixture/Projects/sample repo',
      open_count: 1,
      delivered_count: 0,
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
      '/Users/fixture/Projects/sample repo',
    );
    const issueId = resolveIssueIdDeepLink(
      repos[0],
      '4c2638313a4cd447fa61cc4faa1ff63526a92221c7629db1dca75b565af41c6a',
    );

    expect(repoId).toBe('mandible');
    expect(issueId).toBe('4c26383');
  });

  it('resolves partial repo summaries without requiring repo roots', () => {
    const repoId = resolveIssueRepoDeepLink(
      [{
        repo_id: 'dotfiles',
        repo_name: 'dotfiles',
        open_count: 1,
        delivered_count: 0,
        closed_count: 0,
        issues: [],
      }],
      'dotfiles',
    );

    expect(repoId).toBe('dotfiles');
  });

  it('canonicalizes a checkout-shaped deep link to the project key', () => {
    const repoId = resolveIssueRepoDeepLink(
      [{
        repo_id: 'scanner-checkout',
        project_key: 'widgets',
        repo_name: 'widgets',
        open_count: 1,
        delivered_count: 0,
        closed_count: 0,
        issues: [],
      }],
      'scanner-checkout',
    );

    expect(repoId).toBe('widgets');
  });

  it('filters the issue list by canonical kind and priority rather than labels', () => {
    stubIssuesLocalStorage();
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    const typedRepos: IssueRepoSummary[] = [{
      ...repos[0],
      issues: [
        {
          ...repos[0].issues[0],
          id: 'coord-1',
          title: 'Canonical coordination',
          kind: 'tracker',
          priority: 'high',
          labels: ['feature', 'important'],
        },
        {
          ...repos[0].issues[0],
          id: 'feature-1',
          title: 'Canonical feature',
          kind: 'feature',
          priority: 'normal',
          labels: ['coordination', 'user-action-required'],
        },
      ],
    }];

    render(h(IssuesView, {
      repos: typedRepos,
      onRescan: async () => undefined,
      defaultFilter: 'kind:tracker priority:high',
    }));

    expect(screen.getByRole('button', { name: /Canonical coordination/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Canonical feature/ })).toBeNull();
  });

  it.each(['a'.repeat(64), 'aaaaaaa'])('preserves a saved parent filter %s against canonical relationships', (parentFilter) => {
    stubIssuesLocalStorage({
      'mandible_issues_view_state:v1': JSON.stringify({ filter: 'status:all', parentFilter }),
    });
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    const child = {
      ...repos[0].issues[0],
      title: 'Canonical child',
      parent_ids: ['a'.repeat(64)],
      parent_relationships: [{
        id: 'edge-1', parent_id: 'a'.repeat(64), parent_ref: 'aaaaaaa',
        provenance: 'manual' as const, confidence: 'observed' as const,
      }],
    };
    render(h(IssuesView, {
      repos: [{ ...repos[0], issues: [child, { ...child, id: 'other', title: 'Not a child', parent_ids: [], parent_relationships: [] }] }],
      onRescan: async () => undefined,
    }));
    expect(screen.getByRole('button', { name: /Canonical child/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Not a child/ })).toBeNull();
    expect(screen.getByText('Children of aaaaaaa')).toBeTruthy();
  });

  it('migrates legacy typed filters to canonical status, resolution, and priority', () => {
    stubIssuesLocalStorage();
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    render(h(IssuesView, {
      repos,
      onRescan: async () => undefined,
      defaultFilter: 'status:merged priority:important',
    }));

    expect((screen.getByLabelText('Filter issues') as HTMLInputElement).value)
      .toBe('status:closed resolution:delivered priority:high');
  });

  it('notifies when an obsolete user-action priority filter cannot be mapped', () => {
    stubIssuesLocalStorage();
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    render(h(IssuesView, {
      repos,
      onRescan: async () => undefined,
      defaultFilter: 'priority:user-action-required',
    }));

    expect(screen.getByRole('status').textContent).toContain('priority:user-action-required');
  });

  it('renders selected issue metadata while ledger detail is still loading', async () => {
    let resolveDetail: (response: Response) => void = () => undefined;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => {
      resolveDetail = resolve;
    })));

    const { rerender } = render(h(IssuesView, {
      repos,
      onRescan: async () => undefined,
      initialRepoId: 'mandible',
      initialIssueId: '4c26383',
    }));

    expect(await screen.findByRole('heading', { name: 'Daemon reload toast link' })).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Issue actions'));
    expect(screen.getByRole('menuitem', { name: 'Show metadata' })).toBeTruthy();
    expect(screen.getByText('Loading full issue detail; more timeline entries may appear.')).toBeTruthy();
    expect(screen.queryByText('Loading...')).toBeNull();

    await act(async () => {
      resolveDetail(new Response(JSON.stringify(issueDetailProjection({
        displayId: '4c26383',
        title: 'Hydrated detail title',
      })), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });

    expect(await screen.findByRole('heading', { name: 'Hydrated detail title' })).toBeTruthy();
  });

  it('renders the pending issue body inside the normal comment card box', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    const pendingRepos: IssueRepoSummary[] = [{
      ...repos[0],
      issues: [{
        ...repos[0].issues[0],
        description: 'Pending issue **body**',
      }],
    }];

    render(h(IssuesView, {
      repos: pendingRepos,
      onRescan: async () => undefined,
      initialRepoId: 'mandible',
      initialIssueId: '4c26383',
    }));

    expect(await screen.findByRole('heading', { name: 'Daemon reload toast link' })).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Issue actions'));
    expect(screen.getByRole('menuitem', { name: 'Show metadata' })).toBeTruthy();
    const card = document.querySelector('.ledger-comment-card.ledger-timeline-card');
    expect(card).toBeTruthy();
    expect(card?.getAttribute('id')).toBe('comment-0');
    expect(card?.getAttribute('data-comment-ordinal')).toBe('0');
    expect(card?.querySelector('.ledger-comment-card__body.spec-panel')?.textContent).toContain('Pending issue body');
  });

  it('uses the canonical project key for synthesized issue detail copy refs', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    const checkoutRepos: IssueRepoSummary[] = [{
      repo_id: '20-widgets-widgets',
      project_key: 'feedbax',
      repo_name: 'Feedbax',
      repo_root: '/Users/fixture/Projects/sample repo',
      open_count: 1,
      delivered_count: 0,
      closed_count: 0,
      issues: [{
        id: 'fbx1234',
        repo_id: '20-widgets-widgets',
        repo_name: 'Feedbax',
        title: 'Feedbax synthesized issue',
        status: 'open',
        labels: ['error'],
        author: 'MLL',
        created_at: '2026-05-30T12:00:00.000Z',
        description: 'Pending issue body',
      }],
    }];

    render(h(IssuesView, {
      repos: checkoutRepos,
      onRescan: async () => undefined,
      initialRepoId: '20-widgets-widgets',
      initialIssueId: 'fbx1234',
    }));

    expect(await screen.findByRole('heading', { name: 'Feedbax synthesized issue' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy feedbax/fbx1234' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copy 20-widgets-widgets/fbx1234' })).toBeNull();
  });

  it('renders initial-stage comments before full ledger detail resolves', async () => {
    let resolveFullDetail: (response: Response) => void = () => undefined;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('stage=initial')) {
        return Promise.resolve(new Response(JSON.stringify(issueDetailProjection({
          displayId: '4c26383',
          title: 'Initial detail title',
          comments: ['First visible comment'],
          stage: 'initial',
        })), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return new Promise<Response>((resolve) => {
        resolveFullDetail = resolve;
      });
    }));

    render(h(IssuesView, {
      repos,
      onRescan: async () => undefined,
      initialRepoId: 'mandible',
      initialIssueId: '4c26383',
    }));

    expect(await screen.findByText('First visible comment')).toBeTruthy();
    expect(screen.getByText('Loading full issue detail; more timeline entries may appear.')).toBeTruthy();
    expect(screen.queryByText('Full detail comment')).toBeNull();

    await act(async () => {
      resolveFullDetail(new Response(JSON.stringify(issueDetailProjection({
        displayId: '4c26383',
        title: 'Full detail title',
        comments: ['First visible comment', 'Full detail comment'],
      })), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });

    expect(await screen.findByRole('heading', { name: 'Full detail title' })).toBeTruthy();
    expect(screen.getByText('Full detail comment')).toBeTruthy();
  });

  it('hides the full-detail loading banner when initial detail is complete enough to show', async () => {
    let resolveFullDetail: (response: Response) => void = () => undefined;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('stage=initial')) {
        return Promise.resolve(new Response(JSON.stringify(issueDetailProjection({
          displayId: '4c26383',
          title: 'Small initial detail',
          comments: ['Only visible comment'],
          stage: 'initial',
          timelinePartial: false,
        })), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return new Promise<Response>((resolve) => {
        resolveFullDetail = resolve;
      });
    }));

    render(h(IssuesView, {
      repos,
      onRescan: async () => undefined,
      initialRepoId: 'mandible',
      initialIssueId: '4c26383',
    }));

    expect(await screen.findByText('Only visible comment')).toBeTruthy();
    expect(screen.queryByText(/Loading full issue detail/)).toBeNull();

    await act(async () => {
      resolveFullDetail(new Response(JSON.stringify(issueDetailProjection({
        displayId: '4c26383',
        title: 'Small full detail',
        comments: ['Only visible comment'],
      })), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });

    expect(await screen.findByRole('heading', { name: 'Small full detail' })).toBeTruthy();
  });

  it('renders cached issue detail synchronously on reselect and revalidates full detail only', async () => {
    const multiRepos: IssueRepoSummary[] = [{
      ...repos[0],
      issues: [
        repos[0].issues[0],
        {
          id: '9f0e111',
          repo_id: 'mandible',
          repo_name: 'mandible',
          title: 'Second issue',
          status: 'open',
          labels: ['feature'],
          author: 'MLL',
          created_at: '2026-05-31T12:00:00.000Z',
          description: 'Second body',
        },
      ],
    }];
    const fetchCalls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      fetchCalls.push(url);
      const displayId = url.includes('9f0e111') ? '9f0e111' : '4c26383';
      if (url.includes('stage=initial')) {
        return Promise.resolve(new Response(JSON.stringify(issueDetailProjection({
          displayId,
          title: `${displayId} initial`,
          comments: [`${displayId} initial comment`],
          stage: 'initial',
        })), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(new Response(JSON.stringify(issueDetailProjection({
        displayId,
        title: `${displayId} full`,
        comments: [`${displayId} cached full comment`],
      })), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }));

    render(h(IssuesView, {
      repos: multiRepos,
      onRescan: async () => undefined,
      initialRepoId: 'mandible',
      initialIssueId: '4c26383',
    }));

    expect(await screen.findByRole('heading', { name: '4c26383 full' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Second issue' }));
    expect(await screen.findByRole('heading', { name: '9f0e111 full' })).toBeTruthy();
    const callsBeforeReselect = fetchCalls.length;

    fireEvent.click(screen.getByRole('button', { name: 'Daemon reload toast link' }));

    expect(await screen.findByRole('heading', { name: '4c26383 full' })).toBeTruthy();
    expect(screen.getByText('4c26383 cached full comment')).toBeTruthy();
    const reselectCalls = fetchCalls.slice(callsBeforeReselect);
    expect(reselectCalls.some((url) => url.includes('4c26383') && url.includes('stage=initial'))).toBe(false);
    expect(reselectCalls.some((url) => url.includes('4c26383') && !url.includes('stage=initial'))).toBe(true);
    expect(screen.queryByText(/Loading full issue detail/)).toBeNull();
  });

  it('restores issue detail scroll position when an issue is reselected', async () => {
    const multiRepos: IssueRepoSummary[] = [{
      ...repos[0],
      issues: [
        repos[0].issues[0],
        {
          id: '9f0e111',
          repo_id: 'mandible',
          repo_name: 'mandible',
          title: 'Second issue',
          status: 'open',
          labels: ['feature'],
          author: 'MLL',
          created_at: '2026-05-31T12:00:00.000Z',
          description: 'Second body',
        },
      ],
    }];
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const displayId = url.includes('9f0e111') ? '9f0e111' : '4c26383';
      return Promise.resolve(new Response(JSON.stringify(issueDetailProjection({
        displayId,
        title: `${displayId} full`,
        comments: Array.from({ length: 8 }, (_, index) => `${displayId} comment ${index}`),
        stage: url.includes('stage=initial') ? 'initial' : 'full',
        timelinePartial: false,
      })), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }));

    render(h(IssuesView, {
      repos: multiRepos,
      onRescan: async () => undefined,
      initialRepoId: 'mandible',
      initialIssueId: '4c26383',
    }));

    expect(await screen.findByRole('heading', { name: '4c26383 full' })).toBeTruthy();
    const scroller = document.querySelector('.ledger-issue-detail__body') as HTMLDivElement;
    scroller.scrollTop = 320;

    fireEvent.click(screen.getByRole('button', { name: 'Second issue' }));
    expect(await screen.findByRole('heading', { name: '9f0e111 full' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Daemon reload toast link' }));

    await waitFor(() => expect(scroller.scrollTop).toBe(320));
    raf.mockRestore();
  });

  it('does not refetch selected issue detail when repo summaries refresh', async () => {
    const fetchCalls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      fetchCalls.push(url);
      if (url.includes('stage=initial')) {
        return Promise.resolve(new Response(JSON.stringify(issueDetailProjection({
          displayId: '4c26383',
          title: 'Stable initial detail',
          comments: ['Visible before poll'],
          stage: 'initial',
        })), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(new Response(JSON.stringify(issueDetailProjection({
        displayId: '4c26383',
        title: 'Stable full detail',
        comments: ['Visible before poll', 'Still mounted after poll'],
      })), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }));

    const { rerender } = render(h(IssuesView, {
      repos,
      onRescan: async () => undefined,
      initialRepoId: 'mandible',
      initialIssueId: '4c26383',
    }));

    expect(await screen.findByRole('heading', { name: 'Stable full detail' })).toBeTruthy();
    const detailFetchCount = () => fetchCalls
      .filter((url) => url.includes('/api/issues/mandible/4c26383/ledger-detail'))
      .length;
    expect(detailFetchCount()).toBe(2);

    await act(async () => {
      rerender(h(IssuesView, {
        repos: repos.map((repo) => ({ ...repo, issues: [...repo.issues] })),
        onRescan: async () => undefined,
        initialRepoId: 'mandible',
        initialIssueId: '4c26383',
      }));
      await Promise.resolve();
    });

    expect(screen.getByText('Still mounted after poll')).toBeTruthy();
    expect(detailFetchCount()).toBe(2);
  });

  it('restores browser-local issue filters and the last valid selection', async () => {
    const storageKey = 'mandible_issues_view_state:v1';
    stubIssuesLocalStorage({
      [storageKey]: JSON.stringify({
        filter: 'daemon',
        filterEdited: true,
        repoFilter: 'mandible',
        parentFilter: null,
      }),
    });

    render(h(IssuesView, {
      repos,
      onRescan: async () => undefined,
      initialRepoId: 'mandible',
    }));

    expect((screen.getByLabelText('Filter issues') as HTMLInputElement).value).toBe('daemon mandible');
    expect(screen.queryByPlaceholderText('Filter by repo...')).toBeNull();
    fireEvent.input(screen.getByLabelText('Filter issues'), { target: { value: 'toast' } });
    await waitFor(() => {
      const stored = JSON.parse(String(window.localStorage.getItem(storageKey)));
      expect(stored).toEqual({
        filter: 'toast',
        filterEdited: true,
        filterNotice: null,
        parentFilter: null,
        selectedRepoId: 'mandible',
        selectedIssueId: '4c26383',
      });
    });

    cleanup();
    render(h(IssuesView, {
      repos,
      onRescan: async () => undefined,
      initialRepoId: 'another-route-repo',
    }));
    expect((screen.getByLabelText('Filter issues') as HTMLInputElement).value).toBe('toast');
    expect(screen.queryByPlaceholderText('Filter by repo...')).toBeNull();
  });

  it('replaces a removed saved issue with the first available issue', async () => {
    const storageKey = 'mandible_issues_view_state:v1';
    stubIssuesLocalStorage({
      [storageKey]: JSON.stringify({
        filter: '',
        filterEdited: false,
        parentFilter: null,
        selectedRepoId: 'removed-repo',
        selectedIssueId: 'removed-issue',
      }),
    });

    render(h(IssuesView, {
      repos,
      onRescan: async () => undefined,
    }));

    await waitFor(() => expect(
      screen.getByRole('button', { name: 'Daemon reload toast link' }).getAttribute('aria-current'),
    ).toBe('true'));
  });

  it('matches repository identity through the view-wide issue filter', () => {
    const repoFiltered: IssueRepoSummary[] = [
      repos[0],
      {
        repo_id: 'feedbax-checkout',
        project_key: 'feedbax',
        repo_name: 'Feedbax',
        repo_root: '/workspace/feedbax',
        open_count: 1,
        delivered_count: 0,
        closed_count: 0,
        issues: [{
          id: 'fbx1234',
          repo_id: 'feedbax-checkout',
          repo_name: 'Feedbax',
          title: 'Unrelated issue title',
          status: 'open',
          labels: ['feature'],
          author: 'MLL',
          created_at: '2026-05-31T12:00:00.000Z',
        }],
      },
    ];

    render(h(IssuesView, {
      repos: repoFiltered,
      onRescan: async () => undefined,
    }));

    fireEvent.input(screen.getByLabelText('Filter issues'), { target: { value: 'feedbax' } });
    expect(screen.getByRole('button', { name: /Unrelated issue title/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Daemon reload toast link/ })).toBeNull();
  });

  it('moves issue selection with ArrowUp and ArrowDown', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    const multiRepos: IssueRepoSummary[] = [{
      ...repos[0],
      issues: [
        repos[0].issues[0],
        {
          id: '9f0e111',
          repo_id: 'mandible',
          repo_name: 'mandible',
          title: 'Newer issue',
          status: 'open',
          labels: ['feature'],
          author: 'MLL',
          created_at: '2026-05-31T12:00:00.000Z',
        },
      ],
    }];

    render(h(IssuesView, {
      repos: multiRepos,
      onRescan: async () => undefined,
      initialRepoId: 'mandible',
      initialIssueId: '4c26383',
    }));

    const selected = await screen.findByRole('button', { name: /Daemon reload toast link/ });
    selected.focus();
    fireEvent.keyDown(selected, { key: 'ArrowUp' });
    const newer = screen.getByRole('button', { name: /Newer issue/ });
    expect(newer.getAttribute('aria-current')).toBe('true');
    expect(document.activeElement).toBe(newer);

    fireEvent.keyDown(newer, { key: 'ArrowDown' });
    expect(selected.getAttribute('aria-current')).toBe('true');
    expect(document.activeElement).toBe(selected);
  });

  it('keeps configured issue-filter defaults until the user edits them', async () => {
    const storageKey = 'mandible_issues_view_state:v1';
    stubIssuesLocalStorage();
    const { rerender } = render(h(IssuesView, {
      repos,
      onRescan: async () => undefined,
      defaultFilter: 'status:open',
    }));
    const filterInput = screen.getByLabelText('Filter issues') as HTMLInputElement;
    expect(filterInput.value).toBe('status:open');

    rerender(h(IssuesView, {
      repos: repos.map((repo) => ({ ...repo, issues: [...repo.issues] })),
      onRescan: async () => undefined,
      defaultFilter: 'status:closed',
    }));
    await waitFor(() => expect(filterInput.value).toBe('status:closed'));

    fireEvent.input(filterInput, { target: { value: 'daemon' } });
    rerender(h(IssuesView, {
      repos: repos.map((repo) => ({ ...repo, issues: [...repo.issues] })),
      onRescan: async () => undefined,
      defaultFilter: 'status:closed',
    }));
    expect(filterInput.value).toBe('daemon');
    await waitFor(() => {
      const stored = JSON.parse(String(window.localStorage.getItem(storageKey)));
      expect(stored.filter).toBe('daemon');
      expect(stored.filterEdited).toBe(true);
    });
  });

  it('falls back from malformed issue filter storage without changing route selection', async () => {
    const storageKey = 'mandible_issues_view_state:v1';
    stubIssuesLocalStorage({
      [storageKey]: JSON.stringify({
        filter: 42,
        filterEdited: true,
        repoFilter: ['mandible'],
        parentFilter: false,
        selectedIssueId: 'stored-selection-must-not-restore',
      }),
    });
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));

    const { rerender } = render(h(IssuesView, {
      repos,
      onRescan: async () => undefined,
      initialRepoId: 'mandible',
      initialIssueId: '4c26383',
      defaultFilter: 'status:closed',
    }));

    expect((screen.getByLabelText('Filter issues') as HTMLInputElement).value).toBe('status:closed');
    expect(await screen.findByRole('heading', { name: 'Daemon reload toast link' })).toBeTruthy();
    expect(screen.queryByText('stored-selection-must-not-restore')).toBeNull();

    rerender(h(IssuesView, {
      repos: repos.map((repo) => ({ ...repo, issues: [...repo.issues] })),
      onRescan: async () => undefined,
      initialRepoId: 'mandible',
      initialIssueId: '4c26383',
      defaultFilter: 'status:closed',
    }));
    const filterInput = screen.getByLabelText('Filter issues') as HTMLInputElement;
    await waitFor(() => expect(filterInput.value).toBe('status:closed'));
    await waitFor(() => {
      const stored = JSON.parse(String(window.localStorage.getItem(storageKey)));
      expect(stored.filter).toBe('status:closed');
      expect(stored.filterEdited).toBe(false);
    });
  });

  it('ignores stale ledger detail responses after selecting a different issue', async () => {
    const multiRepos: IssueRepoSummary[] = [{
      ...repos[0],
      issues: [
        repos[0].issues[0],
        {
          id: '9f0e111',
          repo_id: 'mandible',
          repo_name: 'mandible',
          title: 'Second issue',
          status: 'open',
          labels: ['feature'],
          author: 'MLL',
          created_at: '2026-05-31T12:00:00.000Z',
          description: 'Second body',
        },
      ],
    }];
    const pending: Array<(response: Response) => void> = [];
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => {
      pending.push(resolve);
    })));

    render(h(IssuesView, {
      repos: multiRepos,
      onRescan: async () => undefined,
      initialRepoId: 'mandible',
      initialIssueId: '4c26383',
    }));

    expect(await screen.findByRole('heading', { name: 'Daemon reload toast link' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Second issue' }));
    expect(await screen.findByRole('heading', { name: 'Second issue' })).toBeTruthy();

    await act(async () => {
      pending[0](new Response(JSON.stringify(issueDetailProjection({
        displayId: '4c26383',
        title: 'Stale first initial detail',
        stage: 'initial',
      })), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      pending[1](new Response(JSON.stringify(issueDetailProjection({
        displayId: '4c26383',
        title: 'Stale first detail',
      })), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });

    expect(screen.queryByRole('heading', { name: 'Stale first detail' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Stale first initial detail' })).toBeNull();

    await act(async () => {
      pending[2](new Response(JSON.stringify(issueDetailProjection({
        displayId: '9f0e111',
        title: 'Second initial detail',
        stage: 'initial',
      })), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });

    expect(await screen.findByRole('heading', { name: 'Second initial detail' })).toBeTruthy();

    await act(async () => {
      pending[3](new Response(JSON.stringify(issueDetailProjection({
        displayId: '9f0e111',
        title: 'Second hydrated detail',
      })), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });

    expect(await screen.findByRole('heading', { name: 'Second hydrated detail' })).toBeTruthy();
  });
});

