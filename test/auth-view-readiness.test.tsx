// Bug: 645f8a8 — auth view mutation gate. While the daemon is not ready
// (rebuilding / starting), the Approve button must be disabled and NO approval
// action may fire. Once ready, Approve works normally.
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthHooksPanel, AuthQueueView, type AuthRequest } from '../ui/src/views/auth';
import type { AuthRequestAction, InstanceInfo } from '../ui/src/api';

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
  role: 'preview',
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
      instance={instance}
      onApprove={onApprove}
      onReject={() => undefined}
      onRetry={() => undefined}
      onDismiss={() => undefined}
      onUpdateField={onUpdateField}
    />,
  );
}

beforeEach(() => {
  installMemoryLocalStorage();
  Element.prototype.scrollIntoView = vi.fn();
  // Keep the auto-approve status / action probes hermetic and offline.
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no network in test'))));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AuthQueueView daemon readiness gate', () => {
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

  it('creates, lists, and revokes scoped clearance from the selected request', async () => {
    const clearance = {
      id: 'clearance-12345678', issuer_user_id: 'operator-1', grantee_user_id: 'agent-1',
      grantee_credential_id: 'credential-1234567890', project_id: 'project-1', base_branch: 'main',
      issue_id: 'issue-1', head_branch: 'feature/x', action: 'merge' as const,
      issued_at: Date.now(), expires_at: Date.now() + 60_000, max_uses: 1, consumed_uses: 0,
      revoked_at: null, runtime_epoch: 'runtime-a',
    };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.startsWith('/api/auth/clearances?') && method === 'GET') {
        return Promise.resolve(new Response(JSON.stringify({ clearances: [clearance] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        }));
      }
      if (url === '/api/auth/clearances' && method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify({ clearance }), {
          status: 201, headers: { 'content-type': 'application/json' },
        }));
      }
      if (url === `/api/auth/clearances/${clearance.id}/revoke` && method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify({ clearance: { ...clearance, revoked_at: Date.now() } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        }));
      }
      return Promise.reject(new Error(`unexpected fetch ${method} ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderView(true, vi.fn());

    expect(await screen.findByText(/clearanc.*0\/1 uses/i)).toBeTruthy();
    expect(screen.getByText(/Requester provenance: api_token/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Issue clearance' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url) === '/api/auth/clearances' && (init as RequestInit | undefined)?.method === 'POST')).toBe(true));
    const createCall = fetchMock.mock.calls.find(([url, init]) =>
      String(url) === '/api/auth/clearances' && (init as RequestInit | undefined)?.method === 'POST');
    expect(JSON.parse(String((createCall?.[1] as RequestInit).body))).toMatchObject({
      request_id: 'req-1', grantee: 'agent-1', issue: 'issue-1', head: 'feature/x',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) =>
      String(url) === `/api/auth/clearances/${clearance.id}/revoke`)).toBe(true));
  });

  it('shows preview instance diagnostics and blocks approval actions', () => {
    const onApprove = vi.fn();
    renderView(true, onApprove, previewInstance);

    const warningLabel = screen.getByText('preview instance');
    const warning = warningLabel.closest('.detail-pane-notice');
    const detail = warning?.parentElement;
    const requestPane = document.querySelector('.auth-detail-pane');
    const requestHeader = document.querySelector('.auth-detail__header');
    const requestBody = document.querySelector('.auth-detail__body');
    const canonicalHeaders = requestHeader?.querySelectorAll('[data-detail-pane-header-variant="standard"]');
    const canonicalHeader = canonicalHeaders?.[0] as HTMLElement | undefined;
    const approve = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
    expect(warning).toBeTruthy();
    expect(warning?.getAttribute('data-severity')).toBe('warning');
    expect(warning?.classList.contains('detail-pane-notice')).toBe(true);
    expect(detail?.classList.contains('auth-detail')).toBe(true);
    expect(detail?.firstElementChild).toBe(warning);
    expect(warning?.nextElementSibling).toBe(requestPane);
    expect(requestPane?.classList.contains('detail-pane-shell')).toBe(true);
    expect(requestHeader?.classList.contains('detail-pane-shell__header')).toBe(true);
    expect(requestBody?.classList.contains('detail-pane-shell__body')).toBe(true);
    expect(requestHeader?.querySelector('.detail-pane-shell__header-primary.auth-detail__header-primary')).toBeTruthy();
    expect(canonicalHeaders).toHaveLength(1);
    expect(canonicalHeader?.classList.contains('detail-pane-header')).toBe(true);
    expect(requestHeader && warning?.compareDocumentPosition(requestHeader) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(requestBody?.contains(warning as Node)).toBe(false);
    expect(requestBody?.contains(requestHeader as Node)).toBe(false);
    expect(requestBody?.contains(approve)).toBe(false);
    expect(requestHeader?.contains(approve)).toBe(true);
    expect(canonicalHeader?.contains(screen.getByRole('button', { name: 'Auth actions' }))).toBe(true);
    expect(screen.getByText(/Auth actions are disabled for this copied preview queue/)).toBeTruthy();

    expect(approve.disabled).toBe(true);

    fireEvent.click(approve);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('shows preview instance diagnostics at the top of the empty detail column', () => {
    const onApprove = vi.fn();
    renderView(true, onApprove, previewInstance, undefined, null);

    const warning = screen.getByText(/Auth actions are disabled for this copied preview queue/).closest('.detail-pane-notice')!;
    const detail = warning.parentElement;
    const empty = screen.getByText('Select a request to view details').closest('.auth-detail__empty');
    expect(detail?.classList.contains('auth-detail')).toBe(true);
    expect(warning.getAttribute('data-severity')).toBe('warning');
    expect(detail?.firstElementChild).toBe(warning);
    expect(warning.nextElementSibling).toBe(empty);
    expect(screen.getByText(/Auth actions are disabled for this copied preview queue/)).toBeTruthy();
  });

  it('hides commit message editing on preview instances', () => {
    const onApprove = vi.fn();
    const onUpdateField = vi.fn();
    renderView(true, onApprove, previewInstance, onUpdateField);

    expect(screen.getByText('Commit Message')).toBeTruthy();
    expect(screen.queryByText('edit')).toBeNull();
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

  it('disables auth hook mutation controls on preview instances', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/api/auth/hooks' && method === 'GET') {
        return Promise.resolve(new Response(JSON.stringify({
          hooks: [
            {
              id: 'hook-1',
              repo_pattern: '*',
              auth_type: 'merge',
              command: 'echo hook',
              label: 'Test Hook',
              enabled: true,
              builtin: false,
            },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.reject(new Error(`unexpected fetch ${method} ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<AuthHooksPanel mutationsAllowed={false} />);

    expect(await screen.findByText('Test Hook')).toBeTruthy();
    expect(screen.getByText('Auth hook mutations are disabled on this Mandible preview instance.')).toBeTruthy();

    const addButton = screen.getByRole('button', { name: '+ Add Hook' }) as HTMLButtonElement;
    const toggleButton = screen.getByRole('button', { name: 'ON' }) as HTMLButtonElement;
    const editButton = screen.getByRole('button', { name: 'Edit' }) as HTMLButtonElement;
    const deleteButton = screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement;

    expect(addButton.disabled).toBe(true);
    expect(toggleButton.disabled).toBe(true);
    expect(editButton.disabled).toBe(true);
    expect(deleteButton.disabled).toBe(true);

    fireEvent.click(editButton);
    await waitFor(() => {
      expect(screen.queryByPlaceholderText('Shell command to run after auth action')).toBeNull();
    });
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
  it('shows requester, approver, and credential-signature verification', () => {
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
      verified_signature: true,
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

    expect(screen.getByLabelText('Show attribution for Request Agent')).toBeTruthy();
    expect(screen.getByLabelText('Show attribution for Human Approver')).toBeTruthy();
    expect(screen.getByText('Verified signature')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Show attribution for Human Approver'));
    expect(screen.getByText('credential signature')).toBeTruthy();
    expect(screen.getByText('YubiKey signing key')).toBeTruthy();
  });
});
