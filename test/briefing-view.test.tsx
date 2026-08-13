// Briefing view tests — umbrella 99b74d6, lane d304a9b; contract alignment 223d090.
//
// Every stub here is typed as the SERVER CONTRACT (src/contracts.ts) — the same
// types src/briefing.ts returns — so a fixture can no longer invent a field the
// server never sends. That invention is exactly what hid the queue-key drift
// this suite now guards: the old fixtures stubbed `items`, so a normalizer that
// read `items` while the server sent `candidates` passed every test and rendered
// an empty queue in production. The "server payload → normalizer" describe at
// the bottom closes the loop with a payload built by the real server function.
//
// The rest of the suite covers the properties that make the Briefing
// trustworthy: deterministic health before model output, an honest
// empty-but-broken state, keyboard-only triage with undo, inline (not hover)
// fold-outs, allowlisted ref linkification, and mutation gating on the instance
// policy.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BRIEFING_VISIBLE_LIMIT,
  BriefingView,
  briefingRefLink,
  formatBriefingAge,
  listBriefingProducers,
  summarizeBriefingHealth,
} from '../ui/src/views/briefing';
import {
  deriveBriefingSourceStatus,
  normalizeBriefingQueue,
} from '../ui/src/api';
import { ingestBriefingBatch, listBriefingQueue } from '../src/briefing.js';
import {
  BRIEFING_INGEST_SCHEMA,
  type BriefingCandidateHistoryResponse,
  type BriefingCommentResponse,
  type BriefingDecisionResponse,
  type BriefingQueueEntry,
  type BriefingQueueResponse,
  type BriefingSourceHealth,
} from '../src/contracts.js';
import { migrate, setDb, type Db } from '../src/db.js';
import { AppShellProvider, type AppShellContextValue } from '../ui/src/app-shell';
import { parseRouteFromHash } from '../ui/src/routing';

const HOUR = 60 * 60 * 1000;

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A contract `BriefingQueueEntry`. `id` IS the candidate id — not `candidate_id`. */
function makeItem(overrides: Partial<BriefingQueueEntry> = {}): BriefingQueueEntry {
  const id = overrides.id ?? 'cand-1';
  return {
    id,
    source: 'github-releases',
    candidate_key: `key-${id}`,
    created_at: Date.now() - HOUR,
    state: 'pending',
    revision: {
      id: `rev-${id}`,
      candidate_id: id,
      title: `Finding ${id}`,
      why_notable: `Why ${id} matters.`,
      refs: ['https://example.com/a', 'issue:abc1234'],
      source_ref: 'https://example.com/a',
      evidence_hash: 'a'.repeat(64),
      evidence_kind: 'snapshot-item',
      captured_at: new Date(Date.now() - 2 * HOUR).toISOString(),
      run_id: 'run-9',
      digest_series_ref: 'artifact-series:abcdef123456',
      digest_version: 7,
      rank: 1,
      batch_key: 'b'.repeat(64),
      ingested_at: Date.now() - HOUR,
    },
    revision_count: 1,
    occurrences: { count: 1, first_seen_at: Date.now() - HOUR, last_seen_at: Date.now() - HOUR },
    // The producer of THIS entry's revision — a per-entry contract field, not
    // the source's most recent batch identity.
    task_identity: 'agent-schedule/daily-digest',
    ...overrides,
  };
}

/**
 * A contract `BriefingSourceHealth`. The server reports batch facts and NO
 * `status` field — the client derives the classification — so a fixture cannot
 * declare a source healthy or stale; it can only report when it last ingested.
 */
function makeSource(overrides: Partial<BriefingSourceHealth> = {}): BriefingSourceHealth {
  const lastIngestedAt = overrides.last_ingested_at ?? Date.now() - HOUR;
  return {
    source: 'github-releases',
    pending_count: 1,
    candidate_count: 1,
    last_task_identity: 'agent-schedule/daily-digest',
    last_run_id: 'run-9',
    last_digest_version: 7,
    last_ingested_at: lastIngestedAt,
    last_ingest_age_ms: lastIngestedAt === null ? null : Date.now() - lastIngestedAt,
    last_batch_item_count: 1,
    ...overrides,
  };
}

function makeQueue(overrides: Partial<BriefingQueueResponse> = {}): BriefingQueueResponse {
  return {
    candidates: [makeItem()],
    sources: [makeSource()],
    ...overrides,
  };
}

/**
 * Two producers writing into one briefing: `github-releases` with two pending
 * findings and `rss` with one, each with its own task identity. This is the
 * shape the producer axis exists for, and no earlier fixture had it.
 */
function multiProducerQueue(): BriefingQueueResponse {
  return {
    candidates: [
      makeItem({ id: 'gh-1' }),
      makeItem({ id: 'gh-2' }),
      makeItem({ id: 'rss-1', source: 'rss', task_identity: 'agent-schedule/rss-sweep' }),
    ],
    sources: [
      makeSource({ pending_count: 2, candidate_count: 2 }),
      makeSource({
        source: 'rss',
        pending_count: 1,
        candidate_count: 1,
        last_task_identity: 'agent-schedule/rss-sweep',
      }),
    ],
  };
}

