// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from './helpers/dom.js';
import { render } from './helpers/notice-test-render';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiError, getSessionOverview, type SessionOverview } from '../ui/src/api';
import { SessionOverviewView } from '../ui/src/views/session-overview';

vi.mock('../ui/src/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../ui/src/api')>(),
  getSessionOverview: vi.fn(),
  getSessions: vi.fn(async () => []),
}));

function overview(id: string): SessionOverview {
  return {
    status: 'resolved', as_of: 1,
    session: {
      id, title: `Session ${id}`, provider: 'codex', provider_session_id: id,
      conversation_id: null, liveness: 'stopped', agent: null, cwd: null, branch: null,
      started_at: null, ended_at: null, last_activity: null, process: null,
    },
    children: { items: [], truncated: false, depth_limit: 4, count_limit: 100 },
    linked_issues: { items: [] }, work_units: { items: [], includes_descendants: true },
    conversations: { items: [], limit: 100 },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => { cleanup(); vi.resetAllMocks(); window.history.replaceState(null, '', '/'); });

it('keeps missing and failed replacement distinct from the previous resolved session', async () => {
  vi.mocked(getSessionOverview).mockImplementation(async (ref) => {
    if (ref === 'missing') throw new ApiError('missing', 404);
    if (ref === 'failed') throw new ApiError('lookup failed', 500);
    return overview(ref);
  });
  const view = render(<SessionOverviewView initialSessionId="A" agentBinding="bound" />);
  await screen.findByText('Session A');
  view.rerender(<SessionOverviewView initialSessionId="missing" agentBinding="bound" />);
  await screen.findByText('missing', { selector: 'code' });
  expect(screen.queryByText('Session A')).toBeNull();
  view.rerender(<SessionOverviewView initialSessionId="failed" agentBinding="bound" />);
  await screen.findByText('lookup failed');
  expect(screen.queryByText('Session A')).toBeNull();
});

it('hides prior detail during mounted replacement, ignores late results and retains same-target refresh content', async () => {
  const b = deferred<SessionOverview>();
  const cRefresh = deferred<SessionOverview>();
  let cReads = 0;
  vi.mocked(getSessionOverview).mockImplementation(async (ref) => {
    if (ref === 'B') return b.promise;
    if (ref === 'C' && cReads++ > 0) return cRefresh.promise;
    return overview(ref);
  });
  const view = render(<SessionOverviewView initialSessionId="A" agentBinding="bound" />);
  await screen.findByText('Session A');
  view.rerender(<SessionOverviewView initialSessionId="B" agentBinding="bound" />);
  expect(screen.queryByText('Session A')).toBeNull();
  await waitFor(() => expect(getSessionOverview).toHaveBeenCalledWith('B'));
  view.rerender(<SessionOverviewView initialSessionId="C" agentBinding="bound" />);
  await screen.findByText('Session C');
  await act(async () => b.resolve(overview('B')));
  expect(screen.queryByText('Session B')).toBeNull();
  expect(screen.getByText('Session C')).toBeTruthy();
  fireEvent(window, new Event('focus'));
  await waitFor(() => expect(cReads).toBe(2));
  expect(screen.getByText('Session C')).toBeTruthy();
  await act(async () => cRefresh.resolve(overview('C')));
  expect(getSessionOverview).not.toHaveBeenCalledWith('bound');
});

it('shows ambiguity for the current explicit target and preserves context on a deliberate candidate choice', async () => {
  vi.mocked(getSessionOverview).mockImplementation(async (ref) => ref === 'amb'
    ? { status: 'ambiguous', as_of: 1, truncated: false, candidates: [overview('candidate').session] }
    : overview(ref));
  window.history.replaceState(null, '', '#/overview?session=amb&sidebar=hidden&agent_session=bound&sentinel=a%26b%2Bc');
  render(<SessionOverviewView initialSessionId="amb" agentBinding="bound" />);
  fireEvent.click(await screen.findByRole('button', { name: /candidate/ }));
  await screen.findByText('Session candidate');
  const params = new URLSearchParams(window.location.hash.split('?')[1]);
  expect(params.get('session')).toBe('candidate');
  expect(params.get('sidebar')).toBe('hidden');
  expect(params.get('agent_session')).toBe('bound');
  expect(params.get('sentinel')).toBe('a&b+c');
});
