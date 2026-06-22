import { readFileSync } from 'node:fs';
import { render, screen, fireEvent, waitFor, cleanup, act, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { useCallback, useMemo, useState } from 'preact/hooks';

import { appReducer, applySSEEvent, initialState, selectBadgeCounts } from '../ui/src/state';
import { App } from '../ui/src/app';
import { getReviewSpec, patchSession, updateConversation } from '../ui/src/api';
import {
  installTauriDeepLinkHandler,
  navigateToMandibleDeepLink,
  routeHashFromMandibleDeepLink,
} from '../ui/src/deep-links';
import {
  hashWithViewSidebarHidden,
  hashWithViewSidebarVisible,
  isViewSidebarHidden,
  parseRouteFromHash,
} from '../ui/src/routing';
import {
  AppShellProvider,
  BottomPanelIcon,
  useRegisterAppBottomPanel,
  type AppBottomPanelDescriptor,
  type AppShellContextValue,
} from '../ui/src/app-shell';
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
  cleanup();
  window.history.replaceState(null, '', '/');
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.doUnmock('@tauri-apps/plugin-deep-link');
  delete (window as Window & { __TAURI__?: unknown }).__TAURI__;
});

function changeSelect(select: HTMLElement, value: string): void {
  act(() => {
    (select as HTMLSelectElement).value = value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

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

function stubEventSource(): void {
  class MockEventSource {
    readyState = 1;
    onerror: (() => void) | null = null;
    onopen: (() => void) | null = null;

    constructor(_url: string) {}

    addEventListener(): void {}
    removeEventListener(): void {}
    close(): void {
      this.readyState = 2;
    }
  }

  vi.stubGlobal('EventSource', MockEventSource);
}

function stubAppShellFetch(): void {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/issues/dotfiles/e70757d/ledger-detail')) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: 'not needed for shell test' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    if (url === '/api/issues') {
      return Promise.resolve(
        new Response(JSON.stringify({
          repos: [{
            repo_id: 'dotfiles',
            repo_name: 'dotfiles',
            open_count: 1,
            closed_count: 0,
            issues: [{
              id: 'e70757d',
              display_id: 'e70757d',
              title: 'Deep linked issue',
              status: 'open',
            }],
          }],
        }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    if (url === '/api/inbox/global') {
      return Promise.resolve(
        new Response(JSON.stringify({
          continuations: [],
          auth_results: [],
          open_issues: [],
          total: 0,
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
  }));
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

  it('routes removed Switchboard hashes to the default graph workspace', () => {
    expect(parseRouteFromHash('#/switchboard')).toEqual({
      tab: 'graph',
      params: {},
    });
  });

  it('parses sidebar=hidden as the route-scoped view sidebar hide request', () => {
    const route = parseRouteFromHash('#/issues?repo=dotfiles&issue=e70757d&sidebar=hidden');

    expect(route).toEqual({
      tab: 'issues',
      params: {
        repo: 'dotfiles',
        issue: 'e70757d',
        sidebar: 'hidden',
      },
    });
    expect(isViewSidebarHidden(route)).toBe(true);
    expect(isViewSidebarHidden(parseRouteFromHash('#/issues?sidebar=visible'))).toBe(false);
  });

  it('updates only the sidebar visibility parameter', () => {
    expect(hashWithViewSidebarVisible('#/issues?repo=dotfiles&issue=e70757d&sidebar=hidden')).toBe(
      '#/issues?repo=dotfiles&issue=e70757d',
    );
    expect(hashWithViewSidebarHidden('#/auth?request=abc')).toBe('#/auth?request=abc&sidebar=hidden');
  });

  it('maps mandible issue deep links onto the existing Issues hash route', () => {
    expect(routeHashFromMandibleDeepLink('mandible:///issues?issue=dfc924a')).toBe(
      '#/issues?issue=dfc924a',
    );
    expect(
      routeHashFromMandibleDeepLink('mandible:///issues?repo=mandible&issue=dfc924a&comment=2'),
    ).toBe('#/issues?issue=dfc924a&repo=mandible&comment=2');
    expect(routeHashFromMandibleDeepLink('mandible://issues?issue=dfc924a')).toBe(
      '#/issues?issue=dfc924a',
    );
    expect(routeHashFromMandibleDeepLink('https://example.test/issues?issue=dfc924a')).toBeNull();
  });

  it('maps mandible auth and artifact deep links onto existing hash routes', () => {
    expect(routeHashFromMandibleDeepLink('mandible:///auth?request=abc')).toBe(
      '#/auth?request=abc',
    );
    expect(routeHashFromMandibleDeepLink('mandible:///artifacts?ref=bbbbbbbbbbbb')).toBe(
      '#/artifacts?ref=bbbbbbbbbbbb',
    );
    expect(
      routeHashFromMandibleDeepLink('mandible:///artifacts?artifact=artifact%3Asha256%3Aabc'),
    ).toBe('#/artifacts?artifact=artifact%3Asha256%3Aabc');
  });

  it('navigates only for supported mandible deep links', () => {
    const navigate = vi.fn();

    expect(navigateToMandibleDeepLink('mandible:///issues?issue=dfc924a', navigate)).toBe(true);
    expect(navigate).toHaveBeenCalledWith('#/issues?issue=dfc924a');

    expect(navigateToMandibleDeepLink('mandible:///issues', navigate)).toBe(false);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('enables Tauri deep-link APIs for the daemon-served loopback dashboard', () => {
    const capability = JSON.parse(
      readFileSync('src-tauri/capabilities/default.json', 'utf8'),
    ) as { remote?: { urls?: string[] }; permissions?: string[] };

    expect(capability.remote?.urls).toContain('http://127.0.0.1:19420');
    expect(capability.remote?.urls).toContain('http://localhost:19420');
    expect(capability.permissions).toContain('deep-link:default');
  });

  it('registers the warm deep-link listener before reading the cold-start URL', async () => {
    const calls: string[] = [];
    const cleanup = vi.fn(() => calls.push('cleanup'));
    const onOpenUrl = vi.fn(async (handler: (urls: string[]) => void) => {
      calls.push('listen');
      handler(['mandible:///auth?request=warm']);
      return cleanup;
    });
    const getCurrent = vi.fn(async () => {
      calls.push('current');
      return ['mandible:///issues?issue=cold'];
    });
    vi.doMock('@tauri-apps/plugin-deep-link', () => ({ getCurrent, onOpenUrl }));
    (window as Window & { __TAURI__?: unknown }).__TAURI__ = {};

    const navigate = vi.fn((hash: string) => calls.push(`navigate:${hash}`));
    const removeListener = await installTauriDeepLinkHandler(navigate);

    expect(calls).toEqual([
      'listen',
      'navigate:#/auth?request=warm',
      'current',
      'navigate:#/issues?issue=cold',
    ]);
    expect(onOpenUrl).toHaveBeenCalledOnce();
    expect(getCurrent).toHaveBeenCalledOnce();

    removeListener();
    expect(cleanup).toHaveBeenCalledOnce();
  });
});

describe('app shell', () => {
  function RegisteredSidebar(): JSX.Element {
    const descriptor = useMemo<AppBottomPanelDescriptor>(() => ({
      id: 'test-panel',
      title: 'inspector',
      ariaLabel: 'Test inspector',
      open: true,
      height: 360,
      onOpenChange: () => undefined,
      onHeightChange: () => undefined,
      content: h('div', {}, 'Inspector content'),
    }), []);

    useRegisterAppBottomPanel(descriptor);
    return h('main', {}, 'Workspace');
  }

  function ShellProbe(): JSX.Element {
    const [bottomPanel, setBottomPanel] = useState<AppBottomPanelDescriptor | null>(null);
    const registerBottomPanel = useCallback((descriptor: AppBottomPanelDescriptor) => {
      setBottomPanel(descriptor);
      return () => setBottomPanel((current) => (current?.id === descriptor.id ? null : current));
    }, []);
    const shell = useMemo<AppShellContextValue>(() => ({
      bottomPanel,
      registerBottomPanel,
    }), [bottomPanel, registerBottomPanel]);

    return h(AppShellProvider, { value: shell }, [
      h('header', { className: 'app-header' }, [
        h('span', { className: 'app-header__brand-text' }, 'Mandible'),
        h('span', { className: 'app-header__route' }, 'Timeline'),
        bottomPanel?.content
          ? h('button', {
            type: 'button',
            'aria-label': bottomPanel.open ? `Collapse ${bottomPanel.title}` : `Show ${bottomPanel.title}`,
            onClick: () => setBottomPanel({
              ...bottomPanel,
              open: !bottomPanel.open,
            }),
          }, h(BottomPanelIcon, { open: bottomPanel.open }))
          : null,
      ]),
      h(RegisteredSidebar, {}),
      bottomPanel?.open && bottomPanel.content
        ? h('aside', { className: 'app-bottom-panel', 'aria-label': bottomPanel.ariaLabel }, [
          h('div', { className: 'app-bottom-panel__content' }, bottomPanel.content),
        ])
        : null,
    ]);
  }

  it('renders shared header identity, route title, and registered bottom panel toggle', async () => {
    render(h(ShellProbe, {}));

    expect(screen.getByText('Mandible')).toBeTruthy();
    expect(screen.getByText('Timeline')).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText('Collapse inspector')).toBeTruthy());
    expect(screen.getByLabelText('Test inspector')).toBeTruthy();
    expect(screen.getByText('Inspector content')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Collapse inspector'));
    expect(screen.getByLabelText('Show inspector')).toBeTruthy();
    expect(screen.queryByLabelText('Test inspector')).toBeNull();
  });

  it('keeps the app rail visible while sidebar=hidden hides the view sidebar', async () => {
    stubAppShellFetch();
    stubEventSource();
    window.history.replaceState(
      null,
      '',
      '#/issues?repo=dotfiles&issue=e70757d&sidebar=hidden',
    );

    const { container } = render(h(App, {}));

    expect(screen.getByLabelText('Main navigation')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Filter issues...')).toBeNull();
    const reveal = screen.getByLabelText('Show view sidebar');
    const themeToggle = screen.getByLabelText(/^App theme:/);
    const footer = container.querySelector('.app-rail__footer');
    const sidebarControls = container.querySelector('.app-rail__sidebar-controls');

    expect(footer).toBeTruthy();
    expect(sidebarControls?.parentElement).toBe(footer);
    expect(container.querySelector('.app-rail > .app-rail__sidebar-controls')).toBeNull();
    expect(Boolean(reveal.compareDocumentPosition(themeToggle) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);

    fireEvent.click(reveal);

    await waitFor(() => expect(screen.getByPlaceholderText('Filter issues...')).toBeTruthy());
    expect(window.location.hash).toBe('#/issues?repo=dotfiles&issue=e70757d');
  });

  it('keeps the bottom rail sidebar toggle functional for Inbox', async () => {
    stubAppShellFetch();
    stubEventSource();
    window.history.replaceState(null, '', '#/inbox?sidebar=hidden');

    const { container } = render(h(App, {}));

    const reveal = screen.getByLabelText('Show view sidebar');
    expect(reveal.closest('.app-rail__footer')).toBeTruthy();
    expect(container.querySelector('.app-rail > .app-rail__sidebar-controls')).toBeNull();

    fireEvent.click(reveal);

    await waitFor(() => expect(screen.getByLabelText('Hide view sidebar')).toBeTruthy());
    expect(window.location.hash).toBe('#/inbox');
  });

  it('renders Graph bottom detail without a registration loop', async () => {
    stubEventSource();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/graph?')) {
        return Promise.resolve(
          new Response(JSON.stringify({
            mode: 'activity',
            nodes: [{
              id: 'repo:mandible',
              type: 'repo',
              label: 'mandible',
              status: 'active',
              repo: 'mandible',
            }],
            edges: [],
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
    vi.stubGlobal('fetch', fetchMock);
    window.history.replaceState(null, '', '#/graph');

    render(h(App, {}));

    await waitFor(() => expect(screen.getByLabelText('Collapse Graph detail')).toBeTruthy());
    expect(screen.getByLabelText('Graph detail')).toBeTruthy();
    expect(screen.getAllByText('mandible').length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith('/api/graph?')).length)
      .toBeLessThan(5);
  });

  it('updates Graph selection without remounting the flow canvas', async () => {
    stubEventSource();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/graph?')) {
        return Promise.resolve(
          new Response(JSON.stringify({
            mode: 'activity',
            nodes: [
              {
                id: 'alpha',
                type: 'repo',
                label: 'alpha',
                status: 'active',
                repo: 'mandible',
              },
              {
                id: 'beta',
                type: 'repo',
                label: 'beta',
                status: 'active',
                repo: 'mandible',
              },
            ],
            edges: [{
              id: 'alpha-beta',
              type: 'related',
              source: 'alpha',
              target: 'beta',
            }],
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
    }));
    window.history.replaceState(null, '', '#/graph');

    render(h(App, {}));

    await waitFor(() => expect(screen.getByLabelText('Collapse Graph detail')).toBeTruthy());
    expect(within(screen.getByLabelText('Graph detail')).getByRole('heading', { name: 'alpha' }))
      .toBeTruthy();
    expect(reactFlowMockState.mountCount).toBe(1);

    fireEvent.click(screen.getByLabelText('Select graph node rf_beta'));

    await waitFor(() => expect(
      within(screen.getByLabelText('Graph detail')).getByRole('heading', { name: 'beta' }),
    ).toBeTruthy());
    expect(reactFlowMockState.mountCount).toBe(1);
    expect(reactFlowMockState.unmountCount).toBe(0);
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

  it('saves instruction delivery targets and post-export hook settings', async () => {
    const onSave = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/settings/instructions-delivery' && (!init || init.method === undefined || init.method === 'GET')) {
        return new Response(JSON.stringify({
          targets: [
            { path: '/Users/mll/.claude/CLAUDE.md', mode: 'managed-block' },
            { path: '/Users/mll/.codex/AGENTS.md', mode: 'managed-block' },
          ],
          postExport: '',
          configuredTargets: false,
          export: { ok: true, stdout: '', stderr: '' },
          cleanup: [],
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/settings/instructions-delivery' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as {
          targets?: Array<{ path: string; mode: string }>;
          postExport?: string;
          resetToDefaults?: boolean;
        };
        const targets = body.resetToDefaults
          ? [
            { path: '/Users/mll/.claude/CLAUDE.md', mode: 'managed-block' },
            { path: '/Users/mll/.codex/AGENTS.md', mode: 'managed-block' },
          ]
          : body.targets ?? [
            { path: '/Users/mll/.claude/CLAUDE.md', mode: 'managed-block' },
            { path: '/Users/mll/.codex/AGENTS.md', mode: 'managed-block' },
          ];
        return new Response(JSON.stringify({
          targets,
          postExport: body.postExport ?? '',
          configuredTargets: true,
          export: { ok: true, stdout: 'Installed', stderr: '' },
          cleanup: [],
        }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      h(SettingsView, {
        settings: {},
        onSave,
      }),
    );

    expect(screen.getByText('Instruction Delivery')).toBeTruthy();
    expect(await screen.findByDisplayValue('/Users/mll/.claude/CLAUDE.md')).toBeTruthy();
    expect(screen.getByDisplayValue('/Users/mll/.codex/AGENTS.md')).toBeTruthy();
    expect(screen.queryByPlaceholderText('/path/to/50-mandible.generated.md')).toBeNull();
    expect(screen.queryByPlaceholderText('bin/compile-agent-instructions')).toBeNull();

    fireEvent.input(screen.getByLabelText('New instruction target path'), {
      target: { value: '/tmp/50-mandible.generated.md' },
    });
    fireEvent.click(screen.getByText('Add target'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/instructions-delivery',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          targets: [
            { path: '/Users/mll/.claude/CLAUDE.md', mode: 'managed-block' },
            { path: '/Users/mll/.codex/AGENTS.md', mode: 'managed-block' },
            { path: '/tmp/50-mandible.generated.md', mode: 'managed-block' },
          ],
          cleanupRemovedTargets: false,
        }),
      }),
    ));

    fireEvent.input(screen.getByLabelText('Instructions post-export hook'), {
      target: { value: 'bin/compile-agent-instructions' },
    });
    fireEvent.click(screen.getByLabelText('Save instructions post-export hook'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/instructions-delivery',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ postExport: 'bin/compile-agent-instructions' }),
      }),
    ));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('instructions.post_export', 'bin/compile-agent-instructions'));
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
    expect(screen.getByLabelText('Deferred auth actions')).toBeTruthy();
    expect(screen.getByText('Close issue')).toBeTruthy();
    expect(screen.getByText('Closeout comment body')).toBeTruthy();
    expect(screen.getByText('Add merged')).toBeTruthy();
    expect(screen.getByText('Set to done')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('abc123 · Close umbrella')).toBeTruthy());
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
    expect(screen.queryByLabelText('Deferred auth actions')).toBeNull();
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

    changeSelect(screen.getByDisplayValue('Last activity'), 'name');
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

  it('resolves partial repo summaries without requiring repo roots', () => {
    const repoId = resolveIssueRepoDeepLink(
      [{
        repo_id: 'dotfiles',
        repo_name: 'dotfiles',
        open_count: 1,
        merged_count: 0,
        closed_count: 0,
        issues: [],
      }],
      'dotfiles',
    );

    expect(repoId).toBe('dotfiles');
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
          spec: async () => ({ markdown: 'spec text', commits: ['c1'], meta: {} }),
        },
      }),
    );

    await waitFor(() => expect(screen.getByText('spec text')).toBeTruthy());
    expect(screen.getByText('c1')).toBeTruthy();
  });
});

describe('API contract helpers', () => {
  it('normalizes legacy review spec fields into the canonical payload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => (
      new Response(JSON.stringify({ raw: 'legacy spec', commits: ['c1'] }), {
        headers: { 'content-type': 'application/json' },
      })
    )));

    const spec = await getReviewSpec({ repo: 'repo', branch: 'feature/x' });

    expect(spec).toEqual({ markdown: 'legacy spec', commits: ['c1'], meta: {} });
  });

  it('surfaces server error bodies for PATCH helpers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => (
      new Response(JSON.stringify({ error: 'specific failure' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      })
    )));

    await expect(patchSession('s1', { status: 'dead' })).rejects.toThrow('specific failure');
  });

  it('sends conversation starred updates as booleans', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo, init?: RequestInit) => (
      new Response(JSON.stringify({ id: 'c1', starred: true }), {
        headers: { 'content-type': 'application/json' },
      })
    ));
    vi.stubGlobal('fetch', fetchMock);

    await updateConversation('c1', { starred: true });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.starred).toBe(true);
  });
});

