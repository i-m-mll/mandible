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
  invalidateApiGetCache,
  normalizeBriefingQueue,
} from '../ui/src/api';
import {
  BriefingValidationError,
  countPendingBriefingCandidates,
  getBriefingCandidateHistory,
  ingestBriefingBatch,
  listBriefingQueue,
  recordBriefingDecision,
} from '../src/briefing.js';
import { createUser } from '../src/users/store.js';
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
      publisher_advisory: null,
      batch_key: 'b'.repeat(64),
      ingested_at: Date.now() - HOUR,
    },
    revision_count: 1,
    occurrences: { count: 1, first_seen_at: Date.now() - HOUR, last_seen_at: Date.now() - HOUR },
    // The producer of THIS entry's revision — a per-entry contract field, not
    // the source's most recent batch identity.
    task_identity: 'agent-schedule/daily-digest',
    group: null,
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
  /**
   * A function is resolved per request, which is how a test makes the SERVER
   * change between polls — a new revision arriving, or a decided candidate
   * leaving the queue — instead of pretending the payload is frozen.
   */
  queue?: BriefingQueueResponse | (() => BriefingQueueResponse);
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
      const queue = typeof options.queue === 'function' ? options.queue() : options.queue;
      return Promise.resolve(jsonResponse(queue ?? makeQueue()));
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
        action: (body as { action?: BriefingDecisionResponse['action'] }).action ?? 'keep',
        event_id: 'dec-1',
        state: (body as { action?: string }).action === 'dismiss' ? 'dismissed' : 'kept',
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

function briefingElement(
  props: Partial<Parameters<typeof BriefingView>[0]> = {},
  shell: Partial<AppShellContextValue> = {},
) {
  const context: AppShellContextValue = {
    bottomPanel: null,
    registerBottomPanel: () => () => undefined,
    active: true,
    ...shell,
  };
  return (
    <AppShellProvider value={context}>
      <BriefingView instance={null} {...props} />
    </AppShellProvider>
  );
}

function renderBriefing(
  props: Partial<Parameters<typeof BriefingView>[0]> = {},
  shell: Partial<AppShellContextValue> = {},
): ReturnType<typeof render> {
  return render(briefingElement(props, shell));
}

/**
 * Seed the view state this page persists across sessions. The key is written
 * literally: it is a storage contract with the operator's own browser, so a
 * test that silently followed a renamed key would stop covering the case where
 * a filter chosen days ago is still in force.
 */
