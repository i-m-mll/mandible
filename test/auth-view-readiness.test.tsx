// @vitest-environment jsdom
import { useLayoutEffect } from 'preact/hooks';
import * as ScrollPersistence from '../ui/src/hooks/usePersistedScrollPosition';
import { establishTestClientAccess } from './helpers/local-client-access';
// Bug: 645f8a8 — auth view mutation gate. While the daemon is not ready
// (rebuilding / starting), the Approve button must be disabled and NO approval
// action may fire. Once ready, Approve works normally.
import { act, screen, cleanup, fireEvent, waitFor, within } from './helpers/dom.js';
import { render } from './helpers/notice-test-render';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { authMainInstance, bindAuthUiOperations } from './helpers/auth-ui-fixture';

import { AuthQueueView, type AuthRequest } from '../ui/src/views/auth';
import { CollapsiblePanel, type CollapsiblePanelAvailability } from '../ui/src/components/shared/CollapsiblePanel';
import { usePersistedViewState } from '../ui/src/hooks/usePersistedViewState';
import { AuthChangeBreakdown } from '../ui/src/views/AuthChangeBreakdown';
import type { AuthChangeReport } from '../src/contracts';
import type { AuthRequestAction, InstanceInfo } from '../ui/src/api';
import { __resetBrowserSessionForTests } from '../ui/src/client-auth-token';

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

const pendingRequest: AuthRequest = {
  id: 'req-1',
  type: 'merge',
  title: 'Self-merge: feature/x',
  repo: 'mandible',
  head_branch: 'feature/x',
  base_branch: 'main',
  status: 'pending',
  command: 'mandible auth merge main',
  commit_message: 'Merge feature/x',
  created_at: 1,
  updated_at: 1,
  actions: [],
  requested_by_user_id: 'agent-1',
  requester_evidence_method: 'api_token',
  requester_credential_id: 'credential-1234567890',
  issue_references: ['issue-1'],
};

const deferredAction: AuthRequestAction = {
  id: 'action-1',
  auth_request_id: 'req-1',
  ordinal: 0,
  kind: 'comment_add',
  state: 'staged',
  target_issue_ref: 'issue-1',
  target_digest: null,
  payload: { body: 'Persist this expanded action detail.' },
  staged_at: 1,
  updated_at: 1,
  applied_at: null,
  outcome_detail: 'Expanded action detail',
};

const previewInstance: InstanceInfo = {
  ...authMainInstance,
  role: 'preview',
  instance_id: 'auth-ui-preview',
  backend_generation: 'auth-ui-preview-1',
  allowed_effects: ['ledger:read', 'ledger:write', 'files:preview', 'preferences:instance'],
  operational_mutations: 'reject',
  operational_mutations_overridden: true,
  db_path: '/tmp/mandible-preview.db',
  db_path_source: 'iab-preview-copy',
  source_db_path: '/tmp/mandible-main.db',
  source_db_path_source: 'env',
};

function renderView(
  daemonReady: boolean,
  onApprove: (id: string) => void,
  instance?: InstanceInfo | null,
  selectedAuthId: string | null = 'req-1',
) {
  return render(
    <AuthQueueView
      queue={[pendingRequest]}
      historyQueue={[]}
      outputs={{}}
      selectedAuthId={selectedAuthId}
      daemonReady={daemonReady}
      instance={instance ?? authMainInstance}
      onApprove={onApprove}
      onReject={() => undefined}
      onRetry={() => undefined}
      onDismiss={() => undefined}
    />,
  );
}

beforeEach(async () => {
  await establishTestClientAccess();
  bindAuthUiOperations();
  bindAuthUiOperations(previewInstance);
  installMemoryLocalStorage();
  Element.prototype.scrollIntoView = vi.fn();
  // Keep the auto-approve status / action probes hermetic and offline.
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no network in test'))));
});

