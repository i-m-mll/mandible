// @vitest-environment jsdom
import { installMemoryLocalStorage, issueDetailProjection, makeArtifactFixture, makeArtifactSeries, stubEventSource, render, writablePreviewInstance } from './helpers/ui-workspace-fixture';
import { act, cleanup, screen, waitFor } from './helpers/dom.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { App } from '../ui/src/app';
import { bindOperationCatalog, clearApiGetCache, type InstanceInfo } from '../ui/src/api';
import { clearPersistedDetailCache, isPersistedDetailFresh, writePersistedDetail, ROUTE_DATA_FRESH_MS } from '../ui/src/detail-cache';
import { queryClient } from '../ui/src/query/client';
import { DEFAULT_CHILD_RETENTION_SETTINGS } from '../src/conversations/retention-contract';

// Route chunks load from the module cache, so idle-time work settles within event-loop turns.
const viewModules = import.meta.glob('../ui/src/views/**/*.tsx');

type WarmedTab = 'overview' | 'timeline' | 'console' | 'artifacts';

/** Requests every page load makes, whichever view is active. */
const STARTUP_GLOBALS = new Set([
  'GET /api/health',
  'GET /api/settings',
  'GET /api/dashboard/badges',
  'GET /api/host-preferences/app-theme',
  'GET /api/user-settings/app_rail_order',
  'GET /api/user-settings/ui_font_face',
  'GET /api/user-settings/ui_font_size',
  'GET /api/user-settings/detail_font_face',
  'GET /api/user-settings/detail_font_size',
]);

type Fixture = (search: URLSearchParams, body: unknown) => unknown;

const ISSUE_REPOS = {
  repos: [{
    repo_id: 'mandible',
    repo_name: 'mandible',
    open_count: 1,
    closed_count: 0,
    issues: [{ id: 'e70757d', display_id: 'e70757d', title: 'Warm issue title', status: 'open' }],
  }],
};

const WARM_ARTIFACT = makeArtifactFixture('a', 'warm-report.md');
const WARM_SERIES = makeArtifactSeries('warm-series', [WARM_ARTIFACT], 'Warm artifact series');
const WARM_ARTIFACT_ID = WARM_ARTIFACT.id as string;

const WARM_SPACE = {
  id: 'space-warm', project_id: null, title: 'Warm space title', default_renderer: 'collection',
  description: null, metadata: {}, created_at: 0, updated_at: 0,
};

const WARM_TIMELINE_ISSUE = {
  id: 'issue_root', display_id: '2733a47', project_id: 'prj_mandible', title: 'Warm timeline issue',
  status: 'open', resolution: null, kind: 'feature', priority: 'normal', labels: [], deleted: false,
};
const WARM_TIMELINE = {
  project: { id: 'prj_mandible', display_name: 'mandible', repo_id: 'mandible', repo_name: 'mandible', repo_root: '/repo' },
  inputs: {
    project_id: 'prj_mandible', root_policy: 'coordination_and_explicit', root_specs: [],
    explicit_root_issue_ids: [], promoted_root_issue_ids: [], expanded_event_ids: [], expanded_paths: [],
    include_closed: false, statuses: ['open'], event_kinds: ['body', 'comment', 'state'], depth: 2, from: null, to: null,
  },
  time_axis: { start: Date.UTC(2026, 0, 1), end: Date.UTC(2026, 0, 3), event_count: 0 },
  rows: [{
    id: 'row-root', issue: WARM_TIMELINE_ISSUE, kind: 'root', parent_row_id: null, source_event_id: null,
    depth: 0, path: ['row-root'], expanded: false, cycle: false, hidden_reason: null,
  }],
  events: [],
  links: [],
  diagnostics: {
    total_issues: 1, deleted_issues: 0, root_count: 1, reachable_from_roots_count: 1,
    unreferenced_open_issue_ids: [], loner_open_issue_ids: [], derived_reference_count: 0,
    repeated_reference_target_issue_ids: [], multi_root_issue_ids: [], cycles: [], depth_limits: [],
    filtered_targets: [], missing_expansions: [],
  },
  page: { row_offset: 0, next_row_offset: null },
};