/** A source that has gone quiet past the staleness horizon. */
function staleSource(overrides: Partial<BriefingSourceHealth> = {}): BriefingSourceHealth {
  return makeSource({
    source: 'rss',
    last_ingested_at: Date.now() - 72 * HOUR,
    last_ingest_age_ms: 72 * HOUR,
    ...overrides,
  });
}

/** A contract `BriefingCandidateHistoryResponse`: no per-occurrence rows exist. */
function makeHistory(
  overrides: Partial<BriefingCandidateHistoryResponse> = {},
): BriefingCandidateHistoryResponse {
  return {
    candidate: {
      id: 'cand-1',
      source: 'github-releases',
      candidate_key: 'key-cand-1',
      current_revision_id: 'rev-cand-1',
      created_at: Date.now() - HOUR,
      state: 'pending',
    },
    revisions: [],
    decisions: [],
    comments: [],
    ...overrides,
  };
}

type StubOptions = {
  queue?: BriefingQueueResponse;
  history?: BriefingCandidateHistoryResponse;
  decisionStatus?: number;
};

type FetchCall = { url: string; method: string; body: unknown };

function stubFetch(options: StubOptions = {}): { calls: FetchCall[] } {
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

    if (url === '/api/briefing/queue') {
      return Promise.resolve(jsonResponse(options.queue ?? makeQueue()));
    }
    if (url.includes('/history')) {
      return Promise.resolve(jsonResponse(options.history ?? makeHistory()));
    }
    if (url.includes('/decision') && method === 'POST') {
      if (options.decisionStatus && options.decisionStatus >= 400) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'read-only instance' }), {
          status: options.decisionStatus,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      const decision: BriefingDecisionResponse = {
        candidate_id: 'cand-1',
        revision_id: 'rev-cand-1',
        action: 'keep',
        event_id: 'dec-1',
        state: 'kept',
      };
      return Promise.resolve(jsonResponse(decision));
    }
    if (url.includes('/comments') && method === 'POST') {
      const created: BriefingCommentResponse = {
        comment: {
          id: 'com-1',
          candidate_id: 'cand-1',
          revision_id: 'rev-cand-1',
          body: 'noted',
          actor_user_id: 'operator',
          created_at: Date.now(),
        },
      };
      return Promise.resolve(jsonResponse(created));
    }
    if (url === '/api/dashboard/badges') {
      return Promise.resolve(jsonResponse({ auth: 0, inbox: 0, work: 0, briefing: 1 }));
    }
    return Promise.reject(new Error(`unexpected fetch ${method} ${url}`));
  }));
  return { calls };
}

function renderBriefing(
  props: Partial<Parameters<typeof BriefingView>[0]> = {},
  shell: Partial<AppShellContextValue> = {},
): void {
  const context: AppShellContextValue = {
    bottomPanel: null,
    registerBottomPanel: () => () => undefined,
    active: true,
    ...shell,
  };
  render(
    <AppShellProvider value={context}>
      <BriefingView instance={null} {...props} />
    </AppShellProvider>,
  );
}

/** This jsdom setup has no usable localStorage; the view persists view state. */
function installMemoryLocalStorage(): void {
  const store = new Map<string, string>();
  const mem: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: mem, configurable: true, writable: true });
  Object.defineProperty(window, 'localStorage', { value: mem, configurable: true, writable: true });
}

/**
 * Wait until the keyboard handler is live for a row. Preact defers effects, so
 * a row appearing in the DOM does not yet mean the view's key bindings saw it;
 * the selection marker is written by the same effect pass.
 */
async function awaitSelection(candidateId: string): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId(`briefing-row-${candidateId}`).getAttribute('aria-current')).toBe('true');
  });
}

