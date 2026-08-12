// Briefing view tests — umbrella 99b74d6, lane d304a9b.
//
// The server routes (integration contract v1 §4) are owned by a sibling lane
// and are not live yet, so every test here drives the real client layer in
// ui/src/api.ts against a stubbed `fetch` carrying contract-shaped payloads.
// The point of the suite is the properties that make the Briefing trustworthy:
// deterministic health before model output, an honest empty-but-broken state,
// keyboard-only triage with undo, inline (not hover) fold-outs, allowlisted ref
// linkification, and mutation gating on the instance policy.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BRIEFING_VISIBLE_LIMIT,
  BriefingView,
  briefingRefLink,
  formatBriefingAge,
  summarizeBriefingHealth,
} from '../ui/src/views/briefing';
import {
  deriveBriefingSourceStatus,
  normalizeBriefingQueue,
  type BriefingSourceHealth,
} from '../ui/src/api';
import { AppShellProvider, type AppShellContextValue } from '../ui/src/app-shell';
import { parseRouteFromHash } from '../ui/src/routing';

const HOUR = 60 * 60 * 1000;

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const id = (overrides.candidate_id as string) ?? 'cand-1';
  return {
    candidate_id: id,
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
    occurrences: { count: 1, first_seen_at: Date.now() - HOUR, last_seen_at: Date.now() - HOUR },
    ...overrides,
  };
}

function makeSource(overrides: Partial<BriefingSourceHealth> = {}): Record<string, unknown> {
  return {
    source: 'github-releases',
    status: 'current',
    last_ingest_at: Date.now() - HOUR,
    last_run_id: 'run-9',
    last_run_status: 'ok',
    pending_count: 1,
    ...overrides,
  };
}

function makeQueue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    available: true,
    items: [makeItem()],
    total_pending: 1,
    sources: [makeSource()],
    digest: {
      headline: 'Three releases and one advisory landed overnight.',
      series_ref: 'artifact-series:abcdef123456',
      version: 7,
      generated_at: Date.now() - HOUR,
    },
    cost: { amount_usd: 0.42, window_label: 'today' },
    generated_at: Date.now(),
    ...overrides,
  };
}

type StubOptions = {
  queue?: Record<string, unknown>;
  history?: Record<string, unknown>;
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
      return Promise.resolve(jsonResponse(options.history ?? {
        available: true,
        candidate_id: 'cand-1',
        revisions: [],
        decisions: [],
        comments: [],
        occurrences: [
          { id: 'occ-1', revision_id: 'rev-cand-1', digest_version: 7, batch_key: 'b', seen_at: Date.now() - HOUR },
        ],
      }));
    }
    if (url.includes('/decision') && method === 'POST') {
      if (options.decisionStatus && options.decisionStatus >= 400) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'read-only instance' }), {
          status: options.decisionStatus,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.resolve(jsonResponse({ ok: true, id: 'dec-1' }));
    }
    if (url.includes('/comments') && method === 'POST') {
      return Promise.resolve(jsonResponse({ ok: true, comment_id: 'com-1' }));
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
    stubFetch({
      queue: makeQueue({
        items: [makeItem({ candidate_id: 'cand-1' })],
      }),
    });
    // Rewrite the refs of the single item to a hostile value.
    const queue = makeQueue();
    (queue.items as Record<string, unknown>[])[0] = makeItem({
      candidate_id: 'cand-1',
      revision: {
        ...(makeItem().revision as Record<string, unknown>),
        refs: ['javascript:alert(1)'],
        source_ref: 'javascript:alert(1)',
      },
    });
    cleanup();
    vi.unstubAllGlobals();
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
  it('derives status from batch facts only', () => {
    const now = 1_000_000_000_000;
    expect(deriveBriefingSourceStatus(now - HOUR, 'ok', now)).toBe('current');
    expect(deriveBriefingSourceStatus(now - 48 * HOUR, 'ok', now)).toBe('stale');
    expect(deriveBriefingSourceStatus(now - HOUR, 'failed', now)).toBe('failed');
    expect(deriveBriefingSourceStatus(null, null, now)).toBe('unknown');
  });

  it('summarizes only as healthy when every source is current', () => {
    const now = Date.now();
    const queue = normalizeBriefingQueue({
      items: [],
      sources: [makeSource(), makeSource({ source: 'rss', status: undefined, last_run_status: 'failed' })],
    }, now);
    const summary = summarizeBriefingHealth(queue.sources);
    expect(summary.failed).toBe(1);
    expect(summary.healthy).toBe(false);
    expect(summarizeBriefingHealth([]).healthy).toBe(false);
  });

  it('parses a refs_json string and defaults an absent envelope honestly', () => {
    const queue = normalizeBriefingQueue({
      items: [{
        candidate_id: 'c1',
        source: 's',
        revision: { id: 'r1', title: 't', why_notable: 'w', refs_json: '["https://a.example"]' },
      }],
    });
    expect(queue.available).toBe(true);
    expect(queue.items[0].revision.refs).toEqual(['https://a.example']);
    expect(queue.digest).toBeNull();
    expect(queue.cost).toBeNull();
    expect(queue.total_pending).toBe(1);
  });
});

