// Bug: 645f8a8 — auth view mutation gate. While the daemon is not ready
// (rebuilding / starting), the Approve button must be disabled and NO approval
// action may fire. Once ready, Approve works normally.
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthHooksPanel, AuthQueueView, type AuthRequest } from '../ui/src/views/auth';
import type { InstanceInfo } from '../ui/src/api';

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
) {
  return render(
    <AuthQueueView
      queue={[pendingRequest]}
      historyQueue={[]}
      outputs={{}}
      selectedAuthId="req-1"
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

  it('shows preview instance diagnostics and blocks approval actions', () => {
    const onApprove = vi.fn();
    renderView(true, onApprove, previewInstance);

    expect(screen.getByText('preview instance')).toBeTruthy();
    expect(screen.getByText(/Auth actions are disabled for this copied queue/)).toBeTruthy();

    const approve = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);

    fireEvent.click(approve);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('hides commit message editing on preview instances', () => {
    const onApprove = vi.fn();
    const onUpdateField = vi.fn();
    renderView(true, onApprove, previewInstance, onUpdateField);

    expect(screen.getByText('Commit Message')).toBeTruthy();
    expect(screen.queryByText('edit')).toBeNull();
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
