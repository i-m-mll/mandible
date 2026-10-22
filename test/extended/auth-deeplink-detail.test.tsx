import { establishTestClientAccess } from '../helpers/local-client-access';
// Bug: 2cddba2 — a deep-link (`#/auth?request=<id>`) to a resolved/archived
// request outside the loaded queue/history lists must fetch the request from
// the by-id detail route and render the detail pane from that record, with an
// honest not-found state for invalid ids, instead of falling through to the
// empty-view placeholder (or having the sidebar
// reconciliation effect steal the selection).
import { act, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { useEffect, useState } from 'preact/hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetBrowserSessionForTests } from '../../ui/src/client-auth-token';
import { authMainInstance, bindAuthUiOperations } from '../helpers/auth-ui-fixture';

import { AuthQueueView, type AuthRequest } from '../../ui/src/views/auth';
import { parseRouteFromHash, replaceRouteHash, routeHashWithParams } from '../../ui/src/routing';

// jsdom in this build ships a localStorage stub whose setItem throws; install a
// working in-memory localStorage so the sidebar-width persistence round-trips.
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
}

const REMOTE_ID = 'req-remote-0123456789abcdef';

// Shape of the GET /api/auth/request/:id payload (src/routes/auth.ts) for a
// completed merge that is no longer in the loaded history slice.
const remoteDetailPayload = {
  request_id: REMOTE_ID,
  type: 'merge',
  status: 'completed',
  output: 'merge output',
  exit_code: 0,
  error: null,
  title: 'Archived merge: feature/old-branch',
  created_at: 1_700_000_000_000,
  last_executed_at: 1_700_000_100_000,
  resolved_at: 1_700_000_100_000,
  repo: 'mandible',
  base_branch: 'main',
  head_branch: 'feature/old-branch',
  files_changed: 1,
  additions: 2,
  deletions: 1,
  diff_summary: null,
  commit_message: 'Merge feature/old-branch',
  spec_content: null,
  action_count: 0,
  actions: [],
};

const pendingRequest: AuthRequest = {
  id: 'req-active-1',
  type: 'merge',
  title: 'Self-merge: feature/x',
  repo: 'mandible',
  head_branch: 'feature/x',
  base_branch: 'main',
  status: 'pending',
  commit_message: 'Merge feature/x',
  created_at: 1,
  updated_at: 1,
  actions: [],
};

function stubFetchWithDetailRoute(handler: (id: string) => Response | Promise<Response> | null): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const match = url.match(/^\/api\/auth\/request\/([^/]+)$/);
    if (match) {
      const response = handler(decodeURIComponent(match[1]));
      if (response) return Promise.resolve(response);
    }
    // Everything else (auto-approve status probe, etc.) stays offline.
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function ControlledAuthView({ queue, route, onSelect = () => undefined, propagateSelection = true, onNavigate }: {
  queue: AuthRequest[];
  route?: string;
  onSelect?: (id: string | null) => void;
  propagateSelection?: boolean;
  onNavigate?: (id: string | null) => void;
}) {
  const [selected, setSelected] = useState<string | null>(pendingRequest.id!);
  return (
    <AuthQueueView
      instance={authMainInstance}
      queue={queue}
      historyQueue={[]}
      outputs={{}}
      initialRequestId={route}
      selectedAuthId={selected}
      onSelectAuth={(id) => { onSelect(id); if (propagateSelection) setSelected(id); }}
      onNavigateRequest={onNavigate}
      daemonReady={true}
      onApprove={() => undefined}
      onReject={() => undefined}
      onRetry={() => undefined}
      onDismiss={() => undefined}
    />
  );
}

function renderDeepLinkedView(queue: AuthRequest[], initialRequestId: string) {
  return render(<ControlledAuthView queue={queue} route={initialRequestId} />);
}

function RoutedAuthView({ queue }: { queue: AuthRequest[] }) {
  const [route, setRoute] = useState(() => parseRouteFromHash(window.location.hash));
  useEffect(() => {
    const readRoute = () => setRoute(parseRouteFromHash(window.location.hash));
    window.addEventListener('hashchange', readRoute);
    return () => window.removeEventListener('hashchange', readRoute);
  }, []);
  return <ControlledAuthView queue={queue} route={route.params.request} onNavigate={(id) => {
    replaceRouteHash(routeHashWithParams(window.location.hash, 'auth', { request: id }));
  }} />;
}

beforeEach(async () => {
  await establishTestClientAccess();
  bindAuthUiOperations();
  installMemoryLocalStorage();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  __resetBrowserSessionForTests();
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '#/auth');
});