/** Responses by path pattern; anything else answers `[]`. */
const FIXTURES: Array<[RegExp, Fixture]> = [
  [/^\/api\/sessions$/, () => [{ id: 'sess-warm-1', status: 'active', app: 'warm-app', task: 'Warm session task' }]],
  [/^\/api\/system\/logs$/, () => ({
    entries: [{ id: 'log-1', level: 'info', message: 'Warm log line', event: 'warm.event', subsystem: 'warm', time: '2026-10-24T00:00:00.000Z' }],
    limit: 200,
    offset: 0,
    total: 1,
    exists: true,
  })],
  [/^\/api\/graph$/, () => ({
    nodes: [{ id: 'node-warm', type: 'session', label: 'Warm graph node', detail: {} }],
    edges: [],
    mode: 'work',
  })],
  [/^\/api\/issues$/, () => ISSUE_REPOS],
  [/^\/api\/issues\/mandible\/e70757d\/ledger-detail$/, (search) => issueDetailProjection({
    displayId: 'e70757d',
    title: 'Warm issue title',
    body: 'Warm issue body',
    stage: search.get('stage') === 'initial' ? 'initial' : 'full',
  })],
  [/^\/api\/auth\/queue$/, () => [{
    id: 'auth-warm', type: 'merge', status: 'pending', title: 'Warm auth request',
    repo: 'mandible', head_branch: 'feature/warm', base_branch: 'main', created_at: '2026-10-24T00:00:00.000Z',
  }]],
  [/^\/api\/inbox\/global$/, () => ({
    continuations: [],
    auth_results: [],
    open_issues: [{ id: 'e70757d', title: 'Warm inbox issue', repo_id: 'mandible', status: 'open', labels: [] }],
    total: 1,
  })],
  [/^\/api\/work\/repos$/, () => [{ id: 'mandible', name: 'mandible', path: '/repo' }]],
  [/^\/api\/tasks$/, () => ({
    executors: [],
    tasks: [{
      source_kind: 'executor',
      executor: 'agent-schedule',
      freshness: 'fresh',
      task: { task_id: 'warm-digest', display_name: 'Warm digest task', management_mode: 'external' },
    }],
  })],
  [/^\/api\/artifacts\/series$/, () => ({
    series: [WARM_SERIES.summary],
  })],
  [/^\/api\/artifacts\/versions$/, () => ({ history: WARM_SERIES.history })],
  [/^\/api\/artifacts\/[^/]+\/content$/, () => ({
    content: {
      artifact_id: WARM_ARTIFACT_ID, status: 'available', kind: 'markdown', media_type: 'text/markdown', size_bytes: 20,
      source: null, preview: { encoding: 'utf-8', text: 'Warm artifact body', truncated: false },
    },
  })],
  [/^\/api\/artifacts\/[^/]+\/knowledge-backrefs$/, () => ({ backrefs: [] })],
  [/^\/api\/artifacts\/[^/]+$/, () => ({ artifact: WARM_ARTIFACT })],
  [/^\/api\/spaces$/, () => ({
    groups: [{
      project_id: null, project_key: null, project_name: null,
      spaces: [WARM_SPACE],
    }],
  })],
  [/^\/api\/host-preferences\/chat-shown-projects$/, () => ({ version: 1, key: 'chat_shown_projects', value: [], revision: 1 })],
  [/^\/api\/host-preferences\/sidebar-order$/, () => ({
    version: 1, key: 'sidebar_order', value: { pinnedConversationIds: null, briefingTopLevelIds: null }, revision: 1,
  })],
  [/^\/api\/timeline\/project$/, () => WARM_TIMELINE],
  [/^\/api\/spaces\/space-warm$/, () => ({ space: WARM_SPACE, items: [], occurrences: [], edges: [] })],
  [/^\/api\/conversations\/sidebar$/, () => ({
    limit: 5,
    groups: [{
      key: 'chats', kind: 'chats', label: 'Chats', total: 1, next_cursor: null,
      conversations: [{
        id: 'conv-warm', source: 'claude', title: 'Warm chat title', canonical_project_id: null, canonical_project_key: null,
        created_at: '2026-10-24T00:00:00.000Z', updated_at: '2026-10-24T00:00:00.000Z', block_count: 3, tags: [], starred: false,
      }],
    }],
  })],
  [/^\/api\/briefings$/, () => ({ briefings: [] })],
  [/^\/api\/briefing-bundles$/, () => ({ bundles: [] })],
  [/^\/api\/briefing-groups$/, () => ({ groups: [] })],
  [/^\/api\/work\/repos\/mandible\/branches$/, () => [{ name: 'feature/warm-branch', repo_id: 'mandible' }]],
];