describe('BriefingView page composition', () => {
  it('puts deterministic health above the labelled agent-generated headline', async () => {
    stubFetch();
    renderBriefing();

    const health = await screen.findByTestId('briefing-health');
    await waitFor(() => {
      expect(health.dataset.healthState).toBe('healthy');
    });
    const digest = screen.getByTestId('briefing-digest');
    expect(health.compareDocumentPosition(digest) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(digest).getByText('Agent-generated summary')).toBeTruthy();
    // Compact when healthy: no per-source rows rendered.
    expect(within(health).queryByText(/last ingest/)).toBeNull();
  });

  it('auto-expands the health strip when a source failed', async () => {
    stubFetch({
      queue: makeQueue({
        sources: [makeSource(), makeSource({ source: 'rss', status: 'failed', last_run_status: 'failed' })],
      }),
    });
    renderBriefing();

    const health = await screen.findByTestId('briefing-health');
    await waitFor(() => {
      expect(health.dataset.healthState).toBe('failed');
    });
    expect(within(health).getByText('1 failed')).toBeTruthy();
    expect(within(health).getAllByText(/last ingest/).length).toBe(2);
  });

  it('groups rows by source with a title, source chip, age, and one-sentence rationale', async () => {
    stubFetch({
      queue: makeQueue({
        items: [
          makeItem({ candidate_id: 'a' }),
          makeItem({ candidate_id: 'b', source: 'rss' }),
        ],
        total_pending: 2,
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
    const items = Array.from({ length: BRIEFING_VISIBLE_LIMIT + 4 }, (_unused, index) =>
      makeItem({ candidate_id: `c${index}` }));
    stubFetch({ queue: makeQueue({ items, total_pending: items.length }) });
    renderBriefing();

    const note = await screen.findByTestId('briefing-truncation');
    expect(note.textContent).toContain('4 more pending');
    expect(screen.getAllByTestId(/^briefing-row-/).length).toBe(BRIEFING_VISIBLE_LIMIT);
  });
});

describe('BriefingView empty states', () => {
  it('renders an empty-and-healthy briefing as a success', async () => {
    stubFetch({ queue: makeQueue({ items: [], total_pending: 0 }) });
    renderBriefing();

    expect(await screen.findByTestId('briefing-empty-healthy')).toBeTruthy();
    expect(screen.queryByTestId('briefing-empty-degraded')).toBeNull();
  });

  it('never presents an empty queue as clean when a collector failed', async () => {
    stubFetch({
      queue: makeQueue({
        items: [],
        total_pending: 0,
        sources: [makeSource({ status: 'failed', last_run_status: 'failed' })],
      }),
    });
    renderBriefing();

    const degraded = await screen.findByTestId('briefing-empty-degraded');
    expect(degraded.textContent).toContain('not clean');
    expect(degraded.textContent).toContain('does not mean there was nothing to find');
    expect(screen.queryByTestId('briefing-empty-healthy')).toBeNull();
  });

  it('distinguishes an unavailable queue from an empty one', async () => {
    stubFetch({
      queue: { available: false, reason: 'briefing routes are not deployed', items: [], sources: [] },
    });
    renderBriefing();

    const notice = await screen.findByTestId('briefing-unavailable');
    expect(notice.textContent).toContain('briefing routes are not deployed');
  });
});

describe('BriefingView keyboard triage', () => {
  it('processes the queue with the keyboard only and offers immediate undo', async () => {
    const { calls } = stubFetch({
      queue: makeQueue({
        items: [makeItem({ candidate_id: 'a' }), makeItem({ candidate_id: 'b' })],
        total_pending: 2,
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
