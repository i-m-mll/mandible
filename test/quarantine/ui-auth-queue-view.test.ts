// Quarantined: f9a5ba8 — the single-panel modifier is missing from the detail surface.

import { render, screen, fireEvent, waitFor, cleanup, act, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';

import {
  getWorkCompare,
  getSettings,
  invalidateApiGetCache,
  patchSession,
  updateConversation,
  type InstanceInfo,
} from '../../ui/src/api';

import { __resetSharedSseForTests } from '../../ui/src/sse-shared';

import { AuthQueueView } from '../../ui/src/views/auth';

type ReactFlowMockNode = {
  id: string
  data?: {
    node?: {
      label?: string
    }
  }
}

type ReactFlowMockProps = {
  children?: JSX.Element | JSX.Element[]
  nodes?: ReactFlowMockNode[]
  defaultNodes?: ReactFlowMockNode[]
  onNodeClick?: (event: MouseEvent, node: ReactFlowMockNode) => void
}

const reactFlowMockState = vi.hoisted(() => ({
  mountCount: 0,
  unmountCount: 0,
}));

let restoreTestLocalStorage: (() => void) | null = null;

vi.mock('@xyflow/react', async () => {
  const { Component, h } = await vi.importActual<typeof import('preact')>('preact');

  class MockReactFlow extends Component<ReactFlowMockProps> {
    componentDidMount(): void {
      reactFlowMockState.mountCount += 1;
    }

    componentWillUnmount(): void {
      reactFlowMockState.unmountCount += 1;
    }

    render(props: ReactFlowMockProps): JSX.Element {
      const nodes = props.nodes ?? props.defaultNodes ?? [];
      return h(
        'div',
        { 'data-testid': 'react-flow-mock' },
        ...nodes.map((node) => h(
          'button',
          {
            type: 'button',
            'aria-label': `Select graph node ${node.id}`,
            onClick: (event: MouseEvent) => props.onNodeClick?.(event, node),
          },
          node.data?.node?.label ?? node.id,
        )),
        props.children,
      );
    }
  }

  return {
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    ReactFlow: MockReactFlow,
    ViewportPortal: (props: { children?: JSX.Element | JSX.Element[] }) => props.children ?? null,
  };
});

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    loadAddon(): void {}
    open(): void {}
    write(): void {}
    writeln(): void {}
    clear(): void {}
    focus(): void {}
    dispose(): void {}
    onData(): { dispose: () => void } {
      return { dispose: () => undefined };
    }
    onResize(): { dispose: () => void } {
      return { dispose: () => undefined };
    }
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
  },
}));

beforeEach(() => {
  reactFlowMockState.mountCount = 0;
  reactFlowMockState.unmountCount = 0;
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
});

afterEach(() => {
  invalidateApiGetCache();
  cleanup();
  __resetSharedSseForTests();
  window.localStorage.removeItem?.('mandible:artifacts:list-controls:v1');
  restoreTestLocalStorage?.();
  restoreTestLocalStorage = null;
  window.history.replaceState(null, '', '/');
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (window as Window & { __TAURI__?: unknown }).__TAURI__;
  delete (window as Window & { __MANDIBLE_BOOTSTRAP__?: unknown }).__MANDIBLE_BOOTSTRAP__;
  document.head.querySelector('[data-test-compact-header-styles]')?.remove();
});

