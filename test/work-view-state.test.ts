// @vitest-environment jsdom
import { bindTestInstanceCatalog } from './helpers/instance-operation-fixtures';
import { render, mainInstance } from './helpers/ui-workspace-fixture';
import { screen, fireEvent, waitFor, act } from './helpers/dom.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';

import { WorkOverviewView } from '../ui/src/views/work';

beforeEach(() => bindTestInstanceCatalog(mainInstance));

describe('WorkOverviewView', () => {

  function auditEntry(
    branch: string | null,
    classification: 'safe_candidate' | 'unique_commits' | 'dirty_worktree' | 'protected' | 'current' | 'app_managed' | 'unknown',
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const safe = classification === 'safe_candidate';
    const worktreePath = branch ? `/repo/one/worktrees/${branch.replaceAll('/', '__')}` : '/repo/one/.codex/worktrees/detached';
    return {
      kind: branch ? 'branch' : 'detached_worktree',
      branch,
      classification,
      preserve_by_default: !safe,
      reason: safe ? 'Reachable from main with a clean worktree.' : `${classification} must be preserved.`,
      blockers: safe ? [] : [`blocked:${classification}`],
      proof: { kind: safe ? 'reachable' : 'unknown', default_branch: 'main', merged: safe ? true : null },
      ahead_default: safe ? 0 : 2,
      behind_default: safe ? 1 : 0,
      default_branch: 'main',
      dirty: classification === 'dirty_worktree',
      status_known: classification !== 'unknown',
      canonical_project: classification !== 'unknown',
      canonical_project_id: classification !== 'unknown' ? 'mandible' : null,
      ambiguous_project: classification === 'unknown',
      worktree_path: worktreePath,
      trash_request: safe ? {
        project: 'mandible',
        checkout_root: '/repo/one',
        branch,
        reason: 'manual',
        issue_refs: [],
      } : null,
      trash_command: safe ? `mandible trash create --project mandible --branch ${branch}` : null,
      ...overrides,
    };
  }

  function stubAuditFetch(
    entries: Record<string, unknown>[] | (() => Record<string, unknown>[]),
    trash?: { status: number; body: Record<string, unknown> },
  ): ReturnType<typeof vi.fn> {
    const mock = vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url.includes('/audit')) {
        return new Response(JSON.stringify({
          repo: { id: 'r1', name: 'Repo One', root: '/repo/one', default_branch: 'main' },
          maintenance_issue_ref: null,
          maintenance_issue_note: 'No maintenance issue is configured.',
          worktree_inventory_known: true,
          entries: typeof entries === 'function' ? entries() : entries,
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/v1/trash' && trash) {
        return new Response(JSON.stringify(trash.body), {
          status: trash.status,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/commits')) {
        return new Response(JSON.stringify({
          repo_root: '/repo/one', branch: 'feature/safe', default_branch: 'main', merge_base: null,
          commits: [], total: 0, limit: 50, offset: 0,
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/work/repos') {
        return new Response(JSON.stringify([
          { id: 'r1', name: 'Repo One', path: '/repo/one', default_branch: 'main' },
        ]), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify([]), { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', mock);
    return mock;
  }

  it('confirms one branch and announces a truthful branch-only result without resetting view state', async () => {
    const safe = auditEntry('feature/safe', 'safe_candidate', { worktree_path: null });
    let rescanResolved = false;
    let resolveRescan!: () => void;
    const rescanPromise = new Promise<void>((resolve) => {
      resolveRescan = () => {
        rescanResolved = true;
        resolve();
      };
    });
    const mockFetch = stubAuditFetch(() => rescanResolved ? [] : [safe], {
      status: 201,
      body: { entry: { id: 'trash-1' }, outcome: { worktree_removed: false, branch_removed: true, worktree_path: null } },
    });
    const onRescan = vi.fn(() => rescanPromise);
    render(h(WorkOverviewView, {
      instance: mainInstance,
      repos: [{ id: 'r1', name: 'Repo One', path: '/repo/one', default_branch: 'main' }],
      branchesByRepo: { r1: [{ name: 'feature/safe', status: 'clean' }, { name: 'other', status: 'clean' }] },
      onRescan,
    }));

    await screen.findByText('Safe candidates');
    const filter = screen.getByPlaceholderText('Filter branches...') as HTMLInputElement;
    fireEvent.input(filter, { target: { value: 'feature' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run audit' }));
    await waitFor(() => expect(mockFetch.mock.calls.filter(([input]) => String(input).includes('/audit')).length).toBe(2));
    expect(filter.value).toBe('feature');
    expect(screen.getByRole('button', { name: /Branch audit/ }).getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Review trash action' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm trash feature/safe' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/feature\/safe[\s\S]*No worktree was removed/);
    expect(filter.value).toBe('feature');
    expect(screen.getByRole('button', { name: /Branch audit/ }).getAttribute('aria-expanded')).toBe('true');
    await waitFor(() => expect(onRescan).toHaveBeenCalledTimes(1));
    expect(mockFetch.mock.calls.filter(([input]) => String(input).includes('/audit')).length).toBe(2);
    act(() => resolveRescan());
    await waitFor(() => expect(mockFetch.mock.calls.filter(([input]) => String(input).includes('/audit')).length).toBe(3));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Review trash action' })).toBeNull());
    const trashCall = mockFetch.mock.calls.find(([input]) => String(input) === '/api/v1/trash');
    expect(JSON.parse(String((trashCall?.[1] as RequestInit).body))).toMatchObject({ branch: 'feature/safe', reason: 'manual' });
  });

  it('treats partial removal as an error while announcing completed removal facts', async () => {
    const safe = auditEntry('feature/safe', 'safe_candidate');
    stubAuditFetch([safe], {
      status: 409,
      body: {
        error: 'snapshot is safe but local removal failed',
        code: 'remove_failed',
        detail: { outcome: {
          worktree_removed: true,
          branch_removed: false,
          worktree_path: '/repo/one/worktrees/feature__safe',
        } },
      },
    });
    render(h(WorkOverviewView, {
      instance: mainInstance,
      repos: [{ id: 'r1', name: 'Repo One', path: '/repo/one' }],
      branchesByRepo: { r1: [{ name: 'feature/safe', status: 'clean' }] },
      onRescan: () => undefined,
    }));
    await screen.findByText('Safe candidates');
    fireEvent.click(screen.getByRole('button', { name: 'Review trash action' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm trash feature/safe' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/\/repo\/one\/worktrees\/feature__safe was already removed/);
    expect(alert.textContent).toMatch(/feature\/safe was not removed/);
  });
});

it('keeps cold and failed project discovery distinct from successful empty results', async () => {
  let phase: 'pending' | 'ready' | 'failed' | 'empty' = 'pending';
  const projects = [{ id: 'r1', name: 'One', path: '/repo/one' }, { id: 'r2', name: 'Two', path: '/repo/two' }];
  vi.stubGlobal('fetch', vi.fn(async (input) => {
    if (!String(input).includes('/api/work/repos')) return new Response('{}');
    if (phase === 'pending' || phase === 'failed') return new Response(JSON.stringify({ code: `repo_discovery_${phase}` }), { status: 503, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify(phase === 'ready' ? projects : []), { headers: { 'content-type': 'application/json' } });
  }));
  render(h(WorkOverviewView, { instance: mainInstance, repos: [], branchesByRepo: {}, onRescan: () => undefined }));
  await screen.findByText('Projects are still loading.');
  expect(screen.queryByText('No projects found. Register a session or add a project.')).toBeNull();
  phase = 'ready';
  await act(() => window.dispatchEvent(new CustomEvent('work:scan:completed')));
  await screen.findByRole('button', { name: 'Select project Two' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Select project One' }).getAttribute('aria-current')).toBe('true'));
  await act(() => fireEvent.click(screen.getByRole('button', { name: 'Select project Two' })));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Select project Two' }).getAttribute('aria-current')).toBe('true'));
  phase = 'failed';
  await act(() => window.dispatchEvent(new CustomEvent('work:scan:completed')));
  await screen.findByText('Could not refresh projects. Showing previous results.');
  expect(screen.getByRole('button', { name: 'Select project Two' }).getAttribute('aria-current')).toBe('true');
  expect(screen.getByRole('button', { name: 'Select project One' })).toBeTruthy();
  phase = 'empty';
  await act(() => window.dispatchEvent(new CustomEvent('work:scan:completed')));
  await screen.findByText('No projects found. Register a session or add a project.');
  expect(screen.queryByRole('button', { name: 'Select project Two' })).toBeNull();
});

it('preserves mounted compound targets, absent projects and branches, and unrelated route context', async () => {
    const repos = [{ id: 'r1', name: 'Repo One', default_branch: 'main' }, { id: 'r2', name: 'Repo Two', default_branch: 'main' }];
    const branchesByRepo = { r1: [{ name: 'main', status: 'clean' }], r2: [{ name: 'other', status: 'clean' }] };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url === '/api/work/repos' ? repos : url.includes('/commits')
        ? { commits: [], total: 0, limit: 50, offset: 0 } : url.includes('/compare')
          ? { from: 'old', to: 'new', mode: 'range', range: 'old..new', raw: '', stat: '' }
          : [];
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    }));
    const props = { repos, branchesByRepo, instance: mainInstance, onRescan: () => undefined };
    window.history.replaceState(null, '', '#/work?repo=missing&branch=gone&commit=pinned&compare=old..new&mode=range&sidebar=hidden&agent_session=bound&sentinel=a%26b%2Bc');
    const view = render(h(WorkOverviewView, { ...props, params: { repo: 'missing', branch: 'gone', commit: 'pinned', compare: 'old..new', mode: 'range' } }));
    await screen.findByText('Project unavailable: missing');
    expect(new URLSearchParams(window.location.hash.split('?')[1]).get('repo')).toBe('missing');
    view.rerender(h(WorkOverviewView, { ...props, params: { repo: 'r1', branch: 'gone', commit: 'pinned', compare: 'old..new', mode: 'range' } }));
    await screen.findByText('Branch unavailable: gone');
    expect(screen.queryByRole('list', { name: 'main commits' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Select project Repo Two' }));
    await screen.findByRole('list', { name: 'other commits' });
    const context = new URLSearchParams(window.location.hash.split('?')[1]);
    expect(context.get('repo')).toBe('r2');
    expect(context.get('branch')).toBe('other');
    expect(context.get('commit')).toBeNull();
    expect(context.get('sidebar')).toBe('hidden');
    expect(context.get('agent_session')).toBe('bound');
    expect(context.get('sentinel')).toBe('a&b+c');
    window.history.replaceState(null, '', '#/tasks?sentinel=retained');
    view.rerender(h(WorkOverviewView, { ...props, params: {} }));
    await waitFor(() => expect(window.location.hash).toBe('#/tasks?sentinel=retained'));
  });

