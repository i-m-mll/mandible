import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';

import { parseRouteFromHash } from '../ui/src/routing';
import { TimelineView } from '../ui/src/views/timeline';
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

  it('keeps the last valid projection mounted while a newer request is syncing', async () => {
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
    expect(screen.getByText('Syncing')).toBeTruthy();

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
});
