import { readFileSync } from 'node:fs';
import { render as testingRender, screen, fireEvent, waitFor, cleanup, act, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { useCallback, useMemo, useRef, useState } from 'preact/hooks';

import {
  appReducer,
  authEventRequiresProjectionRefresh,
  applySSEEvent,
  initialState,
  selectBadgeCounts,
  parseAuthOutputEvent,
  parseAuthResolvedId,
  loadCachedState,
  saveCachedState,
  MAX_AUTH_OUTPUT_CHARS,
} from '../ui/src/state';
import { App } from '../ui/src/app';
import { PRODUCTION_ORIGIN } from '../src/canonical-origin';
import { PRODUCTION_EFFECTS } from '../src/security/effect-policy.js';
import { APP_RAIL_PREVIEW_ORDER_STORAGE_KEY } from '../ui/src/app-rail-order';
import {
  getWorkCompare,
  getSettings,
  invalidateApiGetCache,
  patchSession,
  updateConversation,
  type InstanceInfo,
} from '../ui/src/api';
import {
  installTauriDeepLinkHandler,
  navigateToMandibleDeepLink,
  routeHashFromMandibleDeepLink,
} from '../ui/src/deep-links';
import {
  __resetAgentPageBindingForTests,
  adoptAgentSessionBinding,
  adoptAgentSessionFragment,
  getAgentPageBinding,
} from '../ui/src/agent-page-binding';
import {
  briefingGroupRoute,
  hashWithViewSidebarHidden,
  hashWithViewSidebarVisible,
  isViewSidebarHidden,
  parseRouteFromHash,
  shortRouteId,
  spacesRouteFromHash,
} from '../ui/src/routing';
import { __resetSharedSseForTests } from '../ui/src/sse-shared';
import { __resetBrowserSessionForTests, ensureClientAccess } from '../ui/src/client-auth-token';
import {
  AppShellProvider,
  RightSidebarIcon,
  useRegisterAppRightSidebar,
  type AppRightSidebarDescriptor,
  type AppShellContextValue,
} from '../ui/src/app-shell';
import { AuthQueueView } from '../ui/src/views/auth';
import type { AuthChangeReport } from '../src/contracts';
import { GraphView } from '../ui/src/views/graph';
import { SettingsView } from '../ui/src/views/settings';
import { WorkOverviewView } from '../ui/src/views/work';
import { ArtifactsView } from '../ui/src/views/artifacts';
import { getInstructionMessageMeta } from '../ui/src/components/message-blocks/UserBubble';
import { LedgerIssueDetail } from '../ui/src/components/ledger/IssueDetail';
import { useSidebarResize } from '../ui/src/hooks/useSidebarResize';
import {
  IssuesView,
  resolveIssueIdDeepLink,
  resolveIssueRepoDeepLink,
  type IssueRepoSummary,
} from '../ui/src/views/issues';
import { readResolvedStylesheet } from './helpers/css-manifest';

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

const render: typeof testingRender = (view, options) => {
  const noticeHost = document.getElementById('app-operational-notices');
  const wrap = (content: typeof view) => h(AppShellProvider, { value: {
    active: true,
    noticeHost,
    rightSidebar: null,
    registerRightSidebar: () => () => undefined,
    registerInitialRouteLoad: () => undefined,
    updateRightSidebar: () => undefined,
  } }, content);
  const result = testingRender(wrap(view), options);
  return { ...result, rerender: (next) => result.rerender(wrap(next)) };
};

beforeEach(async () => {
  const noticeHost = document.createElement('div');
  noticeHost.id = 'app-operational-notices';
  document.body.append(noticeHost);
  __resetBrowserSessionForTests();
  await ensureClientAccess(async () => new Response(JSON.stringify({
    authenticated: true,
    session: {
      family_id: 'test-family', audience: 'production', csrf_token: 'test-csrf',
      effect_ceiling: [
        'ledger:read', 'ledger:write', 'files:preview', 'files:production',
        'auth:protected', 'auth:credentials', 'process:external', 'provider:send',
        'network:publish', 'delivery:background', 'maintenance:shared',
      ],
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
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
  document.getElementById('app-operational-notices')?.remove();
  __resetBrowserSessionForTests();
  invalidateApiGetCache();
  cleanup();
  __resetSharedSseForTests();
  window.localStorage.removeItem?.('mandible:artifacts:list-controls:v1');
  window.sessionStorage?.clear?.();
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

function railGroupLinks(container: HTMLElement, group: 'primary' | 'secondary'): HTMLAnchorElement[] {
  const containerGroup = group === 'primary' ? 'upper' : 'experimental';
  return Array.from(container.querySelectorAll<HTMLAnchorElement>(
    `.app-rail__group[data-rail-group="${containerGroup}"] [data-rail-group="${group}"][data-rail-item]`,
  ));
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
  instance_id: 'preview-test',
  installation_id: 'install-test',
  public_origin: 'https://preview-test.mandible.localhost:19421',
  backend_generation: 'preview-1',
  allowed_effects: ['ledger:read'],
  writable_roots: ['/tmp'],
  preview_root: '/tmp',
  db_path: '/tmp/mandible-preview.db',
  db_path_source: 'iab-preview-copy',
  source_db_path: '/tmp/mandible-main.db',
  source_db_path_source: 'env',
};

const mainInstance: InstanceInfo = {
  role: 'main',
  instance_id: 'main-ui-tests',
  installation_id: 'install-test',
  public_origin: PRODUCTION_ORIGIN,
  backend_generation: 'main-1',
  allowed_effects: [...PRODUCTION_EFFECTS],
  writable_roots: ['/tmp'],
  db_path: '/tmp/mandible-main.db',
  db_path_source: 'test',
};

const writablePreviewInstance: InstanceInfo = {
  ...previewInstance,
  allowed_effects: ['ledger:read', 'ledger:write', 'maintenance:shared'],
};

const preferenceWritablePreviewInstance: InstanceInfo = {
  ...previewInstance,
  allowed_effects: ['ledger:read', 'ledger:write', 'files:preview', 'preferences:instance'],
};

describe('App routing', () => {
  it('routes legacy monitor hashes into console', () => {
    expect(parseRouteFromHash('#/sessions?session=s1')).toEqual({
      tab: 'console',
      params: { session: 's1' },
    });
  });

  it('routes retired Review hashes into Projects while preserving query params', () => {
    expect(parseRouteFromHash('#/review?repo=repo&base=main&head=feature')).toEqual({
      tab: 'work',
      params: { repo: 'repo', base: 'main', head: 'feature' },
    });
  });

  it('routes retired Presets hashes into instruction artifacts', () => {
    expect(parseRouteFromHash('#/presets')).toEqual({
      tab: 'artifacts',
      params: { role: 'instructions' },
    });
    expect(parseRouteFromHash('#/presets?role=context')).toEqual({
      tab: 'artifacts',
      params: { role: 'context' },
    });
  });

  it('routes removed Switchboard hashes to the default Spaces workspace', () => {
    expect(parseRouteFromHash('#/switchboard')).toEqual({
      tab: 'spaces',
      params: {},
    });
  });

  it('defaults empty and unknown hashes to the Spaces workspace', () => {
    expect(parseRouteFromHash('')).toEqual({ tab: 'spaces', params: {} });
    expect(parseRouteFromHash('#/')).toEqual({ tab: 'spaces', params: {} });
    expect(parseRouteFromHash('#/not-a-real-tab')).toEqual({ tab: 'spaces', params: {} });
  });

  it.each([
    [
      '#/artifacts?artifact=legacy&ref=artifact-blob%3Aabc&series=artifact-series%3Areport&version=2&sidebar=hidden',
      { series: 'artifact-series:report', version: '2', sidebar: 'hidden' },
    ],
    [
      '#/artifacts?artifact=legacy&ref=artifact-version%3Av1&version=3',
      { ref: 'artifact-version:v1' },
    ],
    [
      '#/artifacts?artifact=artifact-blob%3Aabc&version=4',
      { artifact: 'artifact-blob:abc' },
    ],
    [
      '#/artifacts?series=artifact-series%3Areport&version=0',
      { series: 'artifact-series:report' },
    ],
  ])('normalizes direct artifact hash selectors before view wiring: %s', (hash, params) => {
    expect(parseRouteFromHash(hash)).toEqual({ tab: 'artifacts', params });
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

  it('falls back to the Spaces default when toggling the sidebar on an empty hash', () => {
    expect(hashWithViewSidebarHidden('')).toBe('#/spaces?sidebar=hidden');
    expect(hashWithViewSidebarVisible('')).toBe('#/spaces');
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
    expect(
      routeHashFromMandibleDeepLink(
        'mandible:///artifacts?series=artifact-series%3Areport&version=2',
      ),
    ).toBe('#/artifacts?series=artifact-series%3Areport&version=2');
    expect(
      routeHashFromMandibleDeepLink('mandible:///artifacts?ref=artifact-blob%3Aabc'),
    ).toBe('#/artifacts?ref=artifact-blob%3Aabc');
    expect(
      routeHashFromMandibleDeepLink('mandible:///artifacts?artifact=artifact-version%3Av1'),
    ).toBe('#/artifacts?artifact=artifact-version%3Av1');
    expect(
      routeHashFromMandibleDeepLink(
        'mandible:///artifacts?artifact=legacy&ref=artifact-blob%3Aabc&series=artifact-series%3Areport&version=oops',
      ),
    ).toBe('#/artifacts?series=artifact-series%3Areport');
  });

  // Issue f59b5bd — deep links compose: extra params (notably agent_session)
  // carry through into the hash route, but route-owned params always win.
  it('carries extra query params through mandible deep links', () => {
    expect(
      routeHashFromMandibleDeepLink('mandible:///auth?request=abc&agent_session=0198c0de'),
    ).toBe('#/auth?request=abc&agent_session=0198c0de');
    expect(
      routeHashFromMandibleDeepLink(
        'mandible:///issues?repo=mandible&issue=dfc924a&agent_session=0198c0de',
      ),
    ).toBe('#/issues?issue=dfc924a&repo=mandible&agent_session=0198c0de');
    expect(
      routeHashFromMandibleDeepLink(
        'mandible:///artifacts?ref=artifact-blob%3Aabc&agent_session=0198c0de',
      ),
    ).toBe('#/artifacts?ref=artifact-blob%3Aabc&agent_session=0198c0de');
    // The artifact normalizer's dropped identity params stay dropped.
    expect(
      routeHashFromMandibleDeepLink(
        'mandible:///artifacts?series=artifact-series%3Areport&version=oops&agent_session=0198c0de',
      ),
    ).toBe('#/artifacts?series=artifact-series%3Areport&agent_session=0198c0de');
  });

  // Issue f59b5bd — deterministically emitted links shorten full UUIDs to the
  // 8-char short form and typed long-hex refs through the shared 7-char ref
  // formatter; ordinary identifiers pass through untouched.
  it('shortens ambiguity-aware UUID and typed-ref routes', () => {
    expect(shortRouteId('e4c52737-40e4-472a-8367-fbdbe97801a2')).toBe('e4c52737');
    expect(shortRouteId(`briefing:${'a'.repeat(64)}`)).toBe('briefing:aaaaaaa');
    expect(shortRouteId(`briefing-round:${'b'.repeat(64)}`)).toBe('briefing-round:bbbbbbb');
    expect(shortRouteId('prj_00mpmto02f_ec55d4e21bfe5ce116fb')).toBe('prj_00mp');
    expect(shortRouteId('e4c52737')).toBe('e4c52737');
    expect(shortRouteId('req-active-1')).toBe('req-active-1');
    expect(shortRouteId('codex-e4c52737-40e4-472a-8367-fbdbe97801a2')).toBe(
      'codex-e4c52737-40e4-472a-8367-fbdbe97801a2',
    );
  });

  it('generates a short canonical Spaces route without dropping unrelated state', () => {
    expect(spacesRouteFromHash(
      '#/spaces?sidebar=hidden&agent_session=01a02175&filter=open',
      {
        projectId: 'prj_00mpmto02f_ec55d4e21bfe5ce116fb',
        projectKey: 'rlrmp',
        spaceId: '7038d21f-b494-47fb-b9b8-d5fb93b3309a',
        renderer: null,
      },
    )).toBe('#/spaces?sidebar=hidden&agent_session=01a02175&filter=open&project=rlrmp&space=7038d21f');
  });

  it('generates a canonical Briefing group route from its active key', () => {
    expect(briefingGroupRoute('policy-health'))
      .toBe('/#/briefing?group=policy-health');
  });

  it('navigates only for supported mandible deep links', () => {
    const navigate = vi.fn();

    expect(navigateToMandibleDeepLink('mandible:///issues?issue=dfc924a', navigate)).toBe(true);
    expect(navigate).toHaveBeenCalledWith('#/issues?issue=dfc924a');

    expect(navigateToMandibleDeepLink('mandible:///issues', navigate)).toBe(false);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('adopts and preserves agent_session in Tauri deep-link navigation after boot', () => {
    __resetAgentPageBindingForTests();
    try {
      const navigate = vi.fn();

      expect(
        navigateToMandibleDeepLink(
          'mandible:///auth?request=e4c52737&agent_session=0198c0de',
          navigate,
        ),
      ).toBe(true);
      expect(navigate).toHaveBeenCalledWith('#/auth?request=e4c52737&agent_session=0198c0de');
      expect(getAgentPageBinding()).toBe('0198c0de');

      // A later deep link's binding replaces the current one (display-only).
      expect(
        navigateToMandibleDeepLink(
          'mandible:///issues?issue=dfc924a&agent_session=aaaabbbb',
          navigate,
        ),
      ).toBe(true);
      expect(navigate).toHaveBeenCalledWith('#/issues?issue=dfc924a&agent_session=aaaabbbb');
      expect(getAgentPageBinding()).toBe('aaaabbbb');

      // A deep link without the param never clears the binding.
      expect(navigateToMandibleDeepLink('mandible:///issues?issue=dfc924a', navigate)).toBe(true);
      expect(getAgentPageBinding()).toBe('aaaabbbb');
    } finally {
      __resetAgentPageBindingForTests();
    }
  });

  it('enables Tauri deep-link APIs for the daemon-served loopback dashboard', () => {
    const capability = JSON.parse(
      readFileSync('src-tauri/capabilities/default.json', 'utf8'),
    ) as { remote?: { urls?: string[] }; permissions?: string[] };

    expect(capability.remote?.urls).toEqual([PRODUCTION_ORIGIN]);
    expect(capability.permissions).toContain('deep-link:default');
  });

  it('registers one listener for issue, auth, and artifact links before reading the cold-start URL', async () => {
    const calls: string[] = [];
    const cleanup = vi.fn(() => calls.push('cleanup'));
    const onOpenUrl = vi.fn(async (handler: (urls: string[]) => void) => {
      calls.push('listen');
      handler(['mandible:///issues?repo=mandible&issue=warm']);
      handler(['mandible:///auth?request=warm']);
      handler(['mandible:///artifacts?ref=artifact-version%3Awarm']);
      return cleanup;
    });
    const getCurrent = vi.fn(async () => {
      calls.push('current');
      return ['mandible:///issues?issue=cold'];
    });
    (window as Window & { __TAURI__?: unknown }).__TAURI__ = {};

    const navigate = vi.fn((hash: string) => calls.push(`navigate:${hash}`));
    const removeListener = await installTauriDeepLinkHandler(navigate, { getCurrent, onOpenUrl });

    expect(calls).toEqual([
      'listen',
      'navigate:#/issues?issue=warm&repo=mandible',
      'navigate:#/auth?request=warm',
      'navigate:#/artifacts?ref=artifact-version%3Awarm',
      'current',
      'navigate:#/issues?issue=cold',
    ]);
    expect(onOpenUrl).toHaveBeenCalledOnce();
    expect(getCurrent).toHaveBeenCalledOnce();

    removeListener();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  // Agent-session adoption works on both cold and warm Tauri handoff paths,
  // and each route retains the supplied parameter.
  it('adopts agent_session bindings from both cold and warm Tauri handoff paths', async () => {
    __resetAgentPageBindingForTests();
    try {
      let warmHandler: ((urls: string[]) => void) | undefined;
      const onOpenUrl = vi.fn(async (handler: (urls: string[]) => void) => {
        warmHandler = handler;
        return () => undefined;
      });
      const getCurrent = vi.fn(async () => [
        'mandible:///auth?request=cold-req&agent_session=cold-binding',
      ]);
      (window as Window & { __TAURI__?: unknown }).__TAURI__ = {};

      const navigate = vi.fn();
      await installTauriDeepLinkHandler(navigate, { getCurrent, onOpenUrl });

      expect(navigate).toHaveBeenCalledWith('#/auth?request=cold-req&agent_session=cold-binding');
      expect(getAgentPageBinding()).toBe('cold-binding');

      warmHandler?.(['mandible:///auth?request=warm-req&agent_session=warm-binding']);
      expect(navigate).toHaveBeenCalledWith('#/auth?request=warm-req&agent_session=warm-binding');
      expect(getAgentPageBinding()).toBe('warm-binding');
    } finally {
      __resetAgentPageBindingForTests();
    }
  });
});

describe('app shell', () => {
  function RegisteredSidebar(): JSX.Element {
    const descriptor = useMemo<AppRightSidebarDescriptor>(() => ({
      id: 'test-panel',
      kind: 'panel',
      title: 'inspector',
      ariaLabel: 'Test inspector',
      open: true,
      width: 360,
      onOpenChange: () => undefined,
      onWidthChange: () => undefined,
      content: h('div', {}, 'Inspector content'),
    }), []);

    useRegisterAppRightSidebar(descriptor);
    return h('main', {}, 'Workspace');
  }

  function ShellProbe(): JSX.Element {
    const [rightSidebar, setRightSidebar] = useState<AppRightSidebarDescriptor | null>(null);
    const ownerRef = useRef<string | null>(null);
    const registerRightSidebar = useCallback((ownerId: string) => {
      ownerRef.current = ownerId;
      return () => setRightSidebar((current) => (current?.id === ownerId ? null : current));
    }, []);
    const updateRightSidebar = useCallback((ownerId: string, descriptor: AppRightSidebarDescriptor) => {
      if (ownerRef.current === ownerId) setRightSidebar(descriptor);
    }, []);
    const shell = useMemo<AppShellContextValue>(() => ({
      rightSidebar,
      registerRightSidebar,
      registerInitialRouteLoad: () => undefined,
      updateRightSidebar,
      setViewSidebarWidth: () => undefined,
      active: true,
    }), [rightSidebar, registerRightSidebar, updateRightSidebar]);

    return h(AppShellProvider, { value: shell }, [
      h('header', { className: 'app-header' }, [
        h('span', { className: 'app-header__brand-text' }, 'Mandible'),
        h('span', { className: 'app-header__route' }, 'Timeline'),
        rightSidebar?.content
          ? h('button', {
            type: 'button',
            'aria-label': rightSidebar.open ? `Hide ${rightSidebar.ariaLabel}` : `Show ${rightSidebar.ariaLabel}`,
            onClick: () => setRightSidebar({
              ...rightSidebar,
              open: !rightSidebar.open,
            }),
          }, h(RightSidebarIcon, {}))
          : null,
      ]),
      h(RegisteredSidebar, {}),
      rightSidebar?.open && rightSidebar.content
        ? h('aside', { className: 'app-right-sidebar', 'aria-label': rightSidebar.ariaLabel }, [
          h('div', { className: 'app-right-sidebar__content' }, rightSidebar.content),
        ])
        : null,
    ]);
  }

  it('keeps the page-local left shadow control present but fully inert and hidden', async () => {
    stubAppShellFetch();
    stubEventSource();
    __resetAgentPageBindingForTests();
    window.history.replaceState(null, '', '#/spaces');

    const absent = render(h(App, {}));
    expect(absent.container.querySelector('.app-rail__left-shadow-toggle')).toBeNull();
    absent.unmount();

    window.history.replaceState(null, '', '#/spaces?agent_session=toggle-session');
    adoptAgentSessionFragment();
    const present = render(h(App, {}));
    const toggle = present.container.querySelector<HTMLButtonElement>('.app-rail__left-shadow-toggle');
    const shell = present.container.querySelector('.app-shell');

    expect(toggle?.tagName).toBe('BUTTON');
    expect(toggle?.getAttribute('type')).toBe('button');
    expect(toggle?.getAttribute('aria-hidden')).toBe('true');
    expect(toggle?.tabIndex).toBe(-1);
    expect(toggle?.disabled).toBe(true);
    expect(shell?.classList.contains('app-shell--left-shadow')).toBe(false);

    fireEvent.click(screen.getByRole('link', { name: 'Settings' }));
    expect(window.location.hash).toBe('#/settings?agent_session=toggle-session');
    expect(Array.from({ length: window.localStorage.length }, (_, index) => (
      window.localStorage.key(index)
    )).filter((key) => key?.includes('left-shadow'))).toEqual([]);

    present.unmount();
    const remounted = render(h(App, {}));
    expect(remounted.container.querySelector<HTMLButtonElement>('.app-rail__left-shadow-toggle')
      ?.disabled).toBe(true);
    remounted.unmount();
    __resetAgentPageBindingForTests();
  });

  it('renders shared header identity, route title, and registered right sidebar toggle', async () => {
    render(h(ShellProbe, {}));

    expect(screen.getByText('Mandible')).toBeTruthy();
    expect(screen.getByText('Timeline')).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText('Hide Test inspector')).toBeTruthy());
    expect(screen.getByLabelText('Test inspector')).toBeTruthy();
    expect(screen.getByText('Inspector content')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Hide Test inspector'));
    expect(screen.getByLabelText('Show Test inspector')).toBeTruthy();
    expect(screen.queryByLabelText('Test inspector')).toBeNull();
  });

  it('reconciles legacy groups into one upper order and keeps Logs adjacent to Settings', async () => {
    installMemoryLocalStorage();
    const stored = JSON.stringify({
      version: 1,
      groups: {
        primary: ['issues', 'settings', 'console', 'issues', 'unknown', 'timeline', 'auth', 'artifacts', 'spaces', 'briefing', 'inbox'],
        secondary: ['logs', 'work', 'graph'],
      },
    });
    stubRailSettingsFetch(stored);
    stubEventSource();
    window.history.replaceState(null, '', '#/spaces');

    const { container } = render(h(App, {}));
    await waitFor(() => expect(railGroupLinks(container, 'primary')[0]?.dataset.railItem).toBe('issues'));

    expect(railGroupLinks(container, 'primary').map((link) => link.dataset.railItem)).toEqual([
      'issues', 'console', 'auth', 'artifacts', 'briefing', 'inbox', 'work', 'tasks',
    ]);
    expect(railGroupLinks(container, 'secondary').map((link) => link.dataset.railItem)).toEqual([
      'graph', 'timeline', 'spaces',
    ]);
    expect(container.querySelectorAll('.app-rail__group[data-rail-group="upper"]')).toHaveLength(1);
    expect(container.querySelectorAll('.app-rail__group[data-rail-group="experimental"]')).toHaveLength(1);
    const footer = screen.getByRole('link', { name: 'Settings' }).closest('.app-rail__footer');
    expect(footer).toBeTruthy();
    const fixedLinks = Array.from(footer?.querySelectorAll('a') ?? []);
    expect(fixedLinks.slice(-2).map((link) => link.getAttribute('aria-label'))).toEqual(['Logs', 'Settings']);
    for (const fixed of fixedLinks) {
      expect(fixed.hasAttribute('data-rail-item')).toBe(false);
      expect(fixed.hasAttribute('data-rail-group')).toBe(false);
      expect(fixed.hasAttribute('draggable')).toBe(false);
      expect(fixed.hasAttribute('aria-keyshortcuts')).toBe(false);
      expect(fixed.hasAttribute('aria-describedby')).toBe(false);
    }
    const css = readResolvedStylesheet();
    expect(css).not.toContain('.app-rail__group--secondary');
    expect(css).toContain('.app-rail__group {\n  display: flex;\n  flex-direction: column;\n  gap: 4px;');
    expect(screen.getByRole('link', { name: 'Spaces' }).getAttribute('aria-current')).toBe('page');
    await waitFor(() => expect(vi.mocked(fetch).mock.calls
      .some(([input]) => String(input) === '/api/dashboard/badges')).toBe(true));
    expect(screen.getByRole('link', { name: 'Briefing' })
      .querySelector('.app-rail__badge')).toBeNull();
  });

  it('refetches a same-user SSE revision and ignores an already-applied echo', async () => {
    installMemoryLocalStorage();
    const firstOrder = JSON.stringify({
      version: 1,
      groups: { primary: ['issues', 'console'], secondary: ['logs', 'work'] },
    });
    const secondOrder = JSON.stringify({
      version: 1,
      groups: { primary: ['briefing', 'console'], secondary: ['graph', 'work'] },
    });
    const settings = stubRailSettingsFetch(firstOrder);
    const events = stubEventSource();
    window.history.replaceState(null, '', '#/spaces');

    const { container } = render(h(App, {}));
    await waitFor(() => expect(railGroupLinks(container, 'primary')[0]?.dataset.railItem).toBe('issues'));
    expect(settings.getCalls).toHaveBeenCalledTimes(1);

    settings.setRemote(secondOrder, 2);
    act(() => events.emit({
      type: 'user-setting:updated',
      data: { version: 1, key: 'app_rail_order', revision: 2 },
    }));
    await waitFor(() => expect(railGroupLinks(container, 'primary')[0]?.dataset.railItem).toBe('briefing'));
    expect(railGroupLinks(container, 'primary').slice(0, 2).map((link) => link.dataset.railItem))
      .toEqual(['briefing', 'console']);
    expect(railGroupLinks(container, 'secondary')[0]?.dataset.railItem).toBe('graph');
    expect(settings.getCalls).toHaveBeenCalledTimes(2);

    act(() => events.emit({
      type: 'user-setting:updated',
      data: { version: 1, key: 'app_rail_order', revision: 1 },
    }));
    await act(async () => Promise.resolve());
    expect(settings.getCalls).toHaveBeenCalledTimes(2);
  });

  it('converges two simultaneous same-user clients on one event revision', async () => {
    installMemoryLocalStorage();
    const firstOrder = JSON.stringify({
      version: 1,
      groups: { primary: ['issues', 'console'], secondary: [] },
    });
    const secondOrder = JSON.stringify({
      version: 1,
      groups: { primary: ['graph', 'work'], secondary: [] },
    });
    const settings = stubRailSettingsFetch(firstOrder);
    const events = stubEventSource();
    window.history.replaceState(null, '', '#/spaces');
    const { container } = render(h('div', {}, h(App, {}), h(App, {})));
    const shells = Array.from(container.querySelectorAll<HTMLElement>('.app-shell'));
    expect(shells).toHaveLength(2);

    await waitFor(() => {
      expect(railGroupLinks(shells[0]!, 'primary')[0]?.dataset.railItem).toBe('issues');
      expect(railGroupLinks(shells[1]!, 'primary')[0]?.dataset.railItem).toBe('issues');
    });
    expect(settings.getCalls).toHaveBeenCalledTimes(2);

    settings.setRemote(secondOrder, 2);
    act(() => events.emit({
      type: 'user-setting:updated',
      data: { version: 1, key: 'app_rail_order', revision: 2 },
    }));
    await waitFor(() => {
      expect(railGroupLinks(shells[0]!, 'primary')[0]?.dataset.railItem).toBe('work');
      expect(railGroupLinks(shells[1]!, 'primary')[0]?.dataset.railItem).toBe('work');
      expect(railGroupLinks(shells[0]!, 'secondary')[0]?.dataset.railItem).toBe('timeline');
      expect(railGroupLinks(shells[1]!, 'secondary')[0]?.dataset.railItem).toBe('timeline');
    });
    expect(settings.getCalls).toHaveBeenCalledTimes(4);
  });

  it('refetches the authenticated row when a missed-event client becomes visible again', async () => {
    installMemoryLocalStorage();
    const firstOrder = JSON.stringify({
      version: 1,
      groups: { primary: ['issues', 'console'], secondary: [] },
    });
    const secondOrder = JSON.stringify({
      version: 1,
      groups: { primary: ['tasks', 'spaces'], secondary: [] },
    });
    const settings = stubRailSettingsFetch(firstOrder);
    stubEventSource();
    window.history.replaceState(null, '', '#/spaces');
    const { container } = render(h(App, {}));

    await waitFor(() => expect(railGroupLinks(container, 'primary')[0]?.dataset.railItem).toBe('issues'));
    expect(settings.getCalls).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    settings.setRemote(secondOrder, 2);
    fireEvent(document, new Event('visibilitychange'));
    expect(settings.getCalls).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => expect(railGroupLinks(container, 'primary')[0]?.dataset.railItem).toBe('tasks'));
    expect(settings.getCalls).toHaveBeenCalledTimes(2);
  });

  it('converges from the authenticated row during disconnected-stream recovery polling', async () => {
    vi.useFakeTimers();
    installMemoryLocalStorage();
    const firstOrder = JSON.stringify({
      version: 1,
      groups: { primary: ['issues', 'console'], secondary: [] },
    });
    const secondOrder = JSON.stringify({
      version: 1,
      groups: { primary: ['tasks', 'spaces'], secondary: [] },
    });
    const settings = stubRailSettingsFetch(firstOrder);
    stubEventSource();
    window.history.replaceState(null, '', '#/spaces');
    const { container } = render(h(App, {}));

    await vi.waitFor(() => {
      expect(railGroupLinks(container, 'primary')[0]?.dataset.railItem).toBe('issues');
    });
    expect(settings.getCalls).toHaveBeenCalledTimes(1);

    settings.setRemote(secondOrder, 2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(railGroupLinks(container, 'primary')[0]?.dataset.railItem).toBe('tasks');
    expect(settings.getCalls).toHaveBeenCalledTimes(2);
  });

  it('quarantines legacy global and browser-cached rail order bytes', async () => {
    const staleOrder = JSON.stringify({
      version: 1,
      groups: { primary: ['briefing'], secondary: [] },
    });
    installMemoryLocalStorage({
      mandible_state_cache: JSON.stringify({
        v: 2,
        state: { settings: { app_theme: 'codex', app_rail_order: staleOrder } },
      }),
    });

    expect(loadCachedState().settings).toEqual({ app_theme: 'codex' });
    saveCachedState({
      ...initialState,
      settings: { app_theme: 'codex', app_rail_order: staleOrder },
    });
    expect(JSON.parse(window.localStorage.getItem('mandible_state_cache') ?? '{}')
      .state.settings).toEqual({ app_theme: 'codex' });

    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      app_theme: 'codex',
      app_rail_order: staleOrder,
    }), { headers: { 'content-type': 'application/json' } }))));
    invalidateApiGetCache();
    await expect(getSettings()).resolves.toEqual({ app_theme: 'codex' });
  });

  it('does not let a stale SSE refetch overwrite a newer local mutation', async () => {
    installMemoryLocalStorage();
    (window as Window & { __MANDIBLE_BOOTSTRAP__?: { instance: InstanceInfo } }).__MANDIBLE_BOOTSTRAP__ = {
      instance: writablePreviewInstance,
    };
    let userGetCount = 0;
    let resolvePut!: (response: Response) => void;
    let resolveStaleGet!: (response: Response) => void;
    const putResponse = new Promise<Response>((resolve) => { resolvePut = resolve; });
    const staleGetResponse = new Promise<Response>((resolve) => { resolveStaleGet = resolve; });
    let localValue = '';
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/settings') {
        return Promise.resolve(new Response(JSON.stringify({}), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      if (url === '/api/user-settings/app_rail_order' && init?.method !== 'PUT') {
        userGetCount += 1;
        if (userGetCount === 1) {
          return Promise.resolve(new Response(JSON.stringify({
            version: 1,
            key: 'app_rail_order',
            value: null,
            revision: 1,
          }), { headers: { 'content-type': 'application/json' } }));
        }
        return staleGetResponse;
      }
      if (url === '/api/user-settings/app_rail_order' && init?.method === 'PUT') {
        localValue = (JSON.parse(String(init.body)) as { value: string }).value;
        return putResponse;
      }
      if (url === '/api/dashboard/badges') {
        return Promise.resolve(new Response(JSON.stringify({ auth: 0, briefing: 0, inbox: 0 }), {
          headers: { 'content-type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response(JSON.stringify([]), {
        headers: { 'content-type': 'application/json' },
      }));
    }));
    const events = stubEventSource();
    window.history.replaceState(null, '', '#/spaces');
    const { container } = render(h(App, {}));
    await railReorderReady();

    const spaces = screen.getByRole('link', { name: 'Spaces' });
    spaces.focus();
    fireEvent.keyDown(spaces, { key: 'ArrowUp', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(localValue).toContain('"secondary":["timeline","spaces","graph"]'));
    act(() => events.emit({
      type: 'user-setting:updated',
      data: { version: 1, key: 'app_rail_order', revision: 2 },
    }));
    await waitFor(() => expect(userGetCount).toBe(2));

    await act(async () => {
      resolvePut(new Response(JSON.stringify({
        version: 1,
        key: 'app_rail_order',
        value: localValue,
        revision: 3,
      }), { headers: { 'content-type': 'application/json' } }));
      await putResponse;
    });
    await act(async () => {
      resolveStaleGet(new Response(JSON.stringify({
        version: 1,
        key: 'app_rail_order',
        value: JSON.stringify({
          version: 1,
          groups: { primary: ['issues', 'console'], secondary: ['logs', 'work'] },
        }),
        revision: 2,
      }), { headers: { 'content-type': 'application/json' } }));
      await staleGetResponse;
    });

    await waitFor(() => expect(railGroupLinks(container, 'primary')[0]?.dataset.railItem).toBe('console'));
    const finalOrder = railGroupLinks(container, 'secondary').map((link) => link.dataset.railItem);
    expect(finalOrder.indexOf('spaces')).toBeLessThan(finalOrder.indexOf('graph'));
  });

  it('fails an old settings envelope closed and inserts a returning destination canonically', async () => {
    installMemoryLocalStorage();
    __resetAgentPageBindingForTests();
    const stored = JSON.stringify({
      version: 0,
      groups: { primary: ['issues', 'console'], secondary: ['logs', 'work'] },
    });
    stubRailSettingsFetch(stored);
    stubEventSource();
    window.history.replaceState(null, '', '#/spaces');

    const { container } = render(h(App, {}));
    await waitFor(() => expect(railGroupLinks(container, 'primary')[0]?.dataset.railItem).toBe('console'));
    expect(railGroupLinks(container, 'primary').slice(-3).map((link) => link.dataset.railItem))
      .toEqual(['inbox', 'work', 'tasks']);
    expect(railGroupLinks(container, 'secondary').map((link) => link.dataset.railItem))
      .toEqual(['timeline', 'graph', 'spaces']);

    act(() => adoptAgentSessionBinding('returning-session'));
    await waitFor(() => expect(railGroupLinks(container, 'primary')[0]?.dataset.railItem).toBe('overview'));
    expect(railGroupLinks(container, 'primary')[1]?.dataset.railItem).toBe('console');
    __resetAgentPageBindingForTests();
  });

  it('keeps click navigation intact below the pointer movement threshold', async () => {
    installMemoryLocalStorage();
    installPointerEventForTest();
    const { putCalls } = stubRailSettingsFetch();
    stubEventSource();
    window.history.replaceState(null, '', '#/spaces');
    render(h(App, {}));
    const chat = await screen.findByRole('link', { name: 'Chat' });

    fireRailPointer(chat, 'pointerdown', { pointerId: 3, button: 2, clientX: 10, clientY: 10 });
    fireRailPointer(chat, 'pointermove', { pointerId: 3, button: 2, clientX: 80, clientY: 80 });
    fireRailPointer(chat, 'pointerup', { pointerId: 3, button: 2, clientX: 80, clientY: 80 });
    fireEvent.contextMenu(chat);
    let modifierClickPrevented = true;
    document.addEventListener('click', (event) => {
      modifierClickPrevented = event.defaultPrevented;
      event.preventDefault();
    }, { once: true });
    fireEvent.click(chat, { ctrlKey: true });
    expect(modifierClickPrevented).toBe(false);
    expect(window.location.hash).toBe('#/spaces');

    fireRailPointer(chat, 'pointerdown', { pointerId: 4, button: 0, clientX: 10, clientY: 10 });
    fireRailPointer(chat, 'pointermove', { pointerId: 4, clientX: 13, clientY: 12 });
    fireRailPointer(chat, 'pointerup', { pointerId: 4, clientX: 13, clientY: 12 });
    fireEvent.click(chat);

    expect(window.location.hash).toBe('#/console');
    expect(putCalls).not.toHaveBeenCalled();
  });

  it('removes the reorder toggle and fails closed until authenticated user settings hydrate', async () => {
    const browserCachedOrder = JSON.stringify({
      version: 1,
      groups: { primary: ['briefing', 'console'], secondary: ['logs', 'work'] },
    });
    installMemoryLocalStorage({
      mandible_state_cache: JSON.stringify({
        v: 2,
        state: { settings: { app_rail_order: browserCachedOrder } },
      }),
    });
    installPointerEventForTest();
    (window as Window & { __MANDIBLE_BOOTSTRAP__?: { instance: InstanceInfo } }).__MANDIBLE_BOOTSTRAP__ = {
      instance: writablePreviewInstance,
    };
    let resolveUserSetting!: (response: Response) => void;
    const userSettingResponse = new Promise<Response>((resolve) => {
      resolveUserSetting = resolve;
    });
    const putCalls = vi.fn();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/settings') return Promise.resolve(new Response(JSON.stringify({
        app_rail_order: browserCachedOrder,
      }), { headers: { 'content-type': 'application/json' } }));
      if (url === '/api/user-settings/app_rail_order' && init?.method !== 'PUT') {
        return userSettingResponse;
      }
      if (url === '/api/user-settings/app_rail_order' && init?.method === 'PUT') {
        putCalls(input, init);
        return Promise.resolve(new Response(JSON.stringify({
          version: 1,
          key: 'app_rail_order',
          value: (JSON.parse(String(init.body)) as { value: string }).value,
          revision: 1,
        }), { headers: { 'content-type': 'application/json' } }));
      }
      if (url === '/api/dashboard/badges') {
        return Promise.resolve(new Response(JSON.stringify({ auth: 0, briefing: 0, inbox: 0 })));
      }
      return Promise.resolve(new Response(JSON.stringify([])));
    }));
    stubEventSource();
    window.history.replaceState(null, '', '#/spaces');
    render(h(App, {}));

    expect(screen.queryByRole('button', { name: 'Reorder navigation' })).toBeNull();
    expect(screen.getAllByRole('link')[0]?.getAttribute('data-rail-item')).toBe('console');
    const chat = screen.getByRole('link', { name: 'Chat' });
    fireRailPointer(chat, 'pointerdown', { pointerId: 12, button: 0, clientX: 10, clientY: 10 });
    fireRailPointer(chat, 'pointermove', { pointerId: 12, clientX: 80, clientY: 80 });
    fireRailPointer(chat, 'pointerup', { pointerId: 12, clientX: 80, clientY: 80 });
    expect(putCalls).not.toHaveBeenCalled();

    await act(async () => {
      resolveUserSetting(new Response(JSON.stringify({
        version: 1,
        key: 'app_rail_order',
        value: null,
        revision: 0,
      }), {
        headers: { 'content-type': 'application/json' },
      }));
      await userSettingResponse;
    });
    await railReorderReady();
    expect(putCalls).not.toHaveBeenCalled();
  });

  it('does not read or mutate user rail settings when capability is unknown', async () => {
    installMemoryLocalStorage();
    const fetchMock = vi.fn((input: RequestInfo | URL) => Promise.resolve(new Response(
      String(input) === '/api/settings' ? JSON.stringify({}) : JSON.stringify([]),
      { headers: { 'content-type': 'application/json' } },
    )));
    vi.stubGlobal('fetch', fetchMock);
    stubEventSource();
    window.history.replaceState(null, '', '#/spaces');
    render(h(App, {}));

    const spaces = await screen.findByRole('link', { name: 'Spaces' });
    spaces.focus();
    fireEvent.keyDown(spaces, { key: 'ArrowUp', ctrlKey: true, shiftKey: true });
    await act(async () => Promise.resolve());
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith('/api/user-settings/'))).toBe(false);
  });

  it('does not infer reject-mode fallback from an authenticated-settings 403', async () => {
    installMemoryLocalStorage();
    (window as Window & { __MANDIBLE_BOOTSTRAP__?: { instance: InstanceInfo } }).__MANDIBLE_BOOTSTRAP__ = {
      instance: writablePreviewInstance,
    };
    const putCalls = vi.fn();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/user-settings/app_rail_order' && init?.method !== 'PUT') {
        return Promise.resolve(new Response(JSON.stringify({
          error: 'Forbidden',
          code: 'forbidden',
        }), { status: 403, headers: { 'content-type': 'application/json' } }));
      }
      if (url === '/api/user-settings/app_rail_order' && init?.method === 'PUT') {
        putCalls(input, init);
      }
      if (url === '/api/settings') {
        return Promise.resolve(new Response(JSON.stringify({
          app_rail_order: JSON.stringify({
            version: 1,
            groups: { primary: ['issues', 'console'], secondary: ['logs', 'work'] },
          }),
        }), { headers: { 'content-type': 'application/json' } }));
      }
      return Promise.resolve(new Response(JSON.stringify([]), {
        headers: { 'content-type': 'application/json' },
      }));
    }));
    stubEventSource();
    window.history.replaceState(null, '', '#/spaces');
    const { container } = render(h(App, {}));

    await waitFor(() => expect(railGroupLinks(container, 'primary')[0]?.dataset.railItem).toBe('console'));
    const spaces = screen.getByRole('link', { name: 'Spaces' });
    fireEvent.keyDown(spaces, { key: 'ArrowUp', ctrlKey: true, shiftKey: true });
    await act(async () => Promise.resolve());
    expect(putCalls).not.toHaveBeenCalled();
    expect(railGroupLinks(container, 'primary')[0]?.dataset.railItem).toBe('console');
  });

  it('pointer-reorders inside one group, suppresses the drag click, and cancels cleanly', async () => {
    installMemoryLocalStorage();
    installPointerEventForTest();
    const { putCalls } = stubRailSettingsFetch();
    stubEventSource();
    window.history.replaceState(null, '', '#/spaces');
    const mounted = render(h(App, {}));
    await railReorderReady();
    const primary = railGroupLinks(mounted.container, 'primary');
    mockRailRects(primary);
    const briefing = primary.find((link) => link.dataset.railItem === 'briefing')!;
    const capture = vi.fn();
    briefing.setPointerCapture = capture;

    fireRailPointer(briefing, 'pointerdown', { pointerId: 8, button: 0, clientX: 12, clientY: 250 });
    expect(capture).toHaveBeenCalledWith(8);
    fireRailPointer(briefing, 'pointermove', { pointerId: 8, clientX: 12, clientY: 1 });
    expect(briefing.classList.contains('app-rail__item--dragging')).toBe(true);
    fireRailPointer(briefing, 'pointerup', { pointerId: 8, clientX: 12, clientY: 1 });
    fireEvent.click(briefing);

    await waitFor(() => expect(putCalls).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(railGroupLinks(mounted.container, 'primary')[0]?.dataset.railItem).toBe('briefing'));
    expect(window.location.hash).toBe('#/spaces');
    expect(railGroupLinks(mounted.container, 'primary').slice(-3).map((link) => link.dataset.railItem))
      .toEqual(['inbox', 'work', 'tasks']);
    expect(screen.getByRole('link', { name: 'Logs' }).hasAttribute('data-rail-item')).toBe(false);

    const inbox = railGroupLinks(mounted.container, 'primary').find((link) => link.dataset.railItem === 'inbox')!;
    mockRailRects(railGroupLinks(mounted.container, 'primary'));
    fireRailPointer(inbox, 'pointerdown', { pointerId: 9, button: 0, clientX: 12, clientY: 250 });
    fireRailPointer(inbox, 'pointermove', { pointerId: 9, clientX: 12, clientY: 1 });
    fireRailPointer(inbox, 'pointercancel', { pointerId: 9 });
    expect(railGroupLinks(mounted.container, 'primary')[0]?.dataset.railItem).toBe('briefing');
    expect(putCalls).toHaveBeenCalledTimes(1);
  });

  it('keeps Logs and every footer utility outside pointer and keyboard reorder contracts', async () => {
    installMemoryLocalStorage();
    installPointerEventForTest();
    const settings = stubRailSettingsFetch();
    stubEventSource();
    window.history.replaceState(null, '', '#/spaces');
    const { container } = render(h(App, {}));
    await railReorderReady();
    const before = railGroupLinks(container, 'primary').map((link) => link.dataset.railItem);
    const footer = container.querySelector<HTMLElement>('.app-rail__footer')!;
    const fixedControls = Array.from(footer.querySelectorAll<HTMLElement>('a, button'));

    for (const control of fixedControls) {
      expect(control.hasAttribute('data-rail-item')).toBe(false);
      expect(control.hasAttribute('data-rail-group')).toBe(false);
      expect(control.hasAttribute('draggable')).toBe(false);
      expect(control.hasAttribute('aria-keyshortcuts')).toBe(false);
      expect(control.hasAttribute('aria-describedby')).toBe(false);
    }

    const logs = screen.getByRole('link', { name: 'Logs' });
    fireRailPointer(logs, 'pointerdown', { pointerId: 31, button: 0, clientX: 12, clientY: 100 });
    fireRailPointer(logs, 'pointermove', { pointerId: 31, clientX: 12, clientY: 1 });
    fireRailPointer(logs, 'pointerup', { pointerId: 31, clientX: 12, clientY: 1 });
    fireEvent.keyDown(logs, { key: 'ArrowUp', ctrlKey: true, shiftKey: true });
    await act(async () => Promise.resolve());

    expect(settings.putCalls).not.toHaveBeenCalled();
    expect(logs.classList.contains('app-rail__item--dragging')).toBe(false);
    expect(railGroupLinks(container, 'primary').map((link) => link.dataset.railItem)).toEqual(before);
  });

  it('keeps repeated pointer frames over one captured target from undoing the drop', async () => {
    const ignoredPreviewOrder = JSON.stringify({
      version: 1,
      groups: { primary: ['briefing', 'console'], secondary: ['logs', 'work'] },
    });
    installMemoryLocalStorage({ [APP_RAIL_PREVIEW_ORDER_STORAGE_KEY]: ignoredPreviewOrder });
    installPointerEventForTest();
    (window as Window & { __MANDIBLE_BOOTSTRAP__?: { instance: InstanceInfo } }).__MANDIBLE_BOOTSTRAP__ = {
      instance: writablePreviewInstance,
    };
    const settings = stubRailSettingsFetch();
    stubEventSource();
    window.history.replaceState(null, '', '#/spaces');
    const mounted = render(h(App, {}));
    await railReorderReady();
    const primary = railGroupLinks(mounted.container, 'primary');
    expect(primary[0]?.dataset.railItem).toBe('console');
    mockRailRects(primary);
    const chat = primary.find((link) => link.dataset.railItem === 'console')!;

    fireRailPointer(chat, 'pointerdown', { pointerId: 18, button: 0, clientX: 12, clientY: 1 });
    fireRailPointer(chat, 'pointermove', { pointerId: 18, clientX: 12, clientY: 45 });
    fireRailPointer(chat, 'pointermove', { pointerId: 18, clientX: 12, clientY: 45 });
    fireRailPointer(chat, 'pointermove', { pointerId: 18, clientX: 12, clientY: 1 });
    fireRailPointer(chat, 'pointermove', { pointerId: 18, clientX: 12, clientY: 45 });
    fireRailPointer(chat, 'pointerup', { pointerId: 18, clientX: 12, clientY: 45 });

    await waitFor(() => expect(settings.putCalls).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(railGroupLinks(mounted.container, 'primary').slice(0, 2)
      .map((link) => link.dataset.railItem)).toEqual(['auth', 'console']));

    // The optimistic order precedes persistence; start the next drag only after its save completes.
    await waitFor(() => expect(within(screen.getByRole('navigation', { name: 'Main navigation' }))
      .getByRole('status').textContent).toContain('Chat moved to position'));

    const unifiedUpper = railGroupLinks(mounted.container, 'primary');
    mockRailRects(unifiedUpper);
    const projects = unifiedUpper.find((link) => link.dataset.railItem === 'work')!;
    fireRailPointer(projects, 'pointerdown', { pointerId: 19, button: 0, clientX: 12, clientY: 250 });
    fireRailPointer(projects, 'pointermove', { pointerId: 19, clientX: 12, clientY: 1 });
    fireRailPointer(projects, 'pointermove', { pointerId: 19, clientX: 12, clientY: 1 });
    fireRailPointer(projects, 'pointerup', { pointerId: 19, clientX: 12, clientY: 1 });

    await waitFor(() => expect(settings.putCalls).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(railGroupLinks(mounted.container, 'primary').slice(0, 3)
      .map((link) => link.dataset.railItem)).toEqual(['work', 'auth', 'console']));

    fireEvent.click(screen.getByRole('link', { name: 'Approvals' }));
    await waitFor(() => expect(window.location.hash).toBe('#/auth'));
    expect(railGroupLinks(mounted.container, 'primary').slice(0, 3)
      .map((link) => link.dataset.railItem)).toEqual(['work', 'auth', 'console']);

    mounted.unmount();
    window.history.replaceState(null, '', '#/spaces');
    const remounted = render(h(App, {}));
    await waitFor(() => expect(railGroupLinks(remounted.container, 'primary').slice(0, 3)
      .map((link) => link.dataset.railItem)).toEqual(['work', 'auth', 'console']));
    expect(settings.getStored()).toContain('"primary":["work","auth","console"');
    expect(settings.getStored()).toContain('"secondary":["timeline","graph","spaces"]');
    expect(settings.getStored()).not.toContain('"logs"');
    expect(window.localStorage.getItem(APP_RAIL_PREVIEW_ORDER_STORAGE_KEY)).toBe(ignoredPreviewOrder);
  });

  it('ignores a malformed preview override and skips durable settings under explicit reject', async () => {
    installMemoryLocalStorage({
      [APP_RAIL_PREVIEW_ORDER_STORAGE_KEY]: JSON.stringify({
        version: 1,
        groups: { primary: 'issues', secondary: [] },
      }),
    });
    (window as Window & { __MANDIBLE_BOOTSTRAP__?: { instance: InstanceInfo } }).__MANDIBLE_BOOTSTRAP__ = {
      instance: previewInstance,
    };
    const serverOrder = JSON.stringify({
      version: 1,
      groups: { primary: ['issues', 'console'], secondary: ['logs', 'work'] },
    });
    const settings = stubRailSettingsFetch(serverOrder);
    stubEventSource();
    window.history.replaceState(null, '', '#/spaces');
    const { container } = render(h(App, {}));

    await waitFor(() => expect(railGroupLinks(container, 'primary')[0]?.dataset.railItem).toBe('console'));
    expect(railGroupLinks(container, 'primary').slice(-3).map((link) => link.dataset.railItem))
      .toEqual(['inbox', 'work', 'tasks']);
    expect(settings.getCalls).not.toHaveBeenCalled();
    expect(settings.putCalls).not.toHaveBeenCalled();
  });

  it('persists physical pointer reorder locally only for an explicit reject preview', async () => {
    installMemoryLocalStorage();
    installPointerEventForTest();
    (window as Window & { __MANDIBLE_BOOTSTRAP__?: { instance: InstanceInfo } }).__MANDIBLE_BOOTSTRAP__ = {
      instance: previewInstance,
    };
    const settings = stubRailSettingsFetch(undefined, true);
    stubEventSource();
    window.history.replaceState(null, '', '#/spaces');
    const mounted = render(h(App, {}));
    await railReorderReady();
    const primary = railGroupLinks(mounted.container, 'primary');
    mockRailRects(primary);
    const chat = primary.find((link) => link.dataset.railItem === 'console')!;

    fireRailPointer(chat, 'pointerdown', { pointerId: 20, button: 0, clientX: 12, clientY: 1 });
    fireRailPointer(chat, 'pointermove', { pointerId: 20, clientX: 12, clientY: 45 });
    fireRailPointer(chat, 'pointermove', { pointerId: 20, clientX: 12, clientY: 45 });
    fireRailPointer(chat, 'pointerup', { pointerId: 20, clientX: 12, clientY: 45 });

    await waitFor(() => expect(railGroupLinks(mounted.container, 'primary').slice(0, 2)
      .map((link) => link.dataset.railItem)).toEqual(['auth', 'console']));
    expect(settings.putCalls).not.toHaveBeenCalled();
    expect(JSON.parse(window.localStorage.getItem(APP_RAIL_PREVIEW_ORDER_STORAGE_KEY) ?? '{}')).toEqual({
      version: 1,
      groups: {
        primary: ['auth', 'console', 'issues', 'artifacts', 'briefing', 'inbox', 'work', 'tasks'],
        secondary: ['timeline', 'graph', 'spaces'],
      },
    });

    fireEvent.click(screen.getByRole('link', { name: 'Approvals' }));
    await waitFor(() => expect(window.location.hash).toBe('#/auth'));
    expect(railGroupLinks(mounted.container, 'primary').slice(0, 2)
      .map((link) => link.dataset.railItem)).toEqual(['auth', 'console']);

    mounted.unmount();
    window.history.replaceState(null, '', '#/spaces');
    const remounted = render(h(App, {}));
    await waitFor(() => expect(railGroupLinks(remounted.container, 'primary').slice(0, 2)
      .map((link) => link.dataset.railItem)).toEqual(['auth', 'console']));
  });

  it('direct keyboard reorder retains focus, announces, persists, and hydrates after remount', async () => {
    installMemoryLocalStorage();
    const settings = stubRailSettingsFetch();
    stubEventSource();
    window.history.replaceState(null, '', '#/spaces');
    const first = render(h(App, {}));
    await railReorderReady();
    const spaces = await screen.findByRole('link', { name: 'Spaces' });
    spaces.focus();

    fireEvent.keyDown(spaces, { key: 'ArrowUp', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(settings.putCalls).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('Spaces'));
    const movedSpaces = screen.getByRole('link', { name: 'Spaces' });
    expect(document.activeElement).toBe(movedSpaces);
    await waitFor(() => expect(within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('status').textContent).toContain('Spaces moved to position'));
    const persistedOrder = railGroupLinks(first.container, 'secondary').map((link) => link.dataset.railItem);
    expect(persistedOrder.indexOf('spaces')).toBeLessThan(persistedOrder.indexOf('graph'));

    first.unmount();
    window.history.replaceState(null, '', '#/spaces');
    const remounted = render(h(App, {}));
    await waitFor(() => expect(railGroupLinks(remounted.container, 'secondary').map((link) => link.dataset.railItem))
      .toEqual(persistedOrder));
    expect(settings.getStored()).toContain('"version":1');
  });

  it('does not hijack ordinary arrows or Enter activation and exposes no visual mode gate', async () => {
    installMemoryLocalStorage();
    const settings = stubRailSettingsFetch();
    stubEventSource();
    window.history.replaceState(null, '', '#/spaces');
    render(h(App, {}));
    await railReorderReady();
    const spaces = screen.getByRole('link', { name: 'Spaces' });
    spaces.focus();
    fireEvent.keyDown(spaces, { key: 'ArrowUp' });
    expect(settings.putCalls).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /reorder navigation/i })).toBeNull();
    fireEvent.keyDown(spaces, { key: 'Enter' });
    fireEvent.click(spaces);
    await waitFor(() => expect(window.location.hash).toBe('#/spaces'));
    expect(settings.putCalls).not.toHaveBeenCalled();
  });

  it('restores server-authoritative order and announces a failed mutation', async () => {
    installMemoryLocalStorage();
    const settings = stubRailSettingsFetch(undefined, true);
    stubEventSource();
    window.history.replaceState(null, '', '#/spaces');
    const { container } = render(h(App, {}));
    await railReorderReady();
    const original = railGroupLinks(container, 'secondary').map((link) => link.dataset.railItem);
    const spaces = screen.getByRole('link', { name: 'Spaces' });
    spaces.focus();
    fireEvent.keyDown(spaces, { key: 'ArrowUp', ctrlKey: true, shiftKey: true });

    await waitFor(() => expect(within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('status').textContent)
      .toBe('Navigation order was not saved. The previous order has been restored.'));
    expect(railGroupLinks(container, 'secondary').map((link) => link.dataset.railItem)).toEqual(original);
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('Spaces'));
    expect(settings.putCalls).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(APP_RAIL_PREVIEW_ORDER_STORAGE_KEY)).toBeNull();
  });

  it('aligns shared header text to the sidebar column and centers the route segment', () => {
    stubAppShellFetch();
    stubEventSource();
    window.history.replaceState(null, '', '#/briefing');

    const { container } = render(h(App, {}));
    const css = readResolvedStylesheet();
    const identity = container.querySelector('.app-header__identity');
    const text = identity?.querySelector(':scope > .app-header__text');

    expect(text?.querySelector(':scope > .app-header__brand')).toBeTruthy();
    expect(text?.querySelector(':scope > .app-header__route')?.textContent).toBe('Briefing');
    expect(css).toMatch(/\.app-header__identity\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*var\(--app-rail-width\) minmax\(0, 1fr\);[^}]*align-items:\s*center;/s);
    expect(css).toMatch(/\.app-header__text\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*max-content minmax\(0, 1fr\);[^}]*align-items:\s*baseline;[^}]*padding-left:\s*14px;/s);
    expect(css).toMatch(/\.app-header__brand\s*\{[^}]*align-items:\s*baseline;/s);
    expect(css).toMatch(/\.app-header__mark\s*\{[^}]*align-self:\s*center;/s);
    expect(css).toMatch(/\.app-header__route\s*\{[^}]*grid-column:\s*2;[^}]*justify-self:\s*stretch;[^}]*text-align:\s*center;/s);
  });

  it('couples the Briefing and Issues header edge to the active persisted sidebar width', async () => {
    const restoreLocalStorage = installMemoryLocalStorage({
      'sidebar-width:briefing': '412',
      'sidebar-width:issues': '444',
    });
    stubAppShellFetch();
    stubEventSource();
    window.history.replaceState(null, '', '#/briefing');

    const first = render(h(App, {}));
    const shell = first.container.querySelector<HTMLElement>('.app-shell');
    const header = first.container.querySelector<HTMLElement>('.app-header');
    expect(shell?.style.getPropertyValue('--app-view-sidebar-persisted-width')).toBe('412px');
    const briefingSidebar = await screen.findByLabelText('Briefings');
    const briefingResize = screen.getByLabelText('Resize Briefings sidebar');

    expect(shell?.classList.contains('app-shell--view-sidebar-open')).toBe(true);
    expect((briefingSidebar as HTMLElement).style.width).toBe('var(--app-view-sidebar-width)');
    mockLeftChromeRects(shell!, header!, briefingSidebar as HTMLElement);
    expect(header!.getBoundingClientRect().right).toBe(
      (briefingSidebar as HTMLElement).getBoundingClientRect().right,
    );
    expect(header?.classList.contains('app-header--sidebar-hidden')).toBe(false);

    fireEvent.mouseDown(briefingResize, { clientX: 412 });
    fireEvent.mouseMove(document, { clientX: 428 });
    await waitFor(() => {
      expect(shell?.style.getPropertyValue('--app-view-sidebar-persisted-width')).toBe('428px');
    });
    fireEvent.mouseUp(document);
    mockLeftChromeRects(shell!, header!, briefingSidebar as HTMLElement);
    expect(header!.getBoundingClientRect().right).toBe(
      (briefingSidebar as HTMLElement).getBoundingClientRect().right,
    );

    fireEvent.click(screen.getByLabelText('Issues'));
    await waitFor(() => expect(
      first.container.querySelector('.view-sidebar[aria-label="Issues"]'),
    ).toBeTruthy());
    const issuesSidebar = first.container.querySelector<HTMLElement>('.view-sidebar[aria-label="Issues"]');
    expect(shell?.style.getPropertyValue('--app-view-sidebar-persisted-width')).toBe('444px');
    expect(issuesSidebar?.style.width).toBe('var(--app-view-sidebar-width)');
    mockLeftChromeRects(shell!, header!, issuesSidebar);
    expect(header!.getBoundingClientRect().right).toBe(issuesSidebar!.getBoundingClientRect().right);

    fireEvent.click(screen.getByLabelText('Briefing'));
    await waitFor(() => {
      expect(shell?.style.getPropertyValue('--app-view-sidebar-persisted-width')).toBe('428px');
    });

    fireEvent.click(screen.getByLabelText('Hide view sidebar'));
    await waitFor(() => expect(screen.queryByLabelText('Briefings')).toBeNull());
    mockLeftChromeRects(shell!, header!, null);
    expect(header!.getBoundingClientRect().right).toBe(208);

    fireEvent.click(screen.getByLabelText('Show view sidebar'));
    const restoredBriefingSidebar = await screen.findByLabelText('Briefings');
    expect(shell?.style.getPropertyValue('--app-view-sidebar-persisted-width')).toBe('428px');
    mockLeftChromeRects(shell!, header!, restoredBriefingSidebar as HTMLElement);
    expect(header!.getBoundingClientRect().right).toBe(
      (restoredBriefingSidebar as HTMLElement).getBoundingClientRect().right,
    );

    setViewportWidth(700);
    mockLeftChromeRects(shell!, header!, restoredBriefingSidebar as HTMLElement);
    expect(header!.getBoundingClientRect().right).toBe(700);
    expect(header!.getBoundingClientRect().right).toBe(
      (restoredBriefingSidebar as HTMLElement).getBoundingClientRect().right,
    );
    setViewportWidth(1024);
    mockLeftChromeRects(shell!, header!, restoredBriefingSidebar as HTMLElement);
    expect(header!.getBoundingClientRect().right).toBe(
      (restoredBriefingSidebar as HTMLElement).getBoundingClientRect().right,
    );

    first.unmount();
    window.history.replaceState(null, '', '#/briefing');
    const refreshed = render(h(App, {}));
    await screen.findByLabelText('Briefings');
    expect(
      refreshed.container.querySelector<HTMLElement>('.app-shell')
        ?.style.getPropertyValue('--app-view-sidebar-persisted-width'),
    ).toBe('428px');

    const css = readResolvedStylesheet();
    expect(css).toMatch(/--app-view-sidebar-outer-width:\s*calc\(var\(--app-view-sidebar-width\) \+ var\(--app-shadow-gutter-width\)\);/s);
    expect(css).toMatch(/\.app-shell--view-sidebar-open \.app-header\s*\{[^}]*width:\s*calc\(var\(--app-left-boundary-width\) \+ var\(--app-rail-width\) \+ var\(--app-view-sidebar-outer-width\)\);/s);
    expect(css).toMatch(/\.app-shell--view-sidebar-open \.app-header__identity\s*\{[^}]*width:\s*calc\(100% - var\(--app-shadow-gutter-width\)\);/s);
    expect(css).toMatch(/@media \(max-width: 700px\)\s*\{\s*\.app-shell\s*\{\s*--app-view-sidebar-width:\s*calc\(100vw - var\(--app-left-boundary-width\) - var\(--app-rail-width\)\);/s);
    expect(css).toMatch(/\.view-sidebar\s*\{[^}]*position:\s*relative;/s);
    expect((await screen.findByLabelText('Briefings') as HTMLElement).style.width)
      .toBe('var(--app-view-sidebar-width)');
    expect(css).toMatch(/\.app-layout\s*\{[^}]*grid-template-columns:\s*calc\(var\(--app-left-boundary-width\) \+ var\(--app-rail-outer-width\)\) minmax\(0, 1fr\);/s);
    expect(css).toMatch(/\.app-layout--view-sidebar-open\s*\{[^}]*grid-template-columns:\s*calc\(var\(--app-left-boundary-width\) \+ var\(--app-rail-width\)\) minmax\(0, 1fr\);/s);
    expect(css).toMatch(/\.app-layout--view-sidebar-open \.view-sidebar\s*\{[^}]*padding-top:\s*var\(--app-left-chrome-height\);/s);

    restoreLocalStorage();
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
    const footer = container.querySelector('.app-rail__footer');
    const sidebarControls = container.querySelector('.app-rail__sidebar-controls');
    const header = container.querySelector('.app-header');

    expect(footer).toBeTruthy();
    expect(header?.classList.contains('app-header--sidebar-hidden')).toBe(true);
    expect(header?.querySelector('.app-header__mark')).toBeTruthy();
    expect(header?.querySelector('.app-header__brand-text')).toBeNull();
    expect(header?.querySelector('.app-header__route')).toBeNull();
    expect(sidebarControls?.parentElement).toBe(footer);
    expect(container.querySelector('.app-rail > .app-rail__sidebar-controls')).toBeNull();
    expect(screen.getByLabelText(/^App theme:/)).toBeTruthy();
    expect(container.querySelector('.app-rail__theme-toggle')).toBeTruthy();

    fireEvent.click(reveal);

    await waitFor(() => expect(screen.getByPlaceholderText('Filter issues...')).toBeTruthy());
    expect(window.location.hash).toBe('#/issues?repo=dotfiles&issue=e70757d');
  });

  it('persists Settings theme choices, applies root attributes, and follows system changes', async () => {
    stubEventSource();
    window.__MANDIBLE_BOOTSTRAP__ = { instance: mainInstance };
    window.history.replaceState(null, '', '#/settings');
    let storedTheme = 'system';
    let systemListener: (() => void) | null = null;
    const mediaQuery = {
      matches: false,
      media: '(prefers-color-scheme: dark)',
      onchange: null,
      addEventListener: vi.fn((_event: string, listener: () => void) => {
        systemListener = listener;
      }),
      removeEventListener: vi.fn((_event: string, listener: () => void) => {
        if (systemListener === listener) systemListener = null;
      }),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
    vi.stubGlobal('matchMedia', vi.fn(() => mediaQuery));
    const savedModes: string[] = [];
    let themeRevision = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/settings' && init?.method !== 'PUT') {
        return new Response(JSON.stringify({ app_theme: storedTheme }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === '/api/host-preferences/app-theme' && init?.method !== 'PUT') {
        return new Response(JSON.stringify({
          version: 1,
          key: 'app_theme',
          value: themeRevision === 0 ? null : storedTheme,
          revision: themeRevision,
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/host-preferences/app-theme' && init?.method === 'PUT') {
        storedTheme = (JSON.parse(String(init.body)) as { value: string }).value;
        themeRevision += 1;
        savedModes.push(storedTheme);
        return new Response(JSON.stringify({
          version: 1,
          key: 'app_theme',
          value: storedTheme,
          revision: themeRevision,
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/projects') {
        return new Response(JSON.stringify({ projects: [] }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === '/api/settings/instructions-delivery') {
        return new Response(JSON.stringify({ targets: [], postExport: '', configuredTargets: false }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    }));

    render(h(App, {}));

    const themeSelect = await screen.findByRole('combobox', { name: 'App theme' });
    await waitFor(() => {
      expect(document.documentElement.dataset.themeMode).toBe('system');
      expect(document.documentElement.dataset.theme).toBe('light');
    });

    changeSelect(themeSelect, 'light');
    await waitFor(() => {
      expect(savedModes).toEqual(['light']);
      expect(document.documentElement.dataset.themeMode).toBe('light');
      expect(document.documentElement.dataset.theme).toBe('light');
    });

    const mainNavigation = screen.getByLabelText('Main navigation');
    fireEvent.click(within(mainNavigation).getByLabelText('Spaces'));
    fireEvent.click(screen.getByRole('link', { name: 'Settings' }));
    await waitFor(() => expect((themeSelect as HTMLSelectElement).value).toBe('light'));

    changeSelect(themeSelect, 'dark');
    await waitFor(() => {
      expect(savedModes).toEqual(['light', 'dark']);
      expect(document.documentElement.dataset.themeMode).toBe('dark');
      expect(document.documentElement.dataset.theme).toBe('dark');
    });

    changeSelect(themeSelect, 'system');
    await waitFor(() => {
      expect(savedModes).toEqual(['light', 'dark', 'system']);
      expect(document.documentElement.dataset.themeMode).toBe('system');
      expect(document.documentElement.dataset.theme).toBe('light');
    });

    act(() => {
      mediaQuery.matches = true;
      systemListener?.();
    });
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('owns operational notices in the main workspace without a rail login', () => {
    const appSource = readFileSync(
      `${process.cwd()}/ui/src/app.tsx`,
      'utf8',
    );
    expect(appSource).toContain('id="app-operational-notices"');
    expect(appSource).not.toContain('<DesktopLoginStatus');
  });

  it('shows one actionable access failure in the main outlet without a signed-out view', async () => {
    __resetBrowserSessionForTests();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).includes('/client-auth/whoami')
        ? { authenticated: false, failure_reason: 'wrong_audience' }
        : {},
    ), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const mounted = render(h(App, {}));
    await waitFor(() => expect(mounted.container.querySelectorAll(
      '.app-content > #app-operational-notices [data-notice-source="local-access"][role="alert"]',
    )).toHaveLength(1));
    expect(mounted.container.querySelector('aside [role="alert"]')).toBeNull();
    expect(mounted.container.querySelector('.desktop-login')).toBeNull();
    const before = fetchMock.mock.calls.filter(([url]) => String(url).includes('/client-auth/whoami')).length;
    fireEvent.click(within(mounted.container.querySelector('#app-operational-notices')!).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/client-auth/whoami'))).toHaveLength(before + 1));
  });

  it('renders a deep-linked issue detail while the global issue list is pending', async () => {
    stubEventSource();
    if (typeof window.localStorage.removeItem === 'function') {
      window.localStorage.removeItem('mandible_state_cache');
    }
    window.history.replaceState(
      null,
      '',
      '#/issues?repo=mandible&issue=4c26383&sidebar=hidden',
    );
    const fetchCalls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      fetchCalls.push(url);
      if (url === '/api/issues') {
        return new Promise<Response>(() => undefined);
      }
      if (
        url === '/api/issues/mandible/4c26383/ledger-detail?stage=initial' ||
        url === '/api/issues/mandible/4c26383/ledger-detail'
      ) {
        return Promise.resolve(new Response(JSON.stringify(issueDetailProjection({
          displayId: '4c26383',
          title: 'Route detail before list',
          comments: ['Detail loaded before sidebar list'],
          stage: url.includes('stage=initial') ? 'initial' : 'full',
        })), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (url === '/api/inbox/global') {
        return Promise.resolve(new Response(JSON.stringify({
          continuations: [],
          auth_results: [],
          open_issues: [],
          total: 0,
        }), { headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.startsWith('/api/conversations')) {
        return Promise.resolve(new Response(JSON.stringify({ conversations: [], total: 0 }), {
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      if (url === '/api/settings') {
        return Promise.resolve(new Response(JSON.stringify({}), {
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response(JSON.stringify([]), {
        headers: { 'Content-Type': 'application/json' },
      }));
    }));

    render(h(App, {}));

    expect(await screen.findByRole('heading', { name: 'Route detail before list' })).toBeTruthy();
    expect(screen.getByText('Detail loaded before sidebar list')).toBeTruthy();
    expect(fetchCalls).toContain('/api/issues');
    expect(fetchCalls).toContain('/api/issues/mandible/4c26383/ledger-detail?stage=initial');
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

  it('renders Graph detail in the shared right sidebar without a registration loop', async () => {
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

    await waitFor(() => expect(screen.getByLabelText('Show Graph detail')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Show Graph detail'));
    await waitFor(() => expect(screen.getByLabelText('Hide Graph detail')).toBeTruthy());
    const hideToggle = screen.getByLabelText('Hide Graph detail');
    expect(hideToggle.closest('.app-right-sidebar__header')).toBeTruthy();
    expect(hideToggle.getAttribute('aria-pressed')).toBe('true');
    const graphDetail = screen.getByLabelText('Graph detail');
    expect(graphDetail.classList.contains('app-right-sidebar')).toBe(true);
    await waitFor(() => expect(graphDetail.querySelector('.detail-pane-shell')).toBeTruthy());
    expect(screen.getAllByText('mandible').length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith('/api/graph?')).length)
      .toBeLessThan(5);
    fireEvent.click(hideToggle);
    await waitFor(() => expect(screen.getByLabelText('Show Graph detail')).toBeTruthy());
    const showToggle = screen.getByLabelText('Show Graph detail');
    expect(showToggle.closest('main')).toBeTruthy();
    expect(showToggle.getAttribute('aria-pressed')).toBe('false');
    await waitFor(() => expect(document.activeElement).toBe(showToggle));
  });

  // Issue 80ced49 regression guard. GraphView used to build its pending-payload
  // placeholder as a fresh object literal on every render, so `payload.nodes` and
  // `payload.edges` changed identity each pass. That invalidated the memoized
  // right-sidebar descriptor, re-ran the registration effect, wrote app shell
  // state, and re-rendered the view — an unbounded synchronous render loop that
  // hung the whole test file. This probe re-renders GraphView while the graph
  // request is still pending and records every registration, so a regression
  // fails on the count instead of spinning forever (the shell probe deliberately
  // holds no state, so the loop cannot self-sustain here).
  it('registers one stable Graph right sidebar descriptor while the payload is pending', async () => {
    stubEventSource();
    // The pending-payload path is only exercised when no cached graph detail is
    // available, so drop anything an earlier test persisted.
    if (typeof window.localStorage.clear === 'function') window.localStorage.clear();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/graph?')) {
        return new Promise<Response>(() => undefined);
      }
      return Promise.resolve(new Response(JSON.stringify([]), {
        headers: { 'content-type': 'application/json' },
      }));
    }));

    const registrations: string[] = [];
    const updates: AppRightSidebarDescriptor[] = [];
    const navigate = (): void => undefined;
    let rerenderProbe: (() => void) | null = null;

    function PendingGraphProbe(): JSX.Element {
      const [, setTick] = useState(0);
      rerenderProbe = () => setTick((value) => value + 1);
      const registerRightSidebar = useCallback((ownerId: string) => {
        registrations.push(ownerId);
        return () => undefined;
      }, []);
      const updateRightSidebar = useCallback((_ownerId: string, descriptor: AppRightSidebarDescriptor) => {
        updates.push(descriptor);
      }, []);
      const shell = useMemo<AppShellContextValue>(() => ({
        rightSidebar: null,
        registerRightSidebar,
        registerInitialRouteLoad: () => undefined,
        updateRightSidebar,
        setViewSidebarWidth: () => undefined,
        active: true,
      }), [registerRightSidebar, updateRightSidebar]);

      return h(AppShellProvider, { value: shell }, h(GraphView, {
        onNavigate: navigate,
        refreshToken: 0,
      }));
    }

    render(h(PendingGraphProbe, {}));

    await waitFor(() => expect(registrations.length).toBeGreaterThan(0));
    expect(updates[0]).not.toHaveProperty('layout');
    expect(updates[0]?.content).toBeNull();

    for (let pass = 0; pass < 5; pass += 1) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        rerenderProbe?.();
      });
    }

    expect(registrations).toHaveLength(1);
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

    await waitFor(() => expect(screen.getByLabelText('Show Graph detail')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Show Graph detail'));
    await waitFor(() => expect(
      within(screen.getByLabelText('Graph detail')).getByRole('heading', { name: 'alpha' }),
    ).toBeTruthy());
    const graphPanel = screen.getByLabelText('Graph detail');
    const detailShell = graphPanel.querySelector('.detail-pane-shell');
    expect(Array.from(detailShell?.children ?? []).map((element) => element.getAttribute('data-detail-pane-slot')))
      .toEqual(['header', 'notice', 'body', 'overlay-host']);
    const copyIdentity = within(graphPanel).getByRole('button', { name: 'Copy Repo reference' });
    expect(copyIdentity.closest('.detail-pane-shell__header')).toBeTruthy();
    expect(copyIdentity.closest('.detail-pane-shell__body')).toBeNull();
    expect(within(graphPanel).queryByText('Actions')).toBeNull();
    expect(reactFlowMockState.mountCount).toBe(1);

    fireEvent.click(screen.getByLabelText('Select graph node rf_beta'));

    await waitFor(() => expect(
      within(screen.getByLabelText('Graph detail')).getByRole('heading', { name: 'beta' }),
    ).toBeTruthy());
    expect(reactFlowMockState.mountCount).toBe(1);
    expect(reactFlowMockState.unmountCount).toBe(0);
  });

  it('resolves an empty hash to the first navigation destination on mount', async () => {
    window.__MANDIBLE_BOOTSTRAP__ = { instance: mainInstance };
    stubRailSettingsFetch(JSON.stringify({
      version: 1,
      groups: { primary: ['issues', 'console'], secondary: [] },
    }));
    stubEventSource();
    window.history.replaceState(null, '', '');
    expect(window.location.hash).toBe('');

    render(h(App, {}));

    const nav = await screen.findByLabelText('Main navigation');
    await waitFor(() => {
      expect(within(nav).getByLabelText('Issues').getAttribute('aria-current')).toBe('page');
      expect(window.location.hash).toBe('#/issues');
    });
    const graphNav = within(nav).getByLabelText('Graph');
    expect(graphNav.getAttribute('aria-current')).toBeNull();
  });

  it('resolves an unknown hash to the Spaces workspace on mount', async () => {
    stubAppShellFetch();
    stubEventSource();
    window.history.replaceState(null, '', '#/not-a-real-tab');

    render(h(App, {}));

    const nav = await screen.findByLabelText('Main navigation');
    await waitFor(() => {
      const spacesNav = within(nav).getByLabelText('Spaces');
      expect(spacesNav.getAttribute('aria-current')).toBe('page');
    });
  });

  it('shows non-blocking workspace population status while the daemon is not warm', async () => {
    stubEventSource();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/health') {
        return Promise.resolve(new Response(JSON.stringify({ ready: true, warm: false }), {
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response(JSON.stringify([]), {
        headers: { 'Content-Type': 'application/json' },
      }));
    }));

    render(h(App, {}));

    expect(await screen.findByText('Still loading workspace data…')).toBeTruthy();
    expect(await screen.findByLabelText('Main navigation')).toBeTruthy();
  });

  it('renders the Spaces preview notice from boot instance data before health resolves', async () => {
    stubEventSource();
    (window as Window & { __MANDIBLE_BOOTSTRAP__?: { instance: InstanceInfo } }).__MANDIBLE_BOOTSTRAP__ = {
      instance: previewInstance,
    };
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/health') {
        return new Promise<Response>(() => undefined);
      }
      if (url === '/api/spaces/s1') {
        return new Promise<Response>(() => undefined);
      }
      if (url === '/api/settings') {
        return Promise.resolve(new Response(JSON.stringify({}), {
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      if (url === '/api/inbox/global') {
        return Promise.resolve(new Response(JSON.stringify({
          continuations: [],
          auth_results: [],
          open_issues: [],
          total: 0,
        }), { headers: { 'Content-Type': 'application/json' } }));
      }
      if (url.startsWith('/api/conversations')) {
        return Promise.resolve(new Response(JSON.stringify({ conversations: [], total: 0 }), {
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response(JSON.stringify([]), {
        headers: { 'Content-Type': 'application/json' },
      }));
    }));
    window.history.replaceState(null, '', '#/spaces?project=p1&space=s1&renderer=collection');

    render(h(App, {}));

    const copyNotice = await screen.findByTestId('preview-copy-notice');
    const spacesNoticeOutlet = await waitFor(() => {
      const outlet = document.querySelector('.spaces-shell__main .app-operational-notice-slot');
      expect(outlet).toBeTruthy();
      return outlet as HTMLElement;
    });
    const notice = spacesNoticeOutlet.querySelector('.detail-pane-notice');
    const spacesHeader = document.querySelector('.spaces-shell__header');
    const appShell = copyNotice.parentElement;
    expect(appShell?.classList.contains('app-shell')).toBe(true);
    expect(appShell?.firstElementChild).toBe(copyNotice);
    expect(copyNotice.closest('.app-layout')).toBeNull();
    expect(spacesHeader?.nextElementSibling).toBe(spacesNoticeOutlet);
    expect(notice).toBeTruthy();
    expect(spacesNoticeOutlet?.contains(notice)).toBe(true);
    expect(spacesNoticeOutlet?.contains(copyNotice)).toBe(false);
    expect(document.querySelectorAll('.spaces-shell__main .detail-pane-notice')).toHaveLength(1);
    expect(document.querySelector('#app-operational-notices .detail-pane-notice')).toBeNull();
  });
});

describe('SettingsView', () => {
  it('offers only the native setup handoff from the browser', () => {
    render(h(SettingsView, { instance: mainInstance, settings: {}, onSave: async () => undefined }));
    const action = screen.getByRole('link', { name: 'Open macOS setup' });
    expect(action.getAttribute('href')).toBe('mandible://connections/setup');
    const handoff = action.closest('section');
    expect(handoff).not.toBeNull();
    expect(within(handoff!).queryByRole('button')).toBeNull();
  });

  it('exposes and saves every app theme mode through the labelled Appearance select', async () => {
    const onSave = vi.fn(async () => undefined);

    render(h(SettingsView, { instance: mainInstance, settings: { app_theme: 'system' }, onSave }));

    const themeSelect = screen.getByRole('combobox', { name: 'App theme' });
    expect(themeSelect.getAttribute('aria-describedby')).toBe('settings-app-theme-description');
    expect(within(themeSelect).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'System',
      'Dark',
      'Light',
    ]);

    for (const mode of ['light', 'dark', 'system']) {
      changeSelect(themeSelect, mode);
      await waitFor(() => expect(onSave).toHaveBeenLastCalledWith('app_theme', mode));
    }

    const lightTerminal = screen.getByRole('combobox', { name: 'Light-mode terminal' });
    const darkTerminal = screen.getByRole('combobox', { name: 'Dark-mode terminal' });
    expect(within(lightTerminal).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Mandible', 'GitHub', 'Solarized', 'One', 'High contrast',
    ]);
    expect(within(darkTerminal).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Mandible', 'GitHub', 'Solarized', 'One', 'High contrast',
    ]);
    changeSelect(lightTerminal, 'solarized');
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith('terminal_theme_light', 'solarized'));
    changeSelect(darkTerminal, 'one');
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith('terminal_theme_dark', 'one'));
  });

  it('disables App theme without saving when operational mutations are rejected', () => {
    const onSave = vi.fn(async () => undefined);

    render(h(SettingsView, {
      settings: { app_theme: 'system' },
      onSave,
      instance: previewInstance,
    }));

    const themeSelect = screen.getByRole('combobox', { name: 'App theme' });
    expect((themeSelect as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByRole('combobox', { name: 'Light-mode terminal' }) as HTMLSelectElement).disabled)
      .toBe(true);
    expect((screen.getByRole('combobox', { name: 'Dark-mode terminal' }) as HTMLSelectElement).disabled)
      .toBe(true);
    changeSelect(themeSelect, 'dark');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('skips unavailable automatic reads while keeping copied Settings preferences editable', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/settings/instructions-delivery') {
        return new Response(JSON.stringify({ targets: [], postExport: '', configuredTargets: false }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === '/api/projects') {
        return new Response(JSON.stringify({ projects: [] }), { headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/users/operator/signing-key') {
        return new Response(JSON.stringify({
          audit: { status: 'unconfigured', configured: false, fingerprint: null, operator_slug: 'operator', reason: null, hint: null },
          credentials: [], git_config_read: true,
        }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const onSave = vi.fn(async () => undefined);
    const onTypographySave = vi.fn(async () => undefined);

    render(h(SettingsView, {
      settings: { app_theme: 'system' },
      onSave,
      onTypographySave,
      instance: preferenceWritablePreviewInstance,
    }));

    const forbiddenReads = [
      '/api/backup/status',
      '/api/runtime/status',
      '/api/auth/hooks',
      '/api/auth/clearances/signing',
    ];
    const requestedUrls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(requestedUrls.filter((url) => forbiddenReads.includes(url))).toEqual([]);

    const theme = screen.getByRole('combobox', { name: 'App theme' }) as HTMLSelectElement;
    const font = screen.getByRole('combobox', { name: 'UI font' }) as HTMLSelectElement;
    expect(theme.disabled).toBe(false);
    expect(font.disabled).toBe(false);
    changeSelect(theme, 'dark');
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('app_theme', 'dark'));
    changeSelect(font, 'space-grotesk');
    await waitFor(() => expect(onTypographySave).toHaveBeenCalledWith('ui_font_face', 'space-grotesk'));

    const chatLimit = screen.getByRole('spinbutton', { name: 'Chats per group' }) as HTMLInputElement;
    expect(chatLimit.value).toBe('5');
    fireEvent.input(chatLimit, { target: { value: '6' } });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('conversations.sidebar_group_limit', '6'));
  });

  it('saves preview instruction settings locally without offering file cleanup', async () => {
    const onSave = vi.fn(async () => undefined);
    const targets = [
      { path: '/tmp/old-codex.md', mode: 'managed-block' },
      { path: '/tmp/old-claude.md', mode: 'managed-block' },
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/settings/instructions-delivery' && init?.method !== 'PUT') {
        return new Response(JSON.stringify({
          targets,
          postExport: 'bin/compile-agent-instructions',
          configuredTargets: true,
          preview_only: true,
          export: { ok: false, stdout: '', stderr: 'not run in preview' },
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/settings/instructions-delivery' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { targets: typeof targets; cleanupRemovedTargets: boolean };
        return new Response(JSON.stringify({
          targets: body.targets,
          postExport: 'bin/compile-agent-instructions',
          configuredTargets: true,
          preview_only: true,
          configuration_saved: true,
          export: { ok: false, stdout: '', stderr: 'not installed in preview' },
          cleanup: [],
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/projects') {
        return new Response(JSON.stringify({ projects: [] }), { headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/users/operator/signing-key') {
        return new Response(JSON.stringify({
          audit: { status: 'unconfigured', configured: false, fingerprint: null, operator_slug: 'operator', reason: null, hint: null },
          credentials: [], git_config_read: true,
        }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(h(SettingsView, {
      settings: {},
      onSave,
      instance: preferenceWritablePreviewInstance,
    }));

    expect(await screen.findByDisplayValue('/tmp/old-codex.md')).toBeTruthy();
    const targetRow = screen.getByLabelText('Instruction target /tmp/old-codex.md').closest('.settings-view__instruction-target') as HTMLElement;
    fireEvent.click(within(targetRow).getByRole('button', { name: 'Remove instruction target /tmp/old-codex.md' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/instructions-delivery',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ targets: [targets[1]], cleanupRemovedTargets: false }),
      }),
    ));
    expect(screen.queryByRole('dialog', { name: 'Clean previous instruction target?' })).toBeNull();
    await waitFor(() => expect(screen.getByText('Saved in this preview copy. Target files were not changed and the post-export hook was not run.')).toBeTruthy());
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('instructions.targets', JSON.stringify([targets[1]])));
  });

  it('shows project restriction state and existing grants', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/projects') {
        return new Response(JSON.stringify({
          projects: [{ id: 'p1', project_key: 'mandible', display_name: 'Mandible' }],
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/projects/mandible/access' && init?.method !== 'PATCH') {
        return new Response(JSON.stringify({
          project_id: 'p1',
          restricted: true,
          grants: [{
            id: 'g1', subject_type: 'group', subject_id: 'agents',
            resource_type: 'project', resource_id: 'p1', permission: 'write',
          }],
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/settings/instructions-delivery') {
        return new Response(JSON.stringify({ targets: [], postExport: '', configuredTargets: false }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    }));

    render(h(SettingsView, { instance: mainInstance, settings: {}, onSave: async () => undefined }));

    expect(await screen.findByTestId('project-permissions-settings')).toBeTruthy();
    expect(await screen.findByText('group:agents — write')).toBeTruthy();
    expect(screen.getByLabelText('Toggle project restriction').getAttribute('aria-checked')).toBe('true');
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

  it('offers independent approval-view and finalized-selection preferences', async () => {
    const onSave = vi.fn(async () => undefined);
    render(h(SettingsView, { settings: {}, onSave }));

    const consoleToggle = screen.getByRole('switch', { name: 'Toggle Show approval console automatically' });
    const overviewToggle = screen.getByRole('switch', { name: 'Toggle Return to overview after approval' });
    const retainToggle = screen.getByRole('switch', { name: 'Toggle Keep the finalized request selected' });
    expect([consoleToggle, overviewToggle, retainToggle].map((toggle) => toggle.getAttribute('aria-checked'))).toEqual(['true', 'true', 'true']);

    fireEvent.click(retainToggle);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('auth.retain_finalized_selection', 'false'));
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
        instance: mainInstance,
        settings: {},
        onSave,
      }),
    );

    expect(screen.getByRole('heading', { name: 'Instruction Delivery' })).toBeTruthy();
    expect(await screen.findByDisplayValue('/Users/mll/.claude/CLAUDE.md')).toBeTruthy();
    expect(screen.getByDisplayValue('/Users/mll/.codex/AGENTS.md')).toBeTruthy();
    expect(screen.queryByPlaceholderText('/path/to/50-mandible.generated.md')).toBeNull();
    expect(screen.queryByPlaceholderText('bin/compile-agent-instructions')).toBeNull();

    fireEvent.input(screen.getByLabelText('New instruction target path'), {
      target: { value: '/tmp/50-mandible.generated.md' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add instruction target' }));

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
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('instructions.targets', expect.any(String)));

    fireEvent.input(screen.getByLabelText('Instructions post-export hook'), {
      target: { value: 'bin/compile-agent-instructions' },
    });

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

  it('defines IconTabList appearance once and removes the retired auth console toggle', () => {
    const resolvedCss = readResolvedStylesheet();
    const baseCss = readFileSync('ui/src/styles/base.css', 'utf8');
    const authCss = readFileSync('ui/src/styles/auth.css', 'utf8');

    expect(ruleBody(resolvedCss, '.icon-tab-list > button')).toContain('min-height: var(--app-header-height)');
    expect(ruleBody(resolvedCss, ".icon-tab-list > button[aria-selected='true']")).toContain('border-bottom-color: var(--accent-blue)');
    expect(baseCss).not.toContain('.app-right-sidebar__tabs button');
    expect(authCss).not.toContain('.auth-detail__mode-tabs button');
    expect(authCss).not.toContain('.console-output__toggle');
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
    expect(getComputedStyle(projectHeader).height).toBe('48px');
    expect(getComputedStyle(projectMain).height).toBe('100%');
    expect(getComputedStyle(projectMain).flexDirection).toBe('row');
    expect(getComputedStyle(projectMain).alignItems).toBe('center');
    expect(getComputedStyle(projectMetadata).marginLeft).toBe('auto');
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
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'Path is not a Git project.' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )));
    render(h(WorkOverviewView, {
      instance: mainInstance,
      repos: [],
      branchesByRepo: {},
      onRescan: () => undefined,
    }));

    expect(screen.getByText('No projects found. Register a session or add a project.')).toBeTruthy();
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
      repo_root: '/Users/mll/Main/10 Projects/05 Utils/mandible',
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
      repo_root: '/Users/mll/Main/10 Projects/10 PhD/20 Feedbax/feedbax',
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

describe('API contract helpers', () => {
  it('loads Projects compare payloads with raw unified diff text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => (
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
      })
    )));

    const compare = await getWorkCompare('repo', { from: 'main', to: 'feature', mode: 'merge-base' });

    expect(compare.raw).toContain('diff --git');
    expect(compare.range).toBe('main...feature');
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

    const mutation = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    const body = JSON.parse(String(mutation?.[1]?.body));
    expect(body.starred).toBe(true);
  });
});

describe('LedgerIssueDetail', () => {
  it('renders issue status in the top metadata row after the copy affordance', () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const detail = issueDetailProjection({
      displayId: 'abc123',
      title: 'Status placement',
    });
    detail.id = 'abc123-full-canonical-id';

    render(h(LedgerIssueDetail, { detail }));

    const canonicalHeaders = document.querySelectorAll('[data-detail-pane-header-variant="standard"]');
    const canonicalHeader = canonicalHeaders[0] as HTMLElement | undefined;
    const topline = canonicalHeader?.querySelector('.detail-pane-header__topline') as HTMLElement | null;
    const identity = canonicalHeader?.querySelector('.detail-pane-header__identity') as HTMLElement | null;
    const status = canonicalHeader?.querySelector('.detail-pane-header__status') as HTMLElement | null;
    const controls = status?.parentElement;
    const copyButton = screen.getByRole('button', { name: 'Copy mandible/abc123' });
    const statusPill = status?.querySelector('.status-pill') as HTMLElement | null;
    const toplineChildren = Array.from(topline?.children ?? []);

    expect(canonicalHeaders).toHaveLength(1);
    expect(canonicalHeader?.classList.contains('detail-pane-header')).toBe(true);
    expect(statusPill?.textContent).toBe('open');
    expect(copyButton.parentElement).toBe(identity);
    expect(statusPill?.parentElement).toBe(status);
    expect(toplineChildren.indexOf(controls as Element)).toBe(toplineChildren.indexOf(identity as Element) + 1);
    const detailPane = document.querySelector('.ledger-issue-detail');
    const header = document.querySelector('.ledger-issue-detail__header');
    const notice = document.querySelector('.ledger-issue-detail [data-detail-pane-slot="notice"]');
    const body = document.querySelector('.ledger-issue-detail__body');
    expect(detailPane?.classList.contains('detail-pane-shell')).toBe(true);
    expect(header?.classList.contains('detail-pane-shell__header')).toBe(true);
    expect(body?.classList.contains('detail-pane-shell__body')).toBe(true);
    expect(header?.querySelector('.detail-pane-shell__header-primary.ledger-issue-detail__header-primary')).toBeTruthy();
    expect(detailPane?.contains(header as Node)).toBe(true);
    expect(detailPane?.contains(body as Node)).toBe(true);
    expect(header?.nextElementSibling).toBe(notice);
    expect(notice?.nextElementSibling).toBe(body);
    expect(body?.contains(header as Node)).toBe(false);
    const overflowAction = screen.getByRole('button', { name: 'Issue actions' });
    expect(canonicalHeader?.querySelector('.detail-pane-header__actions')?.contains(overflowAction)).toBe(true);
    expect(body?.contains(overflowAction)).toBe(false);

    fireEvent.click(copyButton);
    expect(writeText).toHaveBeenCalledWith('mandible/abc123');
  });

  it('prefers canonical project keys over checkout repo ids in copy refs', () => {
    const detail = issueDetailProjection({
      displayId: 'fbx1234',
      title: 'Feedbax ref',
      projectKey: 'feedbax',
      repoId: '20-widgets-widgets',
      repoName: 'Feedbax',
    });

    render(h(LedgerIssueDetail, { detail }));

    expect(screen.getByRole('button', { name: 'Copy feedbax/fbx1234' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copy 20-widgets-widgets/fbx1234' })).toBeNull();
  });

  it('uses canonical project keys for local rendered issue and comment links', () => {
    const detail = issueDetailProjection({
      displayId: 'fbx1234',
      title: 'Feedbax rendered refs',
      body: 'See [issue:def456] and [comment:#com_1].',
      projectKey: 'feedbax',
      repoId: '20-widgets-widgets',
      repoName: 'Feedbax',
    });

    render(h(LedgerIssueDetail, { detail }));

    const issueLinks = Array.from(document.querySelectorAll('a.ledger-xref')).map((node) => ({
      text: node.textContent,
      href: (node as HTMLAnchorElement).getAttribute('href'),
    }));
    expect(issueLinks).toContainEqual({
      text: 'def456',
      href: '#/issues?repo=feedbax&issue=def456',
    });
    expect(issueLinks).toContainEqual({
      text: 'fbx1234#com_1',
      href: '#/issues?repo=feedbax&issue=fbx1234&comment=com_1',
    });
    expect(issueLinks.some((link) => link.href?.includes('20-widgets-widgets'))).toBe(false);
  });

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
    } as const;

    render(h(LedgerIssueDetail, { detail }));

    expect(screen.queryByRole('heading', { name: 'Approval Evidence' })).toBeNull();
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
      href: '#/artifacts?ref=artifact%3Abbbbbbbbbbbb',
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
          ref: 'artifact-blob:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          title: 'R0 audit report',
          logical_name: 'r0-audit.md',
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
          refs: ['artifact-version:version-1'],
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
              link_kind: 'pinned',
              series_id: 'artifact-series:report',
              series_ref: 'artifact-series:report',
              resolved_version_no: null,
              target_type: 'artifact_version',
              target_id: 'artifact-version:version-1',
              created_at: Date.now(),
              updated_at: Date.now(),
            },
          ],
        },
        {
          id: 'artifact:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          ref: 'artifact-blob:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          title: null,
          logical_name: null,
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
          links: [
            {
              id: 'link_blob',
              entity_type: 'issue',
              entity_id: 'issue_1',
              link_type: 'references',
              role: null,
              repo_id: null,
              provider_id: null,
              source: 'artifact_registry',
              metadata: {},
              link_kind: 'pinned',
              series_id: null,
              series_ref: null,
              resolved_version_no: null,
              target_type: 'artifact_blob',
              target_id: 'artifact-blob:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              created_at: Date.now(),
              updated_at: Date.now(),
            },
          ],
        },
        {
          id: 'artifact:sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          ref: 'artifact-blob:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          title: 'Live report',
          logical_name: 'live-report.md',
          algorithm: 'sha256',
          content_hash: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          uri: 'artifact:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          media_type: 'application/json',
          role: 'dataset',
          provider_id: 'provider_1',
          manifest_id: null,
          custody_mode: 'managed',
          availability: 'present',
          created_at: Date.now(),
          refs: ['artifact-series:live-report'],
          links: [
            {
              id: 'link_2',
              entity_type: 'issue',
              entity_id: 'issue_1',
              link_type: 'evidence',
              role: null,
              repo_id: 'mandible',
              provider_id: 'provider_1',
              source: 'artifact_registry',
              metadata: {},
              link_kind: 'living',
              series_id: 'artifact-series:live-report',
              series_ref: 'artifact-series:live-report',
              resolved_version_no: 2,
              target_type: 'artifact',
              target_id: 'artifact:live-report',
              created_at: Date.now(),
              updated_at: Date.now(),
            },
          ],
        },
      ],
    } as const;

    render(h(LedgerIssueDetail, { detail }));

    const artifactsPanel = screen.getByText('Associated Artifacts').closest('.collapsible-panel') as HTMLElement;
    fireEvent.click(artifactsPanel.querySelector('button') as HTMLButtonElement);
    expect(screen.getAllByText('R0 audit report')).toHaveLength(2);
    const versionRefs = screen.getAllByText('artifact-version:version-1');
    const link = versionRefs.find((node) => node.closest('a')?.textContent?.includes('referenced'))
      ?.closest('a') as HTMLAnchorElement | null;
    expect(link?.getAttribute('href')).toBe(
      '#/artifacts?ref=artifact-version%3Aversion-1',
    );
    expect(link?.textContent).toContain('R0 audit report');
    expect(link?.textContent).not.toContain('v1');
    expect(link?.textContent).not.toContain('latest');
    const pinnedLink = versionRefs.find((node) => node.closest('a')?.textContent?.includes('produced by'))
      ?.closest('a') as HTMLAnchorElement | null;
    expect(pinnedLink?.getAttribute('href')).toBe('#/artifacts?ref=artifact-version%3Aversion-1');
    expect(pinnedLink?.textContent).toContain('artifact-version:version-1');
    const compactLink = screen.getByText('artifact-blob:bbbbbbbbbbbb').closest('a') as HTMLAnchorElement | null;
    expect(compactLink?.getAttribute('href')).toBe(
      '#/artifacts?ref=artifact-blob%3Abbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    );
    const livingLinks = screen.getAllByText('artifact-series:live-report');
    expect(livingLinks).toHaveLength(1);
    const authoredLivingLink = livingLinks.find((node) => node.closest('a')?.textContent?.includes('referenced'))
      ?.closest('a') as HTMLAnchorElement | null;
    expect(authoredLivingLink?.getAttribute('href')).toBe('#/artifacts?series=artifact-series%3Alive-report');
    const livingLink = screen.getByText('latest → v2').closest('a') as HTMLAnchorElement | null;
    expect(livingLink?.getAttribute('href')).toBe('#/artifacts?ref=artifact%3Alive-report');
    expect(livingLink?.textContent).toContain('artifact:live-report');
    expect(screen.getAllByText('report · text/markdown · provider_1 · present')).toHaveLength(2);
  });

  it('keeps issue and comment provenance behind metadata controls', async () => {
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
    expect(issueHeader?.querySelector('[aria-label="Issue metadata"]')).toBeNull();
    const detailScroller = document.querySelector('.ledger-issue-detail__body') as HTMLElement | null;
    const originalInnerWidth = window.innerWidth;
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getIssueRect() {
      if (this.classList.contains('ledger-issue-detail__body')) {
        return {
          x: 300,
          y: 176,
          top: 176,
          right: 1180,
          bottom: 800,
          left: 300,
          width: 880,
          height: 624,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return {
        x: 0,
        y: 0,
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        width: 0,
        height: 0,
        toJSON: () => ({}),
      } as DOMRect;
    });
    if (detailScroller) detailScroller.scrollTop = 320;
    fireEvent.click(screen.getByLabelText('Issue actions'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show metadata' }));
    const issueMetadataDialog = screen.getByRole('dialog', { name: 'Issue metadata' });
    await waitFor(() => expect(detailScroller?.className).toContain('detail-pane-shell__body--overlay-open'));
    expect(detailScroller?.scrollTop).toBe(320);
    expect(issueMetadataDialog.closest('.ledger-issue-detail__body')).toBeNull();
    expect(issueMetadataDialog.parentElement?.hasAttribute('data-detail-pane-overlay-host')).toBe(true);
    expect((issueMetadataDialog as HTMLElement).style.getPropertyValue('--detail-pane-modal-top')).toBe('176px');
    expect((issueMetadataDialog as HTMLElement).style.getPropertyValue('--detail-pane-modal-left')).toBe('300px');
    expect((issueMetadataDialog as HTMLElement).style.getPropertyValue('--detail-pane-modal-right')).toBe('100px');
    expect((issueMetadataDialog as HTMLElement).style.getPropertyValue('--detail-pane-modal-bottom')).toBe('0px');
    expect(within(issueMetadataDialog).getByText('Identity')).toBeTruthy();
    expect(within(issueMetadataDialog).getByText('Status')).toBeTruthy();
    expect(within(issueMetadataDialog).getByText('Provenance')).toBeTruthy();
    expect(within(issueMetadataDialog).getByText('abc123')).toBeTruthy();
    expect(within(issueMetadataDialog).getByText('umbrella')).toBeTruthy();
    expect(within(issueMetadataDialog).getByText('git_bug')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Issue metadata' })).toBeNull());
    await waitFor(() => expect(detailScroller?.className).not.toContain('detail-pane-shell__body--overlay-open'));
    rectSpy.mockRestore();
    Object.defineProperty(window, 'innerWidth', { value: originalInnerWidth, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: originalInnerHeight, configurable: true });

    const commentHeader = document.querySelectorAll('.ledger-comment-card__header')[1];
    const commentVisibleMeta = Array.from(commentHeader?.querySelectorAll(':scope > span, :scope > time') ?? [])
      .map((node) => node.textContent)
      .join(' ');
    expect(commentVisibleMeta).toContain('MLL');
    expect(commentVisibleMeta).not.toContain('external adapter');
    expect(commentVisibleMeta).not.toContain('git_bug');
    expect(commentHeader?.querySelector('[aria-label="Comment metadata"]')).toBeTruthy();
  });

  it('scopes issue metadata to embedded graph detail panes', async () => {
    const detail = issueDetailProjection({
      displayId: 'embed123',
      title: 'Embedded metadata',
    });

    render(h('div', { class: 'graph-detail-pane' }, h(LedgerIssueDetail, { detail })));

    const embeddedScroller = document.querySelector('.ledger-issue-detail__body') as HTMLElement | null;
    const originalInnerWidth = window.innerWidth;
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 760, configurable: true });
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getEmbeddedIssueRect() {
      if (this.classList.contains('ledger-issue-detail__body')) {
        return {
          x: 720,
          y: 196,
          top: 196,
          right: 1180,
          bottom: 740,
          left: 720,
          width: 460,
          height: 544,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return {
        x: 0,
        y: 0,
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        width: 0,
        height: 0,
        toJSON: () => ({}),
      } as DOMRect;
    });
    if (embeddedScroller) embeddedScroller.scrollTop = 144;

    fireEvent.click(screen.getByLabelText('Issue actions'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show metadata' }));
    const metadataDialog = screen.getByRole('dialog', { name: 'Issue metadata' });

    await waitFor(() => expect(embeddedScroller?.className).toContain('detail-pane-shell__body--overlay-open'));
    expect(embeddedScroller?.scrollTop).toBe(144);
    expect((metadataDialog as HTMLElement).style.getPropertyValue('--detail-pane-modal-top')).toBe('196px');
    expect((metadataDialog as HTMLElement).style.getPropertyValue('--detail-pane-modal-left')).toBe('720px');
    expect((metadataDialog as HTMLElement).style.getPropertyValue('--detail-pane-modal-right')).toBe('20px');
    expect((metadataDialog as HTMLElement).style.getPropertyValue('--detail-pane-modal-bottom')).toBe('20px');
    expect(within(metadataDialog).getByText('embed123')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Issue metadata' })).toBeNull());
    await waitFor(() => expect(embeddedScroller?.className).not.toContain('detail-pane-shell__body--overlay-open'));
    rectSpy.mockRestore();
    Object.defineProperty(window, 'innerWidth', { value: originalInnerWidth, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: originalInnerHeight, configurable: true });
  });

  it('keeps embedded graph issue content on the shared content-width contract', () => {
    const detail = issueDetailProjection({
      displayId: 'embed-width',
      title: 'Embedded width contract',
    });

    render(h('aside', { class: 'graph-detail-pane graph-detail-pane--ledger' }, h(LedgerIssueDetail, {
      compact: true,
      detail,
      onAddComment: () => undefined,
    })));

    const pane = document.querySelector('.graph-detail-pane--ledger');
    const header = pane?.querySelector('.detail-pane-header');
    const body = pane?.querySelector('.ledger-issue-detail__body');
    expect(pane?.querySelector('.ledger-issue-detail--compact')).toBeTruthy();
    expect(pane?.closest('.issues-detail')).toBeNull();
    expect(header).toBeTruthy();
    expect(body?.querySelector('.ledger-comment-composer')).toBeTruthy();

    const css = readResolvedStylesheet();
    expect(css).toMatch(/\.detail-pane-shell\s*\{[^}]*--detail-content-inline-inset:\s*24px;/s);
    expect(css).toMatch(/\.issues-detail__content \.ledger-issue-detail > \.ledger-issue-detail__body\s*\{[^}]*padding-inline:\s*var\(--detail-content-inline-inset\);/s);
    expect(css).toMatch(/\.app-right-sidebar \.graph-detail-pane--ledger\s*\{[^}]*--detail-content-inline-inset:\s*0;/s);
    expect(css).toMatch(/\.graph-detail-pane--ledger \.ledger-issue-detail__body\s*\{[^}]*padding-inline:\s*var\(--detail-content-inline-inset\);/s);
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
    } as const;

    const onSetStatus = vi.fn();
    render(h(LedgerIssueDetail, {
      detail,
      onAddComment: () => undefined,
      onSetStatus,
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
    expect(screen.getByRole('menuitem', { name: 'Show metadata' })).toBeTruthy();
    expect(screen.getAllByText('Add Comment')).toHaveLength(2);

    fireEvent.click(screen.getByText('Close Issue'));
    expect(screen.getByRole('group', { name: 'Close issue resolution' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Close as delivered' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Close as duplicate' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Close as wontfix' })).toBeTruthy();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Close as duplicate' }));
    expect(onSetStatus).toHaveBeenCalledWith('closed', 'duplicate');
  });
});

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

describe('ArtifactsView', () => {
  it('replaces a removed saved series with the first available artifact', async () => {
    const artifact = makeArtifactFixture('e', 'available-report.md');
    const artifactSeries = makeArtifactSeries('available-report', [artifact], 'available-report.md');
    installMemoryLocalStorage({
      'mandible:artifacts:list-controls:v1': JSON.stringify({
        filters: {},
        sortField: 'updated',
        sortDirection: 'desc',
        selectedSeriesRef: 'artifact-series:removed',
        selectedVersionNo: null,
      }),
    });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/series?')) return jsonResponse({ series: [artifactSeries.summary] });
      if (url.startsWith('/api/artifacts/versions?')) {
        const ref = new URLSearchParams(url.split('?')[1] ?? '').get('ref');
        if (ref === 'artifact-series:removed') {
          return Promise.resolve(new Response(JSON.stringify({ error: 'not found' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          }));
        }
        return jsonResponse({ history: artifactSeries.history });
      }
      if (url.endsWith('/knowledge-backrefs')) return jsonResponse({ backrefs: [] });
      if (url.endsWith('/content')) {
        return jsonResponse({
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
        });
      }
      if (url.includes(encodeURIComponent(artifact.id))) return jsonResponse({ artifact });
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(h(ArtifactsView, {}));

    expect(await screen.findByRole('heading', { name: 'available-report.md' })).toBeTruthy();
    await waitFor(() => expect(JSON.parse(String(window.localStorage.getItem(
      'mandible:artifacts:list-controls:v1',
    ))).selectedSeriesRef).toBe(artifactSeries.summary.ref));
  });

  it('shows artifact load failures once below the detail header', async () => {
    const artifact = makeArtifactFixture('d', 'failed-detail.md', {
      id: 'artifact:dddddddddddd',
    });
    const artifactSeries = makeArtifactSeries('failed-detail', [artifact], 'failed-detail.md');
    const notFound = () => Promise.resolve(new Response(JSON.stringify({ error: 'artifact not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/series?')) return jsonResponse({ series: [artifactSeries.summary] });
      if (url.startsWith('/api/artifacts/versions?')) return jsonResponse({ history: artifactSeries.history });
      if (url.endsWith('/knowledge-backrefs')) return jsonResponse({ backrefs: [] });
      if (url.endsWith('/content')) return notFound();
      if (url.includes(encodeURIComponent(artifact.id))) return notFound();
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(h(ArtifactsView, {}));

    await waitFor(() => expect(screen.getAllByText('Artifact detail: artifact not found')).toHaveLength(1));
    const error = screen.getByText('Artifact detail: artifact not found');
    const header = document.querySelector('.artifact-detail__header');
    const body = document.querySelector('.artifact-detail__pane');
    const anchoredNotice = document.querySelector('#app-operational-notices');
    expect(header).toBeTruthy();
    expect(anchoredNotice?.contains(error)).toBe(true);
    expect(document.querySelector('.artifact-detail .detail-pane-notice')).toBeNull();
    expect(body?.contains(error)).toBe(false);
  });

  it('renders HumbleB knowledge backrefs in artifact detail', async () => {
    const artifact = {
      id: 'artifact:aaaaaaaaaaaa',
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
      links: [
        {
          id: 'link-pinned',
          artifact_id: 'artifact:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          entity_type: 'issue',
          entity_id: 'abc123',
          link_type: 'evidence',
          role: null,
          repo_id: 'mandible',
          provider_id: null,
          source: 'artifact_registry',
          metadata: {},
          link_kind: 'pinned',
          series_id: 'artifact-series:demo-report',
          series_ref: 'artifact-series:demo-report',
          created_at: Date.now(),
          updated_at: Date.now(),
        },
        {
          id: 'link-living',
          artifact_id: 'artifact:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          entity_type: 'issue',
          entity_id: 'def456',
          link_type: 'evidence',
          role: 'latest-evidence',
          repo_id: 'mandible',
          provider_id: null,
          source: 'artifact_registry',
          metadata: {},
          link_kind: 'living',
          series_id: 'artifact-series:demo-report',
          series_ref: 'artifact-series:demo-report',
          created_at: Date.now(),
          updated_at: Date.now(),
        },
      ],
    };
    const artifactSeries = makeArtifactSeries('demo-report', [artifact], 'demo-report.md');
    const mockFetch = vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/series?')) {
        return jsonResponse({ series: [artifactSeries.summary] });
      }
      if (url.startsWith('/api/artifacts/versions?')) {
        return jsonResponse({ history: artifactSeries.history });
      }
      if (url.startsWith('/api/artifacts/resolve?')) {
        return jsonResponse({
          resolution: {
            status: 'resolved',
            ref: artifact.id,
            scheme: 'artifact',
            normalized_ref: artifact.id,
            artifact,
            alias: null,
            series: undefined,
            version: undefined,
            warnings: [],
          },
        });
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
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    render(h(ArtifactsView, { initialArtifactId: artifact.id }));

    await waitFor(() => expect(screen.getByText('humbleb://claims/claim_1')).toBeTruthy());
    expect(screen.getAllByText('demo-report.md').length).toBeGreaterThan(0);
    const detailShell = document.querySelector('.artifact-detail');
    const detailHeader = document.querySelector('.artifact-detail__header');
    const detailBody = document.querySelector('.artifact-detail__pane');
    expect(detailShell?.classList.contains('detail-pane-shell')).toBe(true);
    expect(detailHeader?.classList.contains('detail-pane-shell__header')).toBe(true);
    expect(detailBody?.classList.contains('detail-pane-shell__body')).toBe(true);
    expect(detailHeader?.querySelector('.detail-pane-shell__header-primary > .detail-pane-header--versioned')).toBeTruthy();
    expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('demo-report.md');
    expect(detailHeader?.textContent).not.toContain('present');
    expect(detailHeader?.textContent).not.toContain('pinned');
    const sidebarItem = screen.getByRole('button', { name: /demo-report\.md/ });
    expect(sidebarItem.textContent).not.toContain('present');
    expect(sidebarItem.textContent).not.toContain('pinned');
    expect(sidebarItem.querySelector('.artifacts-sidebar__badges')).toBeNull();
    const sidebarMeta = sidebarItem.querySelector('.artifacts-sidebar__meta');
    expect(sidebarMeta?.textContent).toContain('demo-re');
    expect(sidebarMeta?.textContent).toContain('report');
    const filterButton = screen.getByLabelText('Artifact filters');
    expect(filterButton.textContent).not.toContain('⋯');
    expect(filterButton.querySelector('svg')).toBeTruthy();
    expect(screen.getByText('Knowledge Backrefs')).toBeTruthy();
    expect(screen.getByText('claim')).toBeTruthy();
    expect(screen.getByText('indexed')).toBeTruthy();
    const sectionHeadings = Array.from(document.querySelectorAll('.artifact-detail__section h3')).map((node) => node.textContent);
    expect(screen.queryByRole('heading', { name: 'Preview' })).toBeNull();
    expect(sectionHeadings).not.toContain('Identity');
    expect(sectionHeadings).not.toContain('Custody');
    expect(sectionHeadings[0]).toBe('Links');
    expect(sectionHeadings.indexOf('Links')).toBeLessThan(sectionHeadings.indexOf('Knowledge Backrefs'));
    expect(screen.getByRole('combobox', { name: 'Artifact version' })).toBeTruthy();
    expect(screen.queryByText('Version')).toBeNull();
    expect(detailHeader?.textContent).not.toContain('MANAGED ARTIFACT');
    expect(detailHeader?.textContent).toContain('demo-rep');
    expect(detailHeader?.textContent).not.toContain('mandible');
    expect(detailHeader?.querySelector('.artifact-detail__header-context')?.textContent).toContain('managed · report');
    expect(detailHeader?.querySelector('.artifact-detail__header-context')?.textContent).toContain('Created:');
    expect(detailHeader?.querySelector('.artifact-detail__header-context')?.textContent).toContain('Updated:');
    expect(detailBody?.querySelector('.artifact-detail__context')).toBeNull();
    const seriesCopyButton = screen.getByRole('button', { name: 'Copy artifact series ref' });
    fireEvent.click(seriesCopyButton);
    fireEvent.pointerUp(seriesCopyButton);
    expect(writeText).toHaveBeenCalledWith('artifact-series:demo-report');
    expect(seriesCopyButton.className).not.toContain('active');
    expect(document.activeElement).not.toBe(seriesCopyButton);
    const artifactCopyButton = screen.getByRole('button', { name: 'Copy selected artifact-version reference' });
    fireEvent.click(artifactCopyButton);
    fireEvent.pointerUp(artifactCopyButton);
    expect(writeText).toHaveBeenCalledWith('artifact-version:artifact-series:demo-report:1');
    expect(artifactCopyButton.className).not.toContain('active');
    expect(document.activeElement).not.toBe(artifactCopyButton);
    expect(document.querySelector('.artifact-detail__badge')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Artifact actions' }));
    const actionsMenu = screen.getByRole('menu');
    expect(actionsMenu.className).toContain('artifact-detail__actions-menu');
    expect((actionsMenu as HTMLElement).style.top).toBeTruthy();
    expect((actionsMenu as HTMLElement).style.left).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Add to Space' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Show metadata' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Version history' })).toBeTruthy();
    const detailScroller = document.querySelector('.artifact-detail__pane');
    const originalInnerWidth = window.innerWidth;
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getArtifactRect() {
      if (this.classList.contains('artifact-detail__pane')) {
        return {
          x: 376,
          y: 219,
          top: 219,
          right: 1123,
          bottom: 900,
          left: 376,
          width: 747,
          height: 681,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return {
        x: 0,
        y: 0,
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        width: 0,
        height: 0,
        toJSON: () => ({}),
      } as DOMRect;
    });
    if (detailScroller) detailScroller.scrollTop = 480;
    expect(detailScroller?.className).not.toContain('detail-pane-shell__body--overlay-open');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show metadata' }));
    const metadataDialog = screen.getByRole('dialog', { name: 'Artifact metadata' });
    await waitFor(() => expect(detailScroller?.className).toContain('detail-pane-shell__body--overlay-open'));
    expect(detailScroller?.scrollTop).toBe(480);
    expect((metadataDialog as HTMLElement).style.getPropertyValue('--detail-pane-modal-top')).toBe('219px');
    expect((metadataDialog as HTMLElement).style.getPropertyValue('--detail-pane-modal-left')).toBe('376px');
    expect((metadataDialog as HTMLElement).style.getPropertyValue('--detail-pane-modal-right')).toBe('317px');
    expect((metadataDialog as HTMLElement).style.getPropertyValue('--detail-pane-modal-bottom')).toBe('0px');
    expect(document.querySelector('.artifact-detail')?.contains(metadataDialog)).toBe(true);
    expect(document.querySelector('.artifact-detail__pane')?.contains(metadataDialog)).toBe(false);
    expect(document.querySelector('.artifact-detail__body')).toBeNull();
    expect(within(metadataDialog).getByText('Identity')).toBeTruthy();
    expect(within(metadataDialog).getByText('Custody')).toBeTruthy();
    expect(within(metadataDialog).getByText('Short ID')).toBeTruthy();
    fireEvent.click(within(metadataDialog).getByText('aaaaaaa').closest('button') as HTMLButtonElement);
    expect(writeText).toHaveBeenCalledWith('artifact:aaaaaaaaaaaa');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Artifact metadata' })).toBeNull());
    await waitFor(() => expect(detailScroller?.className).not.toContain('detail-pane-shell__body--overlay-open'));
    rectSpy.mockRestore();
    Object.defineProperty(window, 'innerWidth', { value: originalInnerWidth, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: originalInnerHeight, configurable: true });
    const pinnedBadge = document.querySelector('a.artifact-link-badge--pinned') as HTMLAnchorElement | null;
    expect(pinnedBadge?.textContent).toBe('pinned');
    expect(pinnedBadge?.textContent).not.toContain('latest');
    expect(pinnedBadge?.getAttribute('href')).toBe(
      '#/artifacts?ref=artifact-blob%3Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    const livingBadge = document.querySelector('a.artifact-link-badge--living') as HTMLAnchorElement | null;
    expect(livingBadge?.textContent).toBe('latest');
    expect(livingBadge?.getAttribute('href')).toBe('#/artifacts?series=artifact-series%3Ademo-report');
    const entityLink = screen.getByText('issue:abc123').closest('a') as HTMLAnchorElement | null;
    expect(entityLink?.getAttribute('href')).toBe('#/issues?issue=abc123&repo=mandible');
  });

  it('auto-formats compact JSON-like text previews with header-owned raw state', async () => {
    const artifact = makeArtifactFixture('9', 'metrics.txt', {
      media_type: 'text/plain',
      metadata: {
        title: 'metrics.txt',
        filename: 'metrics.txt',
      },
      home_repo_id: 'rlrmp',
      repo_locator: { repo_id: 'rlrmp', path: 'results/metrics.txt' },
    });
    const artifactSeries = makeArtifactSeries('metrics-text', [artifact], 'metrics.txt');
    const compact = '{"loss":0.125,"tags":["compact","json"]}';
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/series?')) {
        return jsonResponse({ series: [artifactSeries.summary] });
      }
      if (url.startsWith('/api/artifacts/versions?')) {
        return jsonResponse({ history: artifactSeries.history });
      }
      if (url.startsWith('/api/artifacts/resolve?')) {
        return jsonResponse({
          resolution: {
            status: 'resolved',
            ref: artifact.id,
            scheme: 'artifact',
            normalized_ref: artifact.id,
            artifact,
            alias: null,
            series: undefined,
            version: undefined,
            warnings: [],
          },
        });
      }
      if (url.endsWith('/content')) {
        return jsonResponse({
          content: {
            artifact_id: artifact.id,
            status: 'available',
            kind: 'text',
            media_type: 'text/plain',
            size_bytes: compact.length,
            source: { kind: 'managed_file', locator: 'artifact-storage' },
            preview: { encoding: 'utf-8', text: compact, truncated: false },
            download: { available: true, media_type: 'text/plain', size_bytes: compact.length, filename: 'metrics.txt' },
          },
        });
      }
      if (url.endsWith('/knowledge-backrefs')) return jsonResponse({ backrefs: [] });
      if (url.includes(encodeURIComponent(artifact.id))) return jsonResponse({ artifact });
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(h(ArtifactsView, { initialArtifactId: artifact.id }));

    await waitFor(() => expect(document.querySelector('.artifact-preview code')?.textContent).toContain('\n  "loss": 0.125,'));
    expect(document.querySelector('.artifact-detail__repo')).toBeNull();
    const previewCode = document.querySelector('.artifact-preview code');
    expect(previewCode?.textContent).toContain('\n  "loss": 0.125,');
    expect(screen.queryByText('Auto-formatted JSON-like text')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show raw' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Artifact actions' }));
    expect(screen.getByRole('menuitemradio', { name: 'Formatted JSON' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Raw JSON' }));

    expect(document.querySelector('.artifact-preview code')?.textContent).toBe(compact);
    fireEvent.click(screen.getByRole('button', { name: 'Artifact actions' }));
    expect(screen.getByRole('menuitemradio', { name: 'Raw JSON' }).getAttribute('aria-checked')).toBe('true');
  });

  it('renders standalone managed HTML previews when legacy artifact history is absent', async () => {
    const collisionSafeRef = 'artifact:bbbbbbbbbbbb0';
    const contentHash = `bbbbbbbbbbbb0${'b'.repeat(51)}`;
    const artifact = {
      // The first 12 characters collide with another artifact. The backend
      // therefore projects the first safe prefix (13 characters) as the ID.
      id: collisionSafeRef,
      algorithm: 'sha256',
      content_hash: contentHash,
      uri: `artifact-blob:${contentHash}`,
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
    const artifactSeries = makeArtifactSeries('plot-html', [artifact], 'plot.html');
    const html = '<!doctype html><html><body><h1>Plot</h1><script>window.plotReady = true;</script></body></html>';
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/series?')) {
        return jsonResponse({ series: [artifactSeries.summary] });
      }
      if (url.startsWith('/api/artifacts/versions?')) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'no artifact version series found for ref' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }));
      }
      if (url.startsWith('/api/artifacts/resolve?')) {
        return jsonResponse({
          resolution: {
            status: 'resolved',
            ref: artifact.id,
            scheme: 'artifact',
            normalized_ref: artifact.id,
            artifact,
            alias: null,
            series: undefined,
            version: undefined,
            warnings: [],
          },
        });
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
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    render(h(ArtifactsView, { initialArtifactId: `artifact-blob:${artifact.content_hash}` }));

    await waitFor(() => expect(document.querySelector('.artifact-preview--html')).toBeTruthy());
    expect(screen.queryByText('no artifact version series found for ref')).toBeNull();
    const iframe = document.querySelector('.artifact-preview--html') as HTMLIFrameElement | null;
    expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe?.getAttribute('srcdoc')).toContain('<h1>Plot</h1>');

    fireEvent.click(screen.getByRole('button', { name: 'Copy artifact ref' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy selected artifact-version reference' }));
    expect(writeText).toHaveBeenNthCalledWith(1, collisionSafeRef);
    expect(writeText).toHaveBeenNthCalledWith(2, collisionSafeRef);

    fireEvent.click(screen.getByRole('button', { name: 'Artifact actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show metadata' }));
    const metadataDialog = screen.getByRole('dialog', { name: 'Artifact metadata' });
    fireEvent.click(within(metadataDialog).getByText('bbbbbbb').closest('button') as HTMLButtonElement);
    expect(writeText).toHaveBeenNthCalledWith(3, collisionSafeRef);
  });

  it('surfaces non-404 legacy history enrichment failures without losing the resolved artifact', async () => {
    const artifact = makeArtifactFixture('d', 'history-error.md');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/series?')) return jsonResponse({ series: [] });
      if (url.startsWith('/api/artifacts/versions?')) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'history service failed' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }));
      }
      if (url.startsWith('/api/artifacts/resolve?')) {
        return jsonResponse({
          resolution: {
            status: 'resolved',
            ref: `artifact-blob:${artifact.content_hash}`,
            scheme: 'artifact-blob',
            normalized_ref: `artifact-blob:${artifact.content_hash}`,
            artifact,
            alias: null,
            series: undefined,
            version: undefined,
            warnings: [],
          },
        });
      }
      if (url.endsWith('/content')) {
        return jsonResponse({
          content: {
            artifact_id: artifact.id,
            status: 'unavailable',
            kind: 'unavailable',
            media_type: artifact.media_type,
            size_bytes: artifact.size_bytes,
            source: null,
            preview: null,
            download: { available: false, media_type: artifact.media_type, size_bytes: 0, filename: null },
            reason: 'No inline preview is available.',
          },
        });
      }
      if (url.endsWith('/knowledge-backrefs')) return jsonResponse({ backrefs: [] });
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(h(ArtifactsView, { initialArtifactId: `artifact-blob:${artifact.content_hash}` }));

    await waitFor(() => expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('history-error.md'));
    expect(screen.getByText('Artifact detail: history service failed')).toBeTruthy();
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
    const firstSeries = makeArtifactSeries('one-series', [firstArtifact], 'one.md');
    const secondSeries = makeArtifactSeries('two-series', [secondArtifact], 'two.md');
    let listCalls = 0;
    const contentCalls: string[] = [];
    const mockFetch = vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/series?')) {
        const params = new URLSearchParams(url.split('?')[1] ?? '');
        if (params.get('limit') === '200') listCalls += 1;
        if (params.get('limit') === '200' && listCalls > 1) {
          return new Promise<Response>(() => undefined);
        }
        return jsonResponse({ series: [firstSeries.summary, secondSeries.summary] });
      }
      if (url.startsWith('/api/artifacts/versions?')) {
        return jsonResponse({
          history: url.includes('two-series') ? secondSeries.history : firstSeries.history,
        });
      }
      if (url.startsWith('/api/artifacts/resolve?')) {
        return jsonResponse({
          resolution: {
            status: 'resolved',
            ref: firstArtifact.id,
            scheme: 'artifact',
            normalized_ref: firstArtifact.id,
            artifact: firstArtifact,
            alias: null,
            series: undefined,
            version: undefined,
            warnings: [],
          },
        });
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
    await waitFor(() => expect(screen.getByRole('button', { name: /one\.md/ })).toBeTruthy());
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
    const artifactSeries = makeArtifactSeries('fast-summary', [summaryArtifact], 'fast-summary.md');
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
      if (url.startsWith('/api/artifacts/series?')) {
        listUrl = url;
        return jsonResponse({ series: [artifactSeries.summary] });
      }
      if (url.startsWith('/api/artifacts/versions?')) {
        return jsonResponse({ history: artifactSeries.history });
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
    await waitFor(() => expect(screen.getAllByText('Loading preview...')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Artifact actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show metadata' }));
    expect(within(screen.getByRole('dialog', { name: 'Artifact metadata' })).getByText('repo://mandible@main/results/fast-summary.md')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Artifact metadata' })).toBeNull());

    await act(async () => {
      resolveDetail(new Response(JSON.stringify({ artifact: fullArtifact }), {
        headers: { 'content-type': 'application/json' },
      }));
    });

    await waitFor(() => expect(screen.queryByText('Locators')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Artifact actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show metadata' }));
    const hydratedMetadata = screen.getByRole('dialog', { name: 'Artifact metadata' });
    await waitFor(() => expect(within(hydratedMetadata).getByText('Locators')).toBeTruthy());
    expect(within(hydratedMetadata).getAllByText(summaryArtifact.uri).length).toBeGreaterThan(1);
    expect(screen.getAllByText('Loading preview...')).toHaveLength(1);
  });

  it('renders the artifact list as soon as the list request resolves while preview content remains pending', async () => {
    const artifact = makeArtifactFixture('6', 'cold-load-report.md', {
      uri: 'repo://mandible@main/results/cold-load-report.md',
      repo_locator: { repo_id: 'mandible', ref: 'main', path: 'results/cold-load-report.md' },
      alias_schemes: ['artifact', 'repo'],
    });
    const artifactSeries = makeArtifactSeries('cold-load-report', [artifact], 'cold-load-report.md');
    let resolveList: (response: Response) => void = () => undefined;
    const listPromise = new Promise<Response>((resolve) => {
      resolveList = resolve;
    });
    const contentCalls: string[] = [];
    let listRequestSeen = false;

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/series?')) {
        if (url.includes('limit=200')) {
          listRequestSeen = true;
          return listPromise;
        }
        return jsonResponse({ series: [] });
      }
      if (url.startsWith('/api/artifacts/versions?')) {
        return jsonResponse({ history: artifactSeries.history });
      }
      if (url.endsWith('/content')) {
        contentCalls.push(url);
        return new Promise<Response>(() => undefined);
      }
      if (url.endsWith('/knowledge-backrefs')) {
        return jsonResponse({ backrefs: [] });
      }
      if (url.includes(encodeURIComponent(artifact.id))) {
        return jsonResponse({ artifact });
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(h(ArtifactsView, {}));

    await waitFor(() => expect(listRequestSeen).toBe(true));
    expect(contentCalls).toHaveLength(0);
    expect(screen.getByText('Loading artifacts...')).toBeTruthy();

    await act(async () => {
      resolveList(new Response(JSON.stringify({ series: [artifactSeries.summary] }), {
        headers: { 'content-type': 'application/json' },
      }));
    });

    await waitFor(() => expect(screen.getByRole('button', { name: /cold-load-report\.md/ })).toBeTruthy());
    expect(screen.queryByText('Loading artifacts...')).toBeNull();
    await waitFor(() => expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('cold-load-report.md'));
    await waitFor(() => expect(contentCalls).toHaveLength(1));
    await waitFor(() => expect(screen.getAllByText('Loading preview...')).toHaveLength(1));
  });

  it('starts artifact metadata and content requests in parallel for direct artifact links', async () => {
    const artifact = makeArtifactFixture('7', 'parallel-detail.md');
    const artifactSeries = makeArtifactSeries('parallel-detail', [artifact], 'parallel-detail.md');
    const calls: string[] = [];
    let resolveDetail: (response: Response) => void = () => undefined;
    const detailPromise = new Promise<Response>((resolve) => {
      resolveDetail = resolve;
    });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith('/api/artifacts/series?')) return jsonResponse({ series: [artifactSeries.summary] });
      if (url.startsWith('/api/artifacts/versions?')) return jsonResponse({ history: artifactSeries.history });
      if (url.startsWith('/api/artifacts/resolve?')) {
        return jsonResponse({
          resolution: {
            status: 'resolved',
            ref: artifact.id,
            scheme: 'artifact',
            normalized_ref: artifact.id,
            artifact,
            alias: null,
            series: undefined,
            version: undefined,
            warnings: [],
          },
        });
      }
      if (url.endsWith('/content')) {
        return new Promise<Response>(() => undefined);
      }
      if (url.endsWith('/knowledge-backrefs')) return jsonResponse({ backrefs: [] });
      if (url.includes(encodeURIComponent(artifact.id))) return detailPromise;
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(h(ArtifactsView, { initialArtifactId: artifact.id }));

    await waitFor(() => {
      expect(calls.some((url) => url.includes(encodeURIComponent(artifact.id)) && !url.endsWith('/content'))).toBe(true);
      expect(calls.some((url) => url.endsWith('/content') && url.includes(encodeURIComponent(artifact.id)))).toBe(true);
    });

    await act(async () => {
      resolveDetail(new Response(JSON.stringify({ artifact }), {
        headers: { 'content-type': 'application/json' },
      }));
    });
  });

  it('ignores stale preview content when artifact selection changes early', async () => {
    const firstArtifact = makeArtifactFixture('1', 'early-one.md');
    const secondArtifact = makeArtifactFixture('2', 'early-two.md');
    const firstSeries = makeArtifactSeries('early-one-series', [firstArtifact], 'early-one.md');
    const secondSeries = makeArtifactSeries('early-two-series', [secondArtifact], 'early-two.md');
    let resolveFirstContent: (response: Response) => void = () => undefined;
    let resolveSecondContent: (response: Response) => void = () => undefined;
    const firstContent = new Promise<Response>((resolve) => {
      resolveFirstContent = resolve;
    });
    const secondContent = new Promise<Response>((resolve) => {
      resolveSecondContent = resolve;
    });
    const contentCalls: string[] = [];

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/series?')) {
        return jsonResponse({ series: [firstSeries.summary, secondSeries.summary] });
      }
      if (url.startsWith('/api/artifacts/versions?')) {
        return jsonResponse({ history: url.includes('early-two-series') ? secondSeries.history : firstSeries.history });
      }
      if (url.endsWith('/content')) {
        contentCalls.push(url);
        return url.includes(encodeURIComponent(secondArtifact.id)) ? secondContent : firstContent;
      }
      if (url.endsWith('/knowledge-backrefs')) return jsonResponse({ backrefs: [] });
      if (url.includes(encodeURIComponent(firstArtifact.id))) return jsonResponse({ artifact: firstArtifact });
      if (url.includes(encodeURIComponent(secondArtifact.id))) return jsonResponse({ artifact: secondArtifact });
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(h(ArtifactsView, {}));

    await waitFor(() => expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('early-one.md'));
    await waitFor(() => expect(contentCalls.some((url) => url.includes(encodeURIComponent(firstArtifact.id)))).toBe(true));
    expect(screen.getAllByText('Loading preview...')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: /early-two\.md/ }));

    await waitFor(() => expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('early-two.md'));
    await waitFor(() => expect(contentCalls.some((url) => url.includes(encodeURIComponent(secondArtifact.id)))).toBe(true));

    resolveFirstContent(new Response(JSON.stringify({
      content: {
        artifact_id: firstArtifact.id,
        status: 'available',
        kind: 'text',
        media_type: 'text/plain',
        size_bytes: 16,
        source: { kind: 'managed_file', locator: 'artifact-storage' },
        preview: { encoding: 'utf-8', text: 'stale first preview', truncated: false },
        download: { available: true, media_type: 'text/plain', size_bytes: 16, filename: 'early-one.md' },
      },
    }), { headers: { 'content-type': 'application/json' } }));
    resolveSecondContent(new Response(JSON.stringify({
      content: {
        artifact_id: secondArtifact.id,
        status: 'available',
        kind: 'text',
        media_type: 'text/plain',
        size_bytes: 18,
        source: { kind: 'managed_file', locator: 'artifact-storage' },
        preview: { encoding: 'utf-8', text: 'current second preview', truncated: false },
        download: { available: true, media_type: 'text/plain', size_bytes: 18, filename: 'early-two.md' },
      },
    }), { headers: { 'content-type': 'application/json' } }));

    await waitFor(() => expect(screen.getByText('current second preview')).toBeTruthy());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.queryByText('stale first preview')).toBeNull();
    expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('early-two.md');
  });

  it('keeps artifact overlays scoped and layered by CSS contract', () => {
    const css = readResolvedStylesheet();
    expect(css).toMatch(/\.detail-pane-shell\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*flex:\s*1;[^}]*min-height:\s*0;[^}]*overflow:\s*clip;/s);
    expect(css).toMatch(/\.detail-pane-shell__header\s*\{[^}]*flex:\s*none;[^}]*width:\s*100%;/s);
    expect(css).toMatch(/\.detail-pane-shell__body\s*\{[^}]*flex:\s*1;[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/s);
    expect(css).toMatch(/\.detail-pane-shell__body--overlay-open\s*\{[^}]*overflow:\s*hidden;/s);
    expect(css).toMatch(/\.detail-pane-shell__overlay-host\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*pointer-events:\s*none;/s);
    expect(css).toMatch(/\.issues-detail\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s);
    expect(css).not.toMatch(/\.issues-detail\s*\{[^}]*background:/s);
    expect(css).toMatch(/\.issues-detail__content\s*\{[^}]*display:\s*flex;[^}]*flex:\s*1;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s);
    expect(css).toMatch(/\.issues-detail__content \.ledger-issue-detail\s*\{[^}]*flex:\s*1;[^}]*min-height:\s*0;[^}]*gap:\s*0;[^}]*overflow:\s*hidden;/s);
    expect(css).toMatch(/\.issues-detail \.ledger-issue-detail__header\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*12;/s);
    expect(css).not.toMatch(/(?:^|\n)\.issues-detail \.ledger-issue-detail__header\s*\{[^}]*(?:padding|background):/s);
    expect(css).not.toMatch(/\.issues-detail \.ledger-issue-detail__header\s*\{[^}]*position:\s*sticky;/s);
    expect(css).toMatch(/\.issues-detail \.ledger-issue-detail__body\s*\{[^}]*display:\s*flex;[^}]*flex:\s*1;[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior-y:\s*contain;[^}]*padding:\s*18px 24px 24px;/s);
    expect(css).toMatch(/\.issues-detail--metadata-open \.ledger-issue-detail__body\s*\{[^}]*overflow:\s*hidden;/s);
    expect(css).toMatch(/\.artifacts-detail\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*overflow:\s*hidden;/s);
    expect(css).not.toMatch(/\.artifacts-detail\s*\{[^}]*background:/s);
    expect(css).not.toMatch(/\.artifacts-detail\s*\{[^}]*padding:\s*24px;/s);
    expect(css).toMatch(/\.artifacts-detail--metadata-open,\s*\.issues-detail--metadata-open\s*\{[^}]*overflow:\s*hidden;/s);
    expect(css).toMatch(/\.auth-detail--metadata-open\s*\{[^}]*overflow:\s*hidden;/s);
    expect(css).toMatch(/\.artifact-detail__actions-menu\s*\{[^}]*position:\s*fixed;/s);
    expect(css).toMatch(/\.artifact-detail\s*\{[^}]*display:\s*flex;[^}]*flex:\s*1;[^}]*flex-direction:\s*column;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s);
    expect(css).toMatch(/\.artifact-detail__header\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*8;/s);
    expect(css).not.toMatch(/\.artifact-detail__header\s*\{[^}]*padding:/s);
    expect(css).not.toMatch(/\.artifact-detail__header\s*\{[^}]*margin:\s*-24px -24px 0;/s);
    expect(css).toMatch(/\.artifact-detail__pane\s*\{[^}]*--artifact-detail-pane-max-height:\s*calc\(100vh - 190px\);[^}]*position:\s*relative;[^}]*flex:\s*1;[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior-y:\s*contain;[^}]*padding:\s*18px 24px 24px;/s);
    expect(css).not.toMatch(/\.artifact-detail__pane\s*\{[^}]*background:/s);
    expect(css).not.toMatch(/\.artifact-detail__pane\s*\{[^}]*margin:\s*0 -24px -24px;/s);
    expect(css).toMatch(/\.artifact-detail__pane--metadata-open\s*\{[^}]*overflow:\s*hidden;/s);
    expect(css).not.toMatch(/\.artifact-detail__body\s*\{/);
    expect(css).toMatch(/\.detail-pane-modal\s*\{[^}]*position:\s*fixed;[^}]*top:\s*var\(--detail-pane-modal-top\);[^}]*right:\s*var\(--detail-pane-modal-right\);[^}]*bottom:\s*var\(--detail-pane-modal-bottom\);[^}]*left:\s*var\(--detail-pane-modal-left\);[^}]*background:\s*rgba\(5,10,14,0\.32\);/s);
    expect(css).toMatch(/\.detail-pane-modal__panel,\s*\.artifact-detail__metadata-panel\s*\{[^}]*max-height:\s*min\(100%, var\(--artifact-detail-pane-max-height\)\);[^}]*overflow:\s*auto;/s);
    expect(css).toMatch(/\.artifact-preview\s*\{[^}]*overflow:\s*auto;/s);
    const styleRules = Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g)).map((match) => ({
      selectors: match[1].split(',').map((selector) => selector.trim()),
      body: match[2],
    }));
    const baseArtifactPreviewRules = styleRules.filter((rule) =>
      rule.selectors.includes('.artifact-preview'),
    );
    expect(baseArtifactPreviewRules.length).toBeGreaterThan(0);
    for (const rule of baseArtifactPreviewRules) {
      expect(rule.body).not.toMatch(/\bborder(?:-(?!radius\b)[\w-]+)?\s*:/);
      expect(rule.body).not.toMatch(/\bpadding(?:-[\w-]+)?\s*:/);
    }

    const lightArtifactPreviewRules = styleRules.filter((rule) =>
      rule.selectors.some(
        (selector) =>
          /\[data-theme=(['"])light\1\]/.test(selector) &&
          /\.artifact-preview(?![\w-])/.test(selector),
      ),
    );
    const canonicalLightArtifactPreviewRules = lightArtifactPreviewRules.filter((rule) =>
      rule.selectors.includes("[data-theme='light'] .artifact-preview:not(.artifact-preview--code)"),
    );
    expect(canonicalLightArtifactPreviewRules.some((rule) =>
      /background:\s*var\(--bg-card\)/.test(rule.body),
    )).toBe(true);
    for (const rule of lightArtifactPreviewRules) {
      expect(rule.body).not.toMatch(
        /background(?:-color)?:\s*(?:#[\da-f]{3,8}\b|(?:rgb|hsl)a?\(|(?:white|gray|grey|lightgray|lightgrey|gainsboro)\b)/i,
      );
    }
    expect(css).not.toMatch(/\.artifact-preview-frame/);
    const codePreviewRule = ruleBody(css, ':root[data-theme] .artifact-preview--code');
    expect(codePreviewRule).toContain('background: transparent');
    expect(codePreviewRule).toContain('color: var(--text-primary)');
    expect(codePreviewRule).toContain('font-family: var(--font-mono)');
    expect(codePreviewRule).toContain('padding: var(--space-3) 0');
    expect(css).not.toMatch(/\.artifact-preview--code[^}]*color:\s*#/s);
    expect(css).not.toMatch(/\.artifact-preview--code\s*\{[^}]*min-height:/s);
    expect(css).toMatch(/\.artifact-preview--partial\s*\{[^}]*max-height:\s*min\(720px, calc\(100vh - 330px\)\);/s);
    expect(css).not.toMatch(/\.artifact-preview\.spec-panel\s*\{/);
    expect(css).toMatch(/\.detail-pane-header :is\(button, a\):focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent-blue\)/s);
    expect(css).toMatch(/select:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent-blue\)/s);
    expect(css).not.toMatch(/\.artifact-detail__copy-button/);
  });

  it('keeps auth detail surfaces visually separated by the app subdivision contract', () => {
    const css = readResolvedStylesheet();
    const rightEdge = ruleBody(css, '.app-shell__workspace::after');
    const leftEdge = ruleBody(css, '.app-shell--left-shadow::before');

    expect(rightEdge).toContain('inset: 0 auto 0 calc(var(--app-detail-edge-x) - var(--app-boundary-shadow-paint-width))');
    expect(rightEdge).toContain('z-index: var(--z-app-subdivision)');
    expect(rightEdge).toContain('width: calc(var(--app-boundary-shadow-paint-width) + 1px)');
    expect(rightEdge).toContain('background-color: transparent');
    expect(rightEdge).toContain('--app-boundary-divider-paint: linear-gradient(var(--app-boundary-accent), var(--app-boundary-accent))');
    expect(rightEdge).toMatch(/background-image:\s*var\(--app-boundary-divider-paint\),\s*var\(--shadow-app-subdivision-paint\);/s);
    expect(rightEdge).toContain('background-position: right, left');
    expect(rightEdge).toContain('background-size: 1px 100%, var(--app-boundary-shadow-paint-width) 100%');
    expect(css.match(/--app-boundary-divider-paint:/g)).toHaveLength(1);
    expect(leftEdge).toContain('width: var(--app-boundary-shadow-paint-width)');
    expect(leftEdge).toContain('background-image: var(--shadow-app-subdivision-paint)');
    expect(leftEdge).not.toMatch(/divider|1px|box-shadow/);
    expect(css).not.toMatch(/\.(?:app-header|app-layout|view-sidebar)::after\s*\{[^}]*shadow-app-subdivision-paint/s);
    expect(css).toMatch(/\.app-content\s*>\s*\*\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*1;/s);
    expect(css).toMatch(/\.auth-sidebar-layout\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*2;[^}]*isolation:\s*isolate;/s);
    expect(css).toMatch(/\.auth-detail\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*3;[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*overflow:\s*hidden;/s);
    expect(css).not.toMatch(/\.auth-detail\s*\{[^}]*padding:\s*24px;/s);
    expect(css).toMatch(/\.auth-detail-pane\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*1;[^}]*flex:\s*1;[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*overflow:\s*hidden;/s);
    expect(css).toMatch(/\.auth-detail__header\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*2;[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s);
    expect(css).not.toMatch(/\.auth-detail__header\s*\{[^}]*margin:\s*-24px -24px 0;/s);
    expect(css).toMatch(/\.auth-detail__body\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*flex:\s*1;[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior-y:\s*contain;[^}]*padding:\s*20px 24px 24px;/s);
    expect(css).not.toMatch(/\.auth-detail__header-primary\s*\{[^}]*display:\s*grid;[^}]*padding:\s*20px 24px;/s);
    expect(css).toMatch(/\.auth-detail__aux-header\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*space-between;[^}]*min-height:\s*var\(--app-header-height\);[^}]*padding:\s*0 24px;[^}]*border-bottom:\s*1px solid var\(--neutral-alpha-06\);/s);
    expect(css).toMatch(/\.auth-detail__header-primary \.detail-pane-header\s*\{[^}]*border-bottom:\s*0;/s);
    expect(css).toMatch(/\.icon-tab-list > button\s*\{[^}]*border-bottom:\s*2px solid transparent;/s);
    expect(css).toMatch(/\.icon-tab-list > button\[aria-selected='true'\]\s*\{[^}]*border-bottom-color:\s*var\(--accent-blue\);/s);
    expect(css).toMatch(/\.auth-detail-pane\s*\{[^}]*container:\s*auth-detail \/ inline-size;/s);
    expect(css).toMatch(/\.auth-detail__panels\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/s);
    expect(css).toMatch(/@container auth-detail \(min-width:\s*1120px\)\s*\{\s*\.auth-detail__panels--with-actions\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*2fr\)\s+minmax\(260px,\s*1fr\);/s);
    expect(css).toMatch(/\.auth-detail__panels--single\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/s);
    expect(css).not.toMatch(/@media[^}]*\.auth-detail__panels\s*\{/s);
    expect(css).not.toMatch(/\.panel__badge|\.canonical-message/);
    expect(css).toMatch(/\.auth-detail__right-col\s*\{[^}]*align-self:\s*start;/s);
    expect(css).toMatch(/\.auth-detail__right-col \.auth-action-bundle\s*\{[^}]*margin-top:\s*0;/s);
    expect(css).toMatch(/\.auth-diff-file \.d2h-code-wrapper\s*\{[^}]*max-width:\s*100%;[^}]*overflow:\s*auto hidden;/s);
    expect(css).toMatch(/\.auth-diff-file \.d2h-diff-table\s*\{[^}]*min-width:\s*100%;[^}]*width:\s*max-content;/s);
    expect(css).toMatch(/\.auth-diff-file \.d2h-cntx,\s*\.auth-diff-file \.d2h-ins,\s*\.auth-diff-file \.d2h-del,\s*\.auth-diff-file \.d2h-info\s*\{[^}]*height:\s*18px;[^}]*padding-bottom:\s*0;[^}]*padding-top:\s*0;[^}]*white-space:\s*nowrap;/s);
    expect(css).toMatch(/\.auth-diff-file \.d2h-code-line,\s*\.auth-diff-file \.d2h-code-side-line\s*\{[^}]*display:\s*flex;[^}]*height:\s*18px;[^}]*line-height:\s*18px;[^}]*overflow:\s*visible;[^}]*white-space:\s*normal;/s);
    expect(css).toMatch(/\.auth-diff-file \.d2h-code-line-ctn\s*\{[^}]*display:\s*inline-block;[^}]*flex:\s*0 0 auto;[^}]*overflow-wrap:\s*normal;[^}]*white-space:\s*pre;[^}]*word-break:\s*normal;/s);
    expect(css).toMatch(/\.auth-diff-file \.d2h-code-line-prefix\s*\{[^}]*display:\s*inline-block;[^}]*flex:\s*0 0 12px;[^}]*line-height:\s*18px;/s);
    expect(css).toMatch(/:root\[data-theme='light'\]\s+\.collapsible-panel\s*\{[^}]*background:\s*#ffffff;[^}]*border-color:\s*var\(--neutral-alpha-08\);/s);
    expect(css).toMatch(/\.auth-action-row\s*\{[^}]*padding:\s*12px 0;[^}]*border-top:\s*1px solid var\(--neutral-alpha-06\);[^}]*background:\s*transparent;/s);
    expect(css).toMatch(/:root\[data-theme='light'\]\s+\.auth-detail__body\s+\.auth-action-bundle\s*\{\s*background:\s*transparent;\s*\}/s);
    expect(css).toMatch(/:root\[data-theme='light'\]\s+\.auth-action-row--staged\s*\{[^}]*border-color:\s*var\(--neutral-alpha-06\);[^}]*background:\s*transparent;/s);
  });

  it('keeps artifact facet options available after selecting a facet value', async () => {
    const storedViewState = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storedViewState.get(key) ?? null,
        setItem: (key: string, value: string) => storedViewState.set(key, value),
        removeItem: (key: string) => storedViewState.delete(key),
      },
    });
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
    const seriesRows = [
      makeArtifactSeries('input-series', [inputArtifact], 'input.md').summary,
      makeArtifactSeries('output-series', [outputArtifact], 'output.md').summary,
    ];
    const listUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/series?')) {
        listUrls.push(url);
        const params = new URLSearchParams(url.split('?')[1] ?? '');
        let rows = seriesRows;
        const role = params.get('role');
        const repo = params.get('repo');
        if (role) rows = rows.filter((series) => series.latest_artifact?.role === role);
        if (repo) rows = rows.filter((series) => series.latest_artifact?.home_repo_id === repo);
        return jsonResponse({ series: rows });
      }
      if (url.startsWith('/api/artifacts/versions?')) {
        const artifact = url.includes('output-series') ? outputArtifact : inputArtifact;
        const seriesId = url.includes('output-series') ? 'output-series' : 'input-series';
        return jsonResponse({ history: makeArtifactSeries(seriesId, [artifact]).history });
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

    const filterDialog = screen.getByRole('dialog', { name: 'Artifact filter and sort controls' });
    expect(filterDialog.classList.contains('sidebar-search-filter__panel--popover')).toBe(true);
    expect(filterDialog.classList.contains('sidebar-search-filter__panel--inline')).toBe(false);

    const sortField = screen.getByLabelText('Field') as HTMLSelectElement;
    changeSelect(sortField, 'title');
    fireEvent.click(screen.getByRole('button', { name: 'Descending' }));
    await waitFor(() => {
      const names = Array.from(document.querySelectorAll('.artifacts-sidebar__name')).map((node) => node.textContent);
      expect(names).toEqual(['output.md', 'input.md']);
    });
    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem('mandible:artifacts:list-controls:v1') ?? '{}');
      expect(stored.sortField).toBe('title');
      expect(stored.sortDirection).toBe('desc');
    });

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

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Artifact filter and sort controls' })).toBeNull();
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
    const listSeries = makeArtifactSeries('sidebar-series', [listArtifact], 'sidebar-first.md');
    const linkedSeries = makeArtifactSeries('deep-link-series', [linkedArtifact], 'deep-link.md');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/series?')) {
        return jsonResponse({ series: [listSeries.summary] });
      }
      if (url.startsWith('/api/artifacts/versions?')) {
        return jsonResponse({ history: linkedSeries.history });
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
            series: linkedSeries.history.series,
            version: linkedSeries.history.versions[0],
            warnings: [],
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
    expect(await screen.findByText('sidebar-first.md')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Artifact actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show metadata' }));
    expect(within(screen.getByRole('dialog', { name: 'Artifact metadata' })).getByText(ref)).toBeTruthy();
  });

  it('pins legacy artifact deep links to the exact resolved version', async () => {
    const v1 = makeArtifactFixture('8', 'report-v1.md');
    const v2 = makeArtifactFixture('9', 'report-v2.md');
    const artifactSeries = makeArtifactSeries('report-series', [v1, v2], 'report.md');
    const versionRefs: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/series?')) return jsonResponse({ series: [artifactSeries.summary] });
      if (url.startsWith('/api/artifacts/versions?')) {
        const ref = new URLSearchParams(url.split('?')[1] ?? '').get('ref') ?? '';
        versionRefs.push(ref);
        if (ref === v1.id || ref === artifactSeries.summary.ref) return jsonResponse({ history: artifactSeries.history });
        return Promise.reject(new Error(`unexpected versions ref ${ref}`));
      }
      if (url.startsWith('/api/artifacts/resolve?')) {
        return jsonResponse({
          resolution: {
            status: 'resolved',
            ref: v1.id,
            scheme: 'artifact',
            normalized_ref: v1.id,
            artifact: v1,
            alias: null,
            series: undefined,
            version: undefined,
            warnings: [],
          },
        });
      }
      if (url.endsWith('/content')) {
        return jsonResponse({
          content: {
            artifact_id: v1.id,
            status: 'unavailable',
            kind: 'unavailable',
            media_type: 'text/markdown',
            size_bytes: 0,
            source: null,
            preview: null,
            download: { available: false, media_type: 'text/markdown', size_bytes: 0, filename: null },
            reason: 'No inline preview is available.',
          },
        });
      }
      if (url.endsWith('/knowledge-backrefs')) return jsonResponse({ backrefs: [] });
      if (url.includes(encodeURIComponent(v1.id))) return jsonResponse({ artifact: v1 });
      if (url.includes(encodeURIComponent(v2.id))) return jsonResponse({ artifact: v2 });
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(h(ArtifactsView, { initialArtifactId: v1.id }));

    await waitFor(() => expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('report-v1.md'));
    const versionSelect = screen.getByRole('combobox', { name: 'Artifact version' }) as HTMLSelectElement;
    await waitFor(() => expect(versionSelect.value).toBe('1'));
    fireEvent.click(screen.getByRole('button', { name: 'Artifact actions' }));
    expect(screen.getByRole('menuitem', { name: 'Jump to latest' })).toBeTruthy();
    expect(screen.queryByText('series_latest_not_pinned')).toBeNull();
    expect(versionRefs).toContain(v1.id);
    await waitFor(() => expect(versionRefs).toContain(artifactSeries.summary.ref));
    expect(versionRefs).not.toContain(`artifact-series:${artifactSeries.summary.ref}`);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show metadata' }));
    expect(within(screen.getByRole('dialog', { name: 'Artifact metadata' })).getByText(artifactSeries.summary.ref)).toBeTruthy();
  });

  it('keeps artifact-series @latest refs latest-tracking and shows the resolver warning badge', async () => {
    const v1 = makeArtifactFixture('a', 'latest-v1.md');
    const v2 = makeArtifactFixture('b', 'latest-v2.md');
    const artifactSeries = makeArtifactSeries('latest-series', [v1, v2], 'latest-report.md');
    const ref = 'artifact-series:latest-series@latest';
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/series?')) return jsonResponse({ series: [artifactSeries.summary] });
      if (url.startsWith('/api/artifacts/versions?')) return jsonResponse({ history: artifactSeries.history });
      if (url.startsWith('/api/artifacts/resolve?')) {
        return jsonResponse({
          resolution: {
            status: 'resolved',
            ref,
            scheme: 'artifact-series',
            normalized_ref: ref,
            artifact: v2,
            alias: null,
            logical_artifact: { ...artifactSeries.history.series, id: 'artifact:latest-series' },
            artifact_version: artifactSeries.history.versions[1],
            warnings: ['series_latest_not_pinned'],
          },
        });
      }
      if (url.endsWith('/content')) {
        return jsonResponse({
          content: {
            artifact_id: v2.id,
            status: 'unavailable',
            kind: 'unavailable',
            media_type: 'text/markdown',
            size_bytes: 0,
            source: null,
            preview: null,
            download: { available: false, media_type: 'text/markdown', size_bytes: 0, filename: null },
            reason: 'No inline preview is available.',
          },
        });
      }
      if (url.endsWith('/knowledge-backrefs')) return jsonResponse({ backrefs: [] });
      if (url.includes(encodeURIComponent(v2.id))) return jsonResponse({ artifact: v2 });
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(h(ArtifactsView, { initialArtifactId: ref }));

    await waitFor(() => expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('latest-report.md'));
    expect((screen.getByRole('combobox', { name: 'Artifact version' }) as HTMLSelectElement).value).toBe('');
    expect(document.querySelector('.artifact-detail__badge')).toBeNull();
    expect(screen.getByText('series_latest_not_pinned')).toBeTruthy();
  });

  it.each([
    `artifact-blob:${'b'.repeat(64)}`,
    'artifact-version:version-1',
    `artifact:sha256:${'c'.repeat(64)}`,
  ])('rejects immutable typed refs supplied through series= without loading version history: %s', async (invalidSeriesRef) => {
    const versionRequests: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/series?')) return jsonResponse({ series: [] });
      if (url.startsWith('/api/artifacts/versions?')) {
        versionRequests.push(url);
        return Promise.reject(new Error(`unexpected versions request ${url}`));
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(h(ArtifactsView, { initialSeriesRef: invalidSeriesRef, initialVersionNo: 1 }));

    await waitFor(() => expect(screen.getByText(`Invalid series reference: ${invalidSeriesRef}`)).toBeTruthy());
    expect(versionRequests).toEqual([]);
    expect(screen.getByText('No artifacts in this view.')).toBeTruthy();
  });

  it('ignores delayed version history after navigation clears the selected series', async () => {
    const artifact = makeArtifactFixture('e', 'stale-series.md');
    const artifactSeries = makeArtifactSeries('stale-series', [artifact], 'stale-series.md');
    let resolveHistory: (response: Response) => void = () => undefined;
    const delayedHistory = new Promise<Response>((resolve) => {
      resolveHistory = resolve;
    });
    const versionRequests: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/series?')) return jsonResponse({ series: [] });
      if (url.startsWith('/api/artifacts/versions?')) {
        versionRequests.push(url);
        return delayedHistory;
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    const { rerender } = render(h(ArtifactsView, { initialSeriesRef: artifactSeries.summary.ref }));
    await waitFor(() => expect(versionRequests).toHaveLength(1));

    const invalidSeriesRef = `artifact-blob:${artifact.content_hash}`;
    rerender(h(ArtifactsView, { initialSeriesRef: invalidSeriesRef }));
    await waitFor(() => expect(screen.getByText(`Invalid series reference: ${invalidSeriesRef}`)).toBeTruthy());

    resolveHistory(new Response(JSON.stringify({ history: artifactSeries.history }), {
      headers: { 'content-type': 'application/json' },
    }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(document.querySelector('.artifact-detail h2')).toBeNull();
    expect(screen.getByText(`Invalid series reference: ${invalidSeriesRef}`)).toBeTruthy();
  });

  it.each(['blob', 'version', 'series'] as const)(
    'preserves canonical ref= %s selection semantics',
    async (kind) => {
      const v1 = makeArtifactFixture('4', 'typed-v1.md');
      const v2 = makeArtifactFixture('5', 'typed-v2.md');
      const artifactSeries = makeArtifactSeries('typed-series', [v1, v2], 'typed-report.md');
      const ref = kind === 'blob'
        ? `artifact-blob:${v1.content_hash}`
        : kind === 'version'
          ? artifactSeries.history.versions[0].id
          : 'artifact-series:typed-series@latest';
      const artifact = kind === 'series' ? v2 : v1;
      const version = kind === 'blob'
        ? undefined
        : kind === 'series'
          ? artifactSeries.history.versions[1]
          : artifactSeries.history.versions[0];
      const versionRequests: string[] = [];
      vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
        const url = String(input);
        if (url.startsWith('/api/artifacts/series?')) return jsonResponse({ series: [artifactSeries.summary] });
        if (url.startsWith('/api/artifacts/versions?')) {
          versionRequests.push(url);
          return jsonResponse({ history: artifactSeries.history });
        }
        if (url.startsWith('/api/artifacts/resolve?')) {
          return jsonResponse({
            resolution: {
              status: 'resolved',
              ref,
              scheme: kind === 'series' ? 'artifact-series' : `artifact-${kind}`,
              normalized_ref: ref,
              target_type: kind === 'blob' ? 'artifact_blob' : kind === 'version' ? 'artifact_version' : 'artifact',
              artifact_blob: kind === 'blob' ? { id: ref, ref } : undefined,
              artifact,
              alias: null,
              logical_artifact: kind === 'blob' ? undefined : { ...artifactSeries.history.series, id: 'artifact:typed-series' },
              artifact_version: version,
              warnings: kind === 'series' ? ['series_latest_not_pinned'] : [],
            },
          });
        }
        if (url.endsWith('/content')) {
          return jsonResponse({
            content: {
              artifact_id: artifact.id,
              status: 'unavailable',
              kind: 'unavailable',
              media_type: artifact.media_type,
              size_bytes: artifact.size_bytes,
              source: null,
              preview: null,
              download: { available: false, media_type: artifact.media_type, size_bytes: 0, filename: null },
              reason: 'No inline preview is available.',
            },
          });
        }
        if (url.endsWith('/knowledge-backrefs')) return jsonResponse({ backrefs: [] });
        return Promise.reject(new Error(`unexpected fetch ${url}`));
      }));

      render(h(ArtifactsView, { initialRef: ref }));

      if (kind === 'blob') {
        await screen.findByRole('heading', { name: ref });
        expect(screen.getByText(/Artifact blobs identify bytes/)).toBeTruthy();
        expect(screen.getByRole('link', { name: '7da339a' }).getAttribute('href')).toContain('issue=7da339a');
        expect(versionRequests).toEqual([]);
      } else {
        await waitFor(() => expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('typed-report.md'));
        await waitFor(() => expect(versionRequests).toHaveLength(1));
        await waitFor(() => {
          expect((screen.getByRole('combobox', { name: 'Artifact version' }) as HTMLSelectElement).value)
            .toBe(kind === 'series' ? '' : '1');
        });
      }
    },
  );

  it('keeps artifact detail mounted while switching versions', async () => {
    const v1 = makeArtifactFixture('1', 'stable-v1.md');
    const v2 = makeArtifactFixture('2', 'stable-v2.md');
    const artifactSeries = makeArtifactSeries('stable-series', [v1, v2], 'stable-report.md');
    let resolveV2Detail: (response: Response) => void = () => undefined;
    const v2Detail = new Promise<Response>((resolve) => {
      resolveV2Detail = resolve;
    });
    const contentCalls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/series?')) return jsonResponse({ series: [artifactSeries.summary] });
      if (url.startsWith('/api/artifacts/versions?')) return jsonResponse({ history: artifactSeries.history });
      if (url.endsWith('/content')) {
        contentCalls.push(url);
        const artifact = url.includes(encodeURIComponent(v1.id)) ? v1 : v2;
        return jsonResponse({
          content: {
            artifact_id: artifact.id,
            status: 'available',
            kind: 'text',
            media_type: 'text/plain',
            size_bytes: artifact.id.length,
            source: { kind: 'managed_file', locator: 'artifact-storage' },
            preview: { encoding: 'utf-8', text: artifact.metadata.title, truncated: false },
            download: { available: true, media_type: 'text/plain', size_bytes: artifact.id.length, filename: null },
          },
        });
      }
      if (url.endsWith('/knowledge-backrefs')) return jsonResponse({ backrefs: [] });
      if (url.includes(encodeURIComponent(v1.id))) return jsonResponse({ artifact: v1 });
      if (url.includes(encodeURIComponent(v2.id))) return v2Detail;
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(h(ArtifactsView, { initialSeriesRef: artifactSeries.summary.ref, initialVersionNo: 1 }));

    await waitFor(() => expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('stable-report.md'));
    await waitFor(() => expect(screen.getAllByText('stable-v1.md').length).toBeGreaterThan(0));

    changeSelect(screen.getByRole('combobox', { name: 'Artifact version' }) as HTMLSelectElement, '2');

    await waitFor(() => expect(screen.getByRole('status')?.textContent).toBe('Loading artifact...'));
    expect(document.querySelector('.artifact-detail h2')).toBeNull();
    expect(screen.queryByText('Loading preview...')).toBeNull();

    resolveV2Detail(new Response(JSON.stringify({ artifact: v2 }), {
      headers: { 'content-type': 'application/json' },
    }));

    await waitFor(() => expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('stable-report.md'));
    await waitFor(() => expect(contentCalls.some((url) => url.includes(encodeURIComponent(v2.id)))).toBe(true));
  });

  it('keeps pinned version and open history stable when the series sidebar refetches with a newer latest', async () => {
    const v1 = makeArtifactFixture('c', 'pinned-v1.md');
    const v2 = makeArtifactFixture('d', 'pinned-v2.md');
    const v3 = makeArtifactFixture('e', 'pinned-v3.md');
    const initialSeries = makeArtifactSeries('pinned-series', [v1, v2], 'pinned-report.md');
    const refreshedSeries = makeArtifactSeries('pinned-series', [v1, v2, v3], 'pinned-report.md');
    let seriesCalls = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/series?')) {
        seriesCalls += 1;
        return jsonResponse({ series: [seriesCalls > 2 ? refreshedSeries.summary : initialSeries.summary] });
      }
      if (url.startsWith('/api/artifacts/versions?')) return jsonResponse({ history: initialSeries.history });
      if (url.endsWith('/content')) {
        return jsonResponse({
          content: {
            artifact_id: v1.id,
            status: 'unavailable',
            kind: 'unavailable',
            media_type: 'text/markdown',
            size_bytes: 0,
            source: null,
            preview: null,
            download: { available: false, media_type: 'text/markdown', size_bytes: 0, filename: null },
            reason: 'No inline preview is available.',
          },
        });
      }
      if (url.endsWith('/knowledge-backrefs')) return jsonResponse({ backrefs: [] });
      if (url.includes(encodeURIComponent(v1.id))) return jsonResponse({ artifact: v1 });
      if (url.includes(encodeURIComponent(v2.id))) return jsonResponse({ artifact: v2 });
      if (url.includes(encodeURIComponent(v3.id))) return jsonResponse({ artifact: v3 });
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(h(ArtifactsView, { initialSeriesRef: 'artifact-series:pinned-series', initialVersionNo: 1 }));

    await waitFor(() => expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('pinned-report.md'));
    fireEvent.click(screen.getByRole('button', { name: 'Artifact actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Version history' }));
    expect(screen.getAllByText('v1').length).toBeGreaterThan(0);

    fireEvent.input(screen.getByPlaceholderText('Search artifacts'), { target: { value: 'pinned' } });

    await waitFor(() => expect(seriesCalls).toBeGreaterThan(2));
    expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('pinned-report.md');
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'Artifact version' }) as HTMLSelectElement).value).toBe('1'));
    expect(screen.getAllByText('v1').length).toBeGreaterThan(0);
    const pinnedRow = screen.getByRole('button', { name: /pinned-report\.md/ });
    expect(pinnedRow.textContent).toContain('pinned-');
    expect(pinnedRow.textContent).toContain('report');
    expect(pinnedRow.textContent).not.toContain('v3');
  });

  it('ignores self-written series hash updates but reconciles external series changes', async () => {
    const firstArtifact = makeArtifactFixture('f', 'hash-self-v1.md');
    const secondArtifact = makeArtifactFixture('0', 'hash-self-v2.md', {
      id: `artifact:sha256:${'10'.repeat(32)}`,
      content_hash: '10'.repeat(32),
      uri: `artifact:${'10'.repeat(32)}`,
    });
    const firstSeries = makeArtifactSeries('hash-self-first', [firstArtifact], 'hash-self-v1.md');
    const secondSeries = makeArtifactSeries('hash-self-second', [secondArtifact], 'hash-self-v2.md');
    const artifactById = new Map([
      [firstArtifact.id, firstArtifact],
      [secondArtifact.id, secondArtifact],
    ]);
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/series?')) return jsonResponse({ series: [firstSeries.summary, secondSeries.summary] });
      if (url.startsWith('/api/artifacts/versions?')) {
        const ref = new URLSearchParams(url.split('?')[1] ?? '').get('ref');
        if (ref === firstSeries.summary.ref) return jsonResponse({ history: firstSeries.history });
        if (ref === secondSeries.summary.ref) return jsonResponse({ history: secondSeries.history });
        return Promise.reject(new Error(`unexpected versions ref ${ref}`));
      }
      if (url.endsWith('/content')) {
        const artifact = [...artifactById.values()].find((candidate) => url.includes(encodeURIComponent(candidate.id))) ?? firstArtifact;
        return jsonResponse({
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
        });
      }
      if (url.endsWith('/knowledge-backrefs')) return jsonResponse({ backrefs: [] });
      for (const [id, artifact] of artifactById) {
        if (url.includes(encodeURIComponent(id))) return jsonResponse({ artifact });
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    const { rerender } = render(h(ArtifactsView, {}));

    await waitFor(() => expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('hash-self-v1.md'));
    fireEvent.click(screen.getByRole('button', { name: /hash-self-v2\.md/ }));
    await waitFor(() => expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('hash-self-v2.md'));

    rerender(h(ArtifactsView, { initialSeriesRef: secondSeries.summary.ref }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('hash-self-v2.md');
    expect(screen.queryByText('No artifacts in this view.')).toBeNull();

    rerender(h(ArtifactsView, { initialSeriesRef: firstSeries.summary.ref, initialVersionNo: 1 }));

    await waitFor(() => expect(document.querySelector('.artifact-detail h2')?.textContent).toBe('hash-self-v1.md'));
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'Artifact version' }) as HTMLSelectElement).value).toBe('1'));
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
    const artifactSeries = makeArtifactSeries('bundle-series', [artifact], 'run packet');
    const manifest = JSON.stringify({
      schema_version: 'mandible.artifact_bundle.v1',
      name: 'run packet',
      members: [
        { artifact_id: memberId, role: 'figure', order: 0, recoverability: 'repo_commit' },
      ],
    }, null, 2);
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts/series?')) {
        return jsonResponse({ series: [artifactSeries.summary] });
      }
      if (url.startsWith('/api/artifacts/versions?')) {
        return jsonResponse({ history: artifactSeries.history });
      }
      if (url.startsWith('/api/artifacts/resolve?')) {
        return jsonResponse({
          resolution: {
            status: 'resolved',
            ref: artifact.id,
            scheme: 'artifact',
            normalized_ref: artifact.id,
            artifact,
            alias: null,
            series: undefined,
            version: undefined,
            warnings: [],
          },
        });
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
    expect(memberLink?.getAttribute('href')).toBe(
      `#/artifacts?ref=${encodeURIComponent(memberId.replace(/^artifact:sha256:/, 'artifact-blob:'))}`,
    );
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
  it('refetches canonical auth projections for every dependency transition event', () => {
    expect([
      'auth:new', 'auth:updated', 'auth:merged', 'auth:resolved', 'auth:finalized', 'auth:lifecycle',
    ].every(authEventRequiresProjectionRefresh)).toBe(true);
    expect(authEventRequiresProjectionRefresh('auth:output')).toBe(false);
  });

  it('updates badge counts from SSE events', () => {
    let state = initialState;
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

  it('strips ANSI escape sequences from appended output', () => {
    let state = appReducer(initialState, {
      type: 'authOutput',
      requestId: 'a1',
      chunk: '\x1b[32mgreen\x1b[0m\n',
    });
    state = appReducer(state, {
      type: 'authOutput',
      requestId: 'a1',
      chunk: '\x1b[1mbold\x1b[0m done\n',
    });
    expect(state.authOutputs.a1).toBe('green\nbold done\n');
  });

  it('bounds retained output to the tail when it exceeds the cap', () => {
    const head = 'H'.repeat(MAX_AUTH_OUTPUT_CHARS);
    let state = appReducer(initialState, {
      type: 'authOutput',
      requestId: 'a1',
      chunk: head,
    });
    state = appReducer(state, {
      type: 'authOutput',
      requestId: 'a1',
      chunk: 'TAIL',
    });
    expect(state.authOutputs.a1.length).toBe(MAX_AUTH_OUTPUT_CHARS);
    expect(state.authOutputs.a1.endsWith('TAIL')).toBe(true);
  });

  it('routes auth:output SSE events through the reducer with ANSI stripped', () => {
    const state = applySSEEvent(initialState, {
      type: 'auth:output',
      data: { request_id: 'a1', text: '\x1b[31mred\x1b[0m line\n' },
    });
    expect(state.authOutputs.a1).toBe('red line\n');
  });

  it('parses auth:output and auth:resolved event shapes', () => {
    expect(
      parseAuthOutputEvent({
        type: 'auth:output',
        data: { request_id: 'a1', text: 'hello' },
      }),
    ).toEqual({ requestId: 'a1', text: 'hello' });
    expect(
      parseAuthResolvedId({
        type: 'auth:resolved',
        data: { request_id: 'a2', status: 'completed' },
      }),
    ).toBe('a2');
    expect(parseAuthResolvedId({ type: 'auth:resolved' })).toBe('');
  });
});