class Harness {
  readonly requested: string[] = [];
  events!: ReturnType<typeof stubEventSource>;
  private inflight = 0;
  hang = false;
  health: unknown = { ready: true, warm: true };
  private readonly idle = new Map<number, () => void>();
  private nextIdleHandle = 1;

  install(): void {
    installMemoryLocalStorage();
    this.events = stubEventSource();
    (window as Window & { __MANDIBLE_BOOTSTRAP__?: { instance: InstanceInfo } }).__MANDIBLE_BOOTSTRAP__ = {
      instance: writablePreviewInstance,
    };
    bindOperationCatalog(writablePreviewInstance, {
      schema: 'mandible-operation-catalog@2',
      source: 'Router.listRoutePolicies',
      runtime: { instance_id: writablePreviewInstance.instance_id, backend_generation: writablePreviewInstance.backend_generation, version: 'test' },
      routes: [
        { method: 'GET', path: '/api/tasks', effects: null },
        { method: 'GET', path: '/api/tasks/commands', effects: null },
      ],
    });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
      this.requested.push(`${method} ${url.pathname}${url.search}`);
      if (this.hang && !STARTUP_GLOBALS.has(`${method} ${url.pathname}`)) return new Promise<Response>(() => undefined);
      this.inflight += 1;
      try {
        await Promise.resolve();
        return new Response(JSON.stringify(this.respond(url, body)), { headers: { 'content-type': 'application/json' } });
      } finally {
        this.inflight -= 1;
      }
    }));
    vi.stubGlobal('requestIdleCallback', (callback: () => void) => {
      const handle = this.nextIdleHandle++;
      this.idle.set(handle, callback);
      return handle;
    });
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
    vi.stubGlobal('cancelIdleCallback', (handle: number) => { this.idle.delete(handle); });
  }

  private respond(url: URL, body: unknown): unknown {
    if (url.pathname === '/api/settings/child-retention') return DEFAULT_CHILD_RETENTION_SETTINGS;
    if (url.pathname === '/api/settings') return {};
    if (url.pathname.startsWith('/api/user-settings/')) {
      return { version: 1, key: url.pathname.split('/').pop(), value: null, revision: 0 };
    }
    if (url.pathname === '/api/health') return this.health;
    const fixture = FIXTURES.find(([pattern]) => pattern.test(url.pathname))?.[1];
    return fixture ? fixture(url.searchParams, body) : [];
  }

  /** Run event-loop turns (and idle callbacks, unless `runIdle` is false) until nothing is pending. */
  async settle(runIdle = true): Promise<void> {
    let quietTurns = 0;
    for (let turn = 0; turn < 1_000 && quietTurns < 5; turn += 1) {
      await act(async () => {
        if (runIdle) {
          const due = [...this.idle.values()];
          this.idle.clear();
          for (const callback of due) {
            callback();
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      quietTurns = (!runIdle || this.idle.size === 0) && this.inflight === 0 ? quietTurns + 1 : 0;
    }
    expect(quietTurns).toBe(5);
  }

  routeRequests(fromIndex = 0): string[] {
    return [...new Set(this.requested.slice(fromIndex)
      .filter((request) => !STARTUP_GLOBALS.has(request.replace(/\?.*$/, ''))))];
  }
}

function resetBrowserState(): void {
  cleanup();
  clearApiGetCache();
  clearPersistedDetailCache();
  queryClient.clear();
  window.localStorage.clear();
}

afterEach(() => {
  resetBrowserState();
  vi.restoreAllMocks();
});

function navigate(hash: string): void {
  act(() => {
    window.history.pushState(null, '', hash);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

const WARM_TEXT: Record<WarmedTab, string> = {
  overview: 'sess-warm-1',
  artifacts: 'Warm artifact body',
  timeline: 'Warm timeline issue',
  console: 'Warm chat title',
};

describe('startup route warmup', () => {
  it.each([null, {}, { ready: true }, { ready: false, warm: true }, { ready: true, warm: false }])('does not warm inactive routes without affirmative health: %j', async (health) => {
    await Promise.all(Object.values(viewModules).map((load) => load()));
    const harness = new Harness();
    harness.install();
    harness.health = health;
    window.history.replaceState(null, '', '#/settings');
    render(h(App, {}));
    await harness.settle(false);
    const activeRequests = harness.routeRequests();
    await harness.settle();
    expect(harness.routeRequests()).toEqual(activeRequests);
  });


  it('fallback polling marks detail and TanStack caches stale as well as GETs', async () => {
    const harness = new Harness();
    harness.install();
    const intervals = vi.spyOn(window, 'setInterval');
    window.history.replaceState(null, '', '#/settings');
    render(h(App, {}));
    await harness.settle();
    writePersistedDetail('timeline', 'poll-test', { rows: [] });
    queryClient.setQueryData(['poll-test'], { rows: [] });
    expect(isPersistedDetailFresh('timeline', 'poll-test')).toBe(true);
    const poll = intervals.mock.calls.find(([, delay]) => delay === 10_000)?.[0];
    expect(typeof poll).toBe('function');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 46_000);
    await act(async () => { (poll as () => void)(); });
    expect(isPersistedDetailFresh('timeline', 'poll-test')).toBe(false);
    expect(queryClient.getQueryState(['poll-test'])?.isInvalidated).toBe(true);
  });

  it('revalidates a visible Timeline after issue and comment SSE events', async () => {
    const harness = new Harness();
    harness.install();
    window.history.replaceState(null, '', '#/timeline');
    render(h(App, {}));
    await harness.settle();
    const timelineReads = () => harness.requested.filter((request) => request === 'POST /api/timeline/project').length;
    for (const type of ['ledger:issue:updated', 'ledger:comment:created', 'ledger:comment:updated']) {
      const before = timelineReads();
      act(() => harness.events.emit({ type, data: {} }));
      await waitFor(() => expect(timelineReads()).toBeGreaterThan(before));
      await harness.settle();
    }
  });

  it('warms each view once, then fetches nothing more for hidden views', async () => {
    await Promise.all(Object.values(viewModules).map((load) => load()));
    const harness = new Harness();
    harness.install();
    window.history.replaceState(null, '', '#/settings');
    render(h(App, {}));
    await harness.settle();
    expect(harness.routeRequests()).not.toEqual([]);
    const afterWarm = harness.requested.length;
    for (const type of ['ledger:issue:updated', 'conversation:updated', 'auth:request:updated', 'space:updated', 'tasks.updated']) {
      act(() => harness.events.emit({ type, data: {} }));
    }
    await harness.settle();
    expect(harness.routeRequests(afterWarm)).toEqual([]);
  });

  const cases = (['overview', 'timeline', 'console', 'artifacts'] as const)
    .flatMap((tab) => [[tab, 'inside'], [tab, 'after']] as const);
  it.each(cases)('%s shows its warm data when opened %s the freshness window', async (tab, window) => {
    await Promise.all(Object.values(viewModules).map((load) => load()));
    const harness = new Harness();
    harness.install();

    globalThis.window.history.replaceState(null, '', `#/${tab}`);
    render(h(App, {}));
    await harness.settle(false);
    const activation = harness.routeRequests();
    resetBrowserState();

    const beforeWarm = harness.requested.length;
    globalThis.window.history.replaceState(null, '', '#/settings');
    render(h(App, {}));
    await harness.settle();
    const warm = harness.routeRequests(beforeWarm).filter(request => activation.includes(request));
    expect(warm.length).toBeGreaterThan(0);

    if (window === 'after') {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now + ROUTE_DATA_FRESH_MS + 1);
    }
    harness.hang = true;
    const beforeSwitch = harness.requested.length;
    navigate(`#/${tab}`);
    await harness.settle(false);
    const text = WARM_TEXT[tab];
    expect((await screen.findAllByText(text, { exact: false })).length).toBeGreaterThan(0);
    const afterSwitch = harness.routeRequests(beforeSwitch);
    // Inside the window the warm copy is shown without a refetch. Past it the painted data revalidates;
    // the stub never answers, so the data on screen is the warm copy.
    if (window === 'inside') expect(afterSwitch.filter((request) => warm.includes(request))).toEqual([]);
    else expect(afterSwitch.filter((request) => activation.includes(request)).length).toBeGreaterThan(0);
  });
});
