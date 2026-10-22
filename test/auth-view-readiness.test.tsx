// @vitest-environment jsdom
import { establishTestClientAccess } from './helpers/local-client-access';
// Bug: 645f8a8 — auth view mutation gate. While the daemon is not ready
// (rebuilding / starting), the Approve button must be disabled and NO approval
// action may fire. Once ready, Approve works normally.
import { screen, cleanup, fireEvent, waitFor } from './helpers/dom.js';
import { render } from './helpers/notice-test-render';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { authMainInstance, bindAuthUiOperations } from './helpers/auth-ui-fixture';

import { AuthQueueView, type AuthRequest } from '../ui/src/views/auth';
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
      depends_on_id: 'dependency-1',
      dependency: {
        state: 'unfinalized', requested_id: 'dependency-1',
        request_id: 'dependency-1', status: 'completed', outcome: 'succeeded',
        exit_code: 0, merge_finalized_at: null,
      },
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
      dependency: { ...blockedRequest.dependency!, state: 'ready', merge_finalized_at: 10 },
    }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onApprove).toHaveBeenCalledWith('req-1');
  });

  it('disables Approve and fires no approval action while the daemon is not ready', () => {
    const onApprove = vi.fn();
    renderView(false, onApprove);

    const approve = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(approve.closest('.auth-detail__aux-header')).toBeTruthy();
    expect(approve.closest('.auth-detail__header-actions')).toBeNull();

    fireEvent.click(approve);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('enables Approve and fires the approval action once the daemon is ready', () => {
    const onApprove = vi.fn();
    renderView(true, onApprove);

    const approve = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
    expect(approve.closest('.auth-detail__aux-header')).toBeTruthy();
    expect(approve.closest('.auth-detail__header-actions')).toBeNull();

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
      expect(screen.queryByText('Exact Git message')).toBeNull();
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

  it('preserves explicit Description and exact Git toggles across refetch, request switches and remount', async () => {
    const view = render(<AuthQueueView {...props()} />);
    expect(expanded('Description')).toBe('true');
    expect(expanded('Exact Git message')).toBe('false');
    expect(localStorage.getItem('auth-description-view:req-1')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Description' }));
    fireEvent.click(screen.getByRole('button', { name: 'Exact Git message' }));
    await waitFor(() => expect(localStorage.getItem('auth-description-view:req-1'))
      .toBe(JSON.stringify({ descriptionExpanded: false, exactGitExpanded: true, referencesExpanded: true })));

    view.rerender(<AuthQueueView {...props()} queue={[{ ...first, updated_at: 2 }, second]} />);
    expect(expanded('Description')).toBe('false');
    expect(expanded('Exact Git message')).toBe('true');
    view.rerender(<AuthQueueView {...props('req-2')} />);
    await waitFor(() => expect(expanded('Description')).toBe('true'));
    expect(expanded('Exact Git message')).toBe('false');
    expect(localStorage.getItem('auth-description-view:req-2')).toBeNull();
    view.rerender(<AuthQueueView {...props('req-1')} />);
    await waitFor(() => expect(expanded('Description')).toBe('false'));
    expect(expanded('Exact Git message')).toBe('true');
    view.unmount();
    render(<AuthQueueView {...props()} />);
    expect(expanded('Description')).toBe('false');
    expect(expanded('Exact Git message')).toBe('true');
    expect(screen.getByText(/Merge feature\/x: Preserve the reviewed explanation/).textContent).toBe(message);
  });

  it('uses independent strict boolean defaults without rewriting malformed storage on initial read', async () => {
    const invalid = JSON.stringify({ descriptionExpanded: 'false', exactGitExpanded: 1 });
    localStorage.setItem('auth-description-view:req-1', invalid);
    const view = render(<AuthQueueView {...props()} />);
    expect(expanded('Description')).toBe('true');
    expect(expanded('Exact Git message')).toBe('false');
    await waitFor(() => expect(localStorage.getItem('auth-description-view:req-1')).toBe(invalid));
    view.unmount();
    localStorage.setItem('auth-description-view:req-1', JSON.stringify({ descriptionExpanded: false, exactGitExpanded: 'true' }));
    render(<AuthQueueView {...props()} />);
    expect(expanded('Description')).toBe('false');
    expect(expanded('Exact Git message')).toBe('false');
  });
});

describe('AuthQueueView persisted action expansion', () => {
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
  it('keeps references and actions in reading order with independent links, details and saved disclosures', async () => {
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
    const panel = (name: string) => screen.getByRole('button', { name, exact: true }).closest('section')!;
    const description = panel('Description');
    const references = panel('References');
    const actions = panel('Actions on merge');
    expect(description.nextElementSibling).toBe(references);
    expect(references.nextElementSibling).toBe(actions);
    expect(references.classList.contains('collapsible-panel')).toBe(true);
    expect(actions.classList.contains('collapsible-panel')).toBe(true);
    expect(view.container.querySelector('.auth-detail__header')?.querySelector('.issue-pill')).toBeNull();
    expect(references.querySelectorAll('a')).toHaveLength(2);
    for (const link of [...references.querySelectorAll('a'), ...actions.querySelectorAll('a')]) {
      expect(link.querySelector('.issue-pill')?.textContent).toMatch(/^(ref|close)-9b[12]$/);
      expect(link.querySelector('.issue-pill__title')?.closest('.issue-pill')).toBeNull();
      expect(link.getAttribute('href')).toContain('#/issues?issue=');
    }
    const rows = actions.querySelectorAll('.auth-action-row');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.firstElementChild?.className).toBe('auth-action-row__main');
      expect(row.querySelector('.auth-action-row__controls')?.lastElementChild?.textContent).toBe('Done');
    }
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