beforeEach(() => {
  installMemoryLocalStorage();
  window.history.replaceState(null, '', '/#/briefing');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('briefing route registration', () => {
  it('resolves #/briefing instead of silently falling back to spaces', () => {
    expect(parseRouteFromHash('#/briefing').tab).toBe('briefing');
    expect(parseRouteFromHash('#/briefing?filter=judged').params).toMatchObject({ filter: 'judged' });
    // Guard the fallback itself so the assertion above cannot pass vacuously.
    expect(parseRouteFromHash('#/nope').tab).toBe('spaces');
  });

  it('registers the route at every point the build and shell require', () => {
    const esbuildConfig = readFileSync('ui/esbuild.config.js', 'utf8');
    const app = readFileSync('ui/src/app.tsx', 'utf8');
    const routing = readFileSync('ui/src/routing.ts', 'utf8');
    const styles = readFileSync('ui/src/style.css', 'utf8');

    // (1) Route tab union AND the duplicated includes-array.
    expect(routing).toContain("| 'briefing'");
    expect(routing.match(/'briefing'/g)?.length).toBeGreaterThanOrEqual(2);
    // (2) esbuild route entry point — without it the chunk never emits.
    expect(esbuildConfig).toContain("briefing: 'ui/src/views/briefing.tsx'");
    // (3) lazy loader + chunk loader map, (4) rendered tab panel, (5) nav item.
    expect(app).toContain("import('./views/briefing')");
    expect(app).toContain('briefing: loadBriefingView');
    expect(app).toContain("renderTabPanel('briefing'");
    expect(app).toContain("href: '#/briefing'");
    expect(app).toContain('badge: badges.briefing');
    // Per-view stylesheet follows the global-view import convention.
    expect(styles).toContain('@import "./styles/briefing.css";');
  });
});

describe('ref linkification allowlist', () => {
  it('links http(s) URLs and recognized internal refs', () => {
    expect(briefingRefLink('https://example.com/x')).toMatchObject({
      href: 'https://example.com/x',
      external: true,
    });
    expect(briefingRefLink('http://example.com/x')?.external).toBe(true);
    expect(briefingRefLink('issue:abc1234')).toMatchObject({
      href: '#/issues?issue=abc1234',
      external: false,
    });
    expect(briefingRefLink('artifact:abcdef1234567')?.href).toContain('#/artifacts');
    expect(briefingRefLink('comment:abc1234#3')?.href).toContain('comment=3');
  });

  it('refuses every non-allowlisted scheme and every unrecognized ref', () => {
    for (const hostile of [
      'javascript:alert(1)',
      'javascript://example.com/%0aalert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      '  ',
      'not a ref at all',
      'repo://mandible@main/src/db.ts',
      'mandible://mandible/issue/abc',
    ]) {
      expect(briefingRefLink(hostile)).toBeNull();
    }
  });

  it('renders a non-linkable ref as inert visible text rather than dropping it', async () => {
    const queue = makeQueue({
      candidates: [makeItem({
        id: 'cand-1',
        revision: {
          ...makeItem().revision,
          refs: ['javascript:alert(1)'],
          source_ref: 'javascript:alert(1)',
        },
      })],
    });
    stubFetch({ queue });
    renderBriefing();

    const row = await screen.findByTestId('briefing-row-cand-1');
    fireEvent.click(within(row).getByRole('button', { expanded: false }));
    const detail = await screen.findByTestId('briefing-detail-cand-1');
    const hostile = within(detail).getAllByText('javascript:alert(1)');
    expect(hostile.length).toBeGreaterThan(0);
    for (const node of hostile) {
      expect(node.tagName).toBe('SPAN');
    }
    expect(within(detail).queryByRole('link', { name: /javascript/ })).toBeNull();
  });
});

describe('deterministic health classification', () => {
  it('derives status from the batch facts the server actually reports', () => {
    const now = 1_000_000_000_000;
    expect(deriveBriefingSourceStatus(now - HOUR, HOUR, now)).toBe('current');
    expect(deriveBriefingSourceStatus(now - 48 * HOUR, 48 * HOUR, now)).toBe('stale');
    // The server's own age wins over the client clock when the two disagree.
    expect(deriveBriefingSourceStatus(now - HOUR, 48 * HOUR, now)).toBe('stale');
    // No batch on record at all is unknown — never quietly "current".
    expect(deriveBriefingSourceStatus(null, null, now)).toBe('unknown');
  });

  it('summarizes only as healthy when every source is current', () => {
    const now = Date.now();
    const queue = normalizeBriefingQueue({
      candidates: [],
      sources: [makeSource(), staleSource()],
    }, now);
    const summary = summarizeBriefingHealth(queue.sources);
    expect(summary.stale).toBe(1);
    expect(summary.healthy).toBe(false);
    expect(summarizeBriefingHealth([]).healthy).toBe(false);
  });

  it('degrades an unrecognizable payload to empty instead of inventing content', () => {
    const queue = normalizeBriefingQueue({ candidates: 'nope', sources: null });
    expect(queue.candidates).toEqual([]);
    expect(queue.sources).toEqual([]);
  });
});

describe('BriefingView page composition', () => {
  it('leads with deterministic health and publishes no agent-written summary', async () => {
    stubFetch();
    renderBriefing();

    const health = await screen.findByTestId('briefing-health');
    await waitFor(() => {
      expect(health.dataset.healthState).toBe('healthy');
    });
    // Nothing in the pipeline writes a digest headline, so the page reserves no
    // space for one and never apologizes for its absence.
    expect(screen.queryByTestId('briefing-digest')).toBeNull();
    expect(screen.queryByText(/No agent-generated headline/)).toBeNull();
    // Compact when healthy: no per-source rows rendered.
    expect(within(health).queryByText(/last ingest/)).toBeNull();
  });

  it('auto-expands the health strip when a source went stale', async () => {
    stubFetch({ queue: makeQueue({ sources: [makeSource(), staleSource()] }) });
    renderBriefing();

    const health = await screen.findByTestId('briefing-health');
    await waitFor(() => {
      expect(health.dataset.healthState).toBe('degraded');
    });
    expect(within(health).getByText('1 stale')).toBeTruthy();
    expect(within(health).getAllByText(/last ingest/).length).toBe(2);
    // The expanded rows carry the server's real batch facts, not placeholders.
    expect(within(health).getAllByText(/digest v7/).length).toBe(2);
  });

  it('groups rows by source with a title, source chip, age, and one-sentence rationale', async () => {
    stubFetch({
      queue: makeQueue({
        candidates: [
          makeItem({ id: 'a' }),
          makeItem({ id: 'b', source: 'rss' }),
        ],
        sources: [makeSource(), makeSource({ source: 'rss' })],
      }),
    });
    renderBriefing();

    const row = await screen.findByTestId('briefing-row-a');
    expect(within(row).getByText('Finding a')).toBeTruthy();
    expect(within(row).getByText('Why a matters.')).toBeTruthy();
    expect(within(row).getByText(/ago$/)).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 3 }).length).toBe(2);
  });

  it('truncates honestly instead of rendering an unbounded queue', async () => {
    const candidates = Array.from({ length: BRIEFING_VISIBLE_LIMIT + 4 }, (_unused, index) =>
      makeItem({ id: `c${index}` }));
    stubFetch({ queue: makeQueue({ candidates }) });
    renderBriefing();

    const note = await screen.findByTestId('briefing-truncation');
    expect(note.textContent).toContain('4 more pending');
    expect(screen.getAllByTestId(/^briefing-row-/).length).toBe(BRIEFING_VISIBLE_LIMIT);
  });
});

