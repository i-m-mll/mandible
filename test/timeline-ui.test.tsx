import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { useCallback, useMemo, useState } from 'preact/hooks';

import { parseRouteFromHash } from '../ui/src/routing';
import {
  AppShellProvider,
  type AppRightSidebarDescriptor,
  type AppShellContextValue,
} from '../ui/src/app-shell';
import { TimelineView as RawTimelineView, type TimelineViewProps } from '../ui/src/views/timeline';
import type { ProjectTimelineProjection } from '../ui/src/types/timeline';

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

beforeEach(() => {
  stubLocalStorage();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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
      explicit_root_issue_ids: [],
      promoted_root_issue_ids: [],
      expanded_event_ids: [],
      expanded_paths: [],
      include_closed: false,
      statuses: ['open'],
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
          id: 'iss_root',
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
          id: 'iss_root',
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
          id: 'iss_root:body',
          issue_id: 'iss_root',
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
          id: 'iss_root:body',
          issue_id: 'iss_root',
        },
        source_issue: {
          id: 'iss_root',
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
          id: 'iss_child',
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

function TimelineView(props: TimelineViewProps): JSX.Element {
  const [rightSidebar, setRightSidebar] = useState<AppRightSidebarDescriptor | null>(null);
  const registerRightSidebar = useCallback((descriptor: AppRightSidebarDescriptor) => {
    setRightSidebar(descriptor);
    return () => setRightSidebar((current) => (current?.id === descriptor.id ? null : current));
  }, []);
  const shell = useMemo<AppShellContextValue>(() => ({
    rightSidebar,
    registerRightSidebar,
  }), [registerRightSidebar, rightSidebar]);
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
        <aside className="app-right-sidebar" aria-label={rightSidebar.ariaLabel}>
          {rightSidebar.content}
        </aside>
      ) : null}
    </AppShellProvider>
  );
}

const TEST_DAY_MS = 24 * 60 * 60 * 1000;

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
          id: 'iss_secondary',
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
          id: 'iss_secondary',
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

function sameTimeClusterProjection(): ProjectTimelineProjection {
  const base = projection();
  const timestamp = Date.UTC(2026, 0, 1, 12);
  return projection({
    events: [
      {
        ...base.events[0],
        id: 'event-same-a',
        timestamp,
        ordinal: 0,
        display_headline: 'Same cluster A',
        body: 'First same-time body',
        kind: 'body',
        link_ids: [],
      },
      {
        ...base.events[0],
        id: 'event-same-b',
        timestamp,
        ordinal: 1,
        display_headline: 'Same cluster B',
        body: 'Second same-time body',
        kind: 'comment',
        link_ids: [],
      },
    ],
    links: [],
    time_axis: {
      start: Date.UTC(2026, 0, 1),
      end: Date.UTC(2026, 0, 3),
      event_count: 2,
    },
  });
}

function rangeClusterProjection(): ProjectTimelineProjection {
  const base = projection();
  const start = Date.UTC(2026, 0, 1, 12);
  const events = [0, 15, 30, 45].map((minutes, index) => ({
    ...base.events[0],
    id: `event-range-${index}`,
    timestamp: start + minutes * 60 * 1000,
    ordinal: index,
    display_headline: `Range cluster ${index + 1}`,
    body: `Range event ${index + 1}`,
    kind: 'comment' as const,
    link_ids: [],
  }));
  return projection({
    events,
    links: [],
    time_axis: {
      start: Date.UTC(2026, 0, 1),
      end: Date.UTC(2026, 0, 3),
      event_count: events.length,
    },
  });
}

describe('Timeline route', () => {
  it('parses timeline hashes as a first-class workspace', () => {
    expect(parseRouteFromHash('#/timeline?project=mandible&density=compact')).toEqual({
      tab: 'timeline',
      params: { project: 'mandible', density: 'compact' },
    });
  });
});

