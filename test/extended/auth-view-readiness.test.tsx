import { establishTestClientAccess } from '../helpers/local-client-access';
// Bug: 645f8a8 — auth view mutation gate. While the daemon is not ready
// (rebuilding / starting), the Approve button must be disabled and NO approval
// action may fire. Once ready, Approve works normally.
import { screen, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { render } from './notice-test-render';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { authMainInstance, bindAuthUiOperations } from '../helpers/auth-ui-fixture';

import { AuthQueueView, type AuthRequest } from '../../ui/src/views/auth';
import type { AuthRequestAction, InstanceInfo } from '../../ui/src/api';
import { __resetBrowserSessionForTests } from '../../ui/src/client-auth-token';

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

const executingRequest: AuthRequest = {
  ...pendingRequest,
  id: 'req-executing',
  status: 'executing',
  approved_at: 2,
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
  onUpdateField?: (requestId: string, field: string, value: string) => void,
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
      onUpdateField={onUpdateField}
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

  it('keeps an approval failure in the shared main notice until retry or dismissal', async () => {
    const onApprove = vi.fn()
      .mockRejectedValueOnce(new Error('Signing credential is unavailable.'))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Approval remains unavailable.'));
    renderView(true, onApprove);

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    const alert = await screen.findByRole('alert');
    const requestPane = document.querySelector('.auth-detail-pane');
    const requestHeader = document.querySelector('.auth-detail__header');
    const requestBody = document.querySelector('.auth-detail__body');
    expect(alert.textContent).toContain('Signing credential is unavailable.');
    expect(alert.parentElement?.id).toBe('app-operational-notices');
    expect(requestPane?.contains(alert)).toBe(false);
    expect(requestBody?.contains(alert)).toBe(false);
    expect(document.querySelector('.auth-toast')).toBeNull();

    const retry = screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement;
    await waitFor(() => expect(retry.disabled).toBe(false));
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(onApprove).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const replacementAlert = await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss auth error' }));
    expect(replacementAlert.isConnected).toBe(false);
  });

  it('omits request-local clearance controls and queries while preserving audit metadata', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error('no network in test')));
    vi.stubGlobal('fetch', fetchMock);
    render(
      <AuthQueueView
        queue={[{
          ...pendingRequest,
          approval_source: 'clearance',
          approval_lease_id: 'lease-1',
          clearance_use_id: 'clearance-use-1',
        }]}
        historyQueue={[]}
        outputs={{}}
        selectedAuthId="req-1"
        daemonReady={true}
        onApprove={() => undefined}
        onReject={() => undefined}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Issue clearance' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
    expect(screen.queryByLabelText('Protected merge clearances')).toBeNull();
    expect(document.querySelector('.auth-detail__panels')?.className).toContain('auth-detail__panels--single');

    fireEvent.click(screen.getByRole('button', { name: 'Approval actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show metadata' }));
    expect(screen.getByText('clearance-use-1')).toBeTruthy();
    expect(screen.getByText('api_token')).toBeTruthy();
    expect(screen.getByText('credential-1234567890')).toBeTruthy();
    expect(screen.getByText('clearance')).toBeTruthy();
    expect(screen.getByText('lease-1')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/auth/clearances'))).toBe(false);
  });

  it('allows copied-queue metadata edits while keeping approval disabled', () => {
    const onApprove = vi.fn();
    const onUpdateField = vi.fn();
    renderView(true, onApprove, previewInstance, onUpdateField);

    expect(screen.getByText('Commit message')).toBeTruthy();
    const approve = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Reject' }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByText('edit'));
    const textarea = document.querySelector('.panel__edit-textarea') as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: 'Local copied review text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onUpdateField).toHaveBeenCalledWith('req-1', 'commit_message', 'Local copied review text');
    fireEvent.click(approve);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('maps auth output phases to the execution callout', () => {
    const onApprove = vi.fn();
    render(
      <AuthQueueView
        queue={[executingRequest]}
        historyQueue={[]}
        outputs={{
          'req-executing': 'Auth phase: running merge preflight checks...\n',
        }}
        selectedAuthId="req-executing"
        daemonReady={true}
        onApprove={onApprove}
        onReject={() => undefined}
        onRetry={() => undefined}
        onDismiss={() => undefined}
      />,
    );

    expect(screen.getByText('Running merge preflight checks')).toBeTruthy();
    expect(screen.queryByText(/touch your YubiKey when it lights up/i)).toBeNull();
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

  it('falls back from malformed action expansion storage and writes an array of strings', async () => {
    const storageKey = 'auth-action-expanded:req-1';
    localStorage.setItem(storageKey, '{malformed');
    const request = { ...pendingRequest, actions: [deferredAction] };
    render(
      <AuthQueueView
        queue={[request]}
        historyQueue={[]}
        outputs={{}}
        selectedAuthId="req-1"
        daemonReady={true}
        onApprove={() => undefined}
        onReject={() => undefined}
        onRetry={() => undefined}
        onDismiss={() => undefined}
      />,
    );

    expect(screen.queryByText('Expanded action detail')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand Comment action' }));
    await waitFor(() => expect(localStorage.getItem(storageKey)).toBe('["action-1"]'));
  });
});

describe('AuthQueueView attribution', () => {
  it('renders one outcome label for a completed merge request', () => {
    const mergedRequest: AuthRequest = {
      ...pendingRequest,
      status: 'completed',
      exit_code: 0,
      convergence: { state: 'complete', hooks: [] },
    };
    render(
      <AuthQueueView
        queue={[]}
        historyQueue={[mergedRequest]}
        outputs={{}}
        selectedAuthId="req-1"
        daemonReady={true}
        onApprove={() => undefined}
        onReject={() => undefined}
        onRetry={() => undefined}
        onDismiss={() => undefined}
      />,
    );

    const status = document.querySelector('.detail-pane-header__status');
    expect(status?.textContent).toBe('Merged');
    expect(screen.queryByText('Completed')).toBeNull();
    expect(screen.queryByText('live')).toBeNull();
    expect(screen.queryByText('branch merged')).toBeNull();
  });

  it('attributes creation plainly while retaining approver credential verification', () => {
    const attributedRequest: AuthRequest = {
      ...pendingRequest,
      requester: { id: 'user-agent', display_name: 'Request Agent', kind: 'agent' },
      approver: { id: 'user-human', display_name: 'Human Approver', kind: 'human' },
      execution_evidence: {
        user: null,
        evidence_method: 'credential_signature',
        evidence_id: 'evidence-1',
        credential: { id: 'credential-1', type: 'ssh_key', label: 'YubiKey signing key' },
      },
      merge_signature: { state: 'verified' as const, fingerprint: null },
    };
    render(
      <AuthQueueView
        queue={[attributedRequest]}
        historyQueue={[]}
        outputs={{}}
        selectedAuthId="req-1"
        daemonReady={true}
        onApprove={() => undefined}
        onReject={() => undefined}
        onRetry={() => undefined}
        onDismiss={() => undefined}
      />,
    );

    expect(screen.getByText(/created .* by Request Agent/)).toBeTruthy();
    expect(screen.queryByLabelText('Show attribution for Request Agent')).toBeNull();
    expect(screen.getByLabelText('Show attribution for Human Approver')).toBeTruthy();
    expect(screen.getByText('verified')).toBeTruthy();
    expect(screen.queryByText('Verified signature')).toBeNull();
    expect(screen.queryByText('human')).toBeNull();
    fireEvent.click(screen.getByLabelText('Show attribution for Human Approver'));
    expect(screen.getByText('credential signature')).toBeTruthy();
    expect(screen.getByText('YubiKey signing key')).toBeTruthy();
  });
});