/**
 * Issue 5497690 — the briefing is presented BY PRODUCER. The queue payload
 * already carries everything this needs (`source` per candidate, `task_identity`
 * per candidate, per-source health), so the selector is client-side over the
 * loaded queue and these tests never expect a second fetch.
 */
describe('producer axis derivation', () => {
  it('unions health rows and queue rows so neither can hide a producer', () => {
    const producers = listBriefingProducers(
      normalizeBriefingQueue({
        candidates: [],
        // A source that reported batches but has nothing pending right now.
        sources: [makeSource({ source: 'quiet-but-known', pending_count: 0 })],
      }).sources,
      normalizeBriefingQueue(multiProducerQueue()).candidates,
    );
    expect(producers.map((producer) => producer.source)).toEqual([
      // Sorted, and the queue-only sources are present even though the health
      // list named neither of them.
      'github-releases',
      'quiet-but-known',
      'rss',
    ]);
    expect(producers.map((producer) => producer.pending)).toEqual([2, 0, 1]);
    // A source seen only in the queue has no health row, so no status is claimed.
    expect(producers.find((p) => p.source === 'rss')?.status).toBeNull();
    expect(producers.find((p) => p.source === 'quiet-but-known')?.status).toBe('current');
  });

  it('keeps a selected producer selectable after its last item is judged away', () => {
    const producers = listBriefingProducers([], [], 'rss');
    expect(producers).toEqual([
      { source: 'rss', pending: 0, lastTaskIdentity: null, status: null },
    ]);
  });
});