afterEach(() => {
  __resetBrowserSessionForTests();
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AuthQueueView daemon readiness gate', () => {
  it('blocks from canonical dependency readiness and opens only for ready', () => {
    const onApprove = vi.fn();
    const blockedRequest: AuthRequest = {
      ...pendingRequest,
      depends_on_ids: ['dependency-1'],
      dependencies: [{
        state: 'unfinalized', requested_id: 'dependency-1',
        request_id: 'dependency-1', status: 'completed', outcome: 'succeeded',
        exit_code: 0, merge_finalized_at: null,
      }],
    };
    const props = {
      instance: authMainInstance,
      queue: [blockedRequest], historyQueue: [], outputs: {}, selectedAuthId: 'req-1',
      daemonReady: true, onApprove, onReject: () => undefined,
      onRetry: () => undefined, onDismiss: () => undefined,
    };
    const { rerender } = render(<AuthQueueView {...props} />);

    const blocked = screen.getByRole('button', { name: 'Blocked: dependency unfinalized' }) as HTMLButtonElement;
    expect(blocked.disabled).toBe(true);
    fireEvent.click(blocked);
    expect(onApprove).not.toHaveBeenCalled();

    rerender(<AuthQueueView {...props} queue={[{
      ...blockedRequest,
      dependencies: [{ ...blockedRequest.dependencies![0], state: 'ready', merge_finalized_at: 10 }],
    }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onApprove).toHaveBeenCalledWith('req-1');
  });

  it('disables Approve and fires no approval action while the daemon is not ready', () => {
    const onApprove = vi.fn();
    renderView(false, onApprove);

    const approve = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);

    fireEvent.click(approve);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('enables Approve and fires the approval action once the daemon is ready', () => {
    const onApprove = vi.fn();
    renderView(true, onApprove);

    const approve = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(false);

    fireEvent.click(approve);
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith('req-1');
  });

  it('shows copied Description as read-only while keeping approval disabled', () => {
    const onApprove = vi.fn();
    renderView(true, onApprove, previewInstance);

    expect(screen.getByText('Description')).toBeTruthy();
    const approve = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Reject' }) as HTMLButtonElement).disabled).toBe(false);

    expect(screen.queryByText('edit')).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Description' })).toBeNull();
    fireEvent.click(approve);
    expect(onApprove).not.toHaveBeenCalled();
  });

});

describe('Auth Description presentation', () => {
  for (const type of ['config-change', 'custody-transfer'] as const) {
    it(`renders multiline ${type} review text without Git fallback and sanitizes Markdown`, () => {
      render(<AuthQueueView queue={[{ ...pendingRequest, type,
        commit_message: '# Review this action\n\nPreserve the existing service.\n\n<script>window.bad=true</script>',
      }]} historyQueue={[]} outputs={{}} selectedAuthId="req-1" daemonReady instance={authMainInstance}
        onApprove={vi.fn()} onReject={vi.fn()} onSelectAuth={vi.fn()} />);
      expect(screen.getByText('Description')).toBeTruthy();
      expect(screen.getByRole('heading', { name: 'Review this action' })).toBeTruthy();
      expect(screen.getByText('Preserve the existing service.')).toBeTruthy();
      expect(screen.queryByText(/git.*default/i)).toBeNull();
      expect(document.querySelector('.rendered-markdown script')).toBeNull();
      expect(screen.queryByText('edit')).toBeNull();
    });
  }
});

describe('Auth Description disclosure persistence', () => {
  const message = 'Merge feature/x: Preserve the reviewed explanation\n\nVerification:\nPrivate checks pass.\n';
  const first = { ...pendingRequest, commit_message: message, commit_message_digest: 'a'.repeat(64) };
  const second = { ...first, id: 'req-2', title: 'Second review', commit_message_digest: 'b'.repeat(64) };
  const props = (selectedAuthId = 'req-1') => ({
    queue: [first, second], historyQueue: [], outputs: {}, selectedAuthId, daemonReady: true,
    instance: authMainInstance, onApprove: vi.fn(), onReject: vi.fn(), onRetry: vi.fn(),
  });
  const expanded = (name: string) => screen.getByRole('button', { name }).getAttribute('aria-expanded');

  it('preserves explicit Description and References toggles across refetch, request switches and remount', async () => {
    const view = render(<AuthQueueView {...props()} />);
    expect(expanded('Description')).toBe('true');
    expect(expanded('References')).toBe('true');
    expect(localStorage.getItem('auth-description-view:req-1')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Description' }));
    fireEvent.click(screen.getByRole('button', { name: 'References' }));
    await waitFor(() => expect(localStorage.getItem('auth-description-view:req-1'))
      .toBe(JSON.stringify({ descriptionExpanded: false, referencesExpanded: false })));

    view.rerender(<AuthQueueView {...props()} queue={[{ ...first, updated_at: 2 }, second]} />);
    expect(expanded('Description')).toBe('false');
    expect(expanded('References')).toBe('false');
    view.rerender(<AuthQueueView {...props('req-2')} />);
    await waitFor(() => expect(expanded('Description')).toBe('true'));
    expect(expanded('References')).toBe('true');
    expect(localStorage.getItem('auth-description-view:req-2')).toBeNull();
    view.rerender(<AuthQueueView {...props('req-1')} />);
    await waitFor(() => expect(expanded('Description')).toBe('false'));
    expect(expanded('References')).toBe('false');
    view.unmount();
    render(<AuthQueueView {...props()} />);
    expect(expanded('Description')).toBe('false');
    expect(expanded('References')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Description' }));
    expect(screen.getAllByText(/Preserve the reviewed explanation/)).toHaveLength(1);
    expect(screen.getAllByText(/Private checks pass\./)).toHaveLength(1);
  });

  it('uses independent strict boolean defaults without rewriting malformed storage on initial read', async () => {
    const invalid = JSON.stringify({ descriptionExpanded: 'false', referencesExpanded: 1 });
    localStorage.setItem('auth-description-view:req-1', invalid);
    const view = render(<AuthQueueView {...props()} />);
    expect(expanded('Description')).toBe('true');
    expect(expanded('References')).toBe('true');
    await waitFor(() => expect(localStorage.getItem('auth-description-view:req-1')).toBe(invalid));
    view.unmount();
    localStorage.setItem('auth-description-view:req-1', JSON.stringify({ descriptionExpanded: false, referencesExpanded: 'true' }));
    render(<AuthQueueView {...props()} />);
    expect(expanded('Description')).toBe('false');
    expect(expanded('References')).toBe('true');
  });
});

describe('AuthQueueView persisted action expansion', () => {
  it('reveals the full payload behind a truncated one-line action preview', async () => {
    const body = 'A long review comment. '.repeat(30) + 'The complete final sentence.';
    const request = { ...pendingRequest, actions: [{ ...deferredAction, payload: { body }, outcome_detail: null }] };
    render(<AuthQueueView queue={[request]} historyQueue={[]} outputs={{}} selectedAuthId="req-1"
      daemonReady instance={authMainInstance} onApprove={() => undefined} onReject={() => undefined} />);
    const preview = document.querySelector('.auth-action-row__summary')!;
    expect(preview.textContent!.length).toBeLessThan(body.length);
    expect(document.querySelector('.auth-action-row__detail')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand Comment action' }));
    expect(document.querySelector('.auth-action-row__detail')?.textContent).toBe(body);
  });

  it('restores normalized per-request expansion and preserves it through queue refetches', async () => {
    const storageKey = 'auth-action-expanded:req-1';
    localStorage.setItem(storageKey, JSON.stringify(['action-1', 42, 'action-1']));
    const request = { ...pendingRequest, actions: [deferredAction] };
    const props = {
      historyQueue: [],
      outputs: {},
      selectedAuthId: 'req-1',
      daemonReady: true,
      onApprove: () => undefined,
      onReject: () => undefined,
      onRetry: () => undefined,
      onDismiss: () => undefined,
    };
    const { rerender } = render(<AuthQueueView {...props} queue={[request]} />);

    expect(await screen.findByText('Expanded action detail')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Comment action' }));
    await waitFor(() => expect(localStorage.getItem(storageKey)).toBe('[]'));

    rerender(<AuthQueueView {...props} queue={[{ ...request, updated_at: 2 }]} />);
    expect(screen.queryByText('Expanded action detail')).toBeNull();
    expect(screen.getByRole('button', { name: 'Expand Comment action' })).toBeTruthy();
    expect(localStorage.getItem(storageKey)).toBe('[]');
  });
});

describe('Approval review issue and action composition', () => {
  it('preserves reference and action destinations, completion details and saved disclosures', async () => {
    const titles: Record<string, string> = {
      'ref-9b1': 'Reference one with a title outside its ID',
      'ref-9b2': 'Reference two',
      'close-9b1': 'First completed issue',
      'close-9b2': 'Second completed issue',
    };
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      if (!input.startsWith('/api/spaces/resolve?')) throw new Error('no network in test');
      const ref = new URL(input, 'http://localhost').searchParams.get('ref')!.replace('issue:', '');
      return { ok: true, json: async () => ({ resolved: true, entity: { id: ref, short_id: ref, project_ref: 'mandible', title: titles[ref] }, detail: { same_project: true } }) };
    }));
    const request: AuthRequest = {
      ...pendingRequest,
      status: 'completed', exit_code: 0,
      issue_references: ['ref-9b1', 'ref-9b2'],
      issue_closures: ['close-9b1', 'close-9b2'],
      actions: ['close-9b1', 'close-9b2'].map((ref, index) => ({
        ...deferredAction, id: `layout-action-${index}`, kind: 'issue_close', state: 'applied',
        target_issue_ref: ref, ordinal: index, payload: {},
        outcome_detail: index === 0 ? 'Closed after the reviewed target changed.' : null,
      })),
    };
    const props = {
      queue: [], historyQueue: [request], outputs: {}, selectedAuthId: request.id,
      daemonReady: true, instance: authMainInstance,
      onApprove: () => undefined, onReject: () => undefined, onRetry: () => undefined, onDismiss: () => undefined,
    };
    const view = render(<AuthQueueView {...props} />);
    await screen.findByText(titles['ref-9b1']);
    const references = within(screen.getByRole('region', { name: 'References', exact: true }));
    const actions = within(screen.getByRole('region', { name: 'Actions on merge', exact: true }));
    for (const ref of request.issue_references!) {
      expect(references.getByRole('link', { name: new RegExp(titles[ref]) }).getAttribute('href')).toContain(`issue=${ref}`);
    }
    for (const ref of request.issue_closures!) {
      expect(actions.getByRole('link', { name: new RegExp(titles[ref]) }).getAttribute('href')).toContain(`issue=${ref}`);
    }
    expect(actions.getAllByText('Done')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Expand Close issue action' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Expand Close issue action' }));
    expect(screen.getByText('Closed after the reviewed target changed.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'References', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Actions on merge', exact: true }));
    view.rerender(<AuthQueueView {...props} historyQueue={[{ ...request, updated_at: 2 }]} />);
    expect(screen.getByRole('button', { name: 'References', exact: true }).getAttribute('aria-expanded')).toBe('false');
    view.unmount();
    render(<AuthQueueView {...props} />);
    expect(screen.getByRole('button', { name: 'Actions on merge', exact: true }).getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Actions on merge', exact: true }));
    expect(screen.getByText('Closed after the reviewed target changed.')).toBeTruthy();
  });
});

describe('Approval closure targets without recorded actions', () => {
  for (const field of ['issue_closures', 'issues'] as const) {
    it(`preserves ${field} closure links without assigning completion evidence`, async () => {
      const request = { ...pendingRequest, status: 'completed', exit_code: 0,
        issue_references: [], actions: [], [field]: ['legacy-9b1', 'legacy-9b2', 'legacy-9b1'] };
      render(<AuthQueueView queue={[]} historyQueue={[request]} outputs={{}}
        selectedAuthId={request.id} daemonReady instance={authMainInstance}
        onApprove={() => undefined} onReject={() => undefined} />);
      const panel = screen.getByRole('button', { name: 'Actions on merge', exact: true }).closest('section')!;
      expect(panel.querySelectorAll('a')).toHaveLength(2);
      expect(panel.querySelector('a')?.getAttribute('href')).toContain('legacy-9b1');
      expect(panel.querySelector('.auth-action-row__state')).toBeNull();
      expect(screen.getByText('No action status recorded.')).toBeTruthy();
      expect(screen.queryByRole('switch')).toBeNull();

    });
  }
});

describe('Approval body reading position', () => {
  it('restores request and tab positions across A-to-B navigation and respects Console reading and tailing', async () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function(this: HTMLElement) {
      return this.textContent?.includes('Tail append') ? 5000 : 2000;
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300);
    const second = { ...pendingRequest, id: 'req-scroll-b', title: 'Second reading position' };
    const props = {
      queue: [pendingRequest, second], historyQueue: [], outputs: { 'req-1': 'Initial console output' },
      selectedAuthId: 'req-1', daemonReady: true, instance: authMainInstance,
      onApprove: () => undefined, onReject: () => undefined,
    };
    const view = render(<AuthQueueView {...props} />);
    const body = () => document.querySelector<HTMLDivElement>('.auth-detail__body')!;
    body().scrollTop = 184;
    fireEvent.scroll(body());
    fireEvent.click(screen.getByRole('tab', { name: 'Diff' }));
    expect(body().scrollTop).toBe(0);
    body().scrollTop = 72;
    fireEvent.scroll(body());
    view.rerender(<AuthQueueView {...props} selectedAuthId={second.id} />);
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Info' }).getAttribute('aria-selected')).toBe('true'));
    expect(body().scrollTop).toBe(0);
    body().scrollTop = 39;
    fireEvent.scroll(body());
    view.rerender(<AuthQueueView {...props} />);
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Diff' }).getAttribute('aria-selected')).toBe('true'));
    expect(body().scrollTop).toBe(72);
    fireEvent.click(screen.getByRole('tab', { name: 'Info' }));
    expect(body().scrollTop).toBe(184);
    fireEvent.click(screen.getByRole('tab', { name: 'Console' }));
    body().scrollTop = 61;
    fireEvent.scroll(body());
    vi.mocked(Element.prototype.scrollIntoView).mockClear();
    view.rerender(<AuthQueueView {...props} outputs={{ 'req-1': 'Initial console output\nNew output while reading' }} />);
    expect(body().scrollTop).toBe(61);
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    body().scrollTop = 1700;
    fireEvent.scroll(body());
    view.rerender(<AuthQueueView {...props} outputs={{ 'req-1': 'Tail append with enough output to grow the scroll range' }} />);
    expect(body().scrollHeight).toBe(5000);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledOnce();
  });
});

for (const savedOffset of [0, 184]) {
for (const settleBeforeTailEffect of [false, true]) {
it(`restores saved Console${savedOffset} when delayed output becomes reachable (settles before tail effect: ${settleBeforeTailEffect})`, async () => {
  localStorage.setItem('auth-review-tab:req-1', '"console"');
  localStorage.setItem('auth-review-scroll:req-1:console', String(savedOffset));
  const resizeCallbacks: Array<() => void> = [];
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resizeCallbacks.push(() => callback([], this as unknown as ResizeObserver)); }
    observe() {}
    disconnect() {}
  });
  let outputReady = false;
  if (settleBeforeTailEffect) {
    const realHook = ScrollPersistence.usePersistedScrollPosition;
    vi.spyOn(ScrollPersistence, 'usePersistedScrollPosition').mockImplementation((ref, key) => {
      const pending = realHook(ref, key);
      useLayoutEffect(() => {
        if (outputReady) for (const notify of resizeCallbacks) notify();
      });
      return pending;
    });
  }
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function(this: HTMLElement) {
    return this.querySelector('.console-output__pre') ? 2000 : 300;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300);
  const props = { queue: [pendingRequest], historyQueue: [], outputs: {}, selectedAuthId: 'req-1',
    daemonReady: true, instance: authMainInstance, onApprove: () => undefined, onReject: () => undefined };
  const view = render(<AuthQueueView {...props} />);
  const body = document.querySelector<HTMLDivElement>('.auth-detail__body')!;
  expect(body.scrollTop).toBe(0);
  expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  outputReady = true;
  view.rerender(<AuthQueueView {...props} outputs={{ 'req-1': 'Long console output arrived after the saved reading position was loaded.' }} />);
  await waitFor(() => expect(body.scrollTop).toBe(savedOffset));
  expect(localStorage.getItem('auth-review-scroll:req-1:console')).toBe(String(savedOffset));
  expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
});
}
}

