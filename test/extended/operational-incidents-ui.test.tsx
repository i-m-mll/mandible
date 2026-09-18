// Operational incident UI — issue 5308097, spec §11 ("UI" group).
//
// Every fixture below is typed as the SERVER CONTRACT
// (`OperationalIncidentProjection` in src/contracts.ts) — the same type
// src/operational-incidents.ts projects — so no test can invent a field the
// server never sends, or quietly drop one it always does.
//
// The properties these tests defend, in the spec's own terms:
//
//   - Incidents render BEFORE the recurring briefing collections.
//   - The red navigation badge counts active AND unacknowledged only, and the
//     dashboard's Briefing count never becomes a navigation badge.
//   - An acknowledged-but-still-active incident stays discoverable in its own
//     permanent row without becoming an undismissable red warning.
//   - Acknowledgement is DURABLE SERVER STATE: a refetch, an SSE
//     reconciliation, or newer telemetry converges on the stored
//     acknowledgement rather than resetting it.
//   - An incident SSE event invalidates the incident list and the badges and
//     NOTHING else.
//   - Prepare-fix previews without dispatching, and confirms only with the
//     digests the preview returned.
//   - Every card says its telemetry is unverified, and no card offers a
//     feedback verdict or a task-control action.
//
// MOCK BOUNDARY. The Prepare-fix dispatch ROUTES (`/api/agent-dispatch/preview`
// and `/api/agent-dispatch/dispatch` with an incident subject) are built by a
// separate lane against the same frozen spec and are not in this branch yet.
// Both are stubbed here at the `fetch` boundary with the exact request and
// response shapes of spec §7/§9 — including `prompt_sha256`,
// `incident_telemetry_sha256`, `expected_prompt_sha256`,
// `expected_incident_telemetry_sha256`, and the 409-on-drift behavior. The list,
// acknowledge, close and badge routes are real code in this branch.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../ui/src/app';
import {
  getOperationalIncidents,
  invalidateApiGetCache,
  operationalIncidentApiCacheFamiliesForEvent,
  invalidateDashboardApiCacheForEvent,
} from '../../ui/src/api';
import { AppShellProvider, type AppShellContextValue } from '../../ui/src/app-shell';
import { BriefingView } from '../../ui/src/views/briefing';
import { OperationalIncidentsRegion } from '../../ui/src/views/operational-incidents';
import { __resetSharedSseForTests } from '../../ui/src/sse-shared';
import type {
  OperationalIncidentListResponse,
  OperationalIncidentProjection,
} from '../../src/contracts.js';

const HOUR = 60 * 60 * 1000;
const INCIDENTS_URL = '/api/operational-incidents?status=all&limit=100';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A contract `OperationalIncidentProjection`. */
function makeIncident(
  overrides: Partial<OperationalIncidentProjection> = {},
): OperationalIncidentProjection {
  const id = overrides.id ?? 'inc-1';
  const firstSeen = overrides.first_seen ?? Date.now() - 2 * HOUR;
  return {
    id,
    executor: 'agent-schedule',
    task: 'daily-digest',
    condition: 'failed_permanent',
    first_seen: firstSeen,
    observation: 'active',
    attention: 'unacknowledged',
    remediation: 'none',
    resolved: false,
    resolution_kind: null,
    provenance: {
      label: 'Executor-reported; not verified by Mandible',
      value: 'executor_asserted_unverified',
    },
    latest_telemetry: {
      schema: 'operational-incidents@1',
      event: {
        event_id: `evt-${id}`,
        event_seq: 1,
        episode: { task: 'daily-digest', condition: 'failed_permanent', first_seen: firstSeen },
        observation: 'active',
        observed_at: firstSeen,
        // The executor's five terminal statuses are the only accepted values.
        facts: {
          run_id: '184',
          run_status: 'failed_permanent',
          exit_class: 'validation',
          finished_at: firstSeen,
        },
        recovery: null,
      },
    },
    latest_telemetry_sha256: 'a'.repeat(64),
    latest_observed_at: firstSeen,
    recovered_at: null,
    recovery_run_id: null,
    acknowledged_at: null,
    acknowledged_by_user_id: null,
    resolved_at: null,
    operator_closed_at: null,
    operator_closed_by_user_id: null,
    updated_at: firstSeen,
    ...overrides,
  };
}

