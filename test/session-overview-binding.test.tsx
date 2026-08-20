// Issue f59b5bd (review S1/C4) — Session Overview page binding contract:
// the page-supplied agent_session binding is display-only and must NEVER be
// sent as mutation input. The "Register as Mandible session" action posts
// only the server-resolved full identity from the match record, and a
// truncated resolver result is never auto-bound as a unique match.
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionOverviewView } from '../ui/src/views/session-overview';

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
  window.history.replaceState(null, '', '/#/overview');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SessionOverviewView register action (review S1)', () => {
  it('sends only the server-resolved identity — never the page binding — as mutation input', async () => {
    const registered = { value: false };
    const { calls } = stubFetch({ registered });

    render(
      <SessionOverviewView
        initialSessionId={null}
        agentBinding={PAGE_BINDING}
      />,
    );

    const registerButton = await screen.findByRole('button', {
      name: 'Register as Mandible session',
    });
    fireEvent.click(registerButton);

    await waitFor(() => {
      expect(calls.some((call) => call.url === '/api/sessions/register-provider')).toBe(true);
    });

    // The registration mutation carries ONLY the server-resolved full
    // identity from the match record.
    const registerCall = calls.find((call) => call.url === '/api/sessions/register-provider');
    expect(registerCall?.method).toBe('POST');
    expect(registerCall?.body).toEqual({ provider_session_id: FULL_ID });

    // The forgeable page-binding value itself never appears as a field in ANY
    // mutation request body (the full id legitimately shares its prefix; the
    // exact-shape assertion above already pins the register payload).
    for (const call of calls) {
      if (call.method === 'GET') continue;
      const values = call.body && typeof call.body === 'object'
        ? Object.values(call.body as Record<string, unknown>)
        : [call.body];
      expect(values).not.toContain(PAGE_BINDING);
    }

    // The view upgrades in place to the bound state after registration.
    await waitFor(() => {
      expect(screen.getByText(/Bound to agent session/)).toBeTruthy();
    });
  });
});

describe('SessionOverviewView truncated resolution (review C4)', () => {
  it('never auto-binds a single match from a truncated scan', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
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
  });
});