it('waits for confirmed actions and preserves useful rows throughout a delayed refetch', async () => {
  const replies: Array<{ resolve(response: Response): void; reject(error: Error): void }> = [];
  vi.stubGlobal('fetch', vi.fn((input: string) => {
    if (!String(input).endsWith('/api/auth/request/req-1/actions')) return Promise.reject(new Error('no network in test'));
    return new Promise<Response>((resolve, reject) => replies.push({ resolve, reject }));
  }));
  const request: AuthRequest = { ...pendingRequest, status: 'completed', exit_code: 0,
    actions: undefined, action_count: 3, issue_closures: ['close-loading'], issue_references: [],
    diff_summary: '', spec_content: '', output: '',
  };
  const props = { queue: [], historyQueue: [request], outputs: {}, selectedAuthId: 'req-1',
    daemonReady: true, instance: authMainInstance, onApprove: () => undefined, onReject: () => undefined };
  const view = render(<AuthQueueView {...props} />);
  await waitFor(() => expect(replies).toHaveLength(1));
  expect(screen.queryByText('No action status recorded.')).toBeNull();
  expect(screen.queryByText('Done')).toBeNull();
  expect(document.querySelectorAll('.auth-action-row')).toHaveLength(1);
  expect(document.querySelector('.auth-action-row a')?.getAttribute('href')).toContain('close-loading');
  expect(screen.queryByRole('switch')).toBeNull();
  const respond = (actions: AuthRequestAction[]) => replies.shift()!.resolve(new Response(JSON.stringify({ actions }), {
    headers: { 'content-type': 'application/json' },
  }));
  respond([{ ...deferredAction, kind: 'issue_close', state: 'applied', target_issue_ref: 'close-loading' }]);
  await screen.findByText('Done');
  view.rerender(<AuthQueueView {...props} historyQueue={[{ ...request, action_count: undefined, updated_at: 2 }]} />);
  await waitFor(() => expect(replies).toHaveLength(1));
  expect(screen.getByText('Done')).toBeTruthy();
  expect(screen.queryByText('No action status recorded.')).toBeNull();
  await act(async () => { replies.shift()!.reject(new Error('Refetch unavailable')); });
  expect(screen.getByText('Done')).toBeTruthy();
  expect(screen.queryByText('No action status recorded.')).toBeNull();
  view.rerender(<AuthQueueView {...props} historyQueue={[{ ...request, updated_at: 3 }]} />);
  await waitFor(() => expect(replies).toHaveLength(1));
  respond([]);
  await screen.findByText('No action status recorded.');
  expect(screen.queryByText('Done')).toBeNull();
  expect(document.querySelectorAll('.auth-action-row')).toHaveLength(1);
});