describe('BriefingView producer selector', () => {
  it('offers every producer with its pending count and does not refetch to filter', async () => {
    const { calls } = stubFetch({ queue: multiProducerQueue() });
    renderBriefing();

    const producers = await screen.findByTestId('briefing-producers');
    expect(within(producers).getByTestId('briefing-producer-all').textContent)
      .toContain('All producers');
    expect(within(producers).getByTestId('briefing-producer-all').textContent).toContain('3');
    expect(within(producers).getByTestId('briefing-producer-github-releases').textContent)
      .toContain('2');
    expect(within(producers).getByTestId('briefing-producer-rss').textContent).toContain('1');

    const queueCallsBefore = calls.filter((call) => call.url.startsWith('/api/briefing/queue')).length;
    fireEvent.click(within(producers).getByTestId('briefing-producer-rss'));

    await waitFor(() => {
      expect(screen.queryByTestId('briefing-row-gh-1')).toBeNull();
    });
    expect(screen.getByTestId('briefing-row-rss-1')).toBeTruthy();
    expect(screen.getByTestId('briefing-row-rss-1').getAttribute('aria-current')).toBe('true');
    // The whole point of filtering client-side: no new request, and certainly
    // no `?source=` round trip.
    expect(calls.filter((call) => call.url.startsWith('/api/briefing/queue')).length)
      .toBe(queueCallsBefore);
    expect(calls.some((call) => call.url.includes('source='))).toBe(false);
  });

  it('composes with the pending/judged filter in both directions', async () => {
    stubFetch({ queue: multiProducerQueue() });
    renderBriefing();

    await screen.findByTestId('briefing-producers');
    fireEvent.click(screen.getByTestId('briefing-producer-rss'));
    const row = await screen.findByTestId('briefing-row-rss-1');
    fireEvent.click(within(row).getByRole('button', { name: 'Dismiss' }));

    // Pending under this producer drains; the counts follow immediately.
    await waitFor(() => {
      expect(screen.getByTestId('briefing-producer-rss').textContent).toContain('0');
    });
    expect(screen.getByTestId('briefing-producer-all').textContent).toContain('2');
    expect(screen.getByRole('button', { name: 'Pending' })).toBeTruthy();

    // Judged, scoped to the selected producer.
    fireEvent.click(screen.getByRole('button', { name: 'Judged (1)' }));
    await waitFor(() => {
      expect(screen.getByText('Finding rss-1')).toBeTruthy();
    });
    expect(screen.queryByText('Finding gh-1')).toBeNull();

    // Same filter, other producer: nothing was judged there, and the page says
    // so about THAT producer rather than claiming the session judged nothing.
    fireEvent.click(screen.getByTestId('briefing-producer-github-releases'));
    await waitFor(() => {
      expect(screen.getByText(/Nothing from github-releases has been judged/)).toBeTruthy();
    });
  });

  it('scopes the empty state to the selected producer and names what it hides', async () => {
    stubFetch({
      queue: {
        candidates: [makeItem({ id: 'gh-1' })],
        sources: [makeSource(), makeSource({ source: 'rss', pending_count: 0, candidate_count: 0 })],
      },
    });
    renderBriefing();

    await screen.findByTestId('briefing-producers');
    fireEvent.click(screen.getByTestId('briefing-producer-rss'));

    const empty = await screen.findByTestId('briefing-empty-healthy');
    expect(empty.textContent).toContain('Nothing pending from rss');
    const note = screen.getByTestId('briefing-other-producers');
    expect(note.textContent).toContain('1 pending from other producers');

    fireEvent.click(within(note).getByRole('button', { name: 'Show all producers' }));
    await waitFor(() => {
      expect(screen.getByTestId('briefing-row-gh-1')).toBeTruthy();
    });
  });

  it('never reads a selected producer as clean when that producer went quiet', async () => {
    stubFetch({
      queue: {
        candidates: [makeItem({ id: 'gh-1' })],
        sources: [makeSource(), staleSource({ pending_count: 0, candidate_count: 0 })],
      },
    });
    renderBriefing();

    await screen.findByTestId('briefing-producers');
    fireEvent.click(screen.getByTestId('briefing-producer-rss'));

    const degraded = await screen.findByTestId('briefing-empty-degraded');
    expect(degraded.textContent).toContain('No findings from rss');
    expect(degraded.textContent).toContain('rss stopped reporting.');
    expect(screen.queryByTestId('briefing-empty-healthy')).toBeNull();
  });

  it('keeps the health strip global so a selection cannot hide another source', async () => {
    stubFetch({
      queue: {
        candidates: [makeItem({ id: 'gh-1' })],
        sources: [makeSource(), staleSource({ pending_count: 0, candidate_count: 0 })],
      },
    });
    renderBriefing();

    await screen.findByTestId('briefing-producers');
    fireEvent.click(screen.getByTestId('briefing-producer-github-releases'));

    const health = await screen.findByTestId('briefing-health');
    await waitFor(() => {
      expect(health.dataset.healthState).toBe('degraded');
    });
    expect(within(health).getByText('1 stale')).toBeTruthy();
    expect(within(health).getAllByText(/last ingest/).length).toBe(2);
  });

  it('does not render a producer row when there is only one producer', async () => {
    stubFetch();
    renderBriefing();

    await screen.findByTestId('briefing-row-cand-1');
    expect(screen.queryByTestId('briefing-producers')).toBeNull();
  });
});

