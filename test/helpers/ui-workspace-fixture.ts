import { registerArtifactFixtureHistory } from './artifact-resolution-fixtures';

import { render as testingRender, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/preact';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { h } from 'preact';




import { clearPersistedDetailCache } from '../../ui/src/detail-cache';
import { PRODUCTION_ORIGIN } from '../../src/canonical-origin';
import { PRODUCTION_EFFECTS } from '../../src/security/effect-policy.js';

import { invalidateApiGetCache, type InstanceInfo } from '../../ui/src/api';



import { __resetSharedSseForTests } from '../../ui/src/sse-shared';
import { __resetBrowserSessionForTests, ensureClientAccess } from '../../ui/src/client-auth-token';
import { AppShellProvider } from '../../ui/src/app-shell';












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
  installMemoryLocalStorage();
  clearPersistedDetailCache();
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
  vi.restoreAllMocks();
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
      return new Response(JSON.stringify({ auth: 3, briefing: 2, inbox: 1, work: 0, incidents: 0, tasks: 0 }), {
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
    artifact_id: `artifact-version:${seriesId}:${versionNo}`,
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
  artifacts.forEach((artifact, index) => {
    artifact.id = versions[index].id;
    registerArtifactFixtureHistory(artifact, series, versions[index]);
  });
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


export { railReorderReady, ruleBody, changeSelect, setViewportWidth, readSharedSidebarWidth, mockLeftChromeRects, installMemoryLocalStorage, stubFetch, stubEventSource, stubAppShellFetch, stubRailSettingsFetch, railGroupLinks, mockRailRects, fireRailPointer, installPointerEventForTest, issueDetailProjection, makeArtifactVersion, makeArtifactFixture, makeArtifactSeries, jsonResponse, render, reactFlowMockState, previewInstance, mainInstance, writablePreviewInstance, preferenceWritablePreviewInstance };