describe('TimelineView', () => {
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
    expect(body).not.toHaveProperty('from');
    expect(body).not.toHaveProperty('to');
    expect(document.querySelector('.timeline-grid--compact')).toBeTruthy();
  });

  it('keeps route-ref and canonical project storage coherent after load', async () => {
    stubTimelineFetch(projection());

    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: { project: 'mandible', density: 'expanded' },
    }));

    await waitFor(() => expect(screen.getByText('Build shared axis')).toBeTruthy());
    await waitFor(() => {
      const canonical = window.localStorage.getItem('mandible_timeline_view_state:v1:prj_mandible');
      const routeRef = window.localStorage.getItem('mandible_timeline_view_state:v1:mandible');
      expect(canonical).toBeTruthy();
      expect(routeRef).toBeTruthy();
      expect(JSON.parse(String(canonical)).density).toBe('expanded');
      expect(JSON.parse(String(routeRef)).density).toBe('expanded');
    });
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

    fireEvent.click(screen.getByLabelText('Collapse inspector'));
    expect(screen.getByLabelText('Show inspector')).toBeTruthy();
    await waitFor(() => {
      const stored = window.localStorage.getItem('mandible_timeline_view_state:v1:prj_mandible');
      expect(stored).toBeTruthy();
      const state = JSON.parse(String(stored));
      expect(state.timeWindow.from).toBeGreaterThan(Date.UTC(2026, 0, 1) - 12 * 60 * 60 * 1000);
      expect(state.timeWindow.to).toBeLessThan(Date.UTC(2026, 0, 2));
      expect(state.panes.inspector).toBe(false);
    });
  });

  it('uses a gentler ctrl-wheel zoom than button zoom', async () => {
    const fetchMock = stubTimelineFetch(projection());

    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: {
        project: 'mandible',
        from: String(Date.UTC(2026, 0, 1, 12)),
        to: String(Date.UTC(2026, 0, 2, 12)),
      },
    }));

    await waitFor(() => expect(screen.getByText('Build shared axis')).toBeTruthy());
    fireEvent.wheel(screen.getByLabelText('Timeline time canvas'), {
      ctrlKey: true,
      deltaY: -100,
      clientX: 100,
    });
    expect(fetchMock.mock.calls.length).toBe(1);

    await waitFor(() => {
      const stored = window.localStorage.getItem('mandible_timeline_view_state:v1:prj_mandible');
      expect(stored).toBeTruthy();
      const state = JSON.parse(String(stored));
      expect(state.timeWindow.to - state.timeWindow.from).toBeCloseTo(TEST_DAY_MS * 0.9, 0);
    });
  });

  it('preserves sub-day viewport times when date-only boundaries are edited', async () => {
    const base = projection();
    const fetchMock = stubTimelineFetch(projection({
      events: [
        base.events[0],
        {
          ...base.events[0],
          id: 'event-later',
          timestamp: Date.UTC(2026, 0, 4, 12),
          ordinal: 1,
          display_headline: 'Later domain anchor',
          link_ids: [],
        },
      ],
    }));

    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: {
        project: 'mandible',
        from: String(Date.UTC(2026, 0, 1, 13, 45, 30, 250)),
        to: String(Date.UTC(2026, 0, 2, 17, 20, 10, 500)),
      },
    }));

    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(1));
    await waitFor(() => expect(screen.getByText('Timeline UI shell')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('To'), {
      target: { value: '2026-01-03' },
    });

    await waitFor(() => {
      const stored = window.localStorage.getItem('mandible_timeline_view_state:v1:prj_mandible');
      expect(stored).toBeTruthy();
      const state = JSON.parse(String(stored));
      expect(state.timeWindow.from).toBe(Date.UTC(2026, 0, 1, 13, 45, 30, 250));
      expect(state.timeWindow.to).toBe(Date.UTC(2026, 0, 3, 17, 20, 10, 500));
    });
  });

  it('uses the visible event-type extent for padded mark positions', async () => {
    const base = projection();
    const commentEvent = {
      ...base.events[0],
      id: 'event-comment',
      kind: 'comment' as const,
      timestamp: Date.UTC(2026, 0, 2, 12),
      ordinal: 1,
      display_headline: 'Comment extent anchor',
      body: 'Comment body',
      link_ids: [],
    };
    const fetchMock = stubTimelineFetch(projection({
      events: [base.events[0], commentEvent],
    }));

    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: { project: 'mandible' },
    }));

    await waitFor(() => expect(screen.getByText('Comment extent anchor')).toBeTruthy());
    fireEvent.click(screen.getByText('Body'));

    await waitFor(() => expect(screen.queryByText('Build shared axis')).toBeNull());
    const commentButton = screen.getByText('Comment extent anchor').closest('button') as HTMLButtonElement;
    expect(commentButton.style.left).toBe('410px');
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it('pads fitted timeline edges by the rendered mark width', async () => {
    const base = projection();
    const firstEvent = {
      ...base.events[0],
      id: 'event-first-edge',
      timestamp: Date.UTC(2026, 0, 1, 12),
      ordinal: 0,
      display_headline: 'First edge event',
      link_ids: [],
    };
    const lastEvent = {
      ...base.events[0],
      id: 'event-last-edge',
      timestamp: Date.UTC(2026, 0, 3, 12),
      ordinal: 1,
      display_headline: 'Last edge event',
      link_ids: [],
    };
    stubTimelineFetch(projection({
      events: [firstEvent, lastEvent],
      links: [],
      time_axis: {
        start: Date.UTC(2026, 0, 1),
        end: Date.UTC(2026, 0, 4),
        event_count: 2,
      },
    }));

    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: { project: 'mandible', density: 'comfortable' },
    }));

    await waitFor(() => expect(screen.getByText('Last edge event')).toBeTruthy());

    const firstButton = screen.getByText('First edge event').closest('button') as HTMLButtonElement;
    const lastButton = screen.getByText('Last edge event').closest('button') as HTMLButtonElement;
    const surface = document.querySelector('.timeline-time-surface') as HTMLElement;
    const surfaceWidthPx = parseFloat(surface.style.width);
    const halfComfortableMarkWidthPx = 85;

    expect(parseFloat(firstButton.style.left)).toBeGreaterThan(halfComfortableMarkWidthPx);
    expect(parseFloat(lastButton.style.left)).toBeLessThan(
      surfaceWidthPx - halfComfortableMarkWidthPx,
    );
  });

  it('promotes stale fit-all windows to the padded render domain', async () => {
    const base = projection();
    const firstTimestamp = Date.UTC(2026, 0, 1, 12);
    const lastTimestamp = Date.UTC(2026, 0, 3, 12);
    const firstEvent = {
      ...base.events[0],
      id: 'event-stale-first-edge',
      timestamp: firstTimestamp,
      ordinal: 0,
      display_headline: 'Stale first edge event',
      link_ids: [],
    };
    const lastEvent = {
      ...base.events[0],
      id: 'event-stale-last-edge',
      timestamp: lastTimestamp,
      ordinal: 1,
      display_headline: 'Stale last edge event',
      link_ids: [],
    };
    window.localStorage.setItem('mandible_timeline_view_state:v1:mandible', JSON.stringify({
      timeWindow: { from: firstTimestamp, to: lastTimestamp },
    }));
    stubTimelineFetch(projection({
      events: [firstEvent, lastEvent],
      links: [],
      time_axis: {
        start: Date.UTC(2026, 0, 1),
        end: Date.UTC(2026, 0, 4),
        event_count: 2,
      },
    }));

    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: { project: 'mandible', density: 'comfortable' },
    }));

    await waitFor(() => expect(screen.getByText('Stale last edge event')).toBeTruthy());

    const firstButton = screen.getByText('Stale first edge event').closest('button') as HTMLButtonElement;
    const lastButton = screen.getByText('Stale last edge event').closest('button') as HTMLButtonElement;
    const surface = document.querySelector('.timeline-time-surface') as HTMLElement;
    const surfaceWidthPx = parseFloat(surface.style.width);

    expect(surfaceWidthPx).toBe(820);
    expect(parseFloat(firstButton.style.left)).toBeGreaterThan(85);
    expect(parseFloat(lastButton.style.left)).toBeLessThan(surfaceWidthPx - 85);
  });

  it('renders hour ticks for day-scale timeline views', async () => {
    stubTimelineFetch(projection());

    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: { project: 'mandible' },
    }));

    await waitFor(() => expect(screen.getByText('Build shared axis')).toBeTruthy());
    expect(screen.getByText('06:00')).toBeTruthy();
    expect(screen.getByText('12:00')).toBeTruthy();
    expect(screen.getByText('18:00')).toBeTruthy();
  });

  it('clears stale projection and selection immediately when selecting another project', async () => {
    let resolveSecond: (value: ProjectTimelineProjection) => void = () => undefined;
    const second = new Promise<ProjectTimelineProjection>((resolve) => {
      resolveSecond = resolve;
    });
    const base = projection();
    const other = projection({
      project: {
        ...base.project,
        id: 'prj_humble',
        display_name: 'humble',
        repo_id: 'humble',
        repo_name: 'humble',
        repo_root: '/repo/humble',
      },
      rows: [
        {
          ...base.rows[0],
          id: 'row-humble',
          issue: {
            ...base.rows[0].issue,
            id: 'iss_humble',
            project_id: 'prj_humble',
            display_id: 'abc9876',
            title: 'Humble timeline shell',
          },
        },
      ],
      events: [
        {
          ...base.events[0],
          id: 'event-humble',
          row_id: 'row-humble',
          issue: {
            ...base.events[0].issue,
            id: 'iss_humble',
            project_id: 'prj_humble',
            display_id: 'abc9876',
            title: 'Humble timeline shell',
          },
          display_headline: 'Load Humble timeline',
          body: 'Humble body text',
          link_ids: [],
        },
      ],
      links: [],
    });
    stubTimelineFetch(base, second);

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

    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'humble' } });

    expect(screen.queryByText('Build shared axis')).toBeNull();
    expect(screen.queryByText('Full body text')).toBeNull();
    expect(screen.queryByText('Syncing')).toBeNull();

    resolveSecond(other);
    await waitFor(() => expect(screen.getByText('Load Humble timeline')).toBeTruthy());
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
    fireEvent.click(screen.getByText('Expand refs'));

    await waitFor(() => expect(document.querySelectorAll('.timeline-row').length).toBe(2));
    expect(screen.getByText('Full body text')).toBeTruthy();
    expect(screen.queryByText('No selection')).toBeNull();
  });

  it('expands issue refs from a selected transient event', async () => {
    const base = projection();
    const transient = projection({
      rows: [
        ...base.rows,
        {
          ...base.rows[0],
          id: 'row-child',
          kind: 'transient',
          parent_row_id: 'row-root',
          source_event_id: 'event-body',
          depth: 1,
          path: ['row-root', 'row-child'],
        },
      ],
      events: [
        ...base.events,
        {
          ...base.events[0],
          id: 'event-transient',
          row_id: 'row-child',
          display_headline: 'Transient ref event',
          body: 'Nested event body',
          link_ids: ['link-grandchild'],
        },
      ],
      links: [
        ...base.links,
        {
          ...base.links[0],
          id: 'link-grandchild',
          event_id: 'event-transient',
          source_row_id: 'row-child',
          target_issue: {
            ...base.links[0].target_issue,
            id: 'iss_grandchild',
            display_id: 'abc1234',
            title: 'Nested referenced issue',
          },
          normalized_ref: 'abc1234',
          raw_ref: 'abc1234',
          expanded_row_id: null,
        },
      ],
    });
    const expanded = projection({
      rows: [
        ...transient.rows,
        {
          ...base.rows[0],
          id: 'row-grandchild',
          kind: 'transient',
          parent_row_id: 'row-child',
          source_event_id: 'event-transient',
          depth: 2,
          path: ['row-root', 'row-child', 'row-grandchild'],
          issue: transient.links[1].target_issue,
        },
      ],
      events: transient.events,
      links: [
        transient.links[0],
        {
          ...transient.links[1],
          expanded_row_id: 'row-grandchild',
        },
      ],
    });
    const fetchMock = stubTimelineFetch(transient, expanded);

    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: { project: 'mandible' },
    }));

    await waitFor(() => expect(screen.getByText('Transient ref event')).toBeTruthy());
    fireEvent.click(screen.getByText('Transient ref event'));
    expect(screen.getByText('Nested event body')).toBeTruthy();
    expect(screen.getByText('Expand refs')).toBeTruthy();

    fireEvent.click(screen.getByText('Expand refs'));

    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
    const expandBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(expandBody.expanded_event_ids).toContain('event-transient');
    await waitFor(() => expect(document.querySelectorAll('.timeline-row').length).toBe(3));
    expect(screen.getByText('Fold refs')).toBeTruthy();
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
    expect(screen.queryByText('Synced headline')).toBeNull();
  });

  it('synchronizes gutter and timeline row heights from packed lane layout', async () => {
    stubTimelineFetch(nearTimeProjection());

    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: { project: 'mandible', density: 'comfortable' },
    }));

    await waitFor(() => expect(screen.getByText('Near event C')).toBeTruthy());
    const gutterRows = Array.from(document.querySelectorAll<HTMLElement>('.timeline-gutter-row'));
    const timelineRows = Array.from(document.querySelectorAll<HTMLElement>('.timeline-row'));

    expect(gutterRows).toHaveLength(2);
    expect(timelineRows).toHaveLength(2);
    expect(gutterRows[0].style.height).toBe(timelineRows[0].style.height);
    expect(gutterRows[1].style.height).toBe(timelineRows[1].style.height);
    expect(parseInt(timelineRows[0].style.height, 10)).toBeGreaterThan(
      parseInt(timelineRows[1].style.height, 10),
    );
  });

  it('renders near-time event marks in separate lanes without horizontal displacement', async () => {
    stubTimelineFetch(nearTimeProjection());

    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: { project: 'mandible', density: 'comfortable' },
    }));

    await waitFor(() => expect(screen.getByText('Near event C')).toBeTruthy());
    const nearButtons = ['Near event A', 'Near event B', 'Near event C'].map((label) => (
      screen.getByText(label).closest('button') as HTMLButtonElement
    ));
    const laneTops = nearButtons.map((button) => button.style.top);
    const lefts = nearButtons.map((button) => parseFloat(button.style.left));

    expect(new Set(laneTops).size).toBe(3);
    expect(lefts[0]).toBeLessThan(lefts[1]);
    expect(lefts[1]).toBeLessThan(lefts[2]);
  });

  it('renders same-time clusters and opens a chronological child list', async () => {
    stubTimelineFetch(sameTimeClusterProjection());

    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: { project: 'mandible' },
    }));

    const cluster = await screen.findByRole('button', {
      name: /Same-time cluster, 2 events, Body 1, Comment 1, at 2026-01-01 12:00:00Z/,
    });
    expect(screen.queryByText('Same cluster A')).toBeNull();

    fireEvent.click(cluster);

    const clusterList = screen.getByText('Cluster events').closest('.timeline-list-fallback') as HTMLElement;
    expect(within(clusterList).getByText('Same cluster A')).toBeTruthy();
    expect(within(clusterList).getByText('Same cluster B')).toBeTruthy();
    await waitFor(() => {
      const stored = window.localStorage.getItem('mandible_timeline_view_state:v1:prj_mandible');
      expect(stored).toBeTruthy();
      expect(JSON.parse(String(stored)).selectedClusterId).toContain('same_time_cluster');
    });

    fireEvent.click(within(clusterList).getByText('Same cluster B'));

    expect(screen.getByText('Second same-time body')).toBeTruthy();
    await waitFor(() => {
      const stored = window.localStorage.getItem('mandible_timeline_view_state:v1:prj_mandible');
      const state = JSON.parse(String(stored));
      expect(state.selectedEventId).toBe('event-same-b');
      expect(state.selectedClusterId).toContain('same_time_cluster');
    });
  });

  it('renders range clusters with a true time range label and span', async () => {
    stubTimelineFetch(rangeClusterProjection());

    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: { project: 'mandible', density: 'comfortable' },
    }));

    const cluster = await screen.findByRole('button', {
      name: /Range cluster, 4 events, Comment 4, from 2026-01-01 12:00:00Z to 2026-01-01 12:45:00Z/,
    });

    expect(cluster.classList.contains('timeline-cluster--range')).toBe(true);
    expect(parseFloat((cluster as HTMLButtonElement).style.left)).toBeGreaterThan(0);
    expect(parseFloat((cluster as HTMLButtonElement).style.width)).toBeGreaterThan(0);
  });
});