it('rejects a malformed successful action response instead of confirming an empty list', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } })));
  const { getAuthRequestActions } = await import('../ui/src/api');
  await expect(getAuthRequestActions('req-1')).rejects.toThrow('did not contain an action list');
});

it('shares explicit panel availability without changing saved folding intent', async () => {
  localStorage.setItem('availability-fold', 'true');
  function Panel({ availability }: { availability: CollapsiblePanelAvailability }) {
    const [expanded, setExpanded] = usePersistedViewState('availability-fold', value => value === true, true);
    return <CollapsiblePanel title="Review panel" availability={availability} expanded={expanded}
      onExpandedChange={setExpanded} actions={<span>Known summary</span>}
      persistentContent={<span>Persistent content</span>}>
      <p>Known body</p>
    </CollapsiblePanel>;
  }
  const view = render(<Panel availability="unknown" />);
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByText('Unavailable')).toBeNull();
  expect(screen.queryByText('Known body')).toBeNull();
  expect(screen.queryByText('Persistent content')).toBeNull();
  expect(screen.queryByText('Known summary')).toBeNull();
  view.rerender(<Panel availability="unavailable" />);
  expect(screen.getByText('Unavailable')).toBeTruthy();
  expect(screen.queryByText('Known summary')).toBeNull();
  expect(screen.queryByText('Known body')).toBeNull();
  expect(screen.queryByText('Persistent content')).toBeNull();
  expect(localStorage.getItem('availability-fold')).toBe('true');
  view.rerender(<Panel availability="available" />);
  expect(screen.getByRole('button', { name: 'Review panel' }).getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByText('Known body')).toBeTruthy();
  expect(screen.getByText('Known summary')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Review panel' }));
  await waitFor(() => expect(localStorage.getItem('availability-fold')).toBe('false'));
  view.rerender(<Panel availability="unknown" />);
  view.rerender(<Panel availability="unavailable" />);
  view.rerender(<Panel availability="available" />);
  expect(screen.getByRole('button', { name: 'Review panel' }).getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByText('Known body')).toBeNull();
});