describe('task identity visibility', () => {
  it('renders each source\'s producing task identity as text in the health strip', async () => {
    stubFetch({ queue: multiProducerQueue() });
    renderBriefing();

    const health = await screen.findByTestId('briefing-health');
    // Both sources are current, so the strip settles collapsed; only then is
    // the toggle a reliable "open it" rather than a race with the first load.
    await waitFor(() => {
      expect(health.dataset.healthState).toBe('healthy');
    });
    const toggle = within(health).getByRole('button');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(within(health).getByText('agent-schedule/daily-digest')).toBeTruthy();
    });
    expect(within(health).getByText('agent-schedule/rss-sweep')).toBeTruthy();
  });

  it('says so in words when a source has no batch identity on record', async () => {
    stubFetch({
      queue: makeQueue({
        candidates: [],
        sources: [makeSource({
          last_task_identity: null,
          last_ingested_at: null,
          last_ingest_age_ms: null,
        })],
      }),
    });
    renderBriefing();

    const health = await screen.findByTestId('briefing-health');
    await waitFor(() => {
      expect(within(health).getByText('no batch identity on record')).toBeTruthy();
    });
  });

  it('labels each queue group with the producing identity of its last batch', async () => {
    stubFetch({ queue: multiProducerQueue() });
    renderBriefing();

    await screen.findByTestId('briefing-row-gh-1');
    const headings = screen.getAllByRole('heading', { level: 3 });
    const text = headings.map((heading) => heading.textContent ?? '');
    expect(text.some((line) => /last batch by agent-schedule\/daily-digest/.test(line))).toBe(true);
    expect(text.some((line) => /last batch by agent-schedule\/rss-sweep/.test(line))).toBe(true);
  });

  it('shows the fold-out the producer of that finding, not the source default', async () => {
    stubFetch({ queue: multiProducerQueue() });
    renderBriefing();

    const row = await screen.findByTestId('briefing-row-rss-1');
    fireEvent.click(within(row).getByRole('button', { expanded: false }));
    const detail = await screen.findByTestId('briefing-detail-rss-1');
    expect(within(detail).getByText('producer agent-schedule/rss-sweep')).toBeTruthy();
  });

  it('omits the fold-out producer chip rather than substituting a source-level one', async () => {
    stubFetch({
      queue: makeQueue({ candidates: [makeItem({ id: 'cand-1', task_identity: null })] }),
    });
    renderBriefing();

    const row = await screen.findByTestId('briefing-row-cand-1');
    fireEvent.click(within(row).getByRole('button', { expanded: false }));
    const detail = await screen.findByTestId('briefing-detail-cand-1');
    expect(within(detail).queryByText(/^producer /)).toBeNull();
    // The source-level identity is still on the page; it is simply not claimed
    // as this revision's producer.
    expect(within(detail).getByText(/evidence: snapshot-item/)).toBeTruthy();
  });
});

describe('BriefingView empty states', () => {
  it('renders an empty-and-healthy briefing as a success', async () => {
    stubFetch({ queue: makeQueue({ candidates: [] }) });
    renderBriefing();

    expect(await screen.findByTestId('briefing-empty-healthy')).toBeTruthy();
    expect(screen.queryByTestId('briefing-empty-degraded')).toBeNull();
  });

  it('never presents an empty queue as clean when a collector went quiet', async () => {
    stubFetch({
      queue: makeQueue({
        candidates: [],
        sources: [staleSource()],
      }),
    });
    renderBriefing();

    const degraded = await screen.findByTestId('briefing-empty-degraded');
    expect(degraded.textContent).toContain('not clean');
    expect(degraded.textContent).toContain('does not mean there was nothing to find');
    expect(screen.queryByTestId('briefing-empty-healthy')).toBeNull();
  });

  it('does not read an empty briefing as clean when no source has reported', async () => {
    // The queue route has no "unavailable" envelope: a transport failure is
    // reported by the load error, and zero sources is a degraded briefing.
    stubFetch({ queue: { candidates: [], sources: [] } });
    renderBriefing();

    const degraded = await screen.findByTestId('briefing-empty-degraded');
    expect(degraded.textContent).toContain('No collector source has reported an ingest batch.');
    expect(screen.queryByTestId('briefing-empty-healthy')).toBeNull();
  });
});