describe('AuthQueueView deep-linked request outside loaded lists', () => {
  it('updates route identity for a row choice, preserves context, and restores that choice on refresh', async () => {
    stubFetchWithDetailRoute(() => new Response(JSON.stringify(remoteDetailPayload), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const chosen = { ...pendingRequest, id: 'req-chosen', title: 'Chosen request C' };
    window.history.replaceState(null, '', `#/auth?request=${REMOTE_ID}&sidebar=hidden&agent_session=agent1&opaque=keep`);
    const view = render(<RoutedAuthView queue={[pendingRequest, chosen]} />);
    expect(await screen.findByText(remoteDetailPayload.title)).toBeTruthy();
    fireEvent.click(screen.getByText(chosen.title));
    await waitFor(() => expect(parseRouteFromHash(window.location.hash).params).toEqual({ request: chosen.id, sidebar: 'hidden', agent_session: 'agent1', opaque: 'keep' }));
    view.unmount();
    render(<RoutedAuthView queue={[pendingRequest, chosen]} />);
    await waitFor(() => expect(screen.getAllByText(chosen.title)).toHaveLength(2));
  });

  it('clears route identity for a filter choice without losing navigation context', async () => {
    stubFetchWithDetailRoute(() => new Response(JSON.stringify(remoteDetailPayload), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    window.history.replaceState(null, '', `#/auth?request=${REMOTE_ID}&sidebar=hidden&agent_session=agent1&opaque=keep`);
    render(<RoutedAuthView queue={[pendingRequest]} />);
    expect(await screen.findByText(remoteDetailPayload.title)).toBeTruthy();
    fireEvent.input(screen.getByRole('textbox', { name: 'Search approval requests' }), { target: { value: 'Self-merge' } });
    await waitFor(() => expect(parseRouteFromHash(window.location.hash).params).toEqual({ sidebar: 'hidden', agent_session: 'agent1', opaque: 'keep' }));
    expect(screen.getAllByText(pendingRequest.title!)).toHaveLength(2);
  });

  it('selects the linked loaded row even when another row is first', async () => {
    stubFetchWithDetailRoute(() => null);
    const linked = { ...pendingRequest, id: 'req-linked', title: 'Linked loaded request' };
    renderDeepLinkedView([pendingRequest, linked], linked.id!);
    await waitFor(() => expect(screen.getAllByText(linked.title)).toHaveLength(2));
    expect(screen.getAllByText(pendingRequest.title!)).toHaveLength(1);
  });

  it('falls back to the first visible row when saved selection is missing and there is no route', async () => {
    stubFetchWithDetailRoute(() => new Response('{}', { status: 404 }));
    const first = { ...pendingRequest, id: 'req-first', title: 'First visible request' };
    render(<ControlledAuthView queue={[first]} />);
    await waitFor(() => expect(screen.getAllByText(first.title)).toHaveLength(2));
  });

  it('preserves saved selection without a route and accepts an explicit row action', async () => {
    stubFetchWithDetailRoute(() => null);
    const other = { ...pendingRequest, id: 'req-other', title: 'Other pending request' };
    render(<ControlledAuthView queue={[other, pendingRequest]} />);
    await waitFor(() => expect(screen.getAllByText(pendingRequest.title!)).toHaveLength(2));
    fireEvent.click(screen.getByText(other.title));
    await waitFor(() => expect(screen.getAllByText(other.title)).toHaveLength(2));
  });

  it('rejects a stale resolution after newer navigation and keeps the new detail across refetch', async () => {
    let resolveOld!: (response: Response) => void;
    stubFetchWithDetailRoute((id) => id === 'old-link'
      ? new Promise<Response>((resolve) => { resolveOld = resolve; })
      : new Response(JSON.stringify(remoteDetailPayload), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const view = render(<ControlledAuthView queue={[pendingRequest]} route="old-link" />);
    await waitFor(() => expect(resolveOld).toBeTypeOf('function'));
    view.rerender(<ControlledAuthView queue={[pendingRequest]} route={REMOTE_ID} />);
    expect(await screen.findByText(remoteDetailPayload.title)).toBeTruthy();
    await act(async () => {
      resolveOld(new Response(JSON.stringify({ ...remoteDetailPayload, request_id: 'old-link-full', title: 'Stale detail' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });
    view.rerender(<ControlledAuthView queue={[{ ...pendingRequest }]} route={REMOTE_ID} />);
    await waitFor(() => expect(screen.queryByText('Stale detail')).toBeNull());
    expect(screen.getByText(remoteDetailPayload.title)).toBeTruthy();
    fireEvent.click(screen.getByText(pendingRequest.title!));
    await waitFor(() => expect(screen.getAllByText(pendingRequest.title!)).toHaveLength(2));
  });

  it('does not restore a resolving route after the user picks a row', async () => {
    let resolveDetail!: (response: Response) => void;
    stubFetchWithDetailRoute(() => new Promise<Response>((resolve) => { resolveDetail = resolve; }));
    renderDeepLinkedView([pendingRequest], REMOTE_ID);
    await waitFor(() => expect(resolveDetail).toBeTypeOf('function'));
    fireEvent.click(screen.getByText(pendingRequest.title!));
    await act(async () => { resolveDetail(new Response(JSON.stringify(remoteDetailPayload), { status: 200, headers: { 'Content-Type': 'application/json' } })); });
    await waitFor(() => expect(screen.getAllByText(pendingRequest.title!)).toHaveLength(2));
    expect(screen.queryByText(remoteDetailPayload.title)).toBeNull();
  });

  it('allows a deliberate filter action to replace the linked detail', async () => {
    stubFetchWithDetailRoute(() => new Response(JSON.stringify(remoteDetailPayload), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    renderDeepLinkedView([pendingRequest], REMOTE_ID);
    expect(await screen.findByText(remoteDetailPayload.title)).toBeTruthy();
    fireEvent.input(screen.getByRole('textbox', { name: 'Search approval requests' }), { target: { value: 'Self-merge' } });
    await waitFor(() => expect(screen.getAllByText(pendingRequest.title!)).toHaveLength(2));
  });

  it('fetches the request from the detail route and renders the detail pane', async () => {
    const fetchMock = stubFetchWithDetailRoute((id) =>
      id === REMOTE_ID
        ? new Response(JSON.stringify(remoteDetailPayload), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        : null,
    );

    renderDeepLinkedView([], REMOTE_ID);

    expect(await screen.findByText(/Archived merge: feature\/old-branch/)).toBeTruthy();
    expect(screen.queryByText('No requests in this view')).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/auth/request/${encodeURIComponent(REMOTE_ID)}`,
      expect.anything(),
    );
  });

  it('keeps the deep-linked selection when the sidebar has other rows', async () => {
    stubFetchWithDetailRoute((id) =>
      id === REMOTE_ID
        ? new Response(JSON.stringify(remoteDetailPayload), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        : null,
    );

    renderDeepLinkedView([pendingRequest], REMOTE_ID);

    expect(screen.getAllByText(pendingRequest.title!)).toHaveLength(1);

    // The fetched request renders in the detail pane; the sidebar row is not
    // promoted over the deep-linked selection.
    expect(await screen.findByText(/Archived merge: feature\/old-branch/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('shows an honest not-found state for an invalid deep-linked id', async () => {
    stubFetchWithDetailRoute(() =>
      new Response(JSON.stringify({ error: 'Auth request not found.' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    renderDeepLinkedView([], 'req-nonexistent');

    expect(await screen.findByText(/Approval request req-none was not found/)).toBeTruthy();
    expect(screen.queryByText('No requests in this view')).toBeNull();
  });
});

// Issue f59b5bd — deep links carry the 8-char short form; the view
// canonicalizes every shortened id through the detail route (which resolves
// unambiguous prefixes and 409s ambiguous ones) and only then uses loaded
// records, keyed by the canonical full id.
describe('AuthQueueView short-form request params', () => {
  const fullId = 'e4c52737-40e4-472a-8367-fbdbe97801a2';
  const uuidRequest: AuthRequest = {
    ...pendingRequest,
    id: fullId,
    // Carry the body fields so selection does not trigger body hydration.
    diff_summary: '',
    spec_content: '',
    output: '',
  };

  it('holds a non-first linked row through canonicalization while controlled selection is still saved A', async () => {
    stubFetchWithDetailRoute(() => new Response(JSON.stringify({ ...remoteDetailPayload, request_id: fullId, title: 'Linked request B' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const linked = { ...uuidRequest, title: 'Linked request B' };
    const onSelect = vi.fn();
    const view = render(<ControlledAuthView queue={[pendingRequest, linked]} route={fullId.slice(0, 8)} onSelect={onSelect} propagateSelection={false} />);
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(fullId));
    expect(screen.getAllByText(linked.title)).toHaveLength(2);
    expect(onSelect).not.toHaveBeenCalledWith(pendingRequest.id);
    view.rerender(<ControlledAuthView queue={[{ ...pendingRequest }, { ...linked }]} route={fullId.slice(0, 8)} onSelect={onSelect} propagateSelection={false} />);
    expect(screen.getAllByText(linked.title)).toHaveLength(2);
  });

  // Review C1 — a loaded-list prefix match must NOT bypass the server
  // uniqueness check: the short id always canonicalizes via the detail route.
  it('canonicalizes a short id through the detail route even when a loaded row matches', async () => {
    const fetchMock = stubFetchWithDetailRoute((id) =>
      fullId.startsWith(id)
        ? new Response(
            JSON.stringify({ ...remoteDetailPayload, request_id: fullId, title: uuidRequest.title }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        : null,
    );

    renderDeepLinkedView([uuidRequest], fullId.slice(0, 8));

    // Title renders in the sidebar row AND the detail pane once the fetched
    // canonical id upgrades the selection.
    await waitFor(() => {
      expect(screen.getAllByText(/Self-merge: feature\/x/).length).toBeGreaterThan(1);
    });
    expect(screen.queryByText('No requests in this view')).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/auth/request/${encodeURIComponent(fullId.slice(0, 8))}`,
      expect.anything(),
    );
  });

  // Review C1 (named failure scenario) — one loaded request matches the
  // prefix, but a second request outside the loaded slice collides: the
  // server 409 must win and no silent wrong selection may happen.
  it('honors a server 409 over a loaded-list prefix match (one loaded, one unloaded)', async () => {
    stubFetchWithDetailRoute(() =>
      new Response(
        JSON.stringify({ error: "Ambiguous prefix 'e4c52737' — matches 2 requests." }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    renderDeepLinkedView([uuidRequest], fullId.slice(0, 8));

    expect(await screen.findByText(/is ambiguous — it matches multiple requests/)).toBeTruthy();
    // The loaded row was NOT silently selected into the detail pane: its
    // title appears only once (the sidebar row), never in the detail header.
    expect(screen.getAllByText(/Self-merge: feature\/x/)).toHaveLength(1);
  });

  // Review D2 — the deep-linked row scrolls into view only after the short
  // selection upgrades to the canonical full id the rows are keyed by.
  it('scrolls the sidebar row into view after the canonical-id upgrade', async () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    stubFetchWithDetailRoute((id) =>
      fullId.startsWith(id)
        ? new Response(
            JSON.stringify({ ...remoteDetailPayload, request_id: fullId, title: uuidRequest.title }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        : null,
    );

    renderDeepLinkedView([uuidRequest], fullId.slice(0, 8));

    await waitFor(() => {
      expect(scrollSpy).toHaveBeenCalled();
    }, { timeout: 3000 });
    const scrolled = scrollSpy.mock.instances[0] as Element;
    expect(scrolled.getAttribute('data-request-id')).toBe(fullId);
  });

  // Review D1 — a non-404/409 failure renders an explicit error state with a
  // retry affordance instead of an eternal "Loading request…".
  it('shows an error state with retry for a failed detail fetch', async () => {
    let failing = true;
    stubFetchWithDetailRoute(() =>
      failing
        ? new Response(JSON.stringify({ error: 'daemon rebuilding' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          })
        : new Response(JSON.stringify(remoteDetailPayload), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
    );

    renderDeepLinkedView([], REMOTE_ID);

    expect(await screen.findByText(/Failed to load approval request/)).toBeTruthy();
    expect(screen.queryByText('Loading request…')).toBeNull();

    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText(/Archived merge: feature\/old-branch/)).toBeTruthy();
  });

  it('fetches a short id outside the loaded lists from the detail route', async () => {
    const shortId = REMOTE_ID.slice(0, 8);
    const fetchMock = stubFetchWithDetailRoute((id) =>
      REMOTE_ID.startsWith(id)
        ? new Response(JSON.stringify(remoteDetailPayload), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        : null,
    );

    renderDeepLinkedView([], shortId);

    expect(await screen.findByText(/Archived merge: feature\/old-branch/)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/auth/request/${encodeURIComponent(shortId)}`,
      expect.anything(),
    );
  });

  it('shows an honest ambiguity state for a prefix matching multiple requests', async () => {
    stubFetchWithDetailRoute(() =>
      new Response(JSON.stringify({ error: "Ambiguous prefix 'req-ambi' — matches 2 requests." }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    renderDeepLinkedView([], 'req-ambiguous-prefix');

    expect(await screen.findByText(/is ambiguous — it matches multiple requests/)).toBeTruthy();
    expect(screen.queryByText('No requests in this view')).toBeNull();
  });
});
