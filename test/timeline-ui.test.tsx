import { render, screen, waitFor, cleanup, fireEvent, act } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { useCallback, useMemo, useRef, useState } from 'preact/hooks';
import {
  AppShellProvider,
  type AppRightSidebarDescriptor,
  type AppShellContextValue,
} from '../ui/src/app-shell';
import { TimelineView as RawTimelineView, type TimelineViewProps } from '../ui/src/views/timeline';
import type { ProjectTimelineProjection } from '../ui/src/types/timeline';
import { __resetBrowserSessionForTests, ensureClientAccess } from '../ui/src/client-auth-token';

function stubLocalStorage(): void {
  const store = new Map<string, string>();
  const localStorageStub = {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    clear: vi.fn(() => store.clear()),
  };
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: localStorageStub,
  });
}

beforeEach(async () => {
  stubLocalStorage();
  __resetBrowserSessionForTests();
  await ensureClientAccess(async () => new Response(JSON.stringify({ authenticated: true, session: { csrf_token: 'timeline-csrf',
  } }), { status: 200, headers: { 'content-type': 'application/json' } }));
});

afterEach(() => {
  cleanup();
  __resetBrowserSessionForTests();
  vi.unstubAllGlobals();
});

function changeSelect(select: HTMLElement, value: string): void {
  act(() => {
    (select as HTMLSelectElement).value = value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function projection(overrides: Partial<ProjectTimelineProjection> = {}): ProjectTimelineProjection {
  const base: ProjectTimelineProjection = {
    project: {
      id: 'prj_mandible',
      display_name: 'mandible',
      repo_id: 'mandible',
      repo_name: 'mandible',
      repo_root: '/repo/mandible',
    },
    inputs: {
      project_id: 'prj_mandible',
      root_policy: 'coordination_and_explicit',
      root_specs: [],
      explicit_root_issue_ids: [],
      promoted_root_issue_ids: [],
      expanded_event_ids: [],
      expanded_paths: [],
      include_closed: false,
      statuses: ['open'],
      event_kinds: ['body', 'comment', 'state'],
      depth: 2,
      from: null,
      to: null,
    },
    time_axis: {
      start: Date.UTC(2026, 0, 1),
      end: Date.UTC(2026, 0, 3),
      event_count: 2,
    },
    rows: [
      {
        id: 'row-root',
        issue: {
          id: 'issue_root',
          display_id: '2733a47',
          project_id: 'prj_mandible',
          title: 'Timeline UI shell',
          status: 'open',
          resolution: null,
          kind: 'feature',
          priority: 'normal',
          labels: ['timeline'],
          deleted: false,
        },
        kind: 'root',
        parent_row_id: null,
        source_event_id: null,
        depth: 0,
        path: ['row-root'],
        expanded: false,
        cycle: false,
        hidden_reason: null,
      },
    ],
    events: [
      {
        id: 'event-body',
        row_id: 'row-root',
        issue: {
          id: 'issue_root',
          display_id: '2733a47',
          project_id: 'prj_mandible',
          title: 'Timeline UI shell',
          status: 'open',
          resolution: null,
          kind: 'feature',
          priority: 'normal',
          labels: ['timeline'],
          deleted: false,
        },
        source_entity: {
          type: 'issue_body',
          id: 'issue_root:body',
          issue_id: 'issue_root',
        },
        kind: 'body',
        timestamp: Date.UTC(2026, 0, 1, 12),
        ordinal: 0,
        display_headline: 'Build shared axis',
        headline_source: 'title',
        body: 'Full body text',
        state: null,
        link_ids: ['link-child'],
      },
    ],
    links: [
      {
        id: 'link-child',
        event_id: 'event-body',
        source_row_id: 'row-root',
        source_entity: {
          type: 'issue_body',
          id: 'issue_root:body',
          issue_id: 'issue_root',
        },
        source_issue: {
          id: 'issue_root',
          display_id: '2733a47',
          project_id: 'prj_mandible',
          title: 'Timeline UI shell',
          status: 'open',
          resolution: null,
          kind: 'feature',
          priority: 'normal',
          labels: ['timeline'],
          deleted: false,
        },
        target_issue: {
          id: 'issue_child',
          display_id: '96b5bff',
          project_id: 'prj_mandible',
          title: 'Left gutter tree',
          status: 'open',
          resolution: null,
          kind: 'feature',
          priority: 'normal',
          labels: ['timeline'],
          deleted: false,
        },
        relationship_id: 'rel_1',
        relationship_type: 'references',
        ref_kind: 'issue',
        raw_ref: '96b5bff',
        normalized_ref: '96b5bff',
        derived: true,
        expanded_row_id: null,
        created_at: Date.UTC(2026, 0, 1),
      },
    ],
    diagnostics: {
      total_issues: 2,
      deleted_issues: 0,
      root_count: 1,
      reachable_from_roots_count: 2,
      unreferenced_open_issue_ids: [],
      loner_open_issue_ids: [],
      derived_reference_count: 1,
      repeated_reference_target_issue_ids: [],
      multi_root_issue_ids: [],
      cycles: [],
      depth_limits: [],
      filtered_targets: [],
      missing_expansions: [],
    },
  };
  return { ...base, ...overrides };
}

function projectProjection(
  projectRef: string,
  title: string,
  headline: string,
): ProjectTimelineProjection {
  const base = projection();
  const projectId = `prj_${projectRef}`;
  const issue = {
    ...base.rows[0].issue!,
    id: `issue_${projectRef}`,
    display_id: `${projectRef.slice(0, 3)}1234`,
    project_id: projectId,
    title,
    kind: 'umbrella',
    labels: ['coordination'],
  };
  const row = {
    ...base.rows[0],
    id: `row-${projectRef}`,
    issue,
  };
  const event = {
    ...base.events[0],
    id: `event-${projectRef}`,
    row_id: row.id,
    issue,
    display_headline: headline,
    body: `${title} body`,
    link_ids: [],
  };
  return projection({
    project: {
      id: projectId,
      display_name: projectRef,
      repo_id: projectRef,
      repo_name: projectRef,
      repo_root: `/repo/${projectRef}`,
    },
    inputs: {
      ...base.inputs,
      project_id: projectId,
    },
    rows: [row],
    events: [event],
    links: [],
    diagnostics: {
      ...base.diagnostics,
      root_count: 1,
      reachable_from_roots_count: 1,
    },
  });
}

function stubTimelineFetch(...responses: Array<ProjectTimelineProjection | Promise<ProjectTimelineProjection>>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    const next = responses.shift() ?? projection();
    return Promise.resolve(next).then((body) => {
      if (init?.signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
      });
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function TimelineView({ active = true, ...props }: TimelineViewProps & { active?: boolean }): JSX.Element {
  const [rightSidebar, setRightSidebar] = useState<AppRightSidebarDescriptor | null>(null);
  const ownerRef = useRef<string | null>(null);
  const registerRightSidebar = useCallback((ownerId: string) => {
    ownerRef.current = ownerId;
    return () => setRightSidebar((current) => (current?.id === ownerId ? null : current));
  }, []);
  const updateRightSidebar = useCallback((ownerId: string, descriptor: AppRightSidebarDescriptor) => {
    if (ownerRef.current === ownerId) setRightSidebar((current) => current === descriptor ? current : descriptor);
  }, []);
  const shell = useMemo<AppShellContextValue>(() => ({
    active,
    rightSidebar,
    registerRightSidebar,
    registerInitialRouteLoad: () => undefined,
    updateRightSidebar,
    setViewSidebarWidth: () => undefined,
  }), [active, rightSidebar, registerRightSidebar, updateRightSidebar]);
  const toggleLabel = rightSidebar?.open ? `Collapse ${rightSidebar.title}` : `Show ${rightSidebar?.title ?? 'inspector'}`;

  return (
    <AppShellProvider value={shell}>
      <div className="app-header">
        {rightSidebar?.content ? (
          <button
            type="button"
            aria-label={toggleLabel}
            onClick={() => rightSidebar.onOpenChange(!rightSidebar.open)}
          />
        ) : null}
      </div>
      <RawTimelineView {...props} />
      {rightSidebar?.open && rightSidebar.content ? (
        <aside
          className="app-right-sidebar"
          aria-label={rightSidebar.ariaLabel}
        >
          <div className="app-right-sidebar__content">
            {rightSidebar.content}
          </div>
        </aside>
      ) : null}
    </AppShellProvider>
  );
}

function nearTimeProjection(): ProjectTimelineProjection {
  const base = projection();
  const nearEvents = [
    {
      ...base.events[0],
      id: 'event-near-a',
      timestamp: Date.UTC(2026, 0, 1, 12, 0),
      ordinal: 0,
      display_headline: 'Near event A',
      link_ids: [],
    },
    {
      ...base.events[0],
      id: 'event-near-b',
      timestamp: Date.UTC(2026, 0, 1, 12, 30),
      ordinal: 1,
      display_headline: 'Near event B',
      link_ids: [],
    },
    {
      ...base.events[0],
      id: 'event-near-c',
      timestamp: Date.UTC(2026, 0, 1, 13, 0),
      ordinal: 2,
      display_headline: 'Near event C',
      link_ids: [],
    },
  ];
  return projection({
    rows: [
      base.rows[0],
      {
        ...base.rows[0],
        id: 'row-secondary',
        kind: 'explicit_root',
        issue: {
          ...base.rows[0].issue,
          id: 'issue_secondary',
          display_id: 'bb22ccd',
          title: 'Secondary row',
        },
      },
    ],
    events: [
      ...nearEvents,
      {
        ...base.events[0],
        id: 'event-secondary',
        row_id: 'row-secondary',
        timestamp: Date.UTC(2026, 0, 2, 12),
        ordinal: 0,
        display_headline: 'Secondary event',
        link_ids: [],
        issue: {
          ...base.events[0].issue,
          id: 'issue_secondary',
          display_id: 'bb22ccd',
          title: 'Secondary row',
        },
      },
    ],
    links: [],
    time_axis: {
      start: Date.UTC(2026, 0, 1),
      end: Date.UTC(2026, 0, 3),
      event_count: 4,
    },
  });
}

describe('TimelineView', () => {

  it('stops global arrow-key navigation when its keep-alive view becomes inactive', async () => {
    stubTimelineFetch(nearTimeProjection());

    const result = render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: { project: 'mandible' },
    }));

    const firstEvent = await screen.findByText('Near event A');
    fireEvent.click(firstEvent.closest('button') as HTMLButtonElement);
    await waitFor(() => {
      const stored = window.localStorage.getItem('mandible_timeline_view_state:v1:prj_mandible');
      expect(stored).toBeTruthy();
      expect(JSON.parse(String(stored)).selectedEventId).toBe('event-near-a');
    });
    const activeKey = new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true });
    window.dispatchEvent(activeKey);
    expect(activeKey.defaultPrevented).toBe(true);
    await waitFor(() => {
      const stored = window.localStorage.getItem('mandible_timeline_view_state:v1:prj_mandible');
      expect(stored).toBeTruthy();
      expect(JSON.parse(String(stored)).selectedEventId).toBe('event-near-b');
    });

    result.rerender(h(TimelineView, {
      active: false,
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: { project: 'mandible' },
    }));
    const inactiveState = window.localStorage.getItem('mandible_timeline_view_state:v1:prj_mandible');
    const inactiveEventKey = new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true });
    const inactiveRowKey = new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true });
    window.dispatchEvent(inactiveEventKey);
    window.dispatchEvent(inactiveRowKey);
    expect(inactiveEventKey.defaultPrevented).toBe(false);
    expect(inactiveRowKey.defaultPrevented).toBe(false);
    expect(window.localStorage.getItem('mandible_timeline_view_state:v1:prj_mandible')).toBe(inactiveState);
  });

  it('loads the projection and merges URL state over browser-local state', async () => {
    window.localStorage.setItem(
      'mandible_timeline_view_state:v1:mandible',
      JSON.stringify({
        density: 'expanded',
        includeClosed: false,
        expandedEventIds: ['stored-event'],
      }),
    );
    const fetchMock = stubTimelineFetch(projection());

    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: {
        project: 'mandible',
        density: 'compact',
        closed: '1',
        expanded: 'url-event',
        from: String(Date.UTC(2026, 0, 1, 6)),
        to: String(Date.UTC(2026, 0, 2, 6)),
      },
    }));

    await waitFor(() => expect(screen.getByText('Build shared axis')).toBeTruthy());
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.include_closed).toBe(true);
    expect(body.expanded_event_ids).toEqual(['url-event']);
    expect(body.event_kinds).toEqual(['body', 'comment', 'state']);
    expect(body).not.toHaveProperty('from');
    expect(body).not.toHaveProperty('to');
  });

  it('normalizes untrusted browser-local timeline state before restoring it', async () => {
    window.localStorage.setItem(
      'mandible_timeline_view_state:v1:mandible',
      JSON.stringify({
        density: 'illegible',
        includeClosed: 'yes',
        explicitRootIssueIds: ['root-a', 42, 'root-a'],
        visibleEventTypes: ['body', 'unknown'],
        expandedPaths: 'row:not-an-array',
        filterRows: [{ id: 5, chips: 'not-an-array' }],
        panes: { inspectorWidth: 1, rowListWidth: 9999 },
      }),
    );
    const fetchMock = stubTimelineFetch(projection());

    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: { project: 'mandible' },
    }));

    await waitFor(() => expect(screen.getByText('Build shared axis')).toBeTruthy());
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.explicit_root_issue_ids).toEqual(['root-a']);
    expect(body.expanded_paths).toEqual([]);
    expect(body.event_kinds).toEqual(['body']);
    expect(body.include_closed).toBe(false);

    await waitFor(() => {
      const canonical = window.localStorage.getItem('mandible_timeline_view_state:v1:prj_mandible');
      expect(canonical).toBeTruthy();
      const stored = JSON.parse(String(canonical));
      expect(stored.filterRows).toEqual([]);
      expect(stored.panes.inspectorWidth).toBe(280);
      expect(stored.panes.rowListWidth).toBe(520);
    });
  });

  it('preserves an explicitly empty event-type selection across refetch and reload', async () => {
    const storageKey = 'mandible_timeline_view_state:v1:mandible';
    window.localStorage.setItem(storageKey, JSON.stringify({ visibleEventTypes: [] }));
    const fetchMock = stubTimelineFetch(projection(), projection());

    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: { project: 'mandible' },
    }));

    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(1));
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).event_kinds).toEqual([]);

    fireEvent.click(screen.getByLabelText('Closed'));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(2));
    const refetchBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(refetchBody.include_closed).toBe(true);
    expect(refetchBody.event_kinds).toEqual([]);
    await waitFor(() => {
      const stored = JSON.parse(String(window.localStorage.getItem(storageKey)));
      expect(stored.visibleEventTypes).toEqual([]);
    });

    cleanup();
    const reloadFetchMock = stubTimelineFetch(projection());
    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: { project: 'mandible' },
    }));
    await waitFor(() => expect(reloadFetchMock.mock.calls.length).toBe(1));
    expect(JSON.parse(String(reloadFetchMock.mock.calls[0][1]?.body)).event_kinds).toEqual([]);
  });

  it('persists zoom and inspector collapsed state without viewport refetches', async () => {
    const fetchMock = stubTimelineFetch(projection());

    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: { project: 'mandible' },
    }));

    await waitFor(() => expect(screen.getByText('Build shared axis')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Zoom in'));
    expect(fetchMock.mock.calls.length).toBe(1);

    fireEvent.click(screen.getByLabelText('Collapse Timeline inspector'));
    expect(screen.getByLabelText('Show Timeline inspector')).toBeTruthy();
    await waitFor(() => {
      const stored = window.localStorage.getItem('mandible_timeline_view_state:v1:prj_mandible');
      expect(stored).toBeTruthy();
      const state = JSON.parse(String(stored));
      expect(state.timeWindow.from).toBeGreaterThan(Date.UTC(2026, 0, 1) - 12 * 60 * 60 * 1000);
      expect(state.timeWindow.to).toBeLessThan(Date.UTC(2026, 0, 2));
      expect(window.localStorage.getItem('mandible_app_right_sidebar:timeline:mandible:v1'))
        .toBe(JSON.stringify({ open: false, width: 350 }));
    });
  });

  it('clears stale projection and selection immediately when selecting another project', async () => {
    window.localStorage.setItem(
      'mandible_timeline_view_state:v1:mandible',
      JSON.stringify({
        explicitRootIssueIds: ['mandible-only-root'],
        expandedEventIds: ['mandible-only-event'],
        expandedPaths: ['mandible-only-path'],
        filterRows: [{
          id: 'local-label-mandible-only',
          title: 'label:mandible-only',
          chips: [{ field: 'label', values: ['mandible-only'], negated: false }],
          scope: { type: 'label', name: 'mandible-only' },
        }],
      }),
    );
    let resolveSecond: (value: ProjectTimelineProjection) => void = () => undefined;
    const second = new Promise<ProjectTimelineProjection>((resolve) => {
      resolveSecond = resolve;
    });
    const base = projection();
    const other = projectProjection('humble', 'Humble timeline shell', 'Load Humble coordination root');
    const fetchMock = stubTimelineFetch(base, second);

    render(h(TimelineView, {
      repos: [
        { id: 'mandible', name: 'mandible' },
        { id: 'humble', name: 'humble' },
      ],
      params: { project: 'mandible' },
    }));

    await waitFor(() => expect(screen.getByText('Build shared axis')).toBeTruthy());
    fireEvent.click(screen.getByText('Build shared axis'));
    expect(screen.getByText('Full body text')).toBeTruthy();

    changeSelect(screen.getByLabelText('Project'), 'humble');

    await waitFor(() => expect(screen.queryAllByText('Build shared axis')).toHaveLength(0));
    expect(screen.queryAllByText('Full body text')).toHaveLength(0);
    expect(screen.getByRole('status', { name: 'Loading timeline' })).toBeTruthy();
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(2));
    const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(body.project_ref).toBe('humble');
    expect(body.root_policy).toBe('coordination_and_explicit');
    expect(body.explicit_root_issue_ids).toEqual([]);
    expect(body.expanded_event_ids).toEqual([]);
    expect(body.expanded_paths).toEqual([]);
    expect(body.root_specs).toEqual([]);
    expect(body.event_kinds).toEqual(['body', 'comment', 'state']);

    resolveSecond(other);
    await waitFor(() => expect(screen.getByText('Load Humble coordination root')).toBeTruthy());
  });

  it('invalidates stale prior-project responses as soon as the selected request key changes', async () => {
    const mandible = projectProjection(
      'mandible',
      'Mandible coordination root',
      'Mandible stale response',
    );
    const feedbax = projectProjection(
      'feedbax',
      'Feedbax coordination root',
      'Feedbax selected response',
    );
    let resolveMandible: () => void = () => undefined;
    let resolveFeedbax: () => void = () => undefined;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return new Promise<Response>((resolve) => {
        const finish = (projectionBody: ProjectTimelineProjection) => {
          resolve(new Response(JSON.stringify(projectionBody), {
            headers: { 'content-type': 'application/json' },
          }));
        };
        if (body.project_ref === 'mandible') {
          resolveMandible = () => finish(mandible);
          return;
        }
        if (body.project_ref === 'feedbax') {
          resolveFeedbax = () => finish(feedbax);
          return;
        }
        finish(projection());
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(h(TimelineView, {
      repos: [
        { id: 'mandible', name: 'mandible' },
        { id: 'feedbax', name: 'feedbax' },
      ],
      params: { project: 'mandible' },
    }));

    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(1));
    changeSelect(screen.getByLabelText('Project'), 'feedbax');
    resolveMandible();
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(2));
    expect(screen.queryByText('Mandible stale response')).toBeNull();

    resolveFeedbax();
    await waitFor(() => expect(screen.getByText('Feedbax selected response')).toBeTruthy());
    expect(screen.queryByText('Mandible stale response')).toBeNull();

    await waitFor(() => {
      expect(screen.getByText('Feedbax selected response')).toBeTruthy();
      expect(screen.queryByText('Mandible stale response')).toBeNull();
    });
  });

  it('keeps the last valid projection mounted while a newer same-project request is syncing', async () => {
    let resolveSecond: (value: ProjectTimelineProjection) => void = () => undefined;
    const second = new Promise<ProjectTimelineProjection>((resolve) => {
      resolveSecond = resolve;
    });
    stubTimelineFetch(projection(), second);

    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: { project: 'mandible' },
    }));

    await waitFor(() => expect(screen.getByText('Build shared axis')).toBeTruthy());
    fireEvent.click(screen.getByText('Closed'));
    expect(screen.getByText('Build shared axis')).toBeTruthy();
    expect(screen.queryByText('Syncing')).toBeNull();
    expect(screen.getByRole('status', { name: 'Updating timeline' })).toBeTruthy();

    resolveSecond(projection({
      events: [
        {
          ...projection().events[0],
          id: 'event-next',
          display_headline: 'Synced headline',
        },
      ],
    }));
    await waitFor(() => expect(screen.getByText('Synced headline')).toBeTruthy());
  });

  it('preserves selected event state when expansion refetches without URL selection params', async () => {
    const expanded = projection({
      rows: [
        ...projection().rows,
        {
          ...projection().rows[0],
          id: 'row-child',
          kind: 'transient',
          parent_row_id: 'row-root',
          source_event_id: 'event-body',
          depth: 1,
        },
      ],
      links: [
        {
          ...projection().links[0],
          expanded_row_id: 'row-child',
        },
      ],
    });
    stubTimelineFetch(projection(), expanded);

    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: { project: 'mandible' },
    }));

    await waitFor(() => expect(screen.getByText('Build shared axis')).toBeTruthy());
    fireEvent.click(screen.getByText('Build shared axis'));
    expect(screen.getByText('Full body text')).toBeTruthy();
    const rowsBefore = screen.getAllByRole('row').length;
    fireEvent.click(screen.getByText('Expand refs'));

    await waitFor(() => expect(screen.getAllByRole('row').length).toBe(rowsBefore + 1));
    expect(screen.getByText('Full body text')).toBeTruthy();
    expect(screen.queryByText('No selection')).toBeNull();
  });

  it('does not auto-select a replacement when the selected event disappears', async () => {
    stubTimelineFetch(projection(), projection({ events: [] }));

    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: { project: 'mandible' },
    }));

    await waitFor(() => expect(screen.getByText('Build shared axis')).toBeTruthy());
    fireEvent.click(screen.getByText('Build shared axis'));
    expect(screen.getAllByText('Build shared axis').length).toBeGreaterThan(1);
    fireEvent.click(screen.getByText('Closed'));

    await waitFor(() => expect(screen.getByText('Selection is outside the current projection.')).toBeTruthy());
    expect(screen.queryByText('No selection')).toBeNull();
    expect(screen.queryByText('Synced headline')).toBeNull();
  });
});