describe('BriefingView keyboard triage', () => {
  it('processes the queue with the keyboard only and offers immediate undo', async () => {
    const { calls } = stubFetch({
      queue: makeQueue({
        candidates: [makeItem({ id: 'a' }), makeItem({ id: 'b' })],
      }),
    });
    renderBriefing();

    await screen.findByTestId('briefing-row-a');
    await awaitSelection('a');

    fireEvent.keyDown(window, { key: 'j' });
    await waitFor(() => {
      expect(screen.getByTestId('briefing-row-b').getAttribute('aria-current')).toBe('true');
    });
    fireEvent.keyDown(window, { key: 'k' });
    await waitFor(() => {
      expect(screen.getByTestId('briefing-row-a').getAttribute('aria-current')).toBe('true');
    });

    fireEvent.keyDown(window, { key: 'y' });
    await waitFor(() => {
      expect(screen.queryByTestId('briefing-row-a')).toBeNull();
    });
    const decision = calls.find((call) => call.url.includes('/decision'));
    expect(decision?.body).toEqual({ action: 'keep' });
    expect(decision?.url).toBe('/api/briefing/candidates/a/decision');

    const toast = await screen.findByTestId('briefing-undo-toast');
    expect(toast.textContent).toContain('Kept');
    // Selection moving to the next row marks the effect pass that also re-bound
    // the key handler around the new undo entry.
    await awaitSelection('b');

    fireEvent.keyDown(window, { key: 'u' });
    await waitFor(() => {
      expect(screen.getByTestId('briefing-row-a')).toBeTruthy();
    });
    expect(calls.filter((call) => call.url.includes('/decision')).at(-1)?.body).toEqual({ action: 'undo' });
  });

  it('opens the fold-out from the keyboard, inline and not on hover', async () => {
    stubFetch();
    renderBriefing();

    await screen.findByTestId('briefing-row-cand-1');
    await awaitSelection('cand-1');
    fireEvent.mouseOver(screen.getByTestId('briefing-row-cand-1'));
    expect(screen.queryByTestId('briefing-detail-cand-1')).toBeNull();

    fireEvent.keyDown(window, { key: 'o' });
    const detail = await screen.findByTestId('briefing-detail-cand-1');
    // The fold-out is a child of its row: inline, in flow, not an overlay.
    expect(screen.getByTestId('briefing-row-cand-1').contains(detail)).toBe(true);
    expect(within(detail).getByText('Provenance')).toBeTruthy();
    expect(within(detail).getByText(/evidence: snapshot-item/)).toBeTruthy();
    await waitFor(() => {
      expect(within(detail).getByText(/Occurrences/)).toBeTruthy();
    });
  });

  it('ignores triage keys typed into a text field', async () => {
    const { calls } = stubFetch();
    renderBriefing();

    await screen.findByTestId('briefing-row-cand-1');
    await awaitSelection('cand-1');
    fireEvent.keyDown(window, { key: 'o' });
    const detail = await screen.findByTestId('briefing-detail-cand-1');
    const textarea = within(detail).getByRole('textbox');
    fireEvent.keyDown(textarea, { key: 'n' });
    expect(calls.some((call) => call.url.includes('/decision'))).toBe(false);
  });
});