describe('LedgerIssueDetail', () => {
  it('renders ledger issue evidence and sanitizes Markdown HTML', () => {
    const detail = {
      id: 'issue_1',
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
      id: 'issue_1',
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
      body: 'See [issue:def456], #789abcd, issue_legacy_alias, auth request 2257522a, merge 204ade09bc3a, [comment:mandible/def456#com_2], next `020a65b`, commit `7714da1`, current commit is f026c06, superseding the earlier 7714da1, [artifact:bbbbbbbbbbbb], [artifact:feedbax://runs/demo], [artifact:repo://mandible@main/results/report.md], and `#deadbee` in code.',
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
    expect(issueLinks.some((link) => link.text === '#789abcd')).toBe(false);
    expect(issueLinks.some((link) => link.text === 'issue_legacy_alias')).toBe(false);
    expect(issueLinks.some((link) => link.text === '2257522a')).toBe(false);
    expect(issueLinks.some((link) => link.text === '204ade09bc3a')).toBe(false);
    expect(issueLinks).toContainEqual({
      text: 'def456#com_2',
      href: '#/issues?repo=mandible&issue=def456&comment=com_2',
    });
    expect(issueLinks.some((link) => link.text === '020a65b')).toBe(false);
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
      text: 'artifact:bbbbbbbbbbbb',
      href: '#/artifacts?ref=bbbbbbbbbbbb',
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
      id: 'issue_1',
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
      id: 'issue_1',
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
          uri: 'artifact:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
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
              entity_id: 'issue_1',
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
        {
          id: 'artifact:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          algorithm: 'sha256',
          content_hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          uri: 'artifact:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          media_type: null,
          role: null,
          provider_id: null,
          manifest_id: null,
          custody_mode: 'external',
          availability: 'remote_only',
          created_at: Date.now(),
          refs: [],
          links: [],
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
    const compactLink = screen.getByText('artifact:bbbbbbbbbbbb').closest('a') as HTMLAnchorElement | null;
    expect(compactLink?.getAttribute('href')).toBe(
      '#/artifacts?artifact=artifact%3Asha256%3Abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    );
    expect(screen.getByText('linked + referenced')).toBeTruthy();
    expect(screen.getByText('report · text/markdown · provider_1 · present')).toBeTruthy();
  });

  it('keeps issue and comment provenance behind metadata controls', () => {
    const now = Date.now();
    const detail = {
      id: 'issue_1',
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
      id: 'issue_1',
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
      uri: 'artifact:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      media_type: 'text/markdown',
      role: 'report',
      size_bytes: 42,
      provider_id: 'feedbax',
      manifest_id: null,
      metadata: {
        title: 'demo-report.md',
        filename: 'demo-report.md',
      },
      pinned: true,
      custody_mode: 'managed',
      home_repo_id: 'mandible',
      repo_locator: { repo_id: 'mandible', path: 'reports/demo-report.md' },
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
    expect(screen.getAllByText('demo-report.md').length).toBeGreaterThan(0);
    const detailHeader = document.querySelector('.artifact-detail__header');
    expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('demo-report.md');
    expect(detailHeader?.textContent).not.toContain('present');
    expect(detailHeader?.textContent).not.toContain('pinned');
    const sidebarItem = screen.getByRole('button', { name: /demo-report\.md/ });
    expect(sidebarItem.textContent).not.toContain('present');
    expect(sidebarItem.textContent).not.toContain('pinned');
    expect(sidebarItem.querySelector('.artifacts-sidebar__badges')).toBeNull();
    const sidebarMeta = sidebarItem.querySelector('.artifacts-sidebar__meta');
    expect(sidebarMeta?.textContent).toContain('mandible');
    expect(sidebarMeta?.textContent).toContain('reports/demo-report.md');
    expect(sidebarMeta?.textContent).toContain('report');
    const filterButton = screen.getByLabelText('Artifact filters');
    expect(filterButton.textContent).not.toContain('⋯');
    expect(filterButton.querySelector('svg')).toBeTruthy();
    expect(screen.getByText('Knowledge Backrefs')).toBeTruthy();
    expect(screen.getByText('claim')).toBeTruthy();
    expect(screen.getByText('indexed')).toBeTruthy();
    const sectionHeadings = Array.from(document.querySelectorAll('.artifact-detail__section h3')).map((node) => node.textContent);
    expect(sectionHeadings.slice(0, 3)).toEqual(['Identity', 'Custody', 'Preview']);
    expect(sectionHeadings.indexOf('Preview')).toBeLessThan(sectionHeadings.indexOf('Knowledge Backrefs'));
  });

  it('renders HTML artifact previews in a sandboxed iframe', async () => {
    const artifact = {
      id: 'artifact:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      algorithm: 'sha256',
      content_hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      uri: 'artifact:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      media_type: 'text/html',
      role: 'figure',
      size_bytes: 100,
      provider_id: null,
      manifest_id: null,
      metadata: {
        title: 'plot.html',
        filename: 'plot.html',
      },
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
    const html = '<!doctype html><html><body><h1>Plot</h1><script>window.plotReady = true;</script></body></html>';
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts?')) {
        return Promise.resolve(new Response(JSON.stringify({ artifacts: [artifact] }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      if (url.endsWith('/content')) {
        return Promise.resolve(new Response(JSON.stringify({
          content: {
            artifact_id: artifact.id,
            status: 'available',
            kind: 'html',
            media_type: 'text/html',
            size_bytes: html.length,
            source: { kind: 'managed_file', locator: 'artifact-storage' },
            preview: { encoding: 'utf-8', text: html, truncated: false },
            download: { available: true, media_type: 'text/html', size_bytes: html.length, filename: 'plot.html' },
          },
        }), { headers: { 'content-type': 'application/json' } }));
      }
      if (url.endsWith('/knowledge-backrefs')) {
        return Promise.resolve(new Response(JSON.stringify({ backrefs: [] }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      if (url.includes(encodeURIComponent(artifact.id))) {
        return Promise.resolve(new Response(JSON.stringify({ artifact }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(h(ArtifactsView, { initialArtifactId: artifact.id }));

    await waitFor(() => expect(document.querySelector('.artifact-preview--html')).toBeTruthy());
    const iframe = document.querySelector('.artifact-preview--html') as HTMLIFrameElement | null;
    expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe?.getAttribute('srcdoc')).toContain('<h1>Plot</h1>');
  });

  it('keeps the sidebar list mounted when artifact selection changes', async () => {
    const makeArtifact = (hashChar: string, title: string) => ({
      id: `artifact:sha256:${hashChar.repeat(64)}`,
      algorithm: 'sha256',
      content_hash: hashChar.repeat(64),
      uri: `artifact:${hashChar.repeat(64)}`,
      media_type: 'text/markdown',
      role: 'report',
      size_bytes: 42,
      provider_id: 'feedbax',
      manifest_id: null,
      metadata: {
        title,
        filename: title,
      },
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
    });
    const firstArtifact = makeArtifact('1', 'one.md');
    const secondArtifact = makeArtifact('2', 'two.md');
    let listCalls = 0;
    const contentCalls: string[] = [];
    const mockFetch = vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts?')) {
        const params = new URLSearchParams(url.split('?')[1] ?? '');
        if (params.get('limit') === '200') listCalls += 1;
        if (params.get('limit') === '200' && listCalls > 1) {
          return new Promise<Response>(() => undefined);
        }
        return Promise.resolve(new Response(JSON.stringify({ artifacts: [firstArtifact, secondArtifact] }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      if (url.endsWith('/content')) {
        contentCalls.push(url);
        const artifact = url.includes(encodeURIComponent(secondArtifact.id)) ? secondArtifact : firstArtifact;
        return Promise.resolve(new Response(JSON.stringify({
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
        }), { headers: { 'content-type': 'application/json' } }));
      }
      if (url.endsWith('/knowledge-backrefs')) {
        return Promise.resolve(new Response(JSON.stringify({ backrefs: [] }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      if (url.includes(encodeURIComponent(firstArtifact.id))) {
        return Promise.resolve(new Response(JSON.stringify({ artifact: firstArtifact }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      if (url.includes(encodeURIComponent(secondArtifact.id))) {
        return Promise.resolve(new Response(JSON.stringify({ artifact: secondArtifact }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    });
    vi.stubGlobal('fetch', mockFetch);

    render(h(ArtifactsView, { initialArtifactId: firstArtifact.id }));

    await waitFor(() => expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('one.md'));
    expect(listCalls).toBe(1);
    expect(screen.queryByText('Loading artifacts...')).toBeNull();

    const secondButton = screen.getByRole('button', { name: /two\.md/ });
    fireEvent.click(secondButton);

    await waitFor(() => expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('two.md'));
    await waitFor(() => expect(contentCalls.some((url) => url.includes(encodeURIComponent(secondArtifact.id)))).toBe(true));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(listCalls).toBe(1);
    expect(screen.queryByText('Loading artifacts...')).toBeNull();
    expect(screen.getByRole('button', { name: /one\.md/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /two\.md/ })).toBeTruthy();
  });

  it('uses lightweight list records and renders selected identity before preview content resolves', async () => {
    const summaryArtifact = {
      id: 'artifact:sha256:5555555555555555555555555555555555555555555555555555555555555555',
      algorithm: 'sha256',
      content_hash: '5555555555555555555555555555555555555555555555555555555555555555',
      uri: 'repo://mandible@main/results/fast-summary.md',
      media_type: 'text/markdown',
      role: 'report',
      size_bytes: 42,
      provider_id: 'feedbax',
      manifest_id: null,
      metadata: {
        title: 'fast-summary.md',
        filename: 'fast-summary.md',
      },
      pinned: false,
      custody_mode: 'managed',
      home_repo_id: 'mandible',
      repo_locator: { repo_id: 'mandible', ref: 'main', path: 'results/fast-summary.md' },
      availability: 'present',
      retention: {},
      reference: {},
      created_at: Date.now(),
      alias_schemes: ['artifact', 'repo'],
    };
    const fullArtifact = {
      ...summaryArtifact,
      metadata: {
        ...summaryArtifact.metadata,
        nested: { full: true },
      },
      reference: { owner_system: 'repo' },
      aliases: [
        {
          id: 'alias-1',
          artifact_id: summaryArtifact.id,
          scheme: 'repo',
          alias: summaryArtifact.uri,
          normalized_ref: summaryArtifact.uri,
          locator: {},
          resolution_status: 'resolved',
          source: 'artifact_registry',
          created_at: Date.now(),
          updated_at: Date.now(),
        },
      ],
      links: [],
    };
    let listUrl = '';
    let resolveDetail: (response: Response) => void = () => undefined;
    const detailPromise = new Promise<Response>((resolve) => {
      resolveDetail = resolve;
    });
    const contentPromise = new Promise<Response>(() => undefined);
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts?')) {
        listUrl = url;
        return Promise.resolve(new Response(JSON.stringify({ artifacts: [summaryArtifact] }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      if (url.endsWith('/content')) {
        return contentPromise;
      }
      if (url.endsWith('/knowledge-backrefs')) {
        return Promise.resolve(new Response(JSON.stringify({ backrefs: [] }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      if (url.includes(encodeURIComponent(summaryArtifact.id))) {
        return detailPromise;
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(h(ArtifactsView, {}));

    await waitFor(() => expect(listUrl).toContain('summary=true'));
    await waitFor(() => expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('fast-summary.md'));
    await waitFor(() => expect(screen.getByText('Loading preview...')).toBeTruthy());
    expect(screen.getByText('repo://mandible@main/results/fast-summary.md')).toBeTruthy();

    resolveDetail(new Response(JSON.stringify({ artifact: fullArtifact }), {
      headers: { 'content-type': 'application/json' },
    }));

    await waitFor(() => expect(screen.getByText('Locators')).toBeTruthy());
    expect(screen.getAllByText(summaryArtifact.uri).length).toBeGreaterThan(1);
    expect(screen.getByText('Loading preview...')).toBeTruthy();
  });

  it('keeps artifact facet options available after selecting a facet value', async () => {
    const makeArtifact = (
      hashChar: string,
      title: string,
      role: string,
      repo: string,
      provider: string,
      custody: string,
      availability: string,
    ) => ({
      id: `artifact:sha256:${hashChar.repeat(64)}`,
      algorithm: 'sha256',
      content_hash: hashChar.repeat(64),
      uri: `repo://${repo}@main/results/${title}`,
      media_type: 'text/markdown',
      role,
      size_bytes: 42,
      provider_id: provider,
      manifest_id: null,
      metadata: {
        title,
        filename: title,
      },
      pinned: false,
      custody_mode: custody,
      home_repo_id: repo,
      repo_locator: { repo_id: repo, ref: 'main', path: `results/${title}` },
      availability,
      retention: {},
      reference: {},
      created_at: Date.now(),
      alias_schemes: ['repo'],
    });
    const inputArtifact = makeArtifact('6', 'input.md', 'input', 'repo-a', 'provider-a', 'linked', 'present');
    const outputArtifact = makeArtifact('7', 'output.md', 'output', 'repo-b', 'provider-b', 'managed', 'remote_only');
    const artifacts = [inputArtifact, outputArtifact];
    const listUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts?')) {
        listUrls.push(url);
        const params = new URLSearchParams(url.split('?')[1] ?? '');
        let rows = artifacts;
        const role = params.get('role');
        const repo = params.get('repo');
        if (role) rows = rows.filter((artifact) => artifact.role === role);
        if (repo) rows = rows.filter((artifact) => artifact.home_repo_id === repo);
        return Promise.resolve(new Response(JSON.stringify({ artifacts: rows }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      if (url.endsWith('/content')) {
        return new Promise<Response>(() => undefined);
      }
      if (url.endsWith('/knowledge-backrefs')) {
        return Promise.resolve(new Response(JSON.stringify({ backrefs: [] }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      for (const artifact of artifacts) {
        if (url.includes(encodeURIComponent(artifact.id))) {
          return Promise.resolve(new Response(JSON.stringify({ artifact }), {
            headers: { 'content-type': 'application/json' },
          }));
        }
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(h(ArtifactsView, {}));

    await waitFor(() => expect(screen.getByRole('button', { name: /input\.md/ })).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Artifact filters'));

    const roleSelect = screen.getByLabelText('Role') as HTMLSelectElement;
    const repoSelect = screen.getByLabelText('Repo') as HTMLSelectElement;
    await waitFor(() => {
      expect(Array.from(roleSelect.options).map((option) => option.value)).toEqual(['', 'input', 'output']);
    });
    expect(Array.from(repoSelect.options).map((option) => option.value)).toEqual(['', 'repo-a', 'repo-b']);

    changeSelect(roleSelect, 'output');

    await waitFor(() => expect(screen.getByRole('button', { name: /output\.md/ })).toBeTruthy());
    await waitFor(() => expect(screen.queryByRole('button', { name: /input\.md/ })).toBeNull());
    expect(Array.from(roleSelect.options).map((option) => option.value)).toEqual(['', 'input', 'output']);
    expect(Array.from(repoSelect.options).map((option) => option.value)).toEqual(['', 'repo-a', 'repo-b']);

    changeSelect(roleSelect, 'input');

    await waitFor(() => expect(screen.getByRole('button', { name: /input\.md/ })).toBeTruthy());
    await waitFor(() => expect(screen.queryByRole('button', { name: /output\.md/ })).toBeNull());
    expect(listUrls.length).toBeGreaterThan(1);
    expect(listUrls.every((url) => url.includes('summary=true'))).toBe(true);
  });

  it('resolves direct artifact refs without selecting the first sidebar item', async () => {
    const listArtifact = {
      id: 'artifact:sha256:3333333333333333333333333333333333333333333333333333333333333333',
      algorithm: 'sha256',
      content_hash: '3333333333333333333333333333333333333333333333333333333333333333',
      uri: 'artifact:3333333333333333333333333333333333333333333333333333333333333333',
      media_type: 'text/markdown',
      role: 'report',
      size_bytes: 42,
      provider_id: 'feedbax',
      manifest_id: null,
      metadata: {
        title: 'sidebar-first.md',
        filename: 'sidebar-first.md',
      },
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
    const linkedArtifact = {
      ...listArtifact,
      id: 'artifact:sha256:4444444444444444444444444444444444444444444444444444444444444444',
      content_hash: '4444444444444444444444444444444444444444444444444444444444444444',
      uri: 'artifact:4444444444444444444444444444444444444444444444444444444444444444',
      metadata: {
        title: 'deep-link.md',
        filename: 'deep-link.md',
      },
    };
    const ref = 'repo://mandible@main/results/deep-link.md';
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts?')) {
        return Promise.resolve(new Response(JSON.stringify({ artifacts: [listArtifact] }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      if (url.startsWith('/api/artifacts/resolve?')) {
        return Promise.resolve(new Response(JSON.stringify({
          resolution: {
            status: 'resolved',
            ref,
            scheme: 'repo',
            normalized_ref: ref,
            artifact: linkedArtifact,
            alias: null,
          },
        }), { headers: { 'content-type': 'application/json' } }));
      }
      if (url.endsWith('/content')) {
        return Promise.resolve(new Response(JSON.stringify({
          content: {
            artifact_id: linkedArtifact.id,
            status: 'unavailable',
            kind: 'unavailable',
            media_type: 'text/markdown',
            size_bytes: 0,
            source: null,
            preview: null,
            download: { available: false, media_type: 'text/markdown', size_bytes: 0, filename: null },
            reason: 'No inline preview is available.',
          },
        }), { headers: { 'content-type': 'application/json' } }));
      }
      if (url.endsWith('/knowledge-backrefs')) {
        return Promise.resolve(new Response(JSON.stringify({ backrefs: [] }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      if (url.includes(encodeURIComponent(linkedArtifact.id))) {
        return Promise.resolve(new Response(JSON.stringify({ artifact: linkedArtifact }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(h(ArtifactsView, { initialRef: ref }));

    await waitFor(() => expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('deep-link.md'));
    expect(screen.getByText('sidebar-first.md')).toBeTruthy();
    expect(screen.getByText(ref)).toBeTruthy();
  });

  it('renders bundle artifacts as member navigation before manifest JSON', async () => {
    const bundleId = 'artifact:sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
    const memberId = 'artifact:sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
    const artifact = {
      id: bundleId,
      algorithm: 'sha256',
      content_hash: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      uri: 'artifact:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      media_type: 'application/vnd.mandible.artifact-bundle+json',
      role: 'artifact_bundle',
      size_bytes: 160,
      provider_id: null,
      manifest_id: null,
      metadata: {
        title: 'run packet',
        bundle: true,
      },
      pinned: false,
      custody_mode: 'managed',
      home_repo_id: 'mandible',
      repo_locator: {},
      availability: 'present',
      retention: {},
      reference: { identity_kind: 'artifact_bundle' },
      created_at: Date.now(),
      aliases: [],
      links: [],
    };
    const manifest = JSON.stringify({
      schema_version: 'mandible.artifact_bundle.v1',
      name: 'run packet',
      members: [
        { artifact_id: memberId, role: 'figure', order: 0, recoverability: 'repo_commit' },
      ],
    }, null, 2);
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts?')) {
        return Promise.resolve(new Response(JSON.stringify({ artifacts: [artifact] }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      if (url.endsWith('/content')) {
        return Promise.resolve(new Response(JSON.stringify({
          content: {
            artifact_id: artifact.id,
            status: 'available',
            kind: 'json',
            media_type: 'application/vnd.mandible.artifact-bundle+json',
            size_bytes: manifest.length,
            source: { kind: 'managed_file', locator: 'artifact-storage' },
            preview: { encoding: 'utf-8', text: manifest, truncated: false },
            download: {
              available: true,
              media_type: 'application/vnd.mandible.artifact-bundle+json',
              size_bytes: manifest.length,
              filename: 'run-packet.json',
            },
          },
        }), { headers: { 'content-type': 'application/json' } }));
      }
      if (url.endsWith('/knowledge-backrefs')) {
        return Promise.resolve(new Response(JSON.stringify({ backrefs: [] }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      if (url.includes(encodeURIComponent(artifact.id))) {
        return Promise.resolve(new Response(JSON.stringify({ artifact }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(h(ArtifactsView, { initialArtifactId: artifact.id }));

    await waitFor(() => expect(screen.getByText(memberId)).toBeTruthy());
    const memberLink = screen.getByText(memberId).closest('a') as HTMLAnchorElement | null;
    expect(memberLink?.getAttribute('href')).toBe(`#/artifacts?artifact=${encodeURIComponent(memberId)}`);
    expect(screen.getByText('figure')).toBeTruthy();
    expect(screen.getByText('repo_commit')).toBeTruthy();
    expect(screen.getByText('Manifest JSON')).toBeTruthy();
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