function acknowledgedIncident(
  overrides: Partial<OperationalIncidentProjection> = {},
): OperationalIncidentProjection {
  return makeIncident({
    id: 'inc-ack',
    attention: 'acknowledged',
    acknowledged_at: Date.now() - HOUR,
    acknowledged_by_user_id: 'operator',
    ...overrides,
  });
}

function recoveredIncident(
  overrides: Partial<OperationalIncidentProjection> = {},
): OperationalIncidentProjection {
  const recoveredAt = Date.now() - HOUR;
  return makeIncident({
    id: 'inc-recovered',
    observation: 'recovered',
    resolved: true,
    resolution_kind: 'successful_run',
    recovered_at: recoveredAt,
    recovery_run_id: '185',
    resolved_at: recoveredAt,
    remediation: 'complete',
    ...overrides,
  });
}

/** Build the exact list response the server returns, counts included. */
function incidentList(
  incidents: OperationalIncidentProjection[],
  countOverrides: Partial<OperationalIncidentListResponse['counts']> = {},
): OperationalIncidentListResponse {
  return {
    incidents,
    counts: {
      active_unacknowledged: incidents.filter(
        (i) => !i.resolved && i.observation === 'active' && i.attention === 'unacknowledged',
      ).length,
      active_acknowledged: incidents.filter(
        (i) => !i.resolved && i.observation === 'active' && i.attention === 'acknowledged',
      ).length,
      resolved: incidents.filter((i) => i.resolved).length,
      ...countOverrides,
    },
    next_cursor: null,
  };
}

type FetchCall = { url: string; method: string; body: unknown };

type RegionStubOptions = {
  /** Resolved per request so the SERVER can change between polls. */
  list: OperationalIncidentListResponse | (() => OperationalIncidentListResponse);
  acknowledgeStatus?: number;
  /** Preview plan overrides (spec §7 shape). */
  preview?: Record<string, unknown>;
  /** When set, the dispatch route answers with this status (409 = stale plan). */
  dispatchStatus?: number;
};

function stubRegionFetch(options: RegionStubOptions): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown = null;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, method, body });

    if (url.startsWith('/api/operational-incidents') && method === 'GET') {
      const list = typeof options.list === 'function' ? options.list() : options.list;
      return Promise.resolve(jsonResponse(list));
    }
    if (url.includes('/acknowledge') && method === 'POST') {
      if (options.acknowledgeStatus && options.acknowledgeStatus >= 400) {
        return Promise.resolve(jsonResponse(
          { error: 'read-only instance' },
          options.acknowledgeStatus,
        ));
      }
      const incidentId = url.split('/').slice(-2)[0];
      return Promise.resolve(jsonResponse({
        incident_id: incidentId,
        attention: 'acknowledged',
        event_id: 'wf-1',
        acknowledged_at: Date.now(),
        acknowledged_by_user_id: 'operator',
      }));
    }
    // --- MOCKED: dispatch lane routes (spec §7/§9) ------------------------
    if (url === '/api/agent-dispatch/preview' && method === 'POST') {
      return Promise.resolve(jsonResponse({
        plan: {
          subject_kind: 'incident',
          incident_id: (body as { subject?: { incident_id?: string } })?.subject?.incident_id,
          subject_label: 'daily-digest — permanent failure',
          instruction: (body as { instruction?: string })?.instruction ?? '',
          cwd: '/repo',
          prompt: 'SEED PROMPT',
          prompt_sha256: 'p'.repeat(64),
          incident_telemetry_sha256: 'a'.repeat(64),
          capability_surface: ['Starts a full interactive Claude Code session.'],
          ...options.preview,
        },
      }));
    }
    if (url === '/api/agent-dispatch/dispatch' && method === 'POST') {
      if (options.dispatchStatus && options.dispatchStatus >= 400) {
        return Promise.resolve(jsonResponse(
          { error: 'The incident evidence changed since the preview.' },
          options.dispatchStatus,
        ));
      }
      return Promise.resolve(jsonResponse({
        ok: true,
        event: {
          id: 'dispatch-1',
          subject_kind: 'incident',
          incident_id: (body as { subject?: { incident_id?: string } })?.subject?.incident_id,
          candidate_id: null,
          comment_id: null,
          issue_id: null,
          instruction: (body as { instruction?: string })?.instruction ?? '',
          cwd: '/repo',
          status: 'dispatched',
          session_handle: 'mandible-incident-1',
          attach_command: 'zellij attach mandible-incident-1',
          error: null,
          created_at: Date.now(),
        },
        incident: { id: 'inc-1', remediation: 'triaging' },
      }));
    }
    if (url === '/api/dashboard/badges') {
      return Promise.resolve(jsonResponse({ auth: 0, inbox: 0, work: 0, briefing: 0, incidents: 0 }));
    }
    return Promise.resolve(jsonResponse({}));
  }));
  return calls;
}

