import { bindTestInstanceCatalog } from './helpers/instance-operation-fixtures';
import { changeSelect, render, mainInstance } from './helpers/ui-workspace-fixture';
import { readFileSync } from 'node:fs';
import { screen, fireEvent, waitFor, act, within } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';

import { WorkOverviewView } from '../ui/src/views/work';

beforeEach(() => bindTestInstanceCatalog(mainInstance));

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
    const style = document.createElement('style');
    style.dataset.testCompactHeaderStyles = '';
    style.textContent = readFileSync('ui/src/styles/detail-pane-shell.css', 'utf8')
      .replaceAll('var(--app-header-height)', '48px');
    document.head.append(style);

    const onRescan = vi.fn();
    render(
      h(WorkOverviewView, {
        instance: mainInstance,
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
    expect(screen.getByLabelText('Projects')).toBeTruthy();
    expect(screen.getByLabelText('Repository details')).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: 'Search projects' })).toBeTruthy();
    expect(screen.getByPlaceholderText('Search projects...')).toBeTruthy();
    expect(screen.getByRole('separator', { name: 'Resize Projects sidebar' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Select project Alpha Repo' }).closest('.sidebar-item-row')).toBeTruthy();
    const footer = document.querySelector('.work-sidebar__footer');
    expect(footer?.children).toHaveLength(2);
    expect(screen.getByRole('button', { name: '+ Add project' }).parentElement).toBe(footer);
    expect(screen.getByRole('button', { name: '\u2191\u2191 Push All' }).parentElement).toBe(footer);
    fireEvent.click(screen.getByRole('button', { name: '+ Add project' }));
    expect(screen.getByRole('textbox', { name: 'Project path' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add project' })).toBeTruthy();
    expect(screen.getAllByText('Alpha Repo').length).toBeGreaterThan(0);
    expect(screen.getAllByText('feature/work').length).toBeGreaterThan(0);
    expect(screen.getAllByText('\u2191 Push').length).toBeGreaterThan(0);
    const projectDetail = document.querySelector('.work-detail-panel.detail-pane-shell--compact') as HTMLElement;
    const projectHeader = projectDetail.querySelector('.detail-pane-header--compact') as HTMLElement;
    expect(projectDetail).toBeTruthy();
    expect(projectHeader.getAttribute('data-detail-pane-header-variant')).toBe('compact');
    expect(within(projectHeader).getByRole('heading', { name: 'Alpha Repo' })).toBeTruthy();
    expect(within(projectHeader).getByRole('group', { name: 'Repository settings' })).toBeTruthy();
    expect(within(projectHeader).getByRole('button', { name: 'Repo settings' })).toBeTruthy();
    const projectMain = projectHeader.querySelector(':scope > .detail-pane-header__main') as HTMLElement;
    const projectTitleRow = projectMain.firstElementChild as HTMLElement;
    const projectMenu = projectHeader.querySelector('.detail-pane-header__menu') as HTMLElement;
    const projectMetadata = projectHeader.querySelector('.detail-pane-header__compact-metadata') as HTMLElement;
    expect(projectTitleRow.querySelector('.detail-pane-header__title')?.nextElementSibling).toBe(projectMenu);
    expect(projectTitleRow.nextElementSibling).toBe(projectMetadata);
    expect(projectMetadata.querySelector('.work-repo-push-btn')).toBeTruthy();
    expect(projectDetail.querySelector(':scope > .detail-pane-shell__body.work-detail__body')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Advanced filters'));
    expect(screen.getByText('Show excluded')).toBeTruthy();
    expect(screen.queryByText('Refresh now')).toBeNull();
    expect(screen.queryByText('Scan now')).toBeNull();
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(onRescan).toHaveBeenCalledTimes(1));

    changeSelect(screen.getByDisplayValue('Last activity'), 'name');
    fireEvent.click(screen.getByTitle('Reverse sort direction'));
    await waitFor(() => {
      const repoNames = Array.from(document.querySelectorAll('.work-repo-list .sidebar-item-row__label'))
        .map((node) => node.textContent ?? '');
      expect(repoNames[0]).toContain('Alpha Repo');
    });

    fireEvent.click(screen.getByText('Zeta Repo'));
    expect(screen.getAllByText('legacy').length).toBeGreaterThan(0);
  });

  it('uses project language for empty and add-error guidance', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input) => String(input).endsWith('/api/work/repos')
      ? new Response('[]', { headers: { 'content-type': 'application/json' } })
      : new Response(JSON.stringify({ error: 'Path is not a Git project.' }), { status: 400, headers: { 'content-type': 'application/json' } })));
    render(h(WorkOverviewView, {
      instance: mainInstance,
      repos: [],
      branchesByRepo: {},
      onRescan: () => undefined,
    }));

    await screen.findByText('No projects found. Register a session or add a project.');
    fireEvent.click(screen.getByRole('button', { name: '+ Add project' }));
    fireEvent.input(screen.getByRole('textbox', { name: 'Project path' }), {
      target: { value: '/missing/project' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add project' }));
    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toContain('Could not add project');
    expect(notice.textContent).toContain('Path is not a Git project.');
  });

  it('loads commit browser and renders URL compare state through DiffView', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url === '/api/work/repos') {
        return new Response(JSON.stringify([
          { id: 'r1', name: 'Repo One', path: '/repo/one', default_branch: 'main' },
        ]), { headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/commits')) {
        return new Response(JSON.stringify({
          repo_root: '/tmp/repo',
          branch: 'feature/work',
          default_branch: 'main',
          merge_base: 'base0000',
          commits: [
            {
              hash: 'new000000000',
              short_hash: 'new0000',
              message: 'Fresh work',
              author: 'Test User',
              date: '2024-01-03T10:00:00Z',
              parents: ['old000000000'],
              classification: 'unique',
              is_pre_branch_point: false,
              is_merged_elsewhere: false,
            },
          ],
          total: 1,
          limit: 50,
          offset: 0,
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/compare')) {
        return new Response(JSON.stringify({
          repo_root: '/tmp/repo',
          from: 'old000000000',
          to: 'new000000000',
          mode: 'range',
          range: 'old000000000..new000000000',
          raw: [
            'diff --git a/file.txt b/file.txt',
            '--- a/file.txt',
            '+++ b/file.txt',
            '@@ -1 +1 @@',
            '-old',
            '+new',
          ].join('\n'),
          stat: 'file.txt | 2 +-',
        }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify([]), { headers: { 'content-type': 'application/json' } });
    }));

    render(
      h(WorkOverviewView, {
        instance: mainInstance,
        repos: [{ id: 'r1', name: 'Repo One', path: '/repo/one', default_branch: 'main' }],
        branchesByRepo: {
          r1: [
            { name: 'feature/work', status: 'clean', ahead_default: 1, behind_default: 0, last_commit_message: 'Fresh work' },
          ],
        },
        params: {
          repo: 'r1',
          branch: 'feature/work',
          compare: 'old000000000..new000000000',
          mode: 'range',
        },
        onRescan: () => undefined,
      }),
    );

    expect((await screen.findAllByText('Fresh work')).length).toBeGreaterThan(0);
    expect(await screen.findByLabelText('Projects compare diff')).toBeTruthy();
    expect(screen.getByText('file.txt | 2 +-')).toBeTruthy();
  });

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
      if (url.endsWith('/audit')) {
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

  it('renders every audit safety group with proof, paths, commands, and disabled reasons', async () => {
    const entries = [
      auditEntry('feature/safe', 'safe_candidate'),
      auditEntry('feature/unique', 'unique_commits'),
      auditEntry('feature/dirty', 'dirty_worktree', {
        worktree_path: '/repo/one/work trees/feature__dirty',
      }),
      auditEntry('main', 'protected'),
      auditEntry('feature/current', 'current'),
      auditEntry('feature/unknown', 'unknown'),
      auditEntry(null, 'app_managed'),
    ];
    stubAuditFetch(entries);
    render(h(WorkOverviewView, {
      instance: mainInstance,
      repos: [{ id: 'r1', name: 'Repo One', path: '/repo/one', default_branch: 'main' }],
      branchesByRepo: { r1: [{ name: 'feature/safe', status: 'clean' }] },
      onRescan: () => undefined,
    }));

    expect(await screen.findByText('Safe candidates')).toBeTruthy();
    for (const group of [
      'Unique commits', 'Dirty worktrees', 'Protected, default, or current',
      'Unknown or ambiguous', 'App-managed or detached',
    ]) expect(screen.getByText(group)).toBeTruthy();
    expect(screen.getByText('Merged into main')).toBeTruthy();
    expect(screen.getByText('/repo/one/worktrees/feature__safe')).toBeTruthy();
    expect(screen.getByText('mandible trash create --project mandible --branch feature/safe')).toBeTruthy();
    expect(screen.getAllByText(/Action disabled:/).length).toBe(6);
    const disabledActions = screen.getAllByRole('button', { name: 'Review trash action' }).filter((button) =>
      (button as HTMLButtonElement).disabled);
    expect(disabledActions.length).toBe(6);
    for (const button of disabledActions) {
      const describedBy = button.getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      expect(describedBy).not.toMatch(/\s/);
      expect(document.getElementById(describedBy!)).toBeTruthy();
    }
  });

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
    await waitFor(() => expect(mockFetch.mock.calls.filter(([input]) => String(input).endsWith('/audit')).length).toBe(2));
    expect(filter.value).toBe('feature');
    expect(screen.getByRole('button', { name: /Branch audit/ }).getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Review trash action' }));
    expect(screen.getByRole('dialog').textContent).toContain('Branch feature/safe has no worktree');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm trash feature/safe' }));
    expect((await screen.findByRole('status')).textContent).toContain(
      'Branch ref feature/safe was removed into reversible Mandible custody. No worktree was removed.',
    );
    expect(filter.value).toBe('feature');
    expect(screen.getByRole('button', { name: /Branch audit/ }).getAttribute('aria-expanded')).toBe('true');
    await waitFor(() => expect(onRescan).toHaveBeenCalledTimes(1));
    expect(mockFetch.mock.calls.filter(([input]) => String(input).endsWith('/audit')).length).toBe(2);
    act(() => resolveRescan());
    await waitFor(() => expect(mockFetch.mock.calls.filter(([input]) => String(input).endsWith('/audit')).length).toBe(3));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Review trash action' })).toBeNull());
    const trashCall = mockFetch.mock.calls.find(([input]) => String(input) === '/api/v1/trash');
    expect(JSON.parse(String((trashCall?.[1] as RequestInit).body))).toMatchObject({ branch: 'feature/safe', reason: 'manual' });
  });

  it('names a removed worktree and warns not to continue work there', async () => {
    const safe = auditEntry('feature/safe', 'safe_candidate');
    stubAuditFetch([safe], {
      status: 201,
      body: { entry: {}, outcome: {
        worktree_removed: true,
        branch_removed: true,
        worktree_path: '/repo/one/worktrees/feature__safe',
      } },
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
    expect((await screen.findByRole('status')).textContent).toContain(
      'Do not continue work in /repo/one/worktrees/feature__safe.',
    );
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
    expect(alert.textContent).toContain('Cleanup did not complete');
    expect(alert.textContent).toContain('Worktree /repo/one/worktrees/feature__safe was already removed');
    expect(alert.textContent).toContain('Branch ref feature/safe was not removed');
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
