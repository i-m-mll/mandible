import { establishTestClientAccess } from './helpers/local-client-access';
// Bug: 645f8a8 — auth view mutation gate. While the daemon is not ready
// (rebuilding / starting), the Approve button must be disabled and NO approval
// action may fire. Once ready, Approve works normally.
import { screen, cleanup, fireEvent, waitFor } from '@testing-library/preact';
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

  it('allows copied-queue metadata edits while keeping approval disabled', () => {
    const onApprove = vi.fn();
    const onUpdateField = vi.fn();
    renderView(true, onApprove, previewInstance, onUpdateField);

    expect(screen.getByText('Commit message')).toBeTruthy();
    const approve = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Reject' }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByText('edit'));
    const textarea = screen.getByRole('textbox', { name: 'Commit message' }) as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: 'Local copied review text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onUpdateField).toHaveBeenCalledWith('req-1', 'commit_message', 'Local copied review text');
    fireEvent.click(approve);
    expect(onApprove).not.toHaveBeenCalled();
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
