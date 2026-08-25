// Quarantined: f9a5ba8 — the single-panel modifier is missing from the detail surface.
import { readFileSync } from 'node:fs';
import { render, screen, fireEvent, waitFor, cleanup, act, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { useCallback, useMemo, useState } from 'preact/hooks';

import {
  appReducer,
  applySSEEvent,
  initialState,
  selectBadgeCounts,
  parseAuthOutputEvent,
  parseAuthResolvedId,
  loadCachedState,
  saveCachedState,
  MAX_AUTH_OUTPUT_CHARS,
} from '../../ui/src/state';
import { App } from '../../ui/src/app';
import { APP_RAIL_PREVIEW_ORDER_STORAGE_KEY } from '../../ui/src/app-rail-order';
import {
  getWorkCompare,
  getSettings,
  invalidateApiGetCache,
  patchSession,
  updateConversation,
  type InstanceInfo,
} from '../../ui/src/api';
import {
  installTauriDeepLinkHandler,
  navigateToMandibleDeepLink,
  routeHashFromMandibleDeepLink,
} from '../../ui/src/deep-links';
import {
  __resetAgentPageBindingForTests,
  adoptAgentSessionBinding,
  adoptAgentSessionFragment,
  getAgentPageBinding,
} from '../../ui/src/agent-page-binding';
import {
  briefingGroupRoute,
  hashWithViewSidebarHidden,
  hashWithViewSidebarVisible,
  isViewSidebarHidden,
  parseRouteFromHash,
  shortRouteId,
  spacesRouteFromHash,
} from '../../ui/src/routing';
import { __resetSharedSseForTests } from '../../ui/src/sse-shared';
import {
  AppShellProvider,
  BottomPanelIcon,
  useRegisterAppBottomPanel,
  type AppBottomPanelDescriptor,
  type AppShellContextValue,
} from '../../ui/src/app-shell';
import { AuthQueueView } from '../../ui/src/views/auth';
import { GraphView } from '../../ui/src/views/graph';
import { SettingsView } from '../../ui/src/views/settings';
import { WorkOverviewView } from '../../ui/src/views/work';
import { ArtifactsView } from '../../ui/src/views/artifacts';
import { getInstructionMessageMeta } from '../../ui/src/components/message-blocks/UserBubble';
import { LedgerIssueDetail } from '../../ui/src/components/ledger/IssueDetail';
import { useSidebarResize } from '../../ui/src/hooks/useSidebarResize';
import {
  IssuesView,
  resolveIssueIdDeepLink,
  resolveIssueRepoDeepLink,
  type IssueRepoSummary,
} from '../../ui/src/views/issues';
import { readResolvedStylesheet } from '../helpers/css-manifest';

function ruleBody(css: string, selector: string): string {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1]!.split(',').map((entry) => entry.trim()).includes(selector)) return match[2]!;
  }
  return '';
}

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

function readSharedSidebarWidth(shell: HTMLElement, railWidth = 208): number {
  if (window.innerWidth <= 700) return window.innerWidth - railWidth;
  return parseInt(shell.style.getPropertyValue('--app-view-sidebar-persisted-width'), 10);
}

function mockLeftChromeRects(
  shell: HTMLElement,
  header: HTMLElement,
  sidebar: HTMLElement | null,
  railWidth = 208,
): void {
  const rect = (left: number, width: number): DOMRect => ({
    x: left,
    y: 0,
    left,
    top: 0,
    width,
    height: 48,
    right: left + width,
    bottom: 48,
    toJSON: () => ({}),
  });
  header.getBoundingClientRect = () => rect(
    0,
    shell.classList.contains('app-shell--view-sidebar-open')
      ? railWidth + readSharedSidebarWidth(shell, railWidth)
      : railWidth,
  );
  if (sidebar) {
    sidebar.getBoundingClientRect = () => rect(
      railWidth,
      readSharedSidebarWidth(shell, railWidth),
    );
  }
}

function installMemoryLocalStorage(initial: Record<string, string> = {}): () => void {
  restoreTestLocalStorage?.();
  const previous = Object.getOwnPropertyDescriptor(window, 'localStorage');
  const store = new Map(Object.entries(initial));
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() { return store.size; },
  };
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  });
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    if (previous) Object.defineProperty(window, 'localStorage', previous);
  };
  restoreTestLocalStorage = restore;
  return restore;
}

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

function stubEventSource(): { emit: (payload: unknown) => void } {
  const messageListeners = new Set<(event: MessageEvent) => void>();
  class MockEventSource {
    readyState = 1;
    onerror: (() => void) | null = null;
    onopen: (() => void) | null = null;

    constructor(_url: string) {}

    addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
      if (type !== 'message' || typeof listener !== 'function') return;
      messageListeners.add(listener as (event: MessageEvent) => void);
    }
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
      if (type !== 'message' || typeof listener !== 'function') return;
      messageListeners.delete(listener as (event: MessageEvent) => void);
    }
    close(): void {
      this.readyState = 2;
    }
  }

  vi.stubGlobal('EventSource', MockEventSource);
  __resetSharedSseForTests(MockEventSource as unknown as typeof EventSource);
  return {
    emit: (payload) => {
      const event = new MessageEvent('message', { data: JSON.stringify(payload) });
      messageListeners.forEach((listener) => listener(event));
    },
  };
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