it('keeps unknown breakdown distinct from confirmed absence and available zero-file data', () => {
  const report: AuthChangeReport = {
    schema: 'mandible-auth-change-report@1', classifier_version: 'mandible-auth-change-classifier@1',
    rules_version: 'mandible-auth-change-rules@1', rename_similarity_percent: 50,
    comparison: { base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40), merge_base_sha: 'a'.repeat(40) },
    totals: { files: 0, additions: 0, deletions: 0, text_files: 0, binary_files: 0 }, files: [],
  };
  const view = render(<AuthChangeBreakdown requestId="availability-report" report={undefined} />);
  expect(screen.queryByRole('button', { name: 'Change breakdown' })).toBeNull();
  expect(screen.queryByText('Unavailable')).toBeNull();
  view.rerender(<AuthChangeBreakdown requestId="availability-report" report={null} />);
  expect(screen.getByText('Unavailable')).toBeTruthy();
  expect(screen.queryByRole('tablist', { name: 'Change breakdown view' })).toBeNull();
  view.rerender(<AuthChangeBreakdown requestId="availability-report" report={report} />);
  expect(screen.getByRole('button', { name: 'Change breakdown' })).toBeTruthy();
  expect(screen.queryByText('Unavailable')).toBeNull();
  expect(screen.getByRole('button', { name: 'Change breakdown' }).getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByRole('tablist', { name: 'Change breakdown view' })).toBeTruthy();
});