function stubFetch(): void {
  const mockFetch = vi.fn((input: RequestInfo) => {
    const url = String(input);
    if (url.includes('/api/work/repos/') && url.includes('/commits')) {
      return Promise.resolve(
        new Response(JSON.stringify({
          repo_root: '/tmp/repo',
          branch: 'feature/work',
          default_branch: 'main',
          merge_base: 'base',
          commits: [
            {
              hash: 'abc123456789',
              short_hash: 'abc1234',
              message: 'Fresh work',
              author: 'Test User',
              date: '2024-01-03T10:00:00Z',
              parents: ['base0000'],
              classification: 'unique',
              is_pre_branch_point: false,
              is_merged_elsewhere: false,
            },
          ],
          total: 1,
          limit: 50,
          offset: 0,
        }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    if (url.includes('/api/work/repos/repo/compare')) {
      return Promise.resolve(
        new Response(JSON.stringify({
          repo_root: '/tmp/repo',
          from: 'main',
          to: 'feature',
          mode: 'merge-base',
          range: 'main...feature',
          raw: 'diff --git a/a.txt b/a.txt\n',
          stat: 'a.txt | 1 +',
        }), {
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

describe('AuthQueueView', () => {

  it('renders the selected request as a structured detail surface', async () => {
    stubFetch();
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    render(
      h(AuthQueueView, {
        queue: [
          {
            id: 'req-structured-detail',
            title: 'Structured auth detail',
            type: 'merge',
            repo: 'mandible',
            base_branch: 'main',
            head_branch: 'feature/detail',
            status: 'pending',
            created_at: 1,
            approval_source: 'manual',
            approval_lease_id: 'lease-123',
            stats: { files: 1, additions: 1, deletions: 1 },
            commit_message: 'Structured auth detail commit',
            spec_content: 'Structured auth detail specification',
            diff_summary: [
              'diff --git a/ui/src/views/auth.tsx b/ui/src/views/auth.tsx',
              'index 1111111..2222222 100644',
              '--- a/ui/src/views/auth.tsx',
              '+++ b/ui/src/views/auth.tsx',
              '@@ -1,2 +1,2 @@',
              ' old line',
              '-removed line',
              '+added line',
            ].join('\n'),
          },
        ],
        outputs: {},
        selectedAuthId: 'req-structured-detail',
        onApprove: () => undefined,
        onReject: () => undefined,
        onUpdateField: () => undefined,
      }),
    );

    expect(screen.getByRole('heading', { name: 'Structured auth detail' })).toBeTruthy();
    const authPane = document.querySelector('.auth-detail-pane');
    const authHeader = document.querySelector('.auth-detail__header');
    const authBody = document.querySelector('.auth-detail__body');
    const canonicalHeaders = authHeader?.querySelectorAll('[data-detail-pane-header-variant="standard"]');
    const canonicalHeader = canonicalHeaders?.[0] as HTMLElement | undefined;
    expect(authPane).toBeTruthy();
    expect(authPane?.classList.contains('detail-pane-shell')).toBe(true);
    expect(authHeader?.classList.contains('detail-pane-shell__header')).toBe(true);
    expect(authBody?.classList.contains('detail-pane-shell__body')).toBe(true);
    expect(authHeader?.querySelector('.detail-pane-shell__header-primary.auth-detail__header-primary')).toBeTruthy();
    expect(canonicalHeaders).toHaveLength(1);
    expect(canonicalHeader?.classList.contains('detail-pane-header')).toBe(true);
    expect(authPane?.contains(authHeader as Node)).toBe(true);
    expect(authPane?.contains(authBody as Node)).toBe(true);
    expect(authHeader?.nextElementSibling).toBe(authBody);
    expect(authBody?.contains(authHeader as Node)).toBe(false);
    expect(document.querySelector('.auth-detail-surface')).toBeNull();
    expect(document.querySelector('.auth-card--expanded')).toBeNull();
    expect(document.querySelector('.auth-detail__summary-grid')).toBeNull();
    expect(document.querySelector('.auth-detail__summary-label')).toBeNull();
    expect(screen.queryByText('Branch flow')).toBeNull();
    expect(screen.queryByText('Request')).toBeNull();
    expect(screen.queryByText('Metadata')).toBeNull();
    expect(canonicalHeader?.querySelector('.detail-pane-header__entity')?.textContent).toBe('mandible');
    expect(canonicalHeader?.querySelector('.detail-pane-header__display-ref')?.textContent).toBe('req-stru');
    expect(canonicalHeader?.querySelector('.detail-pane-header__identity .type-badge')).toBeNull();
    expect(document.querySelector('.auth-detail-meta')).toBeNull();
    expect(document.querySelector('.auth-detail__header-side')).toBeNull();
    expect(document.querySelector('.auth-detail__subtitle-line')?.textContent).toBe('merge · feature/detail → main');
    expect(screen.getByText('Approve')).toBeTruthy();

    const topline = canonicalHeader?.querySelector('.detail-pane-header__topline') as HTMLElement | null;
    const identity = canonicalHeader?.querySelector('.detail-pane-header__identity') as HTMLElement | null;
    const status = canonicalHeader?.querySelector('.detail-pane-header__status') as HTMLElement | null;
    const controls = status?.parentElement;
    const copyButton = screen.getByRole('button', { name: 'Copy auth:req-stru' });
    const statusPill = status?.querySelector('.status-pill') as HTMLElement | null;
    const toplineChildren = Array.from(topline?.children ?? []);
    expect(statusPill?.textContent).toBe('Pending');
    expect(copyButton.parentElement).toBe(identity);
    expect(statusPill?.parentElement).toBe(status);
    expect(toplineChildren.indexOf(controls as Element)).toBe(toplineChildren.indexOf(identity as Element) + 1);
    const overflowAction = screen.getByRole('button', { name: 'Auth actions' });
    expect(canonicalHeader?.querySelector('.detail-pane-header__actions')?.contains(overflowAction)).toBe(true);
    expect(authBody?.contains(overflowAction)).toBe(false);
    expect(document.querySelector('.auth-detail__aux-header .auth-detail__action-strip .auth-actions')).toBeTruthy();
    const diffToggle = screen.getByRole('button', { name: 'Show changes diff' });
    expect(diffToggle.closest('.auth-detail__aux-header')).toBeTruthy();
    expect(diffToggle.getAttribute('aria-pressed')).toBe('false');
    expect(diffToggle.className).not.toContain('auth-detail__diff-toggle--active');
    expect(diffToggle.querySelector('rect')).toBeTruthy();
    expect(diffToggle.querySelectorAll('path').length).toBe(1);
    expect(document.querySelector('.auth-detail__aux-left')?.contains(diffToggle)).toBe(true);
    expect(document.querySelector('.auth-detail__action-strip .auth-actions')).toBeTruthy();
    expect(document.querySelector('.auth-detail__header-actions .auth-actions')).toBeNull();
    expect(document.querySelector('.auth-detail__header-primary .auth-actions')).toBeNull();
    const defaultPanels = document.querySelector('.auth-detail__panels') as HTMLElement | null;
    expect(defaultPanels).toBeTruthy();
    expect(defaultPanels?.className).toContain('auth-detail__panels--single');
    expect(defaultPanels?.className).not.toContain('auth-detail__panels--with-actions');
    expect(document.querySelector('.auth-detail__right-col')).toBeNull();
    expect(screen.queryByLabelText('Auth request changes')).toBeNull();
    expect(screen.queryByText('Changes')).toBeNull();
    expect(screen.getByText('Structured auth detail specification')).toBeTruthy();
    const commitPanel = screen.getByText('Commit message').closest('.collapsible-panel') as HTMLElement | null;
    expect(commitPanel?.querySelector('.collapsible-panel__toggle')?.textContent).toContain('Commit message');
    expect(commitPanel?.querySelector('.collapsible-panel__actions > .panel__edit-btn')?.textContent).toBe('edit');
    expect(commitPanel?.querySelector('.collapsible-panel__toggle .panel__edit-btn')).toBeNull();

    fireEvent.click(copyButton);
    expect(writeText).toHaveBeenCalledWith('auth:req-stru');

    fireEvent.click(diffToggle);
    const activeDiffToggle = screen.getByRole('button', { name: 'Hide changes diff' });
    expect(activeDiffToggle.getAttribute('aria-pressed')).toBe('true');
    expect(activeDiffToggle.className).toContain('auth-detail__diff-toggle--active');
    expect(document.querySelector('.auth-detail__panels')).toBeNull();
    const diffRegion = screen.getByLabelText('Auth request changes');
    expect(diffRegion).toBeTruthy();
    expect(diffRegion.getAttribute('data-diff-mode')).toBe('split');
    expect(screen.getByRole('group', { name: 'Diff layout' })).toBeTruthy();
    const unifiedMode = screen.getByRole('button', { name: 'Unified' });
    const splitMode = screen.getByRole('button', { name: 'Split' });
    expect(unifiedMode.getAttribute('aria-pressed')).toBe('false');
    expect(splitMode.getAttribute('aria-pressed')).toBe('true');
    expect(splitMode.className).toContain('auth-detail__diff-mode-button--active');
    expect(diffRegion.querySelector('.d2h-files-diff')).toBeTruthy();
    expect(diffRegion.querySelectorAll('.d2h-file-side-diff').length).toBeGreaterThanOrEqual(2);
    expect(diffRegion.querySelector('.d2h-code-side-linenumber')).toBeTruthy();
    expect(diffRegion.querySelector('.d2h-code-linenumber')).toBeNull();
    expect(screen.getAllByText('ui/src/views/auth.tsx').length).toBeGreaterThan(0);
    expect(diffRegion.textContent).toContain('added line');
    expect(screen.queryByText('Commit Message')).toBeNull();

    fireEvent.click(unifiedMode);
    const unifiedDiffRegion = screen.getByLabelText('Auth request changes');
    expect(unifiedDiffRegion.getAttribute('data-diff-mode')).toBe('unified');
    expect(screen.getByRole('button', { name: 'Unified' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Split' }).getAttribute('aria-pressed')).toBe('false');
    expect(unifiedDiffRegion.querySelector('.d2h-file-diff')).toBeTruthy();
    expect(unifiedDiffRegion.querySelector('.d2h-files-diff')).toBeNull();
    expect(unifiedDiffRegion.querySelector('.d2h-code-linenumber')).toBeTruthy();
    expect(unifiedDiffRegion.querySelector('.d2h-code-side-linenumber')).toBeNull();
    expect(unifiedDiffRegion.querySelector('.line-num1')).toBeTruthy();
    expect(unifiedDiffRegion.querySelector('.line-num2')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Split' }));
    expect(screen.getByLabelText('Auth request changes').getAttribute('data-diff-mode')).toBe('split');
    fireEvent.click(activeDiffToggle);
    expect(screen.getByRole('button', { name: 'Show changes diff' })).toBeTruthy();
    expect(document.querySelector('.auth-detail__panels')).toBeTruthy();

    const detailScroller = document.querySelector('.auth-detail__body') as HTMLElement | null;
    fireEvent.click(screen.getByRole('button', { name: 'Auth actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show metadata' }));
    const metadataDialog = screen.getByRole('dialog', { name: 'Auth metadata' });
    await waitFor(() => expect(detailScroller?.className).toContain('detail-pane-shell__body--overlay-open'));
    expect(document.querySelector('.auth-detail__pane')?.contains(metadataDialog)).toBe(true);
    expect(document.querySelector('.auth-detail__body')?.contains(metadataDialog)).toBe(false);
    expect(within(metadataDialog).getByText('Approval source')).toBeTruthy();
    expect(within(metadataDialog).getByText('lease-123')).toBeTruthy();
  });

});