function stubRailSettingsFetch(initialSetting?: string, failPut = false): {
  getStored: () => string | undefined;
  getCalls: ReturnType<typeof vi.fn>;
  putCalls: ReturnType<typeof vi.fn>;
  setRemote: (value: string | undefined, nextRevision: number) => void;
} {
  if (!(window as Window & { __MANDIBLE_BOOTSTRAP__?: unknown }).__MANDIBLE_BOOTSTRAP__) {
    (window as Window & { __MANDIBLE_BOOTSTRAP__?: { instance: InstanceInfo } }).__MANDIBLE_BOOTSTRAP__ = {
      instance: writablePreviewInstance,
    };
  }
  let stored = initialSetting;
  let revision = stored ? 1 : 0;
  const getCalls = vi.fn();
  const putCalls = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/settings' && init?.method !== 'PUT') {
      return new Response(JSON.stringify({}), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === '/api/user-settings/app_rail_order' && init?.method !== 'PUT') {
      getCalls(input, init);
      return new Response(JSON.stringify({
        version: 1,
        key: 'app_rail_order',
        value: stored ?? null,
        revision,
      }), { headers: { 'content-type': 'application/json' } });
    }
    if (url === '/api/user-settings/app_rail_order' && init?.method === 'PUT') {
      putCalls(input, init);
      if (failPut) return new Response('{}', { status: 500 });
      stored = (JSON.parse(String(init.body)) as { value: string }).value;
      revision += 1;
      return new Response(JSON.stringify({
        version: 1,
        key: 'app_rail_order',
        value: stored,
        revision,
      }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === '/api/dashboard/badges') {
      return new Response(JSON.stringify({ auth: 3, briefing: 2, inbox: 1 }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify([]), {
      headers: { 'content-type': 'application/json' },
    });
  }));
  return {
    getStored: () => stored,
    getCalls,
    putCalls,
    setRemote: (value, nextRevision) => {
      stored = value;
      revision = nextRevision;
    },
  };
}

function railGroupLinks(container: HTMLElement, _legacyGroup: 'primary' | 'secondary'): HTMLAnchorElement[] {
  return Array.from(container.querySelectorAll<HTMLAnchorElement>('.app-rail__group[data-rail-group="upper"] [data-rail-item]'));
}

async function railReorderReady(): Promise<void> {
  const chat = await screen.findByRole('link', { name: 'Chat' });
  await waitFor(() => expect(chat.getAttribute('aria-keyshortcuts'))
    .toBe('Control+Shift+ArrowUp Control+Shift+ArrowDown'));
  await act(async () => Promise.resolve());
}

function mockRailRects(links: HTMLAnchorElement[]): void {
  links.forEach((link, index) => {
    link.getBoundingClientRect = () => ({
      x: 0,
      y: index * 40,
      left: 0,
      top: index * 40,
      width: 180,
      height: 38,
      right: 180,
      bottom: index * 40 + 38,
      toJSON: () => ({}),
    });
  });
}

function fireRailPointer(
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  init: MouseEventInit & { pointerId: number },
): void {
  // jsdom lacks onpointer* element properties, so Preact retains JSX event
  // casing instead of normalizing to the browser's lowercase event names.
  const jsdomPreactType = {
    pointerdown: 'PointerDown',
    pointermove: 'PointerMove',
    pointerup: 'PointerUp',
    pointercancel: 'PointerCancel',
  }[type];
  const event = new PointerEvent(jsdomPreactType, { bubbles: true, cancelable: true, ...init });
  fireEvent(target, event);
}

function installPointerEventForTest(): void {
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number;

    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  vi.stubGlobal('PointerEvent', TestPointerEvent);
  Object.defineProperty(window, 'PointerEvent', { configurable: true, value: TestPointerEvent });
}

const previewInstance: InstanceInfo = {
  role: 'preview',
  operational_mutations: 'reject',
  operational_mutations_overridden: true,
  db_path: '/tmp/mandible-preview.db',
  db_path_source: 'iab-preview-copy',
  source_db_path: '/tmp/mandible-main.db',
  source_db_path_source: 'env',
};

const writablePreviewInstance: InstanceInfo = {
  ...previewInstance,
  operational_mutations: 'allow',
};

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
    expect(screen.getByText('merge · feature/detail → main')).toBeTruthy();
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
    const commitPanel = screen.getByText('Commit Message').closest('.panel') as HTMLElement | null;
    expect(commitPanel?.querySelector('.panel__header > .panel__toggle')?.textContent).toContain('Commit Message');
    expect(commitPanel?.querySelector('.panel__header > .panel__edit-btn')?.textContent).toBe('edit');
    expect(commitPanel?.querySelector('.panel__toggle .panel__edit-btn')).toBeNull();

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

function issueDetailProjection({
  displayId,
  title,
  body = 'Hydrated body',
  comments = [],
  stage = 'full',
  timelinePartial,
  projectKey = 'mandible',
  repoId = 'mandible',
  repoName = 'mandible',
}: {
  displayId: string;
  title: string;
  body?: string;
  comments?: string[];
  stage?: 'initial' | 'full';
  timelinePartial?: boolean;
  projectKey?: string | null;
  repoId?: string | null;
  repoName?: string | null;
}) {
  const now = Date.now();
  const author = { id: null, type: 'mandible_user', display: 'MLL' };
  const commentEntries = comments.map((body, index) => ({
    id: `${displayId}-comment-${index + 1}`,
    ordinal: index + 1,
    body,
    author,
    source: 'mandible',
    created_at: now + index + 1,
    updated_at: null,
  }));
  return {
    id: displayId,
    display_id: displayId,
    project: {
      id: 'proj_1',
      project_key: projectKey,
      display_name: 'mandible',
      remote_identity: '',
      upstream_identity: '',
      repo_id: repoId,
      repo_name: repoName,
      repo_root: '/repo',
      default_branch: 'main',
    },
    title,
    body,
    status: 'open',
    resolution: null,
    kind: 'bug',
    priority: 'normal',
    source: 'mandible',
    author,
    created_at: now,
    updated_at: now,
    closed_at: null,
    aliases: [],
    labels: ['error'],
    comments: commentEntries,
    checkpoints: [],
    timeline: [
      {
        id: `${displayId}:body`,
        kind: 'body',
        ordinal: 0,
        body,
        author,
        source: 'mandible',
        created_at: now,
        updated_at: null,
      },
      ...commentEntries.map((comment) => ({
        id: comment.id,
        kind: 'comment',
        comment_id: comment.id,
        ordinal: comment.ordinal,
        body: comment.body,
        author: comment.author,
        source: comment.source,
        created_at: comment.created_at,
        updated_at: comment.updated_at,
      })),
    ],
    relationships: [],
    work_units: [],
    sessions: [],
    auth_requests: [],
    associated_artifacts: [],
    detail_stage: stage,
    timeline_partial: timelinePartial ?? stage === 'initial',
  };
}

function makeArtifactVersion(artifact: any, seriesId: string, versionNo: number): any {
  return {
    id: `artifact-version:${seriesId}:${versionNo}`,
    series_id: seriesId,
    artifact_id: artifact.id,
    version_no: versionNo,
    source_kind: 'managed',
    content_hash: artifact.content_hash,
    commit_sha: null,
    repo_path: typeof artifact.repo_locator?.path === 'string' ? artifact.repo_locator.path : null,
    observed_path: null,
    custody_mode: artifact.custody_mode,
    label: null,
    note: null,
    metadata: {},
    created_at: artifact.created_at + versionNo,
  };
}

function makeArtifactFixture(hashChar: string, title: string, overrides: Record<string, unknown> = {}): any {
  return {
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
    repo_locator: { repo_id: 'mandible', path: `reports/${title}` },
    availability: 'present',
    retention: {},
    reference: {},
    created_at: Date.now(),
    aliases: [],
    links: [],
    ...overrides,
  };
}

function makeArtifactSeries(seriesId: string, artifacts: any[], title?: string): { summary: any; history: any } {
  const normalizedSeriesId = seriesId.startsWith('artifact-series:') ? seriesId : `artifact-series:${seriesId}`;
  const seriesKey = normalizedSeriesId.replace(/^artifact-series:/, '');
  const versions = artifacts.map((artifact, index) => makeArtifactVersion(artifact, normalizedSeriesId, index + 1));
  const latestArtifact = artifacts[artifacts.length - 1];
  const latestVersion = versions[versions.length - 1];
  const series = {
    id: normalizedSeriesId,
    ref: normalizedSeriesId,
    series_key: seriesKey,
    source_kind: 'managed',
    title: title ?? latestArtifact?.metadata?.title ?? null,
    repo_id: latestArtifact?.home_repo_id ?? null,
    logical_name: title ?? latestArtifact?.metadata?.logical_name ?? null,
    latest_version_id: latestVersion?.id ?? null,
    version_count: versions.length,
    metadata: {},
    created_at: latestArtifact?.created_at ?? Date.now(),
    updated_at: latestArtifact?.created_at ?? Date.now(),
    latest_version: latestVersion ?? null,
    latest_artifact: latestArtifact ?? null,
    links: [],
  };
  return {
    summary: series,
    history: {
      series: {
        id: series.id,
        series_key: series.series_key,
        source_kind: series.source_kind,
        title: series.title,
        repo_id: series.repo_id,
        logical_name: series.logical_name,
        latest_version_id: series.latest_version_id,
        version_count: series.version_count,
        metadata: series.metadata,
        created_at: series.created_at,
        updated_at: series.updated_at,
      },
      versions,
      links: [],
    },
  };
}

function jsonResponse(body: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  }));
}

