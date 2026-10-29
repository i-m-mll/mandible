// @vitest-environment jsdom
import { readPersistedDetail, writePersistedDetail } from '../ui/src/detail-cache';
import { hashKey } from '@tanstack/preact-query';
import { detailKeys } from '../ui/src/query/detailKeys';
import { queryClient } from '../ui/src/query/client';
import { invalidateDashboardApiCacheForEvent } from '../ui/src/api';
import { issueDetailProjection, render } from './helpers/ui-workspace-fixture';
import { screen, fireEvent, waitFor, cleanup, act } from './helpers/dom.js';
import { describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { IssuesView, resolveIssueRepoDeepLink, type IssueRepoSummary } from '../ui/src/views/issues';

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

  it('keeps full detail authoritative over a late initial response', async () => {
    const pending = new Map<string, (response: Response) => void>();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => new Promise<Response>((resolve) => {
      pending.set(String(input).includes('stage=initial') ? 'initial' : 'full', resolve);
    })));
    render(h(IssuesView, { repos, onRescan: async () => undefined, initialRepoId: 'mandible', initialIssueId: '4c26383' }));
    await waitFor(() => expect(pending.size).toBe(2));
    await act(async () => pending.get('full')!(Response.json(issueDetailProjection({ displayId: '4c26383', title: 'Complete detail', comments: ['Complete timeline'] }))));
    expect(await screen.findByRole('heading', { name: 'Complete detail' })).toBeTruthy();
    await act(async () => pending.get('initial')!(Response.json(issueDetailProjection({ displayId: '4c26383', title: 'Late partial', stage: 'initial' }))));
    expect(screen.getByText('Complete timeline')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Late partial' })).toBeNull();
    expect(queryClient.getQueryData(detailKeys.issue('4c26383', 'mandible'))).toMatchObject({ detail_stage: 'full' });
  });

  it('publishes a comment over an older live read while retaining its filter and draft during refresh', async () => {
    let finishOld!: (response: Response) => void;
    let reads = 0;
    const before = issueDetailProjection({ displayId: '4c26383', title: 'Comment race', comments: [] });
    const posted = issueDetailProjection({ displayId: '4c26383', title: 'Comment race', comments: ['Posted draft'] });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve(Response.json(posted));
      if (String(input).includes('stage=initial')) return Promise.resolve(Response.json({ ...before, detail_stage: 'initial', timeline_partial: true }));
      reads += 1;
      return reads === 1 ? Promise.resolve(Response.json(before)) : new Promise<Response>((resolve) => { finishOld = resolve; });
    }));
    render(h(IssuesView, { repos, onRescan: async () => undefined, initialRepoId: 'mandible', initialIssueId: '4c26383', defaultFilter: 'status:all' }));
    expect(await screen.findByRole('heading', { name: 'Comment race' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add Comment' }));
    const draft = screen.getByPlaceholderText('Write a comment...') as HTMLTextAreaElement;
    fireEvent.input(draft, { target: { value: 'Posted draft' } });
    await act(async () => invalidateDashboardApiCacheForEvent('ledger:comment:added'));
    await waitFor(() => expect(reads).toBe(2));
    expect(draft.value).toBe('Posted draft');
    expect((screen.getByLabelText('Filter issues') as HTMLInputElement).value).toBe('status:all');
    fireEvent.click(screen.getByRole('button', { name: 'Submit Comment' }));
    expect(await screen.findByText('Posted draft')).toBeTruthy();
    await act(async () => finishOld(Response.json(before)));
    expect(screen.getByText('Posted draft')).toBeTruthy();
  });

  it('retains the notes draft after a revision conflict and reconciles the authoritative detail', async () => {
    let conflicted = false;
    const before = { ...issueDetailProjection({ displayId: '4c26383', title: 'Notes conflict' }), work_notes: 'Original notes', work_notes_revision: 'revision-one' };
    const latest = { ...before, work_notes: 'Changed elsewhere', work_notes_revision: 'revision-two' };
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        conflicted = true;
        expect(JSON.parse(String(init.body))).toMatchObject({ work_notes: 'My draft', expected_work_notes_revision: 'revision-one' });
        return Promise.resolve(Response.json({ error: 'Revision conflict' }, { status: 409 }));
      }
      return Promise.resolve(Response.json(conflicted ? latest : before));
    }));
    render(h(IssuesView, { repos, onRescan: async () => undefined, initialRepoId: 'mandible', initialIssueId: '4c26383' }));
    expect(await screen.findByRole('heading', { name: 'Notes conflict' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Issue actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Working notes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.input(screen.getByRole('textbox', { name: 'Working notes' }), { target: { value: 'My draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save notes' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Working notes changed while you were editing');
    expect((screen.getByRole('textbox', { name: 'Working notes' }) as HTMLTextAreaElement).value).toBe('My draft');
    expect(queryClient.getQueryData(detailKeys.issue('4c26383', 'mandible'))).toMatchObject({ work_notes: 'Changed elsewhere', work_notes_revision: 'revision-two' });
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
    const scroller = document.querySelector('[data-detail-pane-slot="body"]') as HTMLDivElement;
    scroller.scrollTop = 320;

    fireEvent.click(screen.getByRole('button', { name: 'Second issue' }));
    expect(await screen.findByRole('heading', { name: '9f0e111 full' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Daemon reload toast link' }));

    await waitFor(() => expect(scroller.scrollTop).toBe(320));
    raf.mockRestore();
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
    expect(screen.queryByRole('heading', { name: 'Daemon reload toast link' })).toBeNull();
    expect(await screen.findByText('Loading...')).toBeTruthy();
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
    const pending = new Map<string, (response: Response) => void>();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo) => new Promise<Response>((resolve) => {
      const url = new URL(String(input), "http://localhost");
      const id = url.pathname.split("/").at(-2)!;
      pending.set(id + (url.searchParams.get("stage") === "initial" ? ":initial" : ":full"), resolve);
    })));

    render(h(IssuesView, {
      repos: multiRepos,
      onRescan: async () => undefined,
      initialRepoId: 'mandible',
      initialIssueId: '4c26383',
    }));

    await waitFor(() => expect(pending.size).toBe(2));
    expect(screen.queryByRole('heading', { name: 'Daemon reload toast link' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Second issue' }));
    expect(await screen.findByRole('heading', { name: 'Second issue' })).toBeTruthy();

    await act(async () => {
      pending.get('4c26383:initial')!(new Response(JSON.stringify(issueDetailProjection({
        displayId: '4c26383',
        title: 'Stale first initial detail',
        stage: 'initial',
      })), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      pending.get('4c26383:full')!(new Response(JSON.stringify(issueDetailProjection({
        displayId: '4c26383',
        title: 'Stale first detail',
      })), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });

    expect(screen.queryByRole('heading', { name: 'Stale first detail' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Stale first initial detail' })).toBeNull();

    await act(async () => {
      pending.get('9f0e111:initial')!(new Response(JSON.stringify(issueDetailProjection({
        displayId: '9f0e111',
        title: 'Second initial detail',
        stage: 'initial',
      })), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });

    expect(await screen.findByRole('heading', { name: 'Second initial detail' })).toBeTruthy();

    await act(async () => {
      pending.get('9f0e111:full')!(new Response(JSON.stringify(issueDetailProjection({
        displayId: '9f0e111',
        title: 'Second hydrated detail',
      })), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });

    expect(await screen.findByRole('heading', { name: 'Second hydrated detail' })).toBeTruthy();
  });
it.each([undefined, 'mandible'])('keeps a full explicit ref intact across partial rows (repo %s)', async (repoId) => {
    stubIssuesLocalStorage({
      'mandible_issues_view_state:v1': JSON.stringify({ selectedRepoId: 'saved', selectedIssueId: 'saved' }),
    });
    const fullId = '4c26383' + 'a'.repeat(57);
    const requests: string[] = [];
    const pending: Array<(response: Response) => void> = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Promise<Response>((resolve) => pending.push(resolve));
    }));
    render(h(IssuesView, { repos, onRescan: async () => undefined, initialRepoId: repoId, initialIssueId: fullId }));
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(requests.every((url) => url.includes(fullId))).toBe(true);
    expect(screen.queryByRole('heading', { name: 'Daemon reload toast link' })).toBeNull();
    await act(async () => {
      for (const resolve of pending) resolve(new Response(JSON.stringify({ error: 'Issue not found' }), {
        status: 404, headers: { 'content-type': 'application/json' },
      }));
    });
    expect(await screen.findByText(/Issue not found/)).toBeTruthy();
    expect(document.querySelector('.issues-detail h2')).toBeNull();
  });

it.each([
  ['restart', 'collision'], ['stale Query', 'collision'],
  ['restart', 'repo-b'], ['stale Query', 'repo-b'],
])('resolves a repo-less cached prefix authoritatively before promoting scope (%s, %s)', async (source, resolution) => {
    stubIssuesLocalStorage();
    const prefix = '4c26383';
    const key = detailKeys.issue(prefix);
    const cached = issueDetailProjection({ displayId: prefix, title: 'Cached repo A', projectKey: 'repo-a' });
    if (source === 'restart') writePersistedDetail('issue-detail-query-snapshot', hashKey(key), cached);
    else queryClient.setQueryData(key, cached, { updatedAt: Date.now() - 60_001 });
    let finish!: (response: Response) => void;
    const signals: AbortSignal[] = [];
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(String(input));
      signals.push(init!.signal!);
      return new Promise<Response>((resolve) => { finish = resolve; });
    }));
    render(h(IssuesView, { repos, onRescan: async () => undefined, initialIssueId: prefix }));
    expect(await screen.findByRole('heading', { name: 'Cached repo A' })).toBeTruthy();
    await act(async () => { await Promise.resolve(); });
    expect(requests).toEqual(['/api/ledger/issues/4c26383']);
    expect(signals[0].aborted).toBe(false);
    expect(queryClient.getQueryData(detailKeys.issue(prefix, 'repo-a'))).toBeUndefined();
    await act(async () => finish(resolution === 'collision'
      ? Response.json({ error: 'New prefix collision' }, { status: 409 })
      : Response.json(issueDetailProjection({ displayId: prefix, title: 'Authoritative repo B', projectKey: 'repo-b' }))));
    if (resolution === 'collision') expect(await screen.findByText('New prefix collision')).toBeTruthy();
    else {
      expect(await screen.findByRole('heading', { name: 'Authoritative repo B' })).toBeTruthy();
      await waitFor(() => expect(queryClient.getQueryData(detailKeys.issue(prefix, 'repo-b'))).toMatchObject({ title: 'Authoritative repo B' }));
    }
    expect(screen.queryByRole('heading', { name: 'Cached repo A' })).toBeNull();
    expect(queryClient.getQueryData(detailKeys.issue(prefix, 'repo-a'))).toBeUndefined();
    expect(requests).toEqual(['/api/ledger/issues/4c26383']);
  });

it('does not infer global uniqueness from one visible prefix match', async () => {
    const pending: Array<(response: Response) => void> = [];
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Promise<Response>((resolve) => pending.push(resolve));
    }));
    render(h(IssuesView, { repos, onRescan: async () => undefined, initialIssueId: '4c26383' }));
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(requests.every((url) => url.startsWith('/api/ledger/issues/4c26383'))).toBe(true);
    expect(document.querySelector('.issues-detail h2')).toBeNull();
    await act(async () => {
      for (const resolve of pending) resolve(new Response(JSON.stringify({ error: 'Ambiguous issue ref' }), {
        status: 409, headers: { 'content-type': 'application/json' },
      }));
    });
    expect(await screen.findByText(/Ambiguous issue ref/)).toBeTruthy();
    expect(document.querySelector('.issues-detail h2')).toBeNull();
  });

it('replaces mounted targets synchronously, ignores late responses and preserves row-choice context', async () => {
    const waiting = new Map<string, Array<(response: Response) => void>>();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      return new Promise<Response>((resolve) => waiting.set(url, [...waiting.get(url) ?? [], resolve]));
    }));
    const props = { repos, onRescan: async () => undefined, initialRepoId: 'mandible' };
    const { rerender } = render(h(IssuesView, { ...props, initialIssueId: 'aaaaaaa' }));
    await waitFor(() => expect(waiting.size).toBe(2));
    const release = async (id: string, title: string) => {
      await act(async () => {
        for (const [url, resolvers] of waiting) {
          if (!url.includes('/' + id + '/')) continue;
          for (const resolve of resolvers) resolve(new Response(JSON.stringify(issueDetailProjection({ displayId: id, title })), {
            headers: { 'content-type': 'application/json' },
          }));
        }
      });
    };
    await release('aaaaaaa', 'Target A');
    expect(await screen.findByRole('heading', { name: 'Target A' })).toBeTruthy();
    rerender(h(IssuesView, { ...props, initialIssueId: 'bbbbbbb' }));
    expect(screen.queryByRole('heading', { name: 'Target A' })).toBeNull();
    await waitFor(() => expect(waiting.size).toBe(4));
    rerender(h(IssuesView, { ...props, initialIssueId: 'ccccccc' }));
    await waitFor(() => expect(waiting.size).toBe(6));
    await release('ccccccc', 'Target C');
    expect(await screen.findByRole('heading', { name: 'Target C' })).toBeTruthy();
    await release('bbbbbbb', 'Stale B');
    expect(screen.queryByRole('heading', { name: 'Stale B' })).toBeNull();
    rerender(h(IssuesView, { ...props, repos: [], initialIssueId: 'ccccccc' }));
    expect(screen.getByRole('heading', { name: 'Target C' })).toBeTruthy();
    rerender(h(IssuesView, { ...props, initialIssueId: 'ccccccc' }));
    window.history.replaceState(null, '', '#/issues?issue=ccccccc&comment=3&sidebar=hidden&agent_session=agent&sentinel=a%2Bb%26c');
    fireEvent.click(screen.getByRole('button', { name: /Daemon reload toast link/ }));
    expect(await screen.findByRole('heading', { name: 'Daemon reload toast link' })).toBeTruthy();
    const params = new URLSearchParams(window.location.hash.split('?')[1]);
    expect(Object.fromEntries(params)).toEqual({ repo: 'mandible', issue: '4c26383', sidebar: 'hidden', agent_session: 'agent', sentinel: 'a+b&c' });
  });

it('resolves an unloaded closed issue and its comment without selecting the saved issue', async () => {
    stubIssuesLocalStorage({ 'mandible_issues_view_state:v1': JSON.stringify({
      selectedRepoId: 'mandible', selectedIssueId: '4c26383', filter: 'status:open', filterEdited: true,
    }) });
    const id = 'bbbbbbb' + 'b'.repeat(57);
    const detail = { ...issueDetailProjection({ displayId: 'bbbbbbb', title: 'Unloaded closed B', comments: ['Requested comment'] }), id, status: 'closed' };
    const scroll = vi.fn();
    const previousScroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(detail), {
      headers: { 'content-type': 'application/json' },
    }))));
    try {
      const { rerender } = render(h(IssuesView, { repos, onRescan: async () => undefined, initialIssueId: id, initialCommentId: '1' }));
      expect(await screen.findByRole('heading', { name: 'Unloaded closed B' })).toBeTruthy();
      await waitFor(() => expect(scroll).toHaveBeenCalledWith({ block: 'center' }));
      expect(screen.queryByRole('heading', { name: 'Daemon reload toast link' })).toBeNull();
      expect(document.querySelector('.issues-list [aria-current="true"]')).toBeNull();
      rerender(h(IssuesView, { repos: [], onRescan: async () => undefined, initialIssueId: id, initialCommentId: '1' }));
      expect(screen.getByRole('heading', { name: 'Unloaded closed B' })).toBeTruthy();
    } finally {
      HTMLElement.prototype.scrollIntoView = previousScroll;
    }
  });

it.each([404, 409, 503])('reconciles cached issue prefix identity with authoritative status %s', async (status) => {
    stubIssuesLocalStorage();
    const prefix = '4c26383';
    const key = hashKey(detailKeys.issue(prefix, 'mandible'));
    const cached = { ...issueDetailProjection({ displayId: prefix, title: 'Cached unique A' }), id: prefix + 'a'.repeat(57) };
    writePersistedDetail('issue-detail-query-snapshot', key, cached);
    writePersistedDetail('issue-detail-query-snapshot', 'unrelated', { id: 'unrelated' });
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    render(h(IssuesView, { repos, onRescan: async () => undefined, initialRepoId: 'mandible', initialIssueId: prefix }));
    expect(await screen.findByRole('heading', { name: 'Cached unique A' })).toBeTruthy();
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    await act(async () => finish(new Response(JSON.stringify({ error: `Authoritative ${status}` }), {
      status, headers: { 'content-type': 'application/json' },
    })));
    if (status === 503) {
      expect(screen.getByRole('heading', { name: 'Cached unique A' })).toBeTruthy();
      expect(readPersistedDetail('issue-detail-query-snapshot', key)).toEqual(cached);
    } else {
      expect(await screen.findByText(`Authoritative ${status}`)).toBeTruthy();
      expect(screen.queryByRole('heading', { name: 'Cached unique A' })).toBeNull();
      expect(readPersistedDetail('issue-detail-query-snapshot', key)).toBeNull();
    }
    expect(readPersistedDetail('issue-detail-query-snapshot', 'unrelated')).toEqual({ id: 'unrelated' });
  });

it('does not restore an invalid issue identity from a late initial projection', async () => {
    let initial!: (response: Response) => void;
    let full!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => new Promise<Response>((resolve) => {
      if (String(input).includes('stage=initial')) initial = resolve;
      else full = resolve;
    })));
    render(h(IssuesView, { repos, onRescan: async () => undefined, initialRepoId: 'mandible', initialIssueId: '4c26383' }));
    await waitFor(() => expect(full).toBeTypeOf('function'));
    await act(async () => full(new Response(JSON.stringify({ error: 'Ambiguous prefix' }), {
      status: 409, headers: { 'content-type': 'application/json' },
    })));
    expect(await screen.findByText('Ambiguous prefix')).toBeTruthy();
    await act(async () => initial(new Response(JSON.stringify(issueDetailProjection({
      displayId: '4c26383', title: 'Obsolete initial A', stage: 'initial',
    })), { headers: { 'content-type': 'application/json' } })));
    expect(screen.queryByRole('heading', { name: 'Obsolete initial A' })).toBeNull();
    expect(screen.getByText('Ambiguous prefix')).toBeTruthy();
  });
});