for (const outcome of ['failed', 'absent'] as const) {
  it(`preserves unknown report availability through delayed ${outcome} history hydration`, async () => {
    let resolve!: (response: Response) => void;
    let reject!: (error: Error) => void;
    const held = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
    const fetch = vi.fn((input: string) => String(input) === '/api/auth/request/req-1'
      ? held : Promise.reject(new Error('no network in test')));
    vi.stubGlobal('fetch', fetch);
    const request = { ...pendingRequest, status: 'completed', exit_code: 0, change_report: undefined,
      diff_summary: undefined, spec_content: undefined, output: undefined };
    render(<AuthQueueView queue={[]} historyQueue={[request]} outputs={{}} selectedAuthId="req-1"
      daemonReady instance={authMainInstance} onApprove={() => undefined} onReject={() => undefined} />);
    await waitFor(() => expect(fetch.mock.calls.some(([input]) => input === '/api/auth/request/req-1')).toBe(true));
    const panel = () => within(screen.getByRole('region', { name: 'Change breakdown', exact: true }));
    expect(panel().queryByRole('button')).toBeNull();
    expect(panel().queryByText('Unavailable')).toBeNull();
    await act(async () => {
      if (outcome === 'failed') reject(new Error('History detail temporarily unavailable'));
      else resolve(new Response(JSON.stringify({ ...request, change_report: null }), { headers: { 'content-type': 'application/json' } }));
    });
    if (outcome === 'failed') {
      expect(panel().queryByText('Unavailable')).toBeNull();
      expect(panel().queryByRole('button')).toBeNull();
    } else {
      await waitFor(() => expect(panel().getByText('Unavailable')).toBeTruthy());
      expect(panel().queryByRole('button')).toBeNull();
    }
  });
}