function renderRegion(): ReturnType<typeof render> {
  return render(<OperationalIncidentsRegion instance={null} />);
}

function shell(overrides: Partial<AppShellContextValue> = {}): AppShellContextValue {
  return {
    rightSidebar: null,
    registerRightSidebar: () => () => undefined,
    setViewSidebarWidth: () => undefined,
    active: true,
    ...overrides,
  };
}

/** This jsdom setup has no usable localStorage; the briefing view persists state. */
function installMemoryLocalStorage(): void {
  const store = new Map<string, string>();
  const mem: Storage = {
    get length() { return store.size; },
    clear: () => store.clear(),
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => { store.delete(key); },
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: mem, configurable: true, writable: true });
  Object.defineProperty(window, 'localStorage', { value: mem, configurable: true, writable: true });
}

function emitIncidentSse(type: string): void {
  window.dispatchEvent(new CustomEvent('operational-incident:sse', { detail: { type } }));
}

beforeEach(() => {
  invalidateApiGetCache();
  installMemoryLocalStorage();
  window.history.replaceState(null, '', '/#/briefing');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  invalidateApiGetCache();
});

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

describe('briefing incident navigation', () => {
  it('shows incident records as the selected main content, without an extra column', async () => {
    stubRegionFetch({ list: incidentList([makeIncident()]) });

    const { container } = render(
      <AppShellProvider value={shell()}>
        <BriefingView instance={null} />
      </AppShellProvider>,
    );

    expect(container.querySelector('[data-testid="operational-incidents-region"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Operational incidents' }));
    const region = await screen.findByTestId('operational-incidents-region');
    const inner = container.querySelector('.feedback-collection-shell__content-inner');
    expect(inner).toBeTruthy();

    expect(inner!.firstElementChild).toBe(region);
    expect(inner!.children).toHaveLength(1);
    expect(container.querySelector('[data-testid="briefing-health"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  readyState = 1;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;

  constructor(_url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  removeEventListener(): void {}
  close(): void { this.readyState = 2; }
}

type AppStubOptions = {
  badges: Record<string, number>;
  onRequest?(url: string): void;
};

function stubAppFetch(options: AppStubOptions): string[] {
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    options.onRequest?.(url);
    if (url === '/api/dashboard/badges') return Promise.resolve(jsonResponse(options.badges));
    if (url === '/api/issues') return Promise.resolve(jsonResponse({ repos: [] }));
    if (url === '/api/settings') return Promise.resolve(jsonResponse({}));
    if (url === '/api/health') {
      return Promise.resolve(jsonResponse({
        status: 'ok',
        ready: true,
        startup_commit: { hash: 'test', summary: 'test', date: '' },
        instance: null,
      }));
    }
    return Promise.resolve(jsonResponse([]));
  }));
  return requests;
}

function prepareAppEnvironment(): void {
  MockEventSource.instances = [];
  vi.stubGlobal('EventSource', MockEventSource);
  __resetSharedSseForTests();
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
  window.localStorage.removeItem('mandible_state_cache');
  // The rail is what these tests read; keep the route off the briefing page so
  // the incident region's own fetches do not enter the picture.
  window.history.replaceState(null, '', '#/issues');
}

describe('incident_badge_counts_only_active_unacknowledged', () => {
  it('renders no red badge when the server reports zero active unacknowledged', async () => {
    prepareAppEnvironment();
    // Acknowledged-active and resolved incidents exist; the server excludes
    // them from the badge count, and the UI must not re-derive its own.
    const requests = stubAppFetch({
      badges: { auth: 0, inbox: 0, work: 0, briefing: 0, incidents: 0 },
    });

    const { container } = render(h(App, {}));
    await waitFor(() => expect(requests).toContain('/api/dashboard/badges'));
    await waitFor(() => expect(screen.getByLabelText('Briefing')).toBeTruthy());

    expect(container.querySelector('.tab-badge--incidents')).toBeNull();
  });

  it('renders exactly the server count of active unacknowledged incidents', async () => {
    prepareAppEnvironment();
    const requests = stubAppFetch({
      badges: { auth: 0, inbox: 0, work: 0, briefing: 0, incidents: 2 },
    });

    const { container } = render(h(App, {}));
    await waitFor(() => expect(requests).toContain('/api/dashboard/badges'));

    await waitFor(() => {
      expect(container.querySelector('.tab-badge--incidents')?.textContent).toBe('2');
    });
  });
});

describe('briefing_navigation_badge_is_suppressed', () => {
  it('ignores the dashboard Briefing count while preserving the incident badge', async () => {
    prepareAppEnvironment();
    const requests = stubAppFetch({
      badges: { auth: 0, inbox: 0, work: 0, briefing: 4, incidents: 1 },
    });

    const { container } = render(h(App, {}));
    await waitFor(() => expect(requests).toContain('/api/dashboard/badges'));

    await waitFor(() => {
      expect(container.querySelector('.tab-badge--incidents')?.textContent).toBe('1');
    });
    expect(container.querySelector('.tab-badge--briefing')).toBeNull();

    // The incident obligation remains visible without projecting the unrelated
    // dashboard Briefing count into the rail.
    const briefingNav = screen.getByLabelText('Briefing');
    expect(briefingNav.textContent).toContain('1');
    expect(briefingNav.textContent).not.toContain('4');
  });
});

// ---------------------------------------------------------------------------
// Acknowledged-but-still-active
// ---------------------------------------------------------------------------

describe('acknowledged_active_incident_remains_discoverable', () => {
  it('keeps a permanent compact row that is neither sticky nor a red warning', async () => {
    stubRegionFetch({ list: incidentList([acknowledgedIncident()]) });

    const { container } = renderRegion();

    const row = await screen.findByTestId('operational-incidents-acknowledged-row');
    expect(row.textContent).toContain('Acknowledged but still active (1)');
    expect(row.getAttribute('aria-expanded')).toBe('false');

    // Not hidden away: one click reveals the full card, with the same facts as
    // a warning card carries.
    fireEvent.click(row);
    const list = await screen.findByTestId('operational-incidents-acknowledged-list');
    const card = within(list).getByTestId('operational-incident-card');
    expect(card.getAttribute('data-attention')).toBe('acknowledged');
    expect(card.getAttribute('data-observation')).toBe('active');
    expect(within(card).getByTestId('operational-incident-observation').textContent).toBe('Active');

    // …but it does not shout: muted tone, and not inside the sticky header or
    // the red warning list.
    expect(card.className).toContain('operational-incident-card--muted');
    expect(card.className).not.toContain('operational-incident-card--warning');
    expect(container.querySelector('[data-testid="operational-incidents-active"]')).toBeNull();
    const sticky = screen.getByTestId('operational-incidents-sticky');
    expect(sticky.contains(card)).toBe(false);

    // And there is no un-acknowledge affordance: V1 has no such operation.
    expect(within(card).queryByRole('button', { name: /acknowledge/i })).toBeNull();
  });
});

describe('acknowledge_survives_refetch_and_sse_reconciliation', () => {
  it('keeps the stored acknowledgement across refetch, new telemetry, and SSE', async () => {
    let acknowledged = false;
    let telemetryRevision = 0;
    const calls = stubRegionFetch({
      list: () => {
        const incident = acknowledged
          ? makeIncident({
            attention: 'acknowledged',
            acknowledged_at: Date.now(),
            acknowledged_by_user_id: 'operator',
            // Evidence revision: a NEWER executor observation on the same
            // episode must not disturb the attention axis.
            latest_observed_at: Date.now() + telemetryRevision,
            latest_telemetry_sha256: String(telemetryRevision).repeat(64).slice(0, 64),
          })
          : makeIncident();
        return incidentList([incident]);
      },
    });

    renderRegion();

    const acknowledgeButton = await screen.findByRole('button', { name: 'Acknowledge' });
    acknowledged = true;
    fireEvent.click(acknowledgeButton);

    // The card moves into the acknowledged section — it does not vanish.
    await waitFor(() => {
      expect(screen.getByTestId('operational-incident-attention').textContent)
        .toBe('Acknowledged');
    });
    expect(calls.some((call) => call.url.includes('/acknowledge') && call.method === 'POST'))
      .toBe(true);

    // A later ingest event carrying revised evidence is a reconciliation input,
    // not a reset.
    telemetryRevision = 7;
    const before = calls.filter((call) => call.url.startsWith(INCIDENTS_URL)).length;
    emitIncidentSse('operational-incident:ingested');
    await waitFor(() => {
      expect(calls.filter((call) => call.url.startsWith(INCIDENTS_URL)).length)
        .toBeGreaterThan(before);
    });

    await waitFor(() => {
      expect(screen.getByTestId('operational-incident-attention').textContent)
        .toBe('Acknowledged');
    });
    // Server state wins: no Acknowledge affordance reappears, and the incident
    // is not back in the red warning list.
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).toBeNull();
    expect(screen.queryByTestId('operational-incidents-active')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SSE reconciliation
// ---------------------------------------------------------------------------

describe('incident_sse_invalidates_only_incidents_and_badges', () => {
  it('names exactly two cache families for every incident topic', () => {
    for (const type of [
      'operational-incident:ingested',
      'operational-incident:acknowledged',
      'operational-incident:remediation-changed',
      'operational-incident:closed',
    ]) {
      expect(operationalIncidentApiCacheFamiliesForEvent(type)).toEqual([
        '/api/operational-incidents',
        '/api/dashboard/badges',
      ]);
    }
    expect(operationalIncidentApiCacheFamiliesForEvent('briefing:created')).toEqual([]);
  });

  it('leaves unrelated API families cached', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith('/api/operational-incidents')) {
        return Promise.resolve(jsonResponse(incidentList([makeIncident()])));
      }
      return Promise.resolve(jsonResponse({ repos: [] }));
    }));

    // Warm two unrelated families plus the incident list.
    const { getWorkRepos, getSessions } = await import('../../ui/src/api');
    await getWorkRepos();
    await getSessions();
    await getOperationalIncidents({ status: 'all', limit: 100 });
    const warmed = calls.length;

    invalidateDashboardApiCacheForEvent('operational-incident:acknowledged');

    // The unrelated families are still served from cache…
    await getWorkRepos();
    await getSessions();
    expect(calls.length).toBe(warmed);
    // …while the incident list itself is refetched.
    await getOperationalIncidents({ status: 'all', limit: 100 });
    expect(calls.length).toBeGreaterThan(warmed);
  });
});

describe('incident_reconnect_refetches_visible_route_and_badges', () => {
  it('refetches badges after a real SSE reconnect', async () => {
    prepareAppEnvironment();
    const requests = stubAppFetch({
      badges: { auth: 0, inbox: 0, work: 0, briefing: 0, incidents: 1 },
    });

    render(h(App, {}));
    await waitFor(() => expect(requests).toContain('/api/dashboard/badges'));

    const reconnectTopics: string[] = [];
    const listener = (event: Event) => {
      const type = (event as CustomEvent<{ type?: string }>).detail?.type;
      if (type) reconnectTopics.push(type);
    };
    window.addEventListener('operational-incident:sse', listener);

    const source = MockEventSource.instances[0];
    expect(source).toBeTruthy();
    const before = requests.filter((url) => url === '/api/dashboard/badges').length;

    // Fail the authenticated fetch stream. The client reconnects with a fresh
    // stream and reports `reconnected`; the server has no event replay.
    source.readyState = 2;
    for (const listener of source.listeners.get('error') ?? []) {
      listener(new MessageEvent('error'));
    }

    await waitFor(() => {
      expect(requests.filter((url) => url === '/api/dashboard/badges').length)
        .toBeGreaterThan(before);
    });
    // The incident region is told to converge too, which is what makes a
    // missed acknowledgement or closure recoverable without event replay.
    expect(reconnectTopics).toContain('reconnected');
    window.removeEventListener('operational-incident:sse', listener);
  });

  it('refetches the incident list when the reconnect topic arrives', async () => {
    const calls = stubRegionFetch({ list: incidentList([makeIncident()]) });
    renderRegion();
    await screen.findByTestId('operational-incidents-region');

    const before = calls.filter((call) => call.url.startsWith(INCIDENTS_URL)).length;
    emitIncidentSse('reconnected');

    await waitFor(() => {
      expect(calls.filter((call) => call.url.startsWith(INCIDENTS_URL)).length)
        .toBeGreaterThan(before);
    });
  });
});

// ---------------------------------------------------------------------------
// Prepare-fix
// ---------------------------------------------------------------------------

describe('prepare_fix_preview_does_not_dispatch', () => {
  it('opens and cancels the confirmation without starting an agent', async () => {
    const calls = stubRegionFetch({ list: incidentList([makeIncident()]) });
    renderRegion();

    fireEvent.click(await screen.findByRole('button', { name: 'Prepare fix…' }));
    await screen.findByTestId('operational-incident-prepare-dialog');
    await screen.findByTestId('operational-incident-prepare-prompt');

    // Exactly one preview, and nothing else was written.
    expect(calls.filter((call) => call.url === '/api/agent-dispatch/preview').length).toBe(1);
    expect(calls.some((call) => call.url === '/api/agent-dispatch/dispatch')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByTestId('operational-incident-prepare-dialog')).toBeNull();
    });

    // Cancelling leaves no trace: still no dispatch, and no incident mutation.
    expect(calls.some((call) => call.url === '/api/agent-dispatch/dispatch')).toBe(false);
    expect(calls.some((call) => call.url.includes('/acknowledge'))).toBe(false);
    expect(calls.some((call) => call.url.includes('/close'))).toBe(false);
  });
});