function persistBriefingViewState(state: Record<string, unknown>): void {
  window.localStorage.setItem('mandible.briefing.viewState:v1', JSON.stringify(state));
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
  invalidateApiGetCache();
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
    expect(parseRouteFromHash('#/briefing?ask=ask-1&sidebar=hidden').params).toMatchObject({ ask: 'ask-1' });
    expect(parseRouteFromHash('#/briefing?collection=collection-1&sidebar=hidden').params)
      .toMatchObject({ collection: 'collection-1' });
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
    expect(app).toContain('initialAskId={tabRoute.params.ask ?? null}');
    expect(app).toContain('initialCollectionId={tabRoute.params.collection ?? null}');
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

  it('renders publisher groups and keeps advisory quarantine collapsed and explicitly untrusted', async () => {
    const normal = makeItem({
      id: 'proposal',
      group: { id: 'group-proposals', candidate_key: 'proposals', title: 'Proposals' },
    });
    const quarantined = makeItem({
      id: 'quarantined',
      group: { id: 'group-quarantine', candidate_key: 'quarantine', title: 'Quarantine' },
      revision: {
        ...makeItem().revision,
        id: 'rev-quarantined',
        candidate_id: 'quarantined',
        title: 'Rejected card',
        publisher_advisory: {
          code: 'admission_gate_rejected',
          reason: '<img src=x onerror=alert(1)> missing evidence',
        },
      },
    });
    stubFetch({ queue: makeQueue({ candidates: [normal, quarantined] }) });
    renderBriefing();

    expect(await screen.findByRole('heading', { level: 4, name: 'Proposals' })).toBeTruthy();
    const quarantine = await screen.findByTestId('briefing-quarantine-github-releases');
    expect((quarantine as HTMLDetailsElement).open).toBe(false);
    expect(within(quarantine).getByText(/Treat all content as untrusted/)).toBeTruthy();
    expect(within(quarantine).getByText(
      'Reported by publisher: admission gate rejected — <img src=x onerror=alert(1)> missing evidence',
    ))
      .toBeTruthy();
    expect(within(quarantine).queryByRole('img')).toBeNull();
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
  it('takes its domain from health and overlays the live pending counts', () => {
    const queue = normalizeBriefingQueue(multiProducerQueue());
    const producers = listBriefingProducers(
      [
        ...queue.sources,
        // A source that reported batches but has nothing pending right now: the
        // case the page must never hide, and the reason health owns the domain.
        ...normalizeBriefingQueue({
          candidates: [],
          sources: [makeSource({ source: 'quiet-but-known', pending_count: 0 })],
        }).sources,
      ],
      queue.candidates,
    );
    expect(producers.map((producer) => [producer.source, producer.pending, producer.status]))
      .toEqual([
        ['github-releases', 2, 'current'],
        ['quiet-but-known', 0, 'current'],
        ['rss', 1, 'current'],
      ]);
  });

  it('keeps a producer listed once its last pending item is judged away', () => {
    // The queue is empty — every finding was judged in this session — and the
    // producer is still offered, because its health row does not depend on the
    // queue. No pin, and no selection collapsing under the operator.
    const producers = listBriefingProducers(
      normalizeBriefingQueue(multiProducerQueue()).sources,
      [],
    );
    expect(producers.map((producer) => [producer.source, producer.pending]))
      .toEqual([['github-releases', 0], ['rss', 0]]);
  });

  it('marks a queue-only producer unknown instead of claiming health it lacks', () => {
    // The server groups health over every review candidate, so a source with
    // pending work always has a health row. A payload without one contradicts
    // the contract: the pending work is still offered, and the producer reads
    // as degraded rather than as a source that is silently fine.
    const producers = listBriefingProducers(
      [],
      normalizeBriefingQueue(multiProducerQueue()).candidates,
    );
    expect(producers.map((producer) => [producer.source, producer.pending, producer.status]))
      .toEqual([
        ['github-releases', 2, 'unknown'],
        ['rss', 1, 'unknown'],
      ]);
    expect(producers.every((producer) => producer.lastTaskIdentity === null)).toBe(true);
  });

  it('renders a contract-inconsistent producer as degraded in the selector', async () => {
    stubFetch({
      queue: {
        candidates: multiProducerQueue().candidates,
        // `rss` has pending candidates but no health row.
        sources: [makeSource()],
      },
    });
    renderBriefing();

    const rss = await screen.findByTestId('briefing-producer-rss');
    expect(rss.className).toContain('briefing-tab--degraded');
    expect(screen.getByTestId('briefing-producer-github-releases').className)
      .not.toContain('briefing-tab--degraded');
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

describe('BriefingView session judgments', () => {
  it('does not hide a newer revision of a candidate judged earlier', async () => {
    let payload = multiProducerQueue();
    stubFetch({ queue: () => payload });
    renderBriefing();

    const row = await screen.findByTestId('briefing-row-rss-1');
    fireEvent.click(within(row).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => {
      expect(screen.queryByTestId('briefing-row-rss-1')).toBeNull();
    });
    expect(screen.getByTestId('briefing-producer-rss').textContent).toContain('0');

    // The collector re-ingests the finding with new content: the SAME candidate,
    // a new revision, pending again. The judgment was about the old revision and
    // says nothing about this one.
    payload = {
      ...multiProducerQueue(),
      candidates: multiProducerQueue().candidates.map((entry) => (
        entry.id === 'rss-1'
          ? {
            ...entry,
            revision: { ...entry.revision, id: 'rev-rss-1-b', title: 'Finding rss-1, revised' },
          }
          : entry
      )),
    };
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    const revised = await screen.findByTestId('briefing-row-rss-1');
    expect(within(revised).getByText('Finding rss-1, revised')).toBeTruthy();
    // Counted, not merely rendered: the producer tab and the pending tab are the
    // numbers an operator would trust to say the queue is empty.
    await waitFor(() => {
      expect(screen.getByTestId('briefing-producer-rss').textContent).toContain('1');
    });
    expect(screen.getByRole('button', { name: 'Pending (3)' })).toBeTruthy();
  });

  it('brings back an undone finding a poll had already removed', async () => {
    const full = multiProducerQueue();
    let payload: BriefingQueueResponse = full;
    const { calls } = stubFetch({ queue: () => payload });
    const queueCalls = () => calls.filter((call) => call.url === '/api/briefing/queue').length;
    renderBriefing();

    const row = await screen.findByTestId('briefing-row-rss-1');
    fireEvent.click(within(row).getByRole('button', { name: 'Dismiss' }));
    await screen.findByTestId('briefing-undo-toast');

    // A poll lands while the toast is still up. The server has taken the decided
    // candidate out of the queue, so the local overlay is no longer what hides it.
    payload = { ...full, candidates: full.candidates.filter((entry) => entry.id !== 'rss-1') };
    const before = queueCalls();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => {
      expect(queueCalls()).toBe(before + 1);
    });

    // Undo puts it back on the server; the page must not stay a poll behind.
    payload = full;
    fireEvent.click(
      within(screen.getByTestId('briefing-undo-toast')).getByRole('button', { name: 'Undo' }),
    );

    const restored = await screen.findByTestId('briefing-row-rss-1');
    expect(within(restored).getByText('Finding rss-1')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId('briefing-producer-rss').textContent).toContain('1');
    });
  });
});

/**
 * The judged/undo path against the REAL store, not a fixture that agrees with
 * the page. Everything below runs `listBriefingQueue` and
 * `recordBriefingDecision` over an in-memory database, so an assertion about
 * "which revision was undone" is an assertion about rows the daemon would
 * write — the one thing a hand-rolled fetch stub cannot establish, and the
 * exact gap that let a candidate-addressed Undo pass this suite.
 */
describe('BriefingView decisions against the real store', () => {
  let db: Db;
  let reviewerId: string;

  const CANDIDATE_KEY = 'c'.repeat(64);

  function ingestRevision(
    options: { title: string; evidenceHash: string; version: number; now: number },
  ): void {
    ingestBriefingBatch(db, {
      schema: BRIEFING_INGEST_SCHEMA,
      task_identity: 'agent-schedule/daily-digest',
      run_id: `run-${options.version}`,
      digest: { series_ref: 'artifact-series:abc123', version: options.version },
      batch_key: `batch-${options.version}`,
      items: [{
        candidate_key: CANDIDATE_KEY,
        source: 'arxiv-scan',
        ref: 'https://example.invalid/paper-1',
        title: options.title,
        why_notable: 'It moves the pilot forward',
        refs: [],
        evidence_hash: options.evidenceHash,
        evidence_kind: 'snapshot-item',
        captured_at: '2026-08-11T09:00:00Z',
        rank: 1,
      }],
    }, options.now);
  }

  function candidateId(): string {
    return (db.prepare('SELECT id FROM feedback_items LIMIT 1').get() as { id: string }).id;
  }

  function revisionIdByTitle(title: string): string {
    return (db
      .prepare('SELECT id FROM feedback_item_revisions WHERE title = ?')
      .get(title) as { id: string }).id;
  }

  function lastActionOn(revisionId: string): string | null {
    const row = db
      .prepare(
        `SELECT CASE operation
                  WHEN 'retract' THEN 'undo'
                  ELSE json_extract(value_json, '$.verdict')
                END AS action
           FROM feedback_response_events
          WHERE item_revision_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1`,
      )
      .get(revisionId) as { action: string } | undefined;
    return row?.action ?? null;
  }

  /** Serve the page from the real store: queue reads and decision writes both. */
  function stubRealServer(): void {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as Record<string, unknown>
        : {};

      if (url === '/api/briefing/queue') {
        return Promise.resolve(jsonResponse(listBriefingQueue(db, { now: Date.now() })));
      }
      if (url === '/api/dashboard/badges') {
        return Promise.resolve(jsonResponse({
          auth: 0,
          inbox: 0,
          work: 0,
          briefing: countPendingBriefingCandidates(db),
        }));
      }
      if (url.includes('/history')) {
        const id = decodeURIComponent(url.split('/candidates/')[1].split('/')[0]);
        return Promise.resolve(jsonResponse(getBriefingCandidateHistory(db, id)));
      }
      if (url.includes('/decision') && method === 'POST') {
        const id = decodeURIComponent(url.split('/candidates/')[1].split('/')[0]);
        try {
          const outcome = recordBriefingDecision(db, {
            candidateId: id,
            action: body.action as 'keep' | 'dismiss' | 'undo',
            actorUserId: reviewerId,
            ...(typeof body.revision_id === 'string' ? { revisionId: body.revision_id } : {}),
            ...(typeof body.expected_event_id === 'string'
              ? { expectedEventId: body.expected_event_id }
              : {}),
          });
          return Promise.resolve(jsonResponse(outcome));
        } catch (error) {
          const status = error instanceof BriefingValidationError ? error.status : 400;
          const message = error instanceof Error ? error.message : String(error);
          return Promise.resolve(new Response(JSON.stringify({ error: message }), {
            status,
            headers: { 'Content-Type': 'application/json' },
          }));
        }
      }
      return Promise.reject(new Error(`unexpected fetch ${method} ${url}`));
    }));
  }

  /** The Undo button on the judged row showing this revision's title. */
  function undoButtonFor(title: string): HTMLElement {
    const row = screen.getByText(title).closest('li');
    if (!row) throw new Error(`no judged row for ${title}`);
    return within(row as HTMLElement).getByRole('button', { name: 'Undo' });
  }

  /**
   * Judge revision A, let the collector revise the finding, judge revision B,
   * then reach back and undo A from the older judged row.
   */
  async function judgeBothRevisions(): Promise<void> {
    ingestRevision({ title: 'Finding A', evidenceHash: 'evidence-a', version: 1, now: Date.now() - HOUR });
    stubRealServer();
    renderBriefing();

    const rowA = await screen.findByText('Finding A');
    fireEvent.click(within(rowA.closest('li') as HTMLElement).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => {
      expect(screen.queryByText('Finding A')).toBeNull();
    });

    ingestRevision({ title: 'Finding B', evidenceHash: 'evidence-b', version: 2, now: Date.now() });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    const rowB = await screen.findByText('Finding B');
    fireEvent.click(within(rowB.closest('li') as HTMLElement).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => {
      expect(screen.queryByText('Finding B')).toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: /^Judged/ }));
    await screen.findByText('Finding A');
    expect(lastActionOn(revisionIdByTitle('Finding A'))).toBe('dismiss');
    expect(lastActionOn(revisionIdByTitle('Finding B'))).toBe('dismiss');
  }

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    setDb(db);
    reviewerId = createUser(db, { slug: 'operator', kind: 'human', display_name: 'Operator' }).id;
  });

  afterEach(() => {
    db.close();
  });

  it('undoes the older judged revision without clearing the newer judgment', async () => {
    await judgeBothRevisions();
    const revisionA = revisionIdByTitle('Finding A');
    const revisionB = revisionIdByTitle('Finding B');

    fireEvent.click(undoButtonFor('Finding A'));

    await waitFor(() => {
      expect(lastActionOn(revisionA)).toBe('undo');
    });
    // The judgment the operator did NOT touch survives. A candidate-addressed
    // undo landed here instead, un-dismissing content nobody re-reviewed.
    expect(lastActionOn(revisionB)).toBe('dismiss');
    // The candidate follows its current revision, so it stays out of the queue.
    expect(countPendingBriefingCandidates(db)).toBe(0);

    // UI state matches: the undone row is gone from Judged, the newer one
    // remains, and the queue does not resurrect the finding.
    await waitFor(() => {
      expect(screen.queryByText('Finding A')).toBeNull();
    });
    expect(screen.getByText('Finding B')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Pending/ }));
    await screen.findByTestId('briefing-view');
    expect(screen.queryByText('Finding B')).toBeNull();
  });

  it('re-pends the candidate when the CURRENT revision is the one undone', async () => {
    await judgeBothRevisions();
    const revisionA = revisionIdByTitle('Finding A');
    const revisionB = revisionIdByTitle('Finding B');

    fireEvent.click(undoButtonFor('Finding B'));
    await waitFor(() => {
      expect(lastActionOn(revisionB)).toBe('undo');
    });
    expect(lastActionOn(revisionA)).toBe('dismiss');
    expect(countPendingBriefingCandidates(db)).toBe(1);

    // Undoing the older row afterwards is still valid and still local to it.
    fireEvent.click(undoButtonFor('Finding A'));
    await waitFor(() => {
      expect(lastActionOn(revisionA)).toBe('undo');
    });
    expect(lastActionOn(revisionB)).toBe('undo');
    expect(countPendingBriefingCandidates(db)).toBe(1);
  });

  it('surfaces a rejected undo and keeps the judged row', async () => {
    await judgeBothRevisions();
    const revisionA = revisionIdByTitle('Finding A');

    // Somewhere else — another tab, another operator — that decision is already
    // gone. The page must report the conflict rather than pretend it undid it.
    recordBriefingDecision(db, {
      candidateId: candidateId(),
      revisionId: revisionA,
      action: 'undo',
      actorUserId: reviewerId,
    });

    fireEvent.click(undoButtonFor('Finding A'));

    const error = await screen.findByRole('alert');
    expect(error.textContent).toContain('no decision to undo');
    expect(screen.getByText('Finding A')).toBeTruthy();
    expect(screen.getByText('Finding B')).toBeTruthy();
  });

  /**
   * The pass-3 finding, end to end through the page. Revision addressing alone
   * cannot save this: the row and the intervening decision are about the SAME
   * revision, so only the event identity distinguishes the judgment this page
   * made from the one that replaced it.
   */
  it('conflicts on a stale undo and reconciles instead of erasing the newer judgment', async () => {
    await judgeBothRevisions();
    const revisionA = revisionIdByTitle('Finding A');
    const pageDismissId = (db
      .prepare(
        `SELECT id FROM feedback_response_events
          WHERE item_revision_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(revisionA) as { id: string }).id;

    // Another operator judges the same revision after this page dismissed it.
    const bob = createUser(db, { slug: 'bob', kind: 'human', display_name: 'Bob' }).id;
    recordBriefingDecision(db, {
      candidateId: candidateId(),
      revisionId: revisionA,
      action: 'keep',
      actorUserId: bob,
    });

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const queueLoads = (): number => fetchMock.mock.calls
      .filter((call) => String(call[0]) === '/api/briefing/queue').length;
    const loadsBefore = queueLoads();

    fireEvent.click(undoButtonFor('Finding A'));

    const error = await screen.findByRole('alert');
    expect(error.textContent).toContain('decision changed since it was read');

    // The request named the event this page recorded, not merely the revision.
    const undoInit = fetchMock.mock.calls
      .filter((call) => String(call[0]).includes('/decision')).at(-1)?.[1] as RequestInit;
    expect(JSON.parse(String(undoInit.body)) as Record<string, unknown>).toMatchObject({
      action: 'undo',
      revision_id: revisionA,
      expected_event_id: pageDismissId,
    });

    // Nothing was written: Bob's judgment stands and the judged row remains,
    // because this page did not undo anything.
    expect(lastActionOn(revisionA)).toBe('keep');
    expect(screen.getByText('Finding A')).toBeTruthy();
    expect(screen.getByText('Finding B')).toBeTruthy();

    // The page refetches so it stops rendering a picture the server moved past.
    await waitFor(() => {
      expect(queueLoads()).toBeGreaterThan(loadsBefore);
    });
  });
});

describe('BriefingView candidate deep link', () => {
  it('overrides a persisted producer filter on first mount', async () => {
    // The operator left the page scoped to `rss` in an earlier session; the link
    // that brings them back points at a `github-releases` finding.
    persistBriefingViewState({ filter: 'pending', source: 'rss' });
    stubFetch({ queue: multiProducerQueue() });
    renderBriefing({ initialCandidateId: 'gh-1' });

    await awaitSelection('gh-1');
    expect(screen.getByTestId('briefing-producer-all').getAttribute('aria-pressed')).toBe('true');
    // The scope was dropped, not narrowed to the link's own producer.
    expect(screen.getByTestId('briefing-row-rss-1')).toBeTruthy();
  });

  it('honors a later candidate prop on the already-mounted route', async () => {
    stubFetch({ queue: multiProducerQueue() });
    const view = renderBriefing();

    await screen.findByTestId('briefing-producers');
    fireEvent.click(screen.getByTestId('briefing-producer-rss'));
    await awaitSelection('rss-1');

    // A second navigation from Spaces: this route is keep-alive, so it arrives
    // as a new prop on the same instance rather than a fresh mount.
    view.rerender(briefingElement({ initialCandidateId: 'gh-1' }));

    await awaitSelection('gh-1');
    expect(screen.getByTestId('briefing-producer-all').getAttribute('aria-pressed')).toBe('true');
  });

  it('reconciles a later link against a queue loaded after the navigation', async () => {
    // The payload this keep-alive page is holding predates the finding: the
    // collector ingested `gh-1` after the last poll. Answering the link from
    // that snapshot means declaring the candidate absent on the strength of
    // evidence that could not have contained it.
    let payload: BriefingQueueResponse = {
      candidates: [makeItem({ id: 'rss-1', source: 'rss', task_identity: 'agent-schedule/rss-sweep' })],
      sources: [makeSource({ source: 'rss', last_task_identity: 'agent-schedule/rss-sweep' })],
    };
    stubFetch({ queue: () => payload });
    const view = renderBriefing();

    await awaitSelection('rss-1');

    payload = multiProducerQueue();
    view.rerender(briefingElement({ initialCandidateId: 'gh-1' }));

    await awaitSelection('gh-1');
  });

  it('does not freeze the selection on a link the queue will never contain', async () => {
    let payload: BriefingQueueResponse = multiProducerQueue();
    stubFetch({ queue: () => payload });
    const view = renderBriefing();

    await screen.findByTestId('briefing-producers');
    fireEvent.click(screen.getByTestId('briefing-producer-rss'));
    await awaitSelection('rss-1');

    view.rerender(briefingElement({ initialCandidateId: 'never-ingested' }));

    // The load the link asked for concludes without it, so the link is spent
    // and the ordinary selection keep-alive resumes rather than waiting forever
    // for a candidate that is not coming.
    payload = {
      candidates: multiProducerQueue().candidates.filter((entry) => entry.id !== 'rss-1'),
      sources: multiProducerQueue().sources,
    };
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => {
      expect(screen.queryByTestId('briefing-row-rss-1')).toBeNull();
    });
    fireEvent.click(screen.getByTestId('briefing-producer-all'));
    await awaitSelection('gh-1');
  });

  it('leaves a filter alone when the linked candidate is already in scope', async () => {
    persistBriefingViewState({ filter: 'pending', source: 'rss' });
    stubFetch({ queue: multiProducerQueue() });
    renderBriefing({ initialCandidateId: 'rss-1' });

    await awaitSelection('rss-1');
    expect(screen.getByTestId('briefing-producer-rss').getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByTestId('briefing-row-gh-1')).toBeNull();
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
    // The revision is on the wire, not just the candidate: the server writes
    // the event where the operator's eyes were.
    expect(decision?.body).toEqual({ action: 'keep', revision_id: 'rev-a' });
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
    // The undo names the EVENT the keep returned, not just the revision, so it
    // can only retract that judgment and never a newer one on the same revision.
    expect(calls.filter((call) => call.url.includes('/decision')).at(-1)?.body)
      .toEqual({ action: 'undo', revision_id: 'rev-a', expected_event_id: 'dec-1' });

  });

  it('dismisses the selected finding with n', async () => {
    const { calls } = stubFetch();
    renderBriefing();
    await screen.findByTestId('briefing-row-cand-1');
    await awaitSelection('cand-1');

    fireEvent.keyDown(window, { key: 'n' });
    await waitFor(() => {
      expect(screen.queryByTestId('briefing-row-cand-1')).toBeNull();
    });
    expect(calls.find((call) => call.url.includes('/decision'))?.body)
      .toEqual({ action: 'dismiss', revision_id: 'rev-cand-1' });
    expect(screen.getByTestId('briefing-undo-toast').textContent).toContain('Dismissed');
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

  it('ignores triage keys from form controls, buttons, and modal content', async () => {
    const { calls } = stubFetch();
    renderBriefing();

    await screen.findByTestId('briefing-row-cand-1');
    await awaitSelection('cand-1');
    fireEvent.keyDown(window, { key: 'o' });
    const detail = await screen.findByTestId('briefing-detail-cand-1');
    const textarea = within(detail).getByRole('textbox');
    fireEvent.keyDown(textarea, { key: 'n' });
    fireEvent.keyDown(within(detail).getByRole('button', { name: 'Save note' }), { key: 'y' });
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const dialogButton = document.createElement('button');
    dialog.append(dialogButton);
    document.body.append(dialog);
    fireEvent.keyDown(dialogButton, { key: 'n' });
    dialog.remove();
    expect(calls.some((call) => call.url.includes('/decision'))).toBe(false);
  });

  it('sends the displayed revision with a saved note', async () => {
    const { calls } = stubFetch();
    renderBriefing();

    await screen.findByTestId('briefing-row-cand-1');
    await awaitSelection('cand-1');
    fireEvent.keyDown(window, { key: 'o' });
    const detail = await screen.findByTestId('briefing-detail-cand-1');
    const textarea = within(detail).getByRole('textbox');
    fireEvent.input(textarea, { target: { value: 'worth a note' } });
    fireEvent.click(within(detail).getByRole('button', { name: 'Save note' }));

    await waitFor(() => {
      expect(calls.some((call) => call.url.includes('/comments'))).toBe(true);
    });
    const commentCall = calls.find((call) => call.url.includes('/comments'));
    // The revision is on the wire for notes exactly like decisions: the server
    // stores the note where the operator's eyes were (issue f8f8d76).
    expect(commentCall?.url).toBe('/api/briefing/candidates/cand-1/comments');
    expect(commentCall?.body).toEqual({ body: 'worth a note', revision_id: 'rev-cand-1' });
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

  /**
   * The claim that `Partial<Contract…>` projections in ui/src/api.ts couple the
   * client to the server at COMPILE time is not enforced anywhere: the root
   * tsconfig includes `src` only, and Vitest transpiles with esbuild without
   * type-checking. A repo-wide `tsc --noEmit` over ui/src and test reports ~600
   * pre-existing errors (mostly the repo's global-`JSX` convention, which preact
   * 10 does not declare), so this suite closes the gap at RUNTIME instead: every
   * field the client reads is asserted present, and equal, on a payload built by
   * the real server function. A renamed or dropped field fails here by name.
   */
  const CONSUMED_ENTRY_FIELDS = [
    'source',
    'candidate_key',
    'created_at',
    'state',
    'revision_count',
    'task_identity',
  ];
  const CONSUMED_REVISION_FIELDS = [
    'id',
    'candidate_id',
    'title',
    'why_notable',
    'refs',
    'source_ref',
    'evidence_hash',
    'evidence_kind',
    'captured_at',
    'run_id',
    'digest_series_ref',
    'digest_version',
    'rank',
    'batch_key',
    'ingested_at',
  ];
  const CONSUMED_OCCURRENCE_FIELDS = ['count', 'first_seen_at', 'last_seen_at'];
  const CONSUMED_HEALTH_FIELDS = [
    'source',
    'last_ingested_at',
    'last_ingest_age_ms',
    'last_task_identity',
    'last_run_id',
    'last_digest_version',
    'last_batch_item_count',
    'pending_count',
  ];

  /** Report missing and drifted field names, so a failure says which one. */
  function expectCarried(
    label: string,
    raw: Record<string, unknown>,
    normalized: Record<string, unknown>,
    fields: string[],
  ): void {
    expect({ [`${label} missing`]: fields.filter((field) => !(field in raw)) })
      .toEqual({ [`${label} missing`]: [] });
    expect({
      [`${label} drifted`]: fields.filter(
        (field) => JSON.stringify(raw[field]) !== JSON.stringify(normalized[field]),
      ),
    }).toEqual({ [`${label} drifted`]: [] });
  }

  it('carries every field the client consumes off the real server payload', () => {
    const now = Date.now();
    ingest(now - HOUR);

    const payload: BriefingQueueResponse = listBriefingQueue(db, { now });
    const queue = normalizeBriefingQueue(payload, now);

    const rawEntry = payload.candidates[0] as unknown as Record<string, unknown>;
    const entry = queue.candidates[0];
    expectCarried('entry', rawEntry, entry as unknown as Record<string, unknown>, CONSUMED_ENTRY_FIELDS);
    // The one deliberate rename in the whole projection.
    expect(entry.candidate_id).toBe(rawEntry.id);
    expectCarried(
      'revision',
      rawEntry.revision as Record<string, unknown>,
      entry.revision as unknown as Record<string, unknown>,
      CONSUMED_REVISION_FIELDS,
    );
    expectCarried(
      'occurrences',
      rawEntry.occurrences as Record<string, unknown>,
      entry.occurrences as unknown as Record<string, unknown>,
      CONSUMED_OCCURRENCE_FIELDS,
    );
    expectCarried(
      'health',
      payload.sources[0] as unknown as Record<string, unknown>,
      queue.sources[0] as unknown as Record<string, unknown>,
      CONSUMED_HEALTH_FIELDS,
    );

    // The provenance the producer axis renders is real, not merely present.
    expect(entry.task_identity).toBe('agent-schedule/daily-digest');
    expect(entry.revision.digest_series_ref).toBe('artifact-series:abc123');
    expect(entry.revision.batch_key).toBe('batch-1');
    expect(queue.sources[0].last_task_identity).toBe('agent-schedule/daily-digest');
    expect(queue.sources[0].last_run_id).toBe('run-1');
    expect(queue.sources[0].last_digest_version).toBe(3);
    expect(queue.sources[0].last_batch_item_count).toBe(1);
    // `status` is the one field the client adds; the server never sends it.
    expect('status' in (payload.sources[0] as unknown as Record<string, unknown>)).toBe(false);
    expect(queue.sources[0].status).toBe('current');
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