for (const coverage of ['absent', 'empty', 'partial', 'wrong-reference', 'duplicate'] as const) {
  it('blocks approval with ' + coverage + ' prerequisite projection coverage', () => {
    const ready = { state: 'ready' as const, requested_id: 'spatial', request_id: 'spatial',
      status: 'completed' as const, outcome: 'succeeded' as const, exit_code: 0, merge_finalized_at: 10 };
    const projections = coverage === 'absent' ? undefined : coverage === 'empty' ? []
      : coverage === 'partial' ? [ready] : coverage === 'wrong-reference' ? [ready, { ...ready, requested_id: 'other' }]
        : [ready, { ...ready, requested_id: 'validation' }, { ...ready, requested_id: 'validation' }];
    const onApprove = vi.fn();
    render(<AuthQueueView queue={[{ ...pendingRequest, depends_on_ids: ['spatial', 'validation'], dependencies: projections }]}
      outputs={{}} selectedAuthId="req-1" daemonReady instance={authMainInstance} onApprove={onApprove} />);
    const approve = screen.getByRole('button', { name: /Blocked: dependency/ }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.click(approve);
    expect(onApprove).not.toHaveBeenCalled();
    const prerequisites = within(screen.getByRole('region', { name: 'Request prerequisites' }));
    expect(prerequisites.getAllByRole('listitem')).toHaveLength(2);
    expect(prerequisites.getByRole('link', { name: 'auth:validati' }).getAttribute('href')).toContain('validation');
  });
}

for (const history of [false, true]) {
  it('renders and navigates every prerequisite in ' + (history ? 'history' : 'queue') + ' while reconciling readiness', () => {
    const ids = ['spatial', 'validation', 'source', 'missing', 'ambiguous'];
    const states = ['ready', 'pending', 'failed', 'missing', 'ambiguous'] as const;
    const dependencies = ids.map((id, index) => ({ requested_id: id,
      request_id: index < 3 ? id : null, state: states[index],
      status: index === 0 ? 'completed' as const : index === 1 ? 'pending' as const : index === 2 ? 'failed' as const : null,
      outcome: index === 0 ? 'succeeded' as const : index === 2 ? 'failed' as const : null,
      exit_code: index === 0 ? 0 : null, merge_finalized_at: index === 0 ? 10 : null }));
    const request = { ...pendingRequest, status: history ? 'completed' : 'pending',
      depends_on_ids: ids, dependencies };
    const onNavigateRequest = vi.fn();
    const onSelectAuth = vi.fn();
    const props = { outputs: {}, selectedAuthId: 'req-1', initialRequestId: 'req-1', daemonReady: true, instance: authMainInstance,
      onNavigateRequest, onSelectAuth };
    const view = render(<AuthQueueView {...props} queue={history ? [] : [request]} historyQueue={history ? [request] : []} />);
    const prerequisites = () => within(screen.getByRole('region', { name: 'Request prerequisites' }));
    const rows = prerequisites().getAllByRole('listitem');
    expect(rows).toHaveLength(5);
    for (const [index, state] of states.entries()) expect(within(rows[index]).getByText(state)).toBeTruthy();
    onSelectAuth.mockClear();
    const updated = { ...request, dependencies: dependencies.map(dependency => ({ ...dependency,
      state: 'ready' as const, status: 'completed' as const, outcome: 'succeeded' as const,
      request_id: dependency.requested_id, merge_finalized_at: 20 })) };
    view.rerender(<AuthQueueView {...props} queue={history ? [] : [updated]} historyQueue={history ? [updated] : []} />);
    expect(onSelectAuth).not.toHaveBeenCalled();
    expect(prerequisites().getAllByText('ready')).toHaveLength(5);
    if (!history) expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(false);
    for (const link of prerequisites().getAllByRole('link')) expect(link.getAttribute('href')).toMatch(/^#\/auth\?request=/);
    fireEvent.click(prerequisites().getByRole('link', { name: 'auth:source' }));
    expect(onSelectAuth).toHaveBeenCalledWith('source');
    expect(onNavigateRequest).toHaveBeenCalledWith('source');
  });
}
