import { installMemoryLocalStorage, stubFetch, render, mainInstance } from '../helpers/ui-workspace-fixture';

import { screen, fireEvent, waitFor, cleanup, within } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { bindAuthUiOperations } from '../helpers/auth-ui-fixture';

beforeEach(() => bindAuthUiOperations(mainInstance));
import { AuthQueueView } from '../../ui/src/views/auth';


describe('AuthQueueView', () => {
  const changeReport: AuthChangeReport = {
    schema: 'mandible-auth-change-report@1',
    classifier_version: 'mandible-auth-change-classifier@1',
    rules_version: 'mandible-auth-change-rules@1',
    comparison: {
      base_sha: 'a'.repeat(40),
      head_sha: 'b'.repeat(40),
      merge_base_sha: 'c'.repeat(40),
    },
    rename_similarity_percent: 50,
    totals: { files: 5, additions: 15, deletions: 3, text_files: 3, binary_files: 1 },
    files: [
      {
        old_path: 'src/auth.ts', new_path: 'src/auth.ts', change_kind: 'modified',
        file_type_before: 'blob', file_type_after: 'blob', additions: 10, deletions: 2,
        bytes_before: 800, bytes_after: 940, language: 'TypeScript', file_role: 'implementation',
        generated: false, vendor: false,
      },
      {
        old_path: null, new_path: 'src/generated schema.json', change_kind: 'added',
        file_type_before: 'absent', file_type_after: 'blob', additions: 3, deletions: 0,
        bytes_before: null, bytes_after: 180, language: 'JSON', file_role: 'configuration',
        generated: true, vendor: false,
      },
      {
        old_path: 'test/old auth.test.ts', new_path: 'test/auth flow.test.ts', change_kind: 'renamed',
        file_type_before: 'blob', file_type_after: 'blob', additions: 2, deletions: 1,
        bytes_before: 200, bytes_after: 220, language: 'TypeScript', file_role: 'tests',
        generated: false, vendor: false,
      },
      {
        old_path: 'assets/logo.bin', new_path: 'assets/logo.bin', change_kind: 'modified',
        file_type_before: 'blob', file_type_after: 'blob', additions: null, deletions: null,
        bytes_before: 1024, bytes_after: 2048, language: 'Unknown', file_role: 'other',
        generated: false, vendor: true,
      },
      {
        old_path: 'deps/old-module', new_path: 'deps/old-module', change_kind: 'type_changed',
        file_type_before: 'gitlink', file_type_after: 'blob', additions: null, deletions: null,
        bytes_before: null, bytes_after: null, language: 'Unknown', file_role: 'other',
        generated: false, vendor: true,
      },
    ],
  };

  it('renders creator-attributed entity times and branch code without a vague session link', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T16:00:00Z'));
    const now = Date.now();

    render(
      h(AuthQueueView, {
        queue: [{
          id: 'req-header',
          title: 'Explicit header metadata',
          type: 'merge',
          repo: 'mandible',
          base_branch: 'main',
          head_branch: 'feature/header-metadata',
          status: 'pending',
          created_at: now - (2 * 60 * 60 * 1000),
          updated_at: now - (5 * 60 * 1000),
          session_id: 'session-123',
          requester: { id: 'user-codex', display_name: 'Codex', kind: 'agent' },
        }],
        outputs: {},
        selectedAuthId: 'req-header',
        onApprove: () => undefined,
        onReject: () => undefined,
      }),
    );

    const header = document.querySelector('.auth-detail__header') as HTMLElement;
    const primaryMetadata = header.querySelector('.auth-detail__primary-metadata') as HTMLElement;
    expect(primaryMetadata.textContent).toContain('created 2h ago by codex · updated 5m ago');
    expect(primaryMetadata.children).toHaveLength(1);
    expect(header.textContent).not.toContain('Requested by');
    expect(within(header).queryByRole('link', { name: 'Requesting session' })).toBeNull();
    const branchLine = header.querySelector('.auth-detail__subtitle-line') as HTMLElement;
    expect(Array.from(branchLine.querySelectorAll('code')).map((node) => node.textContent)).toEqual([
      'feature/header-metadata',
      'main',
    ]);
    expect(branchLine.textContent).toBe('merge · feature/header-metadata → main');
  });

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
    expect(screen.queryByText('Force Dismiss')).toBeNull();
    expect(screen.getByText('Approve')).toBeTruthy();
    expect(screen.getByText('Reject')).toBeTruthy();
  });

  it('shows a clear diff empty state when diff stats exist without diff text', () => {
    render(
      h(AuthQueueView, {
        queue: [
          {
            id: 'req-empty-diff',
            title: 'Empty diff auth',
            type: 'merge',
            repo: 'mandible',
            base_branch: 'main',
            head_branch: 'feature/empty-diff',
            status: 'pending',
            stats: { files: 1, additions: 0, deletions: 0 },
            commit_message: 'Empty diff commit',
            spec_content: 'Empty diff specification',
          },
        ],
        outputs: {},
        selectedAuthId: 'req-empty-diff',
        onApprove: () => undefined,
        onReject: () => undefined,
      }),
    );

    expect(screen.queryByLabelText('Approval request changes')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Diff' }));
    expect(screen.getByLabelText('Approval request changes')).toBeTruthy();
    expect(screen.getByText('No diff available for this request.')).toBeTruthy();
    expect(document.querySelector('.auth-detail__panels')).toBeNull();
  });

  it('moves between overview and console with the approval lifecycle', async () => {
    const request = {
      id: 'req-console-lifecycle',
      title: 'Approval lifecycle',
      type: 'merge',
      repo: 'mandible',
      base_branch: 'main',
      head_branch: 'feature/lifecycle',
      status: 'pending',
      diff_summary: '',
      spec_content: '',
      output: '',
    };
    const view = render(h(AuthQueueView, {
      queue: [request], outputs: {}, selectedAuthId: request.id,
      onApprove: () => undefined, onReject: () => undefined,
    }));

    expect(screen.getByRole('tab', { name: 'Info' }).getAttribute('aria-selected')).toBe('true');
    view.rerender(h(AuthQueueView, {
      queue: [{ ...request, status: 'approved' }], outputs: {}, selectedAuthId: request.id,
      onApprove: () => undefined, onReject: () => undefined,
    }));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Console' }).getAttribute('aria-selected')).toBe('true'));

    view.rerender(h(AuthQueueView, {
      queue: [{ ...request, status: 'completed' }], outputs: {}, selectedAuthId: request.id,
      onApprove: () => undefined, onReject: () => undefined,
    }));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Info' }).getAttribute('aria-selected')).toBe('true'));
  });

  it.each(['approved', 'executing'])('opens Console when selecting an already-%s request', async (status) => {
    render(h(AuthQueueView, {
      queue: [{
        id: `req-already-${status}`,
        title: `Already ${status}`,
        type: 'merge',
        repo: 'mandible',
        base_branch: 'main',
        head_branch: `feature/${status}`,
        status,
      }],
      outputs: {},
      selectedAuthId: `req-already-${status}`,
      onApprove: () => undefined,
      onReject: () => undefined,
      autoShowConsoleOnApproval: true,
    }));

    await waitFor(() => expect(screen.getByRole('tab', { name: 'Console' }).getAttribute('aria-selected')).toBe('true'));
  });

  it('keeps Info as the default tab when automatic Console display is disabled', () => {
    render(h(AuthQueueView, {
      queue: [{
        id: 'req-approved-info',
        title: 'Approved info request',
        type: 'merge',
        repo: 'mandible',
        base_branch: 'main',
        head_branch: 'feature/approved-info',
        status: 'approved',
      }],
      outputs: {},
      selectedAuthId: 'req-approved-info',
      onApprove: () => undefined,
      onReject: () => undefined,
      autoShowConsoleOnApproval: false,
    }));

    expect(screen.getByRole('tab', { name: 'Info' }).getAttribute('aria-selected')).toBe('true');
  });

  it('names the icon-only tabs Info, Console, and Diff and defaults pending requests to Info', () => {
    render(h(AuthQueueView, {
      queue: [{ id: 'req-tab-labels', title: 'Tab labels', repo: 'mandible', status: 'pending' }],
      outputs: {},
      selectedAuthId: 'req-tab-labels',
      onApprove: () => undefined,
      onReject: () => undefined,
    }));

    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.getAttribute('aria-label'))).toEqual(['Info', 'Console', 'Diff']);
    expect(tabs.map((tab) => tab.getAttribute('title'))).toEqual(['Info', 'Console', 'Diff']);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
  });

  it('renders and persists the canonical change inventory views beneath Specification', async () => {
    installMemoryLocalStorage();
    const first = {
      id: 'req-change-report-first', title: 'Captured breakdown', type: 'merge' as const,
      repo: 'mandible', status: 'pending', diff_summary: '', spec_content: '', output: '',
      change_report: changeReport,
    };
    const second = {
      ...first,
      id: 'req-change-report-second',
      title: 'Second captured breakdown',
    };
    const storageKey = 'mandible:auth:change-breakdown:v1:req-change-report-first';
    const view = render(h(AuthQueueView, {
      queue: [first, second], outputs: {}, selectedAuthId: first.id,
      onApprove: () => undefined, onReject: () => undefined,
    }));

    const leftColumn = document.querySelector('.auth-detail__left-col') as HTMLElement;
    expect(Array.from(leftColumn.querySelectorAll(':scope > .collapsible-panel')).map(
      (panel) => panel.querySelector('.collapsible-panel__toggle')?.textContent?.trim(),
    )).toEqual(['Commit message', 'Specification', 'Change breakdown']);
    expect(within(leftColumn).getByText('5 files · +15 −3')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /TypeScript/ }));
    expect(screen.getByText('src/auth.ts')).toBeTruthy();
    expect(screen.getByText('test/old auth.test.ts')).toBeTruthy();
    expect(screen.getByText('test/auth flow.test.ts')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Generated / vendor' }));
    expect(screen.getByText(/independent flags/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Vendor/ }));
    expect(screen.getByText('assets/logo.bin')).toBeTruthy();
    expect(screen.getByText('1.0 KiB → 2.0 KiB')).toBeTruthy();
    const gitlinkRow = screen.getByText('deps/old-module').closest('.auth-change-file') as HTMLElement;
    expect(within(gitlinkRow).getByText('gitlink')).toBeTruthy();
    expect(within(gitlinkRow).getByText('submodule reference changed')).toBeTruthy();
    expect(within(gitlinkRow).queryByText('binary')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Directory' }));
    const srcDirectory = screen.getByRole('button', { name: /src\/.*2.*\+13.*−2.*83%/ });
    fireEvent.click(srcDirectory);
    expect(screen.getByRole('navigation', { name: 'Change report directory' }).textContent).toContain('root/src');
    const generatedFile = screen.getByText('src/generated schema.json').closest('.auth-change-file') as HTMLElement;
    expect(within(generatedFile).getByText('+3')).toBeTruthy();
    expect(within(generatedFile).getByText('−0')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Largest files' }));
    const largestPaths = Array.from(document.querySelectorAll(
      '.auth-change-files--largest .auth-change-file__path',
    )).map((node) => node.textContent);
    expect(largestPaths).toEqual([
      'src/auth.ts',
      'src/generated schema.json',
      'test/old auth.test.ts → test/auth flow.test.ts',
      'assets/logo.bin',
      'deps/old-module',
    ]);

    fireEvent.click(screen.getByRole('tab', { name: 'File role' }));
    const breakdownPanel = screen.getByText('Change breakdown').closest('.collapsible-panel') as HTMLElement;
    fireEvent.click(within(breakdownPanel).getByRole('button', { name: 'Change breakdown' }));
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(storageKey) ?? '{}')).toMatchObject({
      expanded: false,
      view: 'role',
      directoryPath: ['src'],
    }));

    view.rerender(h(AuthQueueView, {
      queue: [first, second], outputs: {}, selectedAuthId: second.id,
      onApprove: () => undefined, onReject: () => undefined,
    }));
    view.rerender(h(AuthQueueView, {
      queue: [first, second], outputs: {}, selectedAuthId: first.id,
      onApprove: () => undefined, onReject: () => undefined,
    }));
    const restored = screen.getByText('Change breakdown').closest('.collapsible-panel') as HTMLElement;
    expect(within(restored).getByRole('button', { name: 'Change breakdown' }).getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(within(restored).getByRole('button', { name: 'Change breakdown' }));
    expect(screen.getByRole('tab', { name: 'File role' }).getAttribute('aria-selected')).toBe('true');

    cleanup();
    render(h(AuthQueueView, {
      queue: [first], outputs: {}, selectedAuthId: first.id,
      onApprove: () => undefined, onReject: () => undefined,
    }));
    expect(screen.getByRole('tab', { name: 'File role' }).getAttribute('aria-selected')).toBe('true');
    window.localStorage.removeItem(storageKey);
  });

  it('renders legacy merge absence honestly and omits breakdowns for non-merge actions', () => {
    const view = render(h(AuthQueueView, {
      queue: [{
        id: 'req-legacy-breakdown', title: 'Legacy merge', type: 'merge', repo: 'mandible',
        status: 'completed', diff_summary: '', spec_content: '', output: '', change_report: null,
      }],
      outputs: {}, selectedAuthId: 'req-legacy-breakdown',
      onApprove: () => undefined, onReject: () => undefined,
    }));
    expect(screen.getByText('Unavailable')).toBeTruthy();
    expect(screen.getByText(/Older requests are not recomputed/)).toBeTruthy();

    view.rerender(h(AuthQueueView, {
      queue: [{
        id: 'req-data-delete-breakdown', title: 'Delete data', type: 'data-delete', repo: 'mandible',
        status: 'pending', diff_summary: '', spec_content: '', output: '', change_report: null,
      }],
      outputs: {}, selectedAuthId: 'req-data-delete-breakdown',
      onApprove: () => undefined, onReject: () => undefined,
    }));
    expect(screen.queryByText('Change breakdown')).toBeNull();
  });

  it('hydrates the frozen change report when a history summary is selected', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/auth/request/req-history-breakdown') {
        return Promise.resolve(new Response(JSON.stringify({
          id: 'req-history-breakdown',
          title: 'Historical breakdown',
          type: 'merge',
          repo: 'mandible',
          status: 'completed',
          diff_summary: '',
          spec_content: '',
          output: '',
          change_report: changeReport,
        }), { headers: { 'content-type': 'application/json' } }));
      }
      return Promise.resolve(new Response(JSON.stringify([]), {
        headers: { 'content-type': 'application/json' },
      }));
    }));

    render(h(AuthQueueView, {
      queue: [],
      historyQueue: [{
        id: 'req-history-breakdown', title: 'Historical breakdown', type: 'merge',
        repo: 'mandible', status: 'completed',
      }],
      outputs: {},
      selectedAuthId: 'req-history-breakdown',
      onApprove: () => undefined,
      onReject: () => undefined,
    }));

    await waitFor(() => expect(screen.getByText('5 files · +15 −3')).toBeTruthy());
    expect(screen.queryByText('Unavailable')).toBeNull();
  });

  it('retains a finalized active-filter selection until another request is selected', async () => {
    const completed = {
      id: 'req-retained-final', title: 'Retained final request', type: 'merge', repo: 'mandible',
      base_branch: 'main', head_branch: 'feature/retained', status: 'pending',
      diff_summary: '', spec_content: '', output: '',
    };
    const pending = {
      id: 'req-next', title: 'Next request', type: 'merge', repo: 'mandible',
      base_branch: 'main', head_branch: 'feature/next', status: 'pending',
      diff_summary: '', spec_content: '', output: '',
    };
    const view = render(h(AuthQueueView, {
      queue: [completed, pending], outputs: {}, initialRequestId: completed.id,
      onApprove: () => undefined, onReject: () => undefined,
    }));
    await waitFor(() => expect(document.querySelector('[data-request-id="req-retained-final"]')?.classList.contains('auth-sidebar-item--selected')).toBe(true));
    view.rerender(h(AuthQueueView, {
      queue: [{ ...completed, status: 'completed' }, pending], outputs: {}, initialRequestId: completed.id,
      onApprove: () => undefined, onReject: () => undefined,
    }));

    await waitFor(() => expect(document.querySelector('[data-request-id="req-retained-final"]')).toBeTruthy());
    expect(window.sessionStorage.getItem('mandible.auth.retained-finalized-selection')).toBe(completed.id);
    fireEvent.click(document.querySelector('[data-request-id="req-next"]') as Element);
    await waitFor(() => expect(document.querySelector('[data-request-id="req-retained-final"]')).toBeNull());
    expect(window.sessionStorage.getItem('mandible.auth.retained-finalized-selection')).toBeNull();
  });

  it('clears finalized retention when controlled route selection moves to another request', async () => {
    const finalized = { id: 'req-route-final', title: 'Route final', repo: 'mandible', status: 'pending' };
    const next = { id: 'req-route-next', title: 'Route next', repo: 'mandible', status: 'pending' };
    const view = render(h(AuthQueueView, {
      queue: [finalized, next], outputs: {}, selectedAuthId: finalized.id,
      onApprove: () => undefined, onReject: () => undefined,
    }));
    view.rerender(h(AuthQueueView, {
      queue: [{ ...finalized, status: 'completed' }, next], outputs: {}, selectedAuthId: finalized.id,
      onApprove: () => undefined, onReject: () => undefined,
    }));
    await waitFor(() => expect(window.sessionStorage.getItem('mandible.auth.retained-finalized-selection')).toBe(finalized.id));

    view.rerender(h(AuthQueueView, {
      queue: [{ ...finalized, status: 'completed' }, next], outputs: {}, selectedAuthId: next.id,
      onApprove: () => undefined, onReject: () => undefined,
    }));

    await waitFor(() => expect(window.sessionStorage.getItem('mandible.auth.retained-finalized-selection')).toBeNull());
  });

  it('clears finalized retention when a new deep link selects another request', async () => {
    const finalized = { id: 'req-deep-final', title: 'Deep final', repo: 'mandible', status: 'pending' };
    const next = { id: 'req-deep-next', title: 'Deep next', repo: 'mandible', status: 'pending' };
    const view = render(h(AuthQueueView, {
      queue: [finalized, next], outputs: {}, initialRequestId: finalized.id,
      onApprove: () => undefined, onReject: () => undefined,
    }));
    view.rerender(h(AuthQueueView, {
      queue: [{ ...finalized, status: 'completed' }, next], outputs: {}, initialRequestId: finalized.id,
      onApprove: () => undefined, onReject: () => undefined,
    }));
    await waitFor(() => expect(window.sessionStorage.getItem('mandible.auth.retained-finalized-selection')).toBe(finalized.id));

    view.rerender(h(AuthQueueView, {
      queue: [{ ...finalized, status: 'completed' }, next], outputs: {}, initialRequestId: next.id,
      onApprove: () => undefined, onReject: () => undefined,
    }));

    await waitFor(() => expect(window.sessionStorage.getItem('mandible.auth.retained-finalized-selection')).toBeNull());
    expect(document.querySelector('[data-request-id="req-deep-next"]')?.classList.contains('auth-sidebar-item--selected')).toBe(true);
  });

  it('clears finalized retention on filter-driven selection without losing All-filter history', async () => {
    const finalized = { id: 'req-filter-final', title: 'Filter final', repo: 'mandible', status: 'pending' };
    const next = { id: 'req-filter-next', title: 'Filter next', repo: 'mandible', status: 'pending' };
    const view = render(h(AuthQueueView, {
      queue: [finalized, next], historyQueue: [], outputs: {}, initialRequestId: finalized.id,
      onApprove: () => undefined, onReject: () => undefined,
    }));
    view.rerender(h(AuthQueueView, {
      queue: [{ ...finalized, status: 'completed' }, next],
      historyQueue: [{ ...finalized, status: 'completed' }],
      outputs: {}, initialRequestId: finalized.id,
      onApprove: () => undefined, onReject: () => undefined,
    }));
    await waitFor(() => expect(window.sessionStorage.getItem('mandible.auth.retained-finalized-selection')).toBe(finalized.id));

    fireEvent.input(screen.getByLabelText('Search approval requests'), {
      target: { value: 'Filter next' },
    });
    await waitFor(() => expect(document.querySelector('[data-request-id="req-filter-next"]')?.classList.contains('auth-sidebar-item--selected')).toBe(true));
    expect(window.sessionStorage.getItem('mandible.auth.retained-finalized-selection')).toBeNull();

    fireEvent.input(screen.getByLabelText('Search approval requests'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Advanced approval filters' }));
    fireEvent.click(screen.getByRole('button', { name: 'all' }));
    await waitFor(() => expect(document.querySelector('[data-request-id="req-filter-final"]')).toBeTruthy());
  });


  it('renders deferred action badges and bundle details', async () => {
    const actions = [
      { id: 'act1', auth_request_id: 'req-actions', ordinal: 1, kind: 'issue_close', target_issue_ref: 'abc123', payload: { reason_comment: 'Done' }, state: 'staged', target_digest: null, staged_at: 1, updated_at: 1, applied_at: null, outcome_detail: null },
      { id: 'act2', auth_request_id: 'req-actions', ordinal: 2, kind: 'comment_add', target_issue_ref: 'def456', payload: { body: 'Closeout comment body' }, state: 'staged', target_digest: null, staged_at: 1, updated_at: 1, applied_at: null, outcome_detail: null },
      { id: 'act3', auth_request_id: 'req-actions', ordinal: 3, kind: 'label_add', target_issue_ref: 'ghi789', payload: { label: 'merged' }, state: 'staged', target_digest: null, staged_at: 1, updated_at: 1, applied_at: null, outcome_detail: null },
      { id: 'act4', auth_request_id: 'req-actions', ordinal: 4, kind: 'worker_status_set', target_issue_ref: 'jkl012', payload: { value: 'done' }, state: 'staged', target_digest: null, staged_at: 1, updated_at: 1, applied_at: null, outcome_detail: null },
    ];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/auth/request/req-actions/actions') {
        return Promise.resolve(new Response(JSON.stringify({ actions }), { headers: { 'content-type': 'application/json' } }));
      }
      if (url === '/api/issues/find/abc123') {
        return Promise.resolve(new Response(JSON.stringify({ title: 'Close umbrella' }), { headers: { 'content-type': 'application/json' } }));
      }
      return Promise.resolve(new Response(JSON.stringify({}), { headers: { 'content-type': 'application/json' } }));
    }));

    render(
      h(AuthQueueView, {
        queue: [
          { id: 'req-actions', title: 'Bundled auth', repo: 'mandible', base: 'main', head: 'feature/actions', action_count: 4, actions: actions as never },
        ],
        outputs: {},
        onApprove: () => undefined,
        onReject: () => undefined,
      }),
    );

    expect(screen.getByTitle('4 deferred actions')).toBeTruthy();
    expect(screen.getByLabelText('Deferred approval actions')).toBeTruthy();
    expect(screen.getByText('On merge...')).toBeTruthy();
    expect(screen.queryByText('On merge, this request will also')).toBeNull();
    const panels = document.querySelector('.auth-detail__panels') as HTMLElement | null;
    const leftColumn = document.querySelector('.auth-detail__left-col') as HTMLElement | null;
    const rightColumn = document.querySelector('.auth-detail__right-col') as HTMLElement | null;
    expect(panels?.className).toContain('auth-detail__panels--with-actions');
    expect(panels?.className).not.toContain('auth-detail__panels--single');
    expect(leftColumn?.textContent).toContain('Commit message');
    expect(leftColumn?.textContent).toContain('Specification');
    expect(rightColumn?.querySelector('.auth-action-bundle')).toBeTruthy();
    expect(rightColumn?.textContent).toContain('On merge...');
    expect(rightColumn?.textContent).not.toContain('Commit Message');
    expect(screen.getByText('Close issue:')).toBeTruthy();
    expect(screen.getByText('Closeout comment body')).toBeTruthy();
    expect(screen.getByText('Add merged')).toBeTruthy();
    expect(screen.getByText('Set to done')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Close umbrella')).toBeTruthy());
    const closeRow = screen.getByText('Close issue:').closest('.auth-action-row') as HTMLElement;
    expect(within(closeRow).getByText('abc123')).toBeTruthy();
    expect(closeRow.textContent).not.toContain('Close target issue');
    expect(closeRow.textContent).not.toContain('Staged');
  });

  it('renders canonical commit messages through sanitized Markdown without an authorship badge', () => {
    render(
      h(AuthQueueView, {
        queue: [{
          id: 'req-canonical-markdown',
          title: 'Canonical Markdown auth',
          repo: 'mandible',
          base: 'main',
          head: 'feature/canonical-markdown',
          status: 'pending',
          commit_message: 'Ship **structured prose** with [artifact:bbbbbbbbbbbb].\n\n<script>window.compromised = true</script>',
          commit_message_digest: 'a'.repeat(64),
        }],
        outputs: {},
        selectedAuthId: 'req-canonical-markdown',
        onApprove: () => undefined,
        onReject: () => undefined,
      }),
    );

    const commitPanel = screen.getByText('Commit message').closest('.collapsible-panel') as HTMLElement | null;
    const rendered = commitPanel?.querySelector('.rendered-markdown') as HTMLElement | null;
    expect(rendered?.querySelector('strong')?.textContent).toBe('structured prose');
    expect(rendered?.querySelector('[data-resource-ref="artifact:bbbbbbbbbbbb"]')).toBeTruthy();
    expect(rendered?.querySelector('script')).toBeNull();
    expect(commitPanel?.querySelector('.panel__badge')).toBeNull();
    expect(commitPanel?.querySelector('.canonical-message')).toBeNull();
    expect(commitPanel?.querySelector('.panel__edit-btn')).toBeNull();
  });

  it('renders multiline specifications as sanitized block Markdown without rewriting legacy text', () => {
    const multilineSpec = [
      '# Intent',
      '',
      'Keep **review prose** readable.',
      '',
      '## Scope',
      '',
      '- Preserve paragraphs and lists.',
      '- Reuse the Auth Markdown renderer.',
      '',
      '```text',
      'operator-gate: none',
      '```',
      '',
      '<img src=x onerror="window.compromised = true">',
    ].join('\n');
    render(
      h(AuthQueueView, {
        queue: [{
          id: 'req-multiline-spec',
          title: 'Multiline specification',
          repo: 'mandible',
          base: 'main',
          head: 'feature/multiline-spec',
          status: 'pending',
          spec_content: multilineSpec,
        }],
        outputs: {},
        selectedAuthId: 'req-multiline-spec',
        onApprove: () => undefined,
        onReject: () => undefined,
      }),
    );

    const specPanel = screen.getByText('Specification').closest('.collapsible-panel') as HTMLElement | null;
    fireEvent.click(specPanel?.querySelector('button') as HTMLButtonElement);
    const rendered = specPanel?.querySelector('.rendered-markdown') as HTMLElement | null;
    expect(rendered?.querySelector('h1')?.textContent).toBe('Intent');
    expect(rendered?.querySelector('h2')?.textContent).toBe('Scope');
    expect(rendered?.querySelectorAll('li')).toHaveLength(2);
    expect(rendered?.querySelector('strong')?.textContent).toBe('review prose');
    expect(rendered?.querySelector('code')?.textContent).toContain('operator-gate: none');
    expect(rendered?.querySelector('img')?.getAttribute('src')).toBe('x');
    expect(rendered?.innerHTML).not.toContain('onerror');

    cleanup();
    render(
      h(AuthQueueView, {
        queue: [{
          id: 'req-legacy-spec',
          title: 'Legacy specification',
          repo: 'mandible',
          status: 'pending',
          spec_content: 'Intent: keep this exact one-line specification.',
        }],
        outputs: {},
        selectedAuthId: 'req-legacy-spec',
        onApprove: () => undefined,
        onReject: () => undefined,
      }),
    );
    const legacyPanel = screen.getByText('Specification').closest('.collapsible-panel') as HTMLElement | null;
    fireEvent.click(legacyPanel?.querySelector('button') as HTMLButtonElement);
    expect(legacyPanel?.textContent).toContain('Intent: keep this exact one-line specification.');
    expect(legacyPanel?.querySelector('.rendered-markdown h1, .rendered-markdown h2')).toBeNull();
  });

  it('toggles pending action veto state through the API', async () => {
    const action = { id: 'act1', auth_request_id: 'req-veto', ordinal: 1, kind: 'comment_add', target_issue_ref: 'abc123', payload: { body: 'Closeout' }, state: 'staged', target_digest: null, staged_at: 1, updated_at: 1, applied_at: null, outcome_detail: null };
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/auth/request/req-veto/actions') {
        return Promise.resolve(new Response(JSON.stringify({ actions: [action] }), { headers: { 'content-type': 'application/json' } }));
      }
      if (url === '/api/auth/request/req-veto/actions/act1/veto') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { vetoed?: boolean };
        return Promise.resolve(new Response(JSON.stringify({
          action: { ...action, state: body.vetoed ? 'vetoed' : 'staged' },
        }), { headers: { 'content-type': 'application/json' } }));
      }
      return Promise.resolve(new Response(JSON.stringify({}), { headers: { 'content-type': 'application/json' } }));
    }));

    render(
      h(AuthQueueView, {
        instance: mainInstance,
        queue: [
          { id: 'req-veto', title: 'Veto auth', repo: 'mandible', status: 'pending', action_count: 1, actions: [action] as never },
        ],
        outputs: {},
        onApprove: () => undefined,
        onReject: () => undefined,
      }),
    );

    fireEvent.click(screen.getByText('Veto'));
    await waitFor(() => expect(screen.getByText('Restore')).toBeTruthy());
    expect(screen.getByText('Vetoed')).toBeTruthy();
  });

  it('renders completed deferred action outcomes and omits empty bundles', () => {
    const outcomes = [
      { id: 'act1', auth_request_id: 'req-complete', ordinal: 1, kind: 'comment_add', target_issue_ref: 'abc123', payload: { body: 'Comment' }, state: 'applied', target_digest: null, staged_at: 1, updated_at: 1, applied_at: 2, outcome_detail: null },
      { id: 'act2', auth_request_id: 'req-complete', ordinal: 2, kind: 'label_add', target_issue_ref: 'abc123', payload: { label: 'merged' }, state: 'failed', target_digest: null, staged_at: 1, updated_at: 1, applied_at: 2, outcome_detail: 'Label write failed' },
      { id: 'act3', auth_request_id: 'req-complete', ordinal: 3, kind: 'issue_close', target_issue_ref: 'abc123', payload: {}, state: 'skipped_stale', target_digest: null, staged_at: 1, updated_at: 1, applied_at: null, outcome_detail: 'Head moved' },
      { id: 'act4', auth_request_id: 'req-complete', ordinal: 4, kind: 'worker_status_set', target_issue_ref: 'abc123', payload: { value: 'done' }, state: 'vetoed', target_digest: null, staged_at: 1, updated_at: 1, applied_at: null, outcome_detail: null },
    ];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/auth/request/req-complete/actions') {
        return Promise.resolve(new Response(JSON.stringify({ actions: outcomes }), { headers: { 'content-type': 'application/json' } }));
      }
      return Promise.resolve(new Response(JSON.stringify({}), { headers: { 'content-type': 'application/json' } }));
    }));
    render(
      h(AuthQueueView, {
        queue: [
          { id: 'req-complete', title: 'Completed auth', repo: 'mandible', status: 'completed', exit_code: 1, action_count: 4, actions: outcomes as never },
          { id: 'req-empty', title: 'Plain auth', repo: 'mandible', status: 'pending' },
        ],
        outputs: {},
        onApprove: () => undefined,
        onReject: () => undefined,
      }),
    );

    expect(screen.getByText('Applied')).toBeTruthy();
    expect(screen.getAllByText('Failed').length).toBeGreaterThan(0);
    expect(screen.getByText('Skipped stale')).toBeTruthy();
    expect(screen.getByText('Vetoed')).toBeTruthy();
    expect(document.querySelector('.auth-action-row--failed')).toBeTruthy();
    fireEvent.click(screen.getByText('Plain auth'));
    expect(screen.queryByLabelText('Deferred approval actions')).toBeNull();
  });
});

