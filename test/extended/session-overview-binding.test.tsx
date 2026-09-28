// Issue f59b5bd (review S1/C4) — Session Overview page binding contract:
// the page-supplied agent_session binding is display-only and must NEVER be
// sent as mutation input, and a truncated resolver result is never auto-bound
// as a unique match.
import { render, screen, cleanup, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetBrowserSessionForTests } from '../../ui/src/client-auth-token';
import { SessionOverviewView } from '../../ui/src/views/session-overview';

const PAGE_BINDING = 'aaaabbbb';
const FULL_ID = 'aaaabbbb-1111-2222-3333-444455556666';
const REGISTERED_ID = `codex-${FULL_ID}`;

const conversationOnlyMatch = {
  matched_ref: FULL_ID,
  provider: 'codex',
  mandible_session_id: null,
  console_session_id: null,
  conversation_id: 'conv-1',
  sources: ['conversations'],
};

const boundMatch = {
  matched_ref: FULL_ID,
  provider: 'codex',
  mandible_session_id: REGISTERED_ID,
  console_session_id: null,
  conversation_id: 'conv-1',
  sources: ['sessions', 'conversations'],
};

const providerScopedOverview = {
  as_of: 1_700_000_000_000,
  binding: { kind: 'provider-scoped', provider: 'codex', provider_session_id: FULL_ID },
  session: { available: false, reason: 'no Mandible session row for this provider session id' },
  children: {
    available: false,
    reason: 'child-session tracking requires a Mandible session row',
    items: [],
    truncated: false,
    depth_limit: 5,
    count_limit: 200,
  },
  linked_issues: { available: true, source: 'work_units', note: 'derived', items: [] },
  work_units: {
    available: true,
    includes_descendants: false,
    matched_provider_aliases: [FULL_ID],
    items: [],
  },
  conversations: { available: true, limit: 20, items: [] },
};

const boundOverview = {
  as_of: 1_700_000_000_000,
  session: { id: REGISTERED_ID, status: 'active', app: 'codex', created_at: 1_700_000_000_000 },
  children: { available: true, items: [], truncated: false, depth_limit: 5, count_limit: 200 },
  linked_issues: { available: true, source: 'ledger_session_issue_links', items: [] },
  work_units: {
    available: true,
    includes_descendants: true,
    matched_provider_aliases: [],
    items: [],
  },
  conversations: { available: true, limit: 20, items: [] },
};

type FetchCall = { url: string; method: string; body: unknown };

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(options: { registered: { value: boolean } }): { calls: FetchCall[] } {
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

    if (url === '/api/client-auth/whoami') {
      return Promise.resolve(jsonResponse({ authenticated: true, session: {
        family_id: 'session-overview-test', audience: 'production', csrf_token: 'csrf',
      } }));
    }
    if (url.startsWith('/api/sessions/resolve')) {
      return Promise.resolve(jsonResponse({
        provider: null,
        provider_session_id: PAGE_BINDING,
        truncated: false,
        matches: [options.registered.value ? boundMatch : conversationOnlyMatch],
      }));
    }
    if (url.startsWith('/api/sessions/overview/by-provider')) {
      return Promise.resolve(jsonResponse(providerScopedOverview));
    }
    if (url === '/api/sessions/register-provider' && method === 'POST') {
      options.registered.value = true;
      return Promise.resolve(jsonResponse({ id: REGISTERED_ID, provider: 'codex' }));
    }
    if (url.startsWith(`/api/sessions/${encodeURIComponent(REGISTERED_ID)}/overview`)) {
      return Promise.resolve(jsonResponse(boundOverview));
    }
    return Promise.reject(new Error(`unexpected fetch ${method} ${url}`));
  }));
  return { calls };
}

beforeEach(() => {
  __resetBrowserSessionForTests();
  window.history.replaceState(null, '', '/#/overview');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetBrowserSessionForTests();
});

describe('SessionOverviewView provider-scoped binding', () => {
  it('renders useful provider data without asking the viewer to create a session row', async () => {
    const registered = { value: false };
    const { calls } = stubFetch({ registered });

    render(
      <SessionOverviewView
        initialSessionId={null}
        agentBinding={PAGE_BINDING}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Linked issues')).toBeTruthy();
    });
    expect(screen.queryByText(/not registered as a Mandible session/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Register as Mandible session' })).toBeNull();
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it.each([
    { binding: 'provider-scoped', registered: false },
    { binding: 'registered', registered: true },
  ])('does not repeat the session id as an embedded $binding heading', async ({ registered }) => {
    const registration = { value: registered };
    stubFetch({ registered: registration });
    const { container } = render(
      <SessionOverviewView
        initialSessionId={null}
        agentBinding={PAGE_BINDING}
        embedded
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Linked issues')).toBeTruthy();
    });
    const overview = container.querySelector('.session-overview--embedded');
    expect(overview?.querySelector('h3')).toBeNull();
    if (registered) {
      expect(screen.getByText('active').className).toContain('session-overview-badge');
    }
  });
});

describe('SessionOverviewView truncated resolution (review C4)', () => {
  it('never auto-binds a single match from a truncated scan', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/client-auth/whoami') {
        return Promise.resolve(jsonResponse({ authenticated: true, session: { csrf_token: 'csrf' } }));
      }
      if (url.startsWith('/api/sessions/resolve')) {
        return Promise.resolve(jsonResponse({
          provider: null,
          provider_session_id: PAGE_BINDING,
          truncated: true,
          matches: [boundMatch],
        }));
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(
      <SessionOverviewView
        initialSessionId={null}
        agentBinding={PAGE_BINDING}
      />,
    );

    expect(
      await screen.findByText(/matches too many identities to resolve uniquely/),
    ).toBeTruthy();
    expect(screen.queryByText(/Bound to agent session/)).toBeNull();
    expect(screen.queryByRole('list', { name: 'Session picker' })).toBeNull();
  });

  it('shows only distinguishable competing matches, never the global session registry', async () => {
    const first = {
      ...boundMatch,
      mandible_session_id: FULL_ID,
    };
    const competing = {
      ...boundMatch,
      matched_ref: 'aaaabbbb-1111-2222-3333-999955556666',
      mandible_session_id: 'aaaabbbb-1111-2222-3333-999955556666',
      conversation_id: 'conv-2',
    };
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/client-auth/whoami') {
        return Promise.resolve(jsonResponse({ authenticated: true, session: { csrf_token: 'csrf' } }));
      }
      if (url.startsWith('/api/sessions/resolve')) {
        return Promise.resolve(jsonResponse({
          provider: null,
          provider_session_id: PAGE_BINDING,
          truncated: false,
          matches: [first, competing],
        }));
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    render(
      <SessionOverviewView
        initialSessionId={null}
        agentBinding={PAGE_BINDING}
      />,
    );

    expect(await screen.findByText(/matches multiple Mandible sessions/)).toBeTruthy();
    const matchList = screen.getByRole('list', { name: 'Agent session matches' });
    expect(matchList.querySelectorAll('li')).toHaveLength(2);
    expect(screen.queryByRole('list', { name: 'Session picker' })).toBeNull();
    expect(screen.getByText('aaaabbbb-1111-2222-3333-4…')).toBeTruthy();
    expect(screen.getByText('aaaabbbb-1111-2222-3333-9…')).toBeTruthy();
  });
});