describe('BriefingView mutation gating', () => {
  it('disables every mutating control on a read-only instance and ignores judge keys', async () => {
    const { calls } = stubFetch();
    renderBriefing({
      instance: {
        role: 'preview',
        operational_mutations: 'reject',
        operational_mutations_overridden: false,
        db_path: null,
        db_path_source: null,
      },
    });

    const row = await screen.findByTestId('briefing-row-cand-1');
    await waitFor(() => {
      expect(screen.getByTestId('preview-disabled-notice')).toBeTruthy();
    });
    expect((within(row).getByRole('button', { name: 'Keep' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(row).getByRole('button', { name: 'Dismiss' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('preview-disabled-notice')).toBeTruthy();

    fireEvent.keyDown(window, { key: 'y' });
    fireEvent.keyDown(window, { key: 'n' });
    await waitFor(() => {
      expect(calls.some((call) => call.method === 'POST')).toBe(false);
    });
  });

  it('surfaces a rejected decision instead of pretending it landed', async () => {
    stubFetch({ decisionStatus: 403 });
    renderBriefing();

    await screen.findByTestId('briefing-row-cand-1');
    await awaitSelection('cand-1');
    fireEvent.keyDown(window, { key: 'y' });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('read-only instance');
    // The row must stay pending: a failed decision never removes it.
    expect(screen.getByTestId('briefing-row-cand-1')).toBeTruthy();
  });
});

describe('BriefingView keep-alive behavior', () => {
  it('does not fetch or bind keys while the route is mounted but hidden', async () => {
    const { calls } = stubFetch();
    renderBriefing({}, { active: false });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual([]);
    fireEvent.keyDown(window, { key: 'y' });
    expect(calls).toEqual([]);
  });
});

describe('age formatting', () => {
  it('is explicit about an unknown age rather than showing a fake one', () => {
    const now = 1_000_000_000_000;
    expect(formatBriefingAge(null, now)).toBe('age unknown');
    expect(formatBriefingAge(now - 30_000, now)).toBe('just now');
    expect(formatBriefingAge(now - 5 * 60_000, now)).toBe('5m ago');
    expect(formatBriefingAge(now - 3 * HOUR, now)).toBe('3h ago');
    expect(formatBriefingAge(now - 50 * HOUR, now)).toBe('2d ago');
  });
});

/**
 * Issue 223d090. Every other test in this file feeds the normalizer a
 * hand-written fixture; a fixture and a normalizer can agree with each other
 * and both be wrong about the server. This one builds the payload with the real
 * server function against a real database, so the queue key, the source-health
 * field names, and the candidate id all have to match what the daemon sends.
 */
describe('server payload → client normalizer', () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    setDb(db);
  });

  afterEach(() => {
    db.close();
  });

  function ingest(now: number): void {
    ingestBriefingBatch(db, {
      schema: BRIEFING_INGEST_SCHEMA,
      task_identity: 'agent-schedule/daily-digest',
      run_id: 'run-1',
      digest: { series_ref: 'artifact-series:abc123', version: 3 },
      batch_key: 'batch-1',
      items: [{
        candidate_key: 'k'.repeat(64),
        source: 'arxiv-scan',
        ref: 'https://example.invalid/paper-1',
        title: 'A notable finding',
        why_notable: 'It moves the pilot forward',
        refs: ['https://example.invalid/paper-1'],
        evidence_hash: 'evidence-a',
        evidence_kind: 'snapshot-item',
        captured_at: '2026-08-11T09:00:00Z',
        rank: 1,
      }],
    }, now);
  }

  /** A second producer: its own task identity, its own source namespace. */
  function ingestSecondProducer(now: number): void {
    ingestBriefingBatch(db, {
      schema: BRIEFING_INGEST_SCHEMA,
      task_identity: 'agent-schedule/rss-sweep',
      run_id: 'run-2',
      digest: { series_ref: 'artifact-series:def456', version: 1 },
      batch_key: 'batch-2',
      items: [{
        candidate_key: 'j'.repeat(64),
        source: 'rss',
        ref: 'https://example.invalid/post-1',
        title: 'A second producer finding',
        why_notable: 'It came from a different collector',
        refs: [],
        evidence_hash: 'evidence-b',
        evidence_kind: 'finding-only',
        captured_at: '2026-08-11T10:00:00Z',
        rank: 1,
      }],
    }, now);
  }

  it('carries candidates and source health from listBriefingQueue into the view model', () => {
    const now = Date.now();
    ingest(now - HOUR);

    // The exact object the route serializes — not a reconstruction of it.
    const payload: BriefingQueueResponse = listBriefingQueue(db, { now });
    const queue = normalizeBriefingQueue(payload, now);

    expect(payload.candidates).toHaveLength(1);
    expect(queue.candidates).toHaveLength(1);
    expect(queue.candidates[0].candidate_id).toBe(payload.candidates[0].id);
    expect(queue.candidates[0].source).toBe('arxiv-scan');
    expect(queue.candidates[0].revision.title).toBe('A notable finding');
    expect(queue.candidates[0].occurrences.count).toBe(1);

    expect(queue.sources).toHaveLength(1);
    expect(queue.sources[0].last_ingested_at).toBe(payload.sources[0].last_ingested_at);
    expect(queue.sources[0].pending_count).toBe(1);
    // A source that reported an hour ago is current, never `unknown`.
    expect(queue.sources[0].status).toBe('current');
    expect(summarizeBriefingHealth(queue.sources).healthy).toBe(true);
  });

  it('classifies a source that stopped reporting as stale, not as clean', () => {
    const now = Date.now();
    ingest(now - 72 * HOUR);

    const queue = normalizeBriefingQueue(listBriefingQueue(db, { now }), now);
    expect(queue.sources[0].status).toBe('stale');
    expect(summarizeBriefingHealth(queue.sources).healthy).toBe(false);
  });

  it('renders a live server payload through the view', async () => {
    const now = Date.now();
    ingest(now - HOUR);
    const payload = listBriefingQueue(db, { now });
    stubFetch({ queue: payload });
    renderBriefing();

    const row = await screen.findByTestId(`briefing-row-${payload.candidates[0].id}`);
    expect(within(row).getByText('A notable finding')).toBeTruthy();
    expect(screen.queryByTestId('briefing-empty-degraded')).toBeNull();
  });

  it('resolves each entry\'s own producing task identity, not the source default', () => {
    const now = Date.now();
    ingest(now - HOUR);
    ingestSecondProducer(now - 2 * HOUR);

    const payload: BriefingQueueResponse = listBriefingQueue(db, { now });
    const queue = normalizeBriefingQueue(payload, now);
    const bySource = new Map(queue.candidates.map((entry) => [entry.source, entry]));

    expect([...bySource.keys()].sort()).toEqual(['arxiv-scan', 'rss']);
    expect(bySource.get('arxiv-scan')?.task_identity).toBe('agent-schedule/daily-digest');
    expect(bySource.get('rss')?.task_identity).toBe('agent-schedule/rss-sweep');

    // Producer counts and identities the tabs render, derived from that payload
    // alone — no second request and no `?source=` filter involved.
    expect(listBriefingProducers(queue.sources, queue.candidates).map((producer) => [
      producer.source,
      producer.pending,
      producer.lastTaskIdentity,
    ])).toEqual([
      ['arxiv-scan', 1, 'agent-schedule/daily-digest'],
      ['rss', 1, 'agent-schedule/rss-sweep'],
    ]);
  });

  it('drives the producer selector from a two-producer server payload', async () => {
    const now = Date.now();
    ingest(now - HOUR);
    ingestSecondProducer(now - 2 * HOUR);
    const payload = listBriefingQueue(db, { now });
    stubFetch({ queue: payload });
    renderBriefing();

    await screen.findByTestId('briefing-producers');
    fireEvent.click(screen.getByTestId('briefing-producer-rss'));

    await waitFor(() => {
      expect(screen.queryByText('A notable finding')).toBeNull();
    });
    expect(screen.getByText('A second producer finding')).toBeTruthy();
  });
});