describe('prepare_fix_confirm_uses_preview_hashes', () => {
  it('sends both digests from the preview on confirmation', async () => {
    const calls = stubRegionFetch({ list: incidentList([makeIncident()]) });
    renderRegion();

    fireEvent.click(await screen.findByRole('button', { name: 'Prepare fix…' }));
    const start = await screen.findByRole('button', { name: 'Start agent' });
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(start);

    await waitFor(() => {
      expect(calls.some((call) => call.url === '/api/agent-dispatch/dispatch')).toBe(true);
    });
    const dispatch = calls.find((call) => call.url === '/api/agent-dispatch/dispatch')!;
    expect(dispatch.body).toMatchObject({
      subject: { kind: 'incident', incident_id: 'inc-1' },
      expected_prompt_sha256: 'p'.repeat(64),
      expected_incident_telemetry_sha256: 'a'.repeat(64),
    });
  });

  it('requires a new preview when the server answers 409', async () => {
    const calls = stubRegionFetch({
      list: incidentList([makeIncident()]),
      dispatchStatus: 409,
    });
    renderRegion();

    fireEvent.click(await screen.findByRole('button', { name: 'Prepare fix…' }));
    const start = await screen.findByRole('button', { name: 'Start agent' });
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(start);

    await screen.findByTestId('operational-incident-prepare-stale');
    // The confirm affordance is replaced by a re-preview, not a retry of the
    // stale plan.
    expect(screen.queryByRole('button', { name: 'Start agent' })).toBeNull();
    const repreview = screen.getByRole('button', { name: 'Preview again' });

    const previewsBefore = calls.filter((c) => c.url === '/api/agent-dispatch/preview').length;
    fireEvent.click(repreview);
    await waitFor(() => {
      expect(calls.filter((c) => c.url === '/api/agent-dispatch/preview').length)
        .toBeGreaterThan(previewsBefore);
    });
    // Exactly one dispatch attempt was ever made.
    expect(calls.filter((c) => c.url === '/api/agent-dispatch/dispatch').length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Card contents
// ---------------------------------------------------------------------------

describe('incident_card_labels_telemetry_unverified', () => {
  it('shows the provenance warning on active, acknowledged and historical cards', async () => {
    stubRegionFetch({
      list: incidentList([makeIncident(), acknowledgedIncident(), recoveredIncident()]),
    });
    renderRegion();

    const active = await screen.findByTestId('operational-incidents-active');
    expect(within(active).getByTestId('operational-incident-provenance').textContent)
      .toBe('Executor-reported; not verified by Mandible');

    fireEvent.click(screen.getByTestId('operational-incidents-acknowledged-row'));
    const acknowledged = await screen.findByTestId('operational-incidents-acknowledged-list');
    expect(within(acknowledged).getByTestId('operational-incident-provenance').textContent)
      .toBe('Executor-reported; not verified by Mandible');

    fireEvent.click(screen.getByTestId('operational-incidents-history-row'));
    const history = await screen.findByTestId('operational-incidents-history-list');
    expect(within(history).getByTestId('operational-incident-provenance').textContent)
      .toBe('Executor-reported; not verified by Mandible');
    // History states the executor's own recovery, not a Mandible verification.
    expect(within(history).getByTestId('operational-incident-observation').textContent)
      .toBe('Recovered');
  });

  it('never calls an operator closure a recovery', async () => {
    const closedAt = Date.now() - HOUR;
    stubRegionFetch({
      list: incidentList([makeIncident({
        id: 'inc-closed',
        resolved: true,
        resolution_kind: 'operator_closure',
        resolved_at: closedAt,
        operator_closed_at: closedAt,
        operator_closed_by_user_id: 'operator',
        attention: 'acknowledged',
        acknowledged_at: closedAt,
        acknowledged_by_user_id: 'operator',
        remediation: 'complete',
      })]),
    });
    renderRegion();

    fireEvent.click(await screen.findByTestId('operational-incidents-history-row'));
    const history = await screen.findByTestId('operational-incidents-history-list');
    const observation = within(history).getByTestId('operational-incident-observation');
    expect(observation.textContent).toBe('Closed by operator; executor recovery unverified');
    expect(observation.textContent).not.toContain('Recovered');
  });
});

describe('incident_card_has_no_feedback_or_task_control_actions', () => {
  it('offers only acknowledge, prepare-fix and operator closure', async () => {
    stubRegionFetch({ list: incidentList([makeIncident()]) });
    const { container } = renderRegion();

    const card = await screen.findByTestId('operational-incident-card');
    const labels = Array.from(card.querySelectorAll('button, a, input, select'))
      .map((node) => (node.textContent ?? '').trim());
    expect(labels).toEqual(['Acknowledge', 'Prepare fix…', 'Close as operator…']);

    // The forbidden verbs are checked against every interactive control in the
    // whole region, not just this card: incidents are not feedback items and
    // Mandible is not a task controller.
    const forbidden = /\b(keep|dismiss|undo|verdict|retry|deploy|dry[ -]?run|enable)\b/i;
    for (const node of Array.from(container.querySelectorAll('button, a, input, select'))) {
      const text = `${node.textContent ?? ''} ${node.getAttribute('aria-label') ?? ''}`;
      expect(text).not.toMatch(forbidden);
    }
  });

  it('offers no prepare-fix once remediation is already in progress', async () => {
    stubRegionFetch({ list: incidentList([makeIncident({ remediation: 'triaging' })]) });
    renderRegion();

    const card = await screen.findByTestId('operational-incident-card');
    expect(within(card).queryByRole('button', { name: 'Prepare fix…' })).toBeNull();
    expect(within(card).getByTestId('operational-incident-remediation').textContent)
      .toBe('Agent triaging');
  });
});
