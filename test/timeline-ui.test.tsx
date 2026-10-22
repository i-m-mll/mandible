import { render, screen, waitFor, cleanup, fireEvent, within, act } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { useCallback, useMemo, useRef, useState } from 'preact/hooks';

import { parseRouteFromHash } from '../../ui/src/routing';
import {
  AppShellProvider,
  type AppRightSidebarDescriptor,
  type AppShellContextValue,
} from '../../ui/src/app-shell';
import { TimelineView as RawTimelineView, type TimelineViewProps } from '../../ui/src/views/timeline';
import type {
  ProjectTimelineInput,
  ProjectTimelineProjection,
  TimelineIssueRef,
  TimelineRowOccurrence,
  TimelineRowSpecInput,
} from '../../ui/src/types/timeline';
import { __resetBrowserSessionForTests, ensureClientAccess } from '../../ui/src/client-auth-token';

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

function emptyProjectProjection(
  projectRef: string,
  title: string,
): ProjectTimelineProjection {
  const base = projectProjection(projectRef, title, `${title} event`);
  return projection({
    project: base.project,
    inputs: base.inputs,
    rows: base.rows,
    events: [],
    links: [],
    time_axis: {
      start: Date.UTC(2026, 0, 1),
      end: Date.UTC(2026, 0, 2),
      event_count: 0,
    },
    diagnostics: {
      ...base.diagnostics,
      root_count: base.rows.length,
      reachable_from_roots_count: base.rows.length,
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

function stubTimelineFetchResolver(
  resolver: (body: ProjectTimelineInput) => ProjectTimelineProjection | Promise<ProjectTimelineProjection>,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as ProjectTimelineInput;
    return Promise.resolve(resolver(body)).then((projectionBody) => {
      if (init?.signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      return new Response(JSON.stringify(projectionBody), {
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

function rowSpecGroupProjection(options: { residual?: boolean } = {}): ProjectTimelineProjection {
  const base = projection();
  const groupId = options.residual ? 'row:spec:residual:0' : 'row:spec:review:0';
  const specId = options.residual ? 'residual' : 'review';
  const specTitle = options.residual ? 'Residual issues' : 'Needs review';
  const memberA = {
    ...base.rows[0].issue,
    id: 'issue_member_a',
    display_id: 'aaa1111',
    title: 'Review member A',
    labels: ['needs-review'],
  };
  const memberB = {
    ...base.rows[0].issue,
    id: 'issue_member_b',
    display_id: 'bbb2222',
    title: options.residual ? 'Residual member B' : 'Review member B',
    labels: options.residual ? [] : ['needs-review'],
  };
  const group = {
    ...base.rows[0],
    id: groupId,
    issue: null,
    row_spec: {
      id: specId,
      title: specTitle,
      anchor_issue_id: null,
      scope: options.residual
        ? { type: 'residual' as const }
        : { type: 'label' as const, name: 'needs-review' },
    },
    kind: 'root' as const,
    parent_row_id: null,
    source_event_id: null,
    depth: 0,
    path: [`rowspec:${specId}`],
    expanded: true,
  };
  const memberRows = [
    {
      ...base.rows[0],
      id: `row:spec:${specId}:member:${memberA.id}`,
      issue: memberA,
      row_spec: group.row_spec,
      kind: 'member' as const,
      parent_row_id: groupId,
      source_event_id: null,
      depth: 1,
      path: [`rowspec:${specId}`, `issue:${memberA.id}`],
      expanded: false,
    },
    {
      ...base.rows[0],
      id: `row:spec:${specId}:member:${memberB.id}`,
      issue: memberB,
      row_spec: group.row_spec,
      kind: 'member' as const,
      parent_row_id: groupId,
      source_event_id: null,
      depth: 1,
      path: [`rowspec:${specId}`, `issue:${memberB.id}`],
      expanded: false,
    },
  ];
  const events = [
    {
      ...base.events[0],
      id: 'event-member-a-start',
      row_id: memberRows[0].id,
      issue: memberA,
      timestamp: Date.UTC(2026, 0, 1, 12),
      ordinal: 0,
      display_headline: 'Review A start',
      body: 'Review A body',
      link_ids: [],
    },
    {
      ...base.events[0],
      id: 'event-member-a-end',
      row_id: memberRows[0].id,
      issue: memberA,
      timestamp: Date.UTC(2026, 0, 2, 12),
      ordinal: 1,
      display_headline: 'Review A end',
      body: 'Review A end body',
      link_ids: [],
    },
    {
      ...base.events[0],
      id: 'event-member-b',
      row_id: memberRows[1].id,
      issue: memberB,
      timestamp: Date.UTC(2026, 0, 3, 12),
      ordinal: 0,
      display_headline: options.residual ? 'Residual B event' : 'Review B event',
      body: 'Review B body',
      link_ids: [],
    },
  ];

  return projection({
    rows: [group, ...memberRows],
    events,
    links: [],
    time_axis: {
      start: Date.UTC(2026, 0, 1),
      end: Date.UTC(2026, 0, 4),
      event_count: events.length,
    },
  });
}

function filterComposerProjection(): ProjectTimelineProjection {
  const base = projection();
  const issues = [
    {
      ...base.rows[0].issue,
      id: 'issue_auth_feature',
      display_id: 'auth111',
      title: 'Auth feature row',
      kind: 'feature',
      labels: ['auth', 'timeline'],
    },
    {
      ...base.rows[0].issue,
      id: 'issue_auth_unknown',
      display_id: 'auth222',
      title: 'Auth unknown row',
      kind: 'unknown',
      labels: ['auth'],
    },
    {
      ...base.rows[0].issue,
      id: 'issue_maintenance',
      display_id: 'maint33',
      title: 'Maintenance row',
      kind: 'maintenance',
      labels: ['ops'],
    },
  ];
  const rows = issues.map((issue, index) => ({
    ...base.rows[0],
    id: `row-filter-${index}`,
    issue,
    kind: index === 0 ? 'root' as const : 'explicit_root' as const,
    path: [`row-filter-${index}`],
  }));
  const events = rows.map((row, index) => ({
    ...base.events[0],
    id: `event-filter-${index}`,
    row_id: row.id,
    issue: row.issue,
    timestamp: Date.UTC(2026, 0, index + 1, 12),
    ordinal: 0,
    display_headline: `${row.issue.display_id} event`,
    body: `${row.issue.title} body`,
    link_ids: index === 1 ? ['link-auth-reference'] : [],
  }));
  return projection({
    rows,
    events,
    links: [{
      ...base.links[0],
      id: 'link-auth-reference',
      event_id: 'event-filter-1',
      source_row_id: rows[1].id,
      source_issue: issues[1],
      target_issue: issues[0],
      raw_ref: issues[0].display_id,
      normalized_ref: issues[0].display_id,
      expanded_row_id: null,
    }],
    time_axis: {
      start: Date.UTC(2026, 0, 1),
      end: Date.UTC(2026, 0, 4),
      event_count: events.length,
    },
    diagnostics: {
      ...base.diagnostics,
      total_issues: issues.length,
      root_count: rows.length,
      reachable_from_roots_count: rows.length,
    },
  });
}

function coordinationFilterProjection(rootSpecs: TimelineRowSpecInput[] = []): ProjectTimelineProjection {
  const base = projection();
  const coordinationIssue: TimelineIssueRef = {
    ...(base.rows[0].issue as TimelineIssueRef),
    id: 'issue_coordination',
    display_id: 'coord00',
    title: 'Coordination root',
    kind: 'coordination',
    labels: ['coordination', 'timeline'],
  };
  const residualIssue: TimelineIssueRef = {
    ...(base.rows[0].issue as TimelineIssueRef),
    id: 'issue_residual',
    display_id: 'resid44',
    title: 'Residual complement issue',
    kind: 'feature',
    labels: ['uncategorized'],
  };
  const projectIssues = [coordinationIssue, residualIssue];
  const coordinationRow: TimelineRowOccurrence = {
    ...base.rows[0],
    id: 'row-coordination-root',
    issue: coordinationIssue,
    kind: 'root',
    parent_row_id: null,
    path: ['root:coordination'],
    row_spec: null,
  };
  const rows: TimelineRowOccurrence[] = [coordinationRow];
  const events = [{
    ...base.events[0],
    id: 'event-coordination-root',
    row_id: coordinationRow.id,
    issue: coordinationIssue,
    display_headline: 'Coordination root event',
    body: 'Coordination root body',
    link_ids: [],
  }];
  const covered = new Set<string>();

  rootSpecs.forEach((spec, index) => {
    const specId = spec.id ?? `input:${index}`;
    const title = spec.title ?? `Filter ${index + 1}`;
    const groupId = `row:spec:${specId}:${index}`;
    const group: TimelineRowOccurrence = {
      ...base.rows[0],
      id: groupId,
      issue: null,
      row_spec: {
        id: specId,
        title,
        anchor_issue_id: spec.anchor_issue_id ?? spec.anchor ?? null,
        scope: spec.scope ?? null,
      },
      kind: 'root',
      parent_row_id: null,
      source_event_id: null,
      depth: 0,
      path: [`rowspec:${specId}`],
      expanded: false,
    };
    rows.push(group);
    const matched = projectIssues.filter((issue) => (
      spec.scope?.type === 'label'
        ? issue.labels.includes(spec.scope.name)
        : spec.scope?.type === 'kind'
          ? issue.kind === spec.scope.kind
          : false
    ));
    matched.forEach((issue, memberIndex) => {
      covered.add(issue.id);
      const memberRow: TimelineRowOccurrence = {
        ...base.rows[0],
        id: `${groupId}:member:${issue.id}`,
        issue,
        row_spec: group.row_spec,
        kind: 'member',
        parent_row_id: groupId,
        source_event_id: null,
        depth: 1,
        path: [`rowspec:${specId}`, `issue:${issue.id}`],
        expanded: false,
      };
      rows.push(memberRow);
      events.push({
        ...base.events[0],
        id: `event-${specId}-${memberIndex}`,
        row_id: memberRow.id,
        issue,
        display_headline: `${title} projected event`,
        body: `${issue.title} projected body`,
        link_ids: [],
      });
    });
  });

  const residualGroupId = `row:spec:residual:${rootSpecs.length}`;
  const residualGroup: TimelineRowOccurrence = {
    ...base.rows[0],
    id: residualGroupId,
    issue: null,
    row_spec: {
      id: 'residual',
      title: 'Residual issues',
      anchor_issue_id: null,
      scope: { type: 'residual' },
    },
    kind: 'root',
    parent_row_id: null,
    source_event_id: null,
    depth: 0,
    path: ['rowspec:residual'],
    expanded: false,
  };
  rows.push(residualGroup);
  if (rootSpecs.length > 0) {
    projectIssues.filter((issue) => !covered.has(issue.id)).forEach((issue, memberIndex) => {
      const memberRow: TimelineRowOccurrence = {
        ...base.rows[0],
        id: `${residualGroupId}:member:${issue.id}`,
        issue,
        row_spec: residualGroup.row_spec,
        kind: 'member',
        parent_row_id: residualGroupId,
        source_event_id: null,
        depth: 1,
        path: ['rowspec:residual', `issue:${issue.id}`],
        expanded: false,
      };
      rows.push(memberRow);
      events.push({
        ...base.events[0],
        id: `event-residual-${memberIndex}`,
        row_id: memberRow.id,
        issue,
        display_headline: `${issue.display_id} residual event`,
        body: `${issue.title} residual body`,
        link_ids: [],
      });
    });
  }

  return projection({
    rows,
    events,
    links: [],
    time_axis: {
      start: Date.UTC(2026, 0, 1),
      end: Date.UTC(2026, 0, 4),
      event_count: events.length,
    },
    diagnostics: {
      ...base.diagnostics,
      total_issues: projectIssues.length,
      root_count: rows.filter((row) => row.parent_row_id === null).length,
      reachable_from_roots_count: projectIssues.length,
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
  it('does not refetch unchanged request meaning after installing a projection or selecting an event', async () => {
    const fetchMock = stubTimelineFetchResolver(() => nearTimeProjection());
    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: { project: 'mandible' },
    }));
    const firstEvent = await screen.findByText('Near event A');
    await act(async () => {
      fireEvent.click(firstEvent.closest('button') as HTMLButtonElement);
    });
    await waitFor(() => {
      const stored = window.localStorage.getItem('mandible_timeline_view_state:v1:prj_mandible');
      expect(JSON.parse(String(stored)).selectedEventId).toBe('event-near-a');
    });
    const payloads = fetchMock.mock.calls.map(([, init]) => String(init?.body));
    expect(payloads.length).toBeGreaterThan(0);
    expect(new Set(payloads).size).toBe(payloads.length);
  });

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

  it('loads initial coordination roots without a transient verified-empty state', async () => {
    let resolveInitial: (value: ProjectTimelineProjection) => void = () => undefined;
    const initial = new Promise<ProjectTimelineProjection>((resolve) => {
      resolveInitial = resolve;
    });
    const fetchMock = stubTimelineFetch(initial);

    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: { project: 'mandible' },
    }));

    expect(screen.getByRole('status', { name: 'Loading timeline' })).toBeTruthy();
    expect(document.querySelector('.loading-skeleton--canvas')).toBeTruthy();
    expect(screen.queryByText('No timeline rows match the current controls.')).toBeNull();

    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(1));
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.project_ref).toBe('mandible');
    expect(body.root_policy).toBe('coordination_and_explicit');
    expect(body.event_kinds).toEqual(['body', 'comment', 'state']);

    resolveInitial(projectProjection(
      'mandible',
      'Mandible coordination root',
      'Mandible default coordination root',
    ));

    await waitFor(() => expect(screen.getByText('Mandible default coordination root')).toBeTruthy());
    expect(screen.queryByRole('status', { name: 'Loading timeline' })).toBeNull();
    expect(screen.queryByText('No timeline rows match the current controls.')).toBeNull();
  });

  it('hides timeline sidebar controls without removing the timeline canvas', async () => {
    stubTimelineFetch(projection());

    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: { project: 'mandible' },
      sidebarHidden: true,
    }));

    await waitFor(() => expect(screen.getByText('Build shared axis')).toBeTruthy());

    expect(document.querySelector('.timeline-sidebar')).toBeNull();
    expect(document.querySelector('.timeline-layout--sidebar-hidden')).toBeTruthy();
    expect(document.querySelector('.timeline-grid')).toBeTruthy();
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
    expect(document.querySelector('.timeline-grid--compact')).toBeTruthy();
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
    expect(document.querySelector('.timeline-grid--comfortable')).toBeTruthy();

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

  it('requests only the currently visible event kinds from the projection', async () => {
    let resolveSecond: (value: ProjectTimelineProjection) => void = () => undefined;
    const second = new Promise<ProjectTimelineProjection>((resolve) => {
      resolveSecond = resolve;
    });
    const fetchMock = stubTimelineFetch(projection(), second);

    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: { project: 'mandible' },
    }));

    await waitFor(() => expect(screen.getByText('Build shared axis')).toBeTruthy());
    fireEvent.click(screen.getByText('Comment'));

    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(2));
    const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(body.event_kinds).toEqual(['body', 'state']);

    resolveSecond(projection());
    await waitFor(() => expect(screen.getByText('Build shared axis')).toBeTruthy());
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

    const inspector = screen.getByLabelText('Timeline inspector');
    expect(inspector.className).toBe('app-right-sidebar');
    expect(inspector.querySelector('.timeline-inspector')).toBeTruthy();
    expect(inspector.querySelector('.timeline-inspector.detail-pane-shell')).toBeNull();
    expect(inspector.querySelector('[data-detail-pane-header-variant="compact"]')).toBeNull();
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

  it('renders timeline header actions in the pinned corner with split axis labels', async () => {
    stubTimelineFetch(projection());

    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: { project: 'mandible' },
    }));

    await waitFor(() => expect(screen.getByText('Build shared axis')).toBeTruthy());
    const corner = document.querySelector('.timeline-axis__corner') as HTMLElement;
    expect(corner).toBeTruthy();
    expect(corner.getAttribute('aria-hidden')).toBeNull();
    expect(within(corner).getByRole('button', { name: 'Zoom out' }).getAttribute('title')).toBe('Zoom out');
    expect(within(corner).getByRole('button', { name: 'Zoom in' }).getAttribute('title')).toBe('Zoom in');
    expect(within(corner).getByRole('button', { name: 'Fit all' }).getAttribute('title')).toBe('Fit all');
    expect(within(corner).getByRole('button', { name: 'Add row' }).getAttribute('title')).toBe('Add row');
    expect(screen.queryByLabelText('Timeline zoom')).toBeNull();
    expect(document.querySelector('.timeline-gutter-stack .timeline-add-row-button')).toBeNull();

    const axisViewport = document.querySelector('.timeline-axis__viewport') as HTMLElement;
    const axisSurface = document.querySelector('.timeline-axis__surface') as HTMLElement;
    const bodyScroll = document.querySelector('.timeline-body-scroll') as HTMLElement;
    const timeScroll = document.querySelector('.timeline-time-scroll') as HTMLElement;
    const tick = document.querySelector('.timeline-axis__tick') as HTMLElement;
    expect(axisViewport).toBeTruthy();
    expect(axisSurface).toBeTruthy();
    expect(bodyScroll).toBeTruthy();
    expect(timeScroll).toBeTruthy();
    expect(bodyScroll.parentElement?.classList.contains('timeline-main')).toBe(true);
    expect(bodyScroll.contains(corner)).toBe(true);
    expect(bodyScroll.contains(axisViewport)).toBe(true);
    expect(bodyScroll.contains(timeScroll)).toBe(true);
    expect(tick.querySelector('.timeline-axis__tick-context')).toBeTruthy();
    expect(tick.querySelector('.timeline-axis__tick-label')).toBeTruthy();
  });

  it('keeps the pinned axis and time canvas on one native horizontal scroller', async () => {
    const base = projection();
    stubTimelineFetch(projection({
      events: [
        base.events[0],
        {
          ...base.events[0],
          id: 'event-later-for-scroll-sync',
          timestamp: Date.UTC(2026, 0, 3, 12),
          ordinal: 1,
          display_headline: 'Later scroll sync anchor',
          link_ids: [],
        },
      ],
    }));

    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: {
        project: 'mandible',
        from: String(Date.UTC(2026, 0, 1, 12)),
        to: String(Date.UTC(2026, 0, 2, 12)),
      },
    }));

    await waitFor(() => expect(screen.getByText('Build shared axis')).toBeTruthy());
    const bodyScroll = document.querySelector('.timeline-body-scroll') as HTMLElement;
    const axisSurface = document.querySelector('.timeline-axis__surface') as HTMLElement;
    const timeScroll = screen.getByLabelText('Timeline time canvas') as HTMLElement;
    expect(timeScroll).toBe(bodyScroll);
    expect(timeScroll.contains(axisSurface)).toBe(true);
    expect(axisSurface.style.transform).toBe('');

    await waitFor(() => {
      expect(timeScroll.scrollLeft).toBeGreaterThan(0);
    });

    const nextScrollLeft = timeScroll.scrollLeft + 120;
    await act(async () => {
      await new Promise((resolve) => {
        window.setTimeout(resolve, 180);
      });
    });
    timeScroll.scrollLeft = nextScrollLeft;
    fireEvent.scroll(timeScroll);

    await waitFor(() => {
      expect(timeScroll.scrollLeft).toBe(nextScrollLeft);
      expect(axisSurface.style.transform).toBe('');
    });
  });

  it('maps pinch-out wheel gestures to zoom in', async () => {
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

    fireEvent.wheel(screen.getByLabelText('Timeline time canvas'), {
      ctrlKey: true,
      deltaY: 100,
      clientX: 100,
    });

    await waitFor(() => {
      const stored = window.localStorage.getItem('mandible_timeline_view_state:v1:prj_mandible');
      expect(stored).toBeTruthy();
      const state = JSON.parse(String(stored));
      expect(state.timeWindow.to - state.timeWindow.from).toBeCloseTo(TEST_DAY_MS, 0);
    });
  });

  it('zooms in from the fitted viewport with wheel gestures over the row area', async () => {
    const base = projection();
    stubTimelineFetch(projection({
      events: [
        base.events[0],
        {
          ...base.events[0],
          id: 'event-next-day',
          timestamp: Date.UTC(2026, 0, 2, 12),
          display_headline: 'Next day event',
        },
      ],
    }));

    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: { project: 'mandible' },
    }));

    await waitFor(() => expect(screen.getByText('Build shared axis')).toBeTruthy());
    fireEvent.wheel(screen.getByRole('grid'), {
      ctrlKey: true,
      deltaY: -100,
      clientX: 500,
    });
    fireEvent.scroll(screen.getByLabelText('Timeline time canvas'), {
      target: { scrollLeft: 0 },
    });

    await waitFor(() => {
      const stored = window.localStorage.getItem('mandible_timeline_view_state:v1:prj_mandible');
      expect(stored).toBeTruthy();
      const state = JSON.parse(String(stored));
      expect(state.timeWindow.to - state.timeWindow.from).toBeLessThan(TEST_DAY_MS * 1.35);
    });
    await waitFor(() => {
      const surface = document.querySelector('.timeline-time-surface') as HTMLElement;
      expect(parseFloat(surface.style.width)).toBeGreaterThan(820);
    });
  });

  it('recovers from the maximum zoomed-out viewport using the next pinch-in gesture', async () => {
    const base = projection();
    stubTimelineFetch(projection({
      events: [
        base.events[0],
        {
          ...base.events[0],
          id: 'event-recovery-next-day',
          timestamp: Date.UTC(2026, 0, 2, 12),
          display_headline: 'Recovery next day event',
        },
      ],
    }));

    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: {
        project: 'mandible',
        from: String(Date.UTC(2026, 0, 1, 12)),
        to: String(Date.UTC(2026, 0, 1, 18)),
      },
    }));

    await waitFor(() => expect(screen.getByText('Recovery next day event')).toBeTruthy());
    const grid = screen.getByRole('grid');
    fireEvent.click(screen.getByRole('button', { name: 'Fit all' }));

    let fittedSurfaceWidth = 0;
    await waitFor(() => {
      const stored = window.localStorage.getItem('mandible_timeline_view_state:v1:prj_mandible');
      expect(JSON.parse(String(stored)).timeWindow).toEqual({ from: null, to: null });
      const surface = document.querySelector('.timeline-time-surface') as HTMLElement;
      fittedSurfaceWidth = parseFloat(surface.style.width);
      expect(fittedSurfaceWidth).toBeLessThanOrEqual(821);
    });

    fireEvent.wheel(grid, { ctrlKey: true, deltaY: -100, clientX: 500 });

    await waitFor(() => {
      const surface = document.querySelector('.timeline-time-surface') as HTMLElement;
      expect(parseFloat(surface.style.width)).toBeGreaterThan(fittedSurfaceWidth * 1.05);
    });
  });

  it('handles native gesture events as a pinch fallback', async () => {
    stubTimelineFetch(projection());

    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: { project: 'mandible' },
    }));

    await waitFor(() => expect(screen.getByText('Build shared axis')).toBeTruthy());
    const grid = screen.getByRole('grid');
    const startEvent = new Event('gesturestart', { bubbles: true, cancelable: true });
    Object.defineProperty(startEvent, 'scale', { value: 1 });
    Object.defineProperty(startEvent, 'clientX', { value: 500 });
    grid.dispatchEvent(startEvent);
    const changeEvent = new Event('gesturechange', { bubbles: true, cancelable: true });
    Object.defineProperty(changeEvent, 'scale', { value: 1.2 });
    Object.defineProperty(changeEvent, 'clientX', { value: 500 });
    grid.dispatchEvent(changeEvent);

    await waitFor(() => {
      const stored = window.localStorage.getItem('mandible_timeline_view_state:v1:prj_mandible');
      const state = JSON.parse(String(stored));
      expect(state.timeWindow.to - state.timeWindow.from).toBeLessThan(TEST_DAY_MS * 1.35);
    });
  });

  it('persists timeline row gutter resizing from the right edge', async () => {
    stubTimelineFetch(projection());

    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: { project: 'mandible' },
    }));

    await waitFor(() => expect(screen.getByText('Build shared axis')).toBeTruthy());
    const separator = screen.getByRole('separator', { name: 'Resize timeline rows' });
    fireEvent.mouseDown(separator, { clientX: 300 });
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 360 }));
    window.dispatchEvent(new MouseEvent('pointerup'));

    await waitFor(() => {
      const grid = document.querySelector<HTMLElement>('.timeline-grid');
      expect(grid?.style.getPropertyValue('--timeline-row-list-width')).toBe('360px');
      const stored = window.localStorage.getItem('mandible_timeline_view_state:v1:prj_mandible');
      expect(stored).toBeTruthy();
      expect(JSON.parse(String(stored)).panes.rowListWidth).toBe(360);
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
    let resolveNarrow: (value: ProjectTimelineProjection) => void = () => undefined;
    const narrow = new Promise<ProjectTimelineProjection>((resolve) => {
      resolveNarrow = resolve;
    });
    const fetchMock = stubTimelineFetch(projection({
      events: [base.events[0], commentEvent],
    }), narrow);

    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: { project: 'mandible' },
    }));

    await waitFor(() => expect(screen.getByText('Comment extent anchor')).toBeTruthy());
    fireEvent.click(screen.getByText('Body'));

    await waitFor(() => expect(screen.queryByText('Build shared axis')).toBeNull());
    const commentButton = screen.getByText('Comment extent anchor').closest('button') as HTMLButtonElement;
    expect(commentButton.style.left).toBe('410px');
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(2));
    const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(body.event_kinds).toEqual(['comment', 'state']);

    resolveNarrow(projection({
      events: [commentEvent],
    }));
    await waitFor(() => expect(screen.getByText('Comment extent anchor')).toBeTruthy());
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

  it('respects explicit near-fit windows instead of snapping them back to fit', async () => {
    const base = projection();
    const firstTimestamp = Date.UTC(2026, 0, 1, 12);
    const lastTimestamp = Date.UTC(2026, 0, 3, 12);
    const firstEvent = {
      ...base.events[0],
      id: 'event-near-fit-first-edge',
      timestamp: firstTimestamp,
      ordinal: 0,
      display_headline: 'Near fit first edge event',
      link_ids: [],
    };
    const lastEvent = {
      ...base.events[0],
      id: 'event-near-fit-last-edge',
      timestamp: lastTimestamp,
      ordinal: 1,
      display_headline: 'Near fit last edge event',
      link_ids: [],
    };
    window.localStorage.setItem('mandible_timeline_view_state:v1:mandible', JSON.stringify({
      timeWindow: { from: firstTimestamp - TEST_DAY_MS / 12, to: lastTimestamp + TEST_DAY_MS / 12 },
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

    await waitFor(() => expect(screen.getByText('Near fit last edge event')).toBeTruthy());

    const surface = document.querySelector('.timeline-time-surface') as HTMLElement;
    expect(parseFloat(surface.style.width)).toBeGreaterThan(820);
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

  it('resolves a previously unseen project when route params catch up after selection', async () => {
    const repos = [
      { id: 'mandible', name: 'mandible' },
      { id: 'mll.bio', name: 'mll.bio' },
    ];
    let resolveMllBio: (value: ProjectTimelineProjection) => void = () => undefined;
    const mllBioResponse = new Promise<ProjectTimelineProjection>((resolve) => {
      resolveMllBio = resolve;
    });
    const fetchMock = stubTimelineFetch(
      projectProjection('mandible', 'Mandible coordination root', 'Mandible loaded root'),
      mllBioResponse,
    );
    const view = render(h(TimelineView, {
      repos,
      params: { project: 'mandible' },
    }));

    await waitFor(() => expect(screen.getByText('Mandible loaded root')).toBeTruthy());
    changeSelect(screen.getByLabelText('Project'), 'mll.bio');
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(2));
    expect(document.querySelector('.loading-skeleton--canvas')).toBeTruthy();

    view.rerender(h(TimelineView, {
      repos,
      params: { project: 'mll.bio' },
    }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(2));

    const secondBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(secondBody.project_ref).toBe('mll.bio');
    expect(secondBody.root_specs).toEqual([]);
    resolveMllBio(emptyProjectProjection('mll.bio', 'mll.bio residual root'));

    await waitFor(() => expect(screen.getByText('mll.bio residual root')).toBeTruthy());
    expect(screen.queryByText('Loading mll.bio timeline...')).toBeNull();
    expect(screen.queryByText('Mandible loaded root')).toBeNull();
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
    fireEvent.click(screen.getByText('Expand refs'));

    await waitFor(() => expect(document.querySelectorAll('.timeline-row').length).toBe(2));
    expect(screen.getByText('Full body text')).toBeTruthy();
    expect(screen.queryByText('No selection')).toBeNull();
  });

  it('keeps empty selection distinct from stale route selection', async () => {
    stubTimelineFetch(projection());
    const view = render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: { project: 'mandible' },
    }));

    await waitFor(() => expect(screen.getByText('Build shared axis')).toBeTruthy());
    expect(screen.getByText('No selection')).toBeTruthy();
    expect(screen.queryByText('Selection is outside the current projection.')).toBeNull();

    view.rerender(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: { project: 'mandible', row: 'row-no-longer-projected' },
    }));

    await waitFor(() => {
      expect(screen.getByText('Selection is outside the current projection.')).toBeTruthy();
    });
    expect(screen.getByText('row-no-longer-projected')).toBeTruthy();
    expect(screen.queryByText('No selection')).toBeNull();
  });

  it('renders selected event bodies with ledger links and header actions', async () => {
    const base = projection();
    stubTimelineFetch(projection({
      events: [{
        ...base.events[0],
        body: 'Full body text references [issue:96b5bff].',
      }],
    }));

    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: { project: 'mandible' },
    }));

    await waitFor(() => expect(screen.getByText('Build shared axis')).toBeTruthy());
    fireEvent.click(screen.getByText('Build shared axis'));

    const body = document.querySelector<HTMLElement>('.timeline-event-body');
    const actionRow = document.querySelector<HTMLElement>('.timeline-action-row--event');
    expect(body).toBeTruthy();
    expect(actionRow).toBeTruthy();
    expect(actionRow?.nextElementSibling).toBe(body);
    expect(within(body!).getByRole('link', { name: '96b5bff' }).getAttribute('href')).toBe(
      '#/issues?repo=mandible&issue=96b5bff',
    );
    expect(screen.getByText('Expand refs')).toBeTruthy();
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
            id: 'issue_grandchild',
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
    expect(expandBody.depth).toBe(2);
    await waitFor(() => expect(document.querySelectorAll('.timeline-row').length).toBe(3));
    const eventButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.timeline-event'));
    expect(eventButtons.some((button) => (
      button.textContent?.includes('Transient ref event')
      && button.classList.contains('timeline-event--expanded')
    ))).toBe(true);
    const sourceParent = document.querySelector<HTMLElement>('.timeline-row--source-parent');
    expect(sourceParent).toBeTruthy();
    expect(sourceParent?.style.getPropertyValue('--source-parent-x')).toMatch(/px$/);
    expect(sourceParent?.style.getPropertyValue('--source-parent-start-y')).toMatch(/px$/);
    expect(document.querySelector('.timeline-row--has-origin')).toBeTruthy();
    expect(document.querySelector('.timeline-origin-marker')).toBeNull();
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
    expect(screen.queryByText('No selection')).toBeNull();
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
    expect(screen.getByText('Zoom to cluster')).toBeTruthy();
    expect(within(clusterList).getByText('Same cluster A')).toBeTruthy();
    expect(within(clusterList).getByText('Same cluster B')).toBeTruthy();
    await waitFor(() => {
      expect(document.querySelector('.timeline-row-canvas .timeline-cluster--same-time')).toBeNull();
      const canvasEvents = Array.from(document.querySelectorAll('.timeline-row-canvas .timeline-event'))
        .map((element) => element.textContent ?? '');
      expect(canvasEvents.some((text) => text.includes('Same cluster A'))).toBe(true);
      expect(canvasEvents.some((text) => text.includes('Same cluster B'))).toBe(true);
    });
    await waitFor(() => {
      const stored = window.localStorage.getItem('mandible_timeline_view_state:v1:prj_mandible');
      expect(stored).toBeTruthy();
      expect(JSON.parse(String(stored)).selectedClusterId).toContain('same_time_cluster');
    });

    const canvasChild = Array.from(document.querySelectorAll<HTMLButtonElement>('.timeline-row-canvas .timeline-event'))
      .find((button) => button.textContent?.includes('Same cluster A'));
    expect(canvasChild).toBeTruthy();
    fireEvent.click(canvasChild as HTMLButtonElement);
    await waitFor(() => {
      const stored = window.localStorage.getItem('mandible_timeline_view_state:v1:prj_mandible');
      const state = JSON.parse(String(stored));
      expect(state.selectedEventId).toBe('event-same-a');
      expect(state.selectedClusterId).toContain('same_time_cluster');
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

  it('double-clicks into same-time clusters instead of only zooming toward the marker', async () => {
    stubTimelineFetch(sameTimeClusterProjection());

    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: { project: 'mandible' },
    }));

    const cluster = await screen.findByRole('button', {
      name: /Same-time cluster, 2 events, Body 1, Comment 1, at 2026-01-01 12:00:00Z/,
    });

    fireEvent.dblClick(cluster);

    await waitFor(() => {
      expect(document.querySelector('.timeline-row-canvas .timeline-cluster--same-time')).toBeNull();
      const canvasEvents = Array.from(document.querySelectorAll('.timeline-row-canvas .timeline-event'))
        .map((element) => element.textContent ?? '');
      expect(canvasEvents.some((text) => text.includes('Same cluster A'))).toBe(true);
      expect(canvasEvents.some((text) => text.includes('Same cluster B'))).toBe(true);
    });
    await waitFor(() => {
      const stored = window.localStorage.getItem('mandible_timeline_view_state:v1:prj_mandible');
      const state = JSON.parse(String(stored));
      expect(state.selectedClusterId).toContain('same_time_cluster');
      expect(state.timeWindow.to - state.timeWindow.from).toBeLessThan(TEST_DAY_MS);
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

    fireEvent.click(cluster);
    fireEvent.click(screen.getByText('Zoom to cluster'));

    await waitFor(() => {
      const stored = window.localStorage.getItem('mandible_timeline_view_state:v1:prj_mandible');
      expect(stored).toBeTruthy();
      const state = JSON.parse(String(stored));
      expect(state.timeWindow.from).toBeLessThanOrEqual(Date.UTC(2026, 0, 1, 12));
      expect(state.timeWindow.to).toBeGreaterThanOrEqual(Date.UTC(2026, 0, 1, 12, 45));
      expect(state.timeWindow.to - state.timeWindow.from).toBeLessThan(TEST_DAY_MS);
    });
  });

  it('collapses RowSpec group rows into aggregate markers and expands member rows with persisted view state', async () => {
    const groupProjection = rowSpecGroupProjection();
    const fetchMock = stubTimelineFetch(groupProjection, groupProjection, groupProjection);

    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: { project: 'mandible' },
    }));

    const groupToggle = await screen.findByRole('button', {
      name: /review Needs review\. Collapsed group with 2 members/i,
    });
    expect(screen.queryByText('Review A start')).toBeNull();
    const aggregates = screen.getAllByRole('button', { name: /Aggregate marker for/ });
    expect(aggregates).toHaveLength(2);
    expect(aggregates[0].classList.contains('timeline-cluster--range')).toBe(true);
    const firstAggregateLeft = parseFloat((aggregates[0] as HTMLButtonElement).style.left);

    fireEvent.click(aggregates[0]);
    expect(screen.getByText('Row events')).toBeTruthy();
    expect(screen.getByText('Review A start')).toBeTruthy();

    fireEvent.click(groupToggle);

    await waitFor(() => expect(document.querySelectorAll('.timeline-row')).toHaveLength(3));
    const canvasEvents = Array.from(document.querySelectorAll('.timeline-row-canvas .timeline-event'))
      .map((element) => element.textContent ?? '');
    expect(canvasEvents.some((text) => text.includes('Review A start'))).toBe(true);
    expect(canvasEvents.some((text) => text.includes('Review B event'))).toBe(true);
    expect(screen.queryByRole('button', { name: /Aggregate marker for/ })).toBeNull();
    await waitFor(() => {
      const body = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
      expect(body.expanded_paths).toContain('row:spec:review:0');
      const stored = window.localStorage.getItem('mandible_timeline_view_state:v1:prj_mandible');
      expect(JSON.parse(String(stored)).expandedPaths).toContain('row:spec:review:0');
    });

    cleanup();
    stubTimelineFetch(groupProjection);
    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: { project: 'mandible' },
    }));

    await waitFor(() => expect(
      Array.from(document.querySelectorAll('.timeline-row-canvas .timeline-event'))
        .some((event) => event.textContent?.includes('Review A start')),
    ).toBe(true));
    const memberEvent = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.timeline-row-canvas .timeline-event'),
    ).find((event) => event.textContent?.includes('Review A start'))!;
    expect(parseFloat(memberEvent.style.left)).toBe(firstAggregateLeft);
  });

  it('renders default backend residual collapsed alongside coordination roots', async () => {
    stubTimelineFetch(coordinationFilterProjection());

    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: { project: 'mandible' },
    }));

    await waitFor(() => expect(screen.getByText('Coordination root event')).toBeTruthy());
    expect(screen.getByText('Coordination root')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Everything else')).toBeTruthy());
    expect(screen.getByRole('button', {
      name: /residual Everything else\. Collapsed group with 0 members\. Status residual/i,
    })).toBeTruthy();
    expect(window.location.hash).not.toContain('rows=');
    const stored = window.localStorage.getItem('mandible_timeline_view_state:v1:prj_mandible');
    expect(stored ? JSON.parse(stored).filterRows ?? [] : []).toHaveLength(0);
  });

  it('sends filter composer rows as backend projection RowSpecs and renders projected rows', async () => {
    const fetchMock = stubTimelineFetchResolver((body) => coordinationFilterProjection(body.root_specs ?? []));

    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: { project: 'mandible' },
    }));

    await waitFor(() => expect(screen.getByText('Coordination root event')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Add row' }));
    const filterInput = screen.getByLabelText('Filter');
    fireEvent.input(filterInput, { target: { value: 'label:coordination' } });
    fireEvent.keyDown(filterInput, { key: 'Enter' });
    expect(screen.getByText('Membership is resolved by the project timeline projection.')).toBeTruthy();
    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Add as row' }) as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add as row' }));

    await waitFor(() => {
      const body = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
      expect(body.root_specs).toMatchObject([{
        id: 'local-label-coordination',
        title: 'label:coordination',
        anchor_issue_id: null,
        scope: { type: 'label', name: 'coordination' },
      }]);
      expect(body.expanded_paths).toContain('row:spec:local-label-coordination:0');
      expect(JSON.stringify(body)).not.toContain('row:local-filter');
      expect(screen.getByRole('button', {
        name: /local-label-coordination label:coordination\. Expanded group with 1 member/i,
      })).toBeTruthy();
      expect(screen.getAllByText('Coordination root').length).toBeGreaterThan(0);
      expect(screen.getByText('label:coordination projected event')).toBeTruthy();
      expect(window.location.hash).toContain('rows=');
      const stored = window.localStorage.getItem('mandible_timeline_view_state:v1:prj_mandible');
      expect(JSON.parse(String(stored)).filterRows).toHaveLength(1);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Add row' }));
    const secondInput = screen.getByLabelText('Filter');
    fireEvent.input(secondInput, { target: { value: 'kind:coordination' } });
    fireEvent.keyDown(secondInput, { key: 'Enter' });
    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Add as row' }) as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add as row' }));
    await waitFor(() => {
      const body = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
      expect(body.root_specs).toMatchObject([
        { id: 'local-label-coordination', scope: { type: 'label', name: 'coordination' } },
        { id: 'local-kind-coordination', scope: { type: 'kind', kind: 'coordination' } },
      ]);
      expect(screen.getByRole('button', {
        name: /local-kind-coordination kind:coordination\. Expanded group with 1 member/i,
      })).toBeTruthy();
      expect(screen.getByRole('button', {
        name: /residual Everything else\. Collapsed group with 1 member/i,
      })).toBeTruthy();
    });
  });

  it('keeps empty filter rows and residual complement backend-projected', async () => {
    const fetchMock = stubTimelineFetchResolver((body) => coordinationFilterProjection(body.root_specs ?? []));

    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: { project: 'mandible' },
    }));

    await waitFor(() => expect(screen.getByText('Coordination root event')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Add row' }));
    const filterInput = screen.getByLabelText('Filter');
    fireEvent.input(filterInput, { target: { value: 'label:not-present' } });
    fireEvent.keyDown(filterInput, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Add as row' }));

    await waitFor(() => {
      const body = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
      expect(body.root_specs).toMatchObject([{
        id: 'local-label-not-present',
        scope: { type: 'label', name: 'not-present' },
      }]);
      expect(screen.getByRole('button', {
        name: /local-label-not-present label:not-present\. Expanded group with 0 members/i,
      })).toBeTruthy();
      expect(screen.getByRole('button', {
        name: /residual Everything else\. Collapsed group with 2 members/i,
      })).toBeTruthy();
      expect(screen.queryByText('label:not-present projected event')).toBeNull();
    });
  });

  it('keeps filter composer keyboard-operable with token removal', async () => {
    stubTimelineFetch(filterComposerProjection());

    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: { project: 'mandible' },
    }));

    await waitFor(() => expect(screen.getByText('auth111 event')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Add row' }));
    const input = screen.getByLabelText('Filter');
    fireEvent.input(input, { target: { value: 'referenced-by:auth222' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('button', { name: 'Remove referenced-by:auth222' })).toBeTruthy();
    expect(screen.getByText('Projection row')).toBeTruthy();
    expect(screen.getByText('Membership is resolved by the project timeline projection.')).toBeTruthy();

    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(screen.queryByRole('button', { name: 'Remove referenced-by:auth222' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Add as row' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps coordination root rows and ref expansion behavior intact', async () => {
    const base = projection();
    const expanded = projection({
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
      links: [{ ...base.links[0], expanded_row_id: 'row-child' }],
    });
    stubTimelineFetch(base, expanded);

    render(h(TimelineView, {
      repos: [{ id: 'mandible', name: 'mandible' }],
      params: { project: 'mandible' },
    }));

    await waitFor(() => expect(screen.getByText('Build shared axis')).toBeTruthy());
    expect(document.querySelector('.timeline-gutter-row--root')).toBeTruthy();
    fireEvent.click(screen.getByText('Build shared axis'));
    fireEvent.click(screen.getByText('Expand refs'));

    await waitFor(() => expect(document.querySelectorAll('.timeline-row')).toHaveLength(2));
    expect(document.querySelector('.timeline-row--transient')).toBeTruthy();
    expect(screen.getByText('Fold refs')).toBeTruthy();
  });
});
